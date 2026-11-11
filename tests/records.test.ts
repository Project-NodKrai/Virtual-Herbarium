import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { handleRecordRequest, initializeRecordStore, restoreRecord } from '../worker/records';

const PREFIX = 'virtual-herbarium/records/v1/';
const A = 'INCH-PT00001';
const B = 'INCH-PT00002';
const SECRET = 'isolated-record-test-encryption-secret-at-least-32-characters';
const fixture = (id = A) => ({ id, collectionNo: id, koreanName: '격리 시험 표본', scientificName: 'Fixture plant', image: 'https://images.example/fixture.png' });

class Bucket {
  values = new Map<string, { body: string; etag: string }>();
  failKeyOnce: string | undefined;
  conflictKeyOnce: string | undefined;
  listLimit = 25;
  gets = 0;
  concurrentGets = 0;
  maxConcurrentGets = 0;
  listed: Array<{ prefix: string; limit: number; cursor?: string }> = [];
  writes: string[] = [];

  async get(key: string) {
    this.gets += 1;
    this.concurrentGets += 1;
    this.maxConcurrentGets = Math.max(this.maxConcurrentGets, this.concurrentGets);
    await new Promise(resolve => setTimeout(resolve, 1));
    this.concurrentGets -= 1;
    const saved = this.values.get(key);
    if (!saved) return null;
    return { key, etag: saved.etag, size: Buffer.byteLength(saved.body), text: async () => saved.body, json: async () => JSON.parse(saved.body) };
  }

  async put(key: string, body: string, options?: { onlyIf?: Headers }) {
    assert.ok(key.startsWith(PREFIX), `Unexpected bucket prefix: ${key}`);
    const existing = this.values.get(key);
    const conditions = new Headers(options?.onlyIf);
    if ((conditions.get('If-None-Match') === '*' && existing)
      || (conditions.has('If-Match') && conditions.get('If-Match') !== `"${existing?.etag}"`)) return null;
    if (this.conflictKeyOnce === key) { this.conflictKeyOnce = undefined; return null; }
    if (this.failKeyOnce === key) { this.failKeyOnce = undefined; throw new Error('Isolated storage failure'); }
    const etag = createHash('md5').update(body).digest('hex');
    this.values.set(key, { body, etag });
    this.writes.push(key);
    return { key, etag };
  }

  async list(options: { prefix: string; limit: number; cursor?: string }) {
    this.listed.push(options);
    const keys = [...this.values.keys()].filter(key => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = Math.min(start + Math.min(options.limit, this.listLimit), keys.length);
    return { objects: keys.slice(start, end).map(key => ({ key })), truncated: end < keys.length, ...(end < keys.length ? { cursor: String(end) } : {}) };
  }
}

function setup() {
  const bucket = new Bucket();
  return { bucket, env: { HERBARIUM_BUCKET: bucket as unknown as R2Bucket, TOTP_STORE_ENCRYPTION_KEY: SECRET } };
}

function request(id?: string, method = 'GET', body?: unknown, headers?: HeadersInit, cursor?: string) {
  const url = new URL(`https://herbarium.example/api/records${id ? `/${id}` : ''}`);
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  return new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers });
}

test('record store fails closed before a verified complete import and resumes only the same import', async () => {
  const { bucket, env } = setup();
  assert.equal((await handleRecordRequest(request(), env)).status, 503);
  assert.equal((await handleRecordRequest(request(A, 'PUT', fixture(), { 'If-None-Match': '*' }), env, A)).status, 503);
  assert.equal(bucket.writes.length, 0);
  bucket.failKeyOnce = `${PREFIX}${B}.json`;
  assert.equal((await initializeRecordStore(env, [fixture(), fixture(B)])).status, 502);
  assert.equal((await handleRecordRequest(request(), env)).status, 503);
  const firstObject = bucket.values.get(`${PREFIX}${A}.json`);
  assert.equal((await initializeRecordStore(env, [fixture()])).status, 409);
  assert.equal((await initializeRecordStore(env, [fixture(B), fixture()])).status, 200);
  assert.equal(bucket.values.get(`${PREFIX}${A}.json`), firstObject, 'Retry must not overwrite an imported record');
  assert.equal((await initializeRecordStore(env, [fixture(), fixture(B)])).status, 409);
});

test('encrypted CRUD preserves images, uses version conditions and requires explicit administrator restore', async () => {
  const { bucket, env } = setup();
  assert.equal((await initializeRecordStore(env, [fixture()])).status, 200);
  const read = await handleRecordRequest(request(A), env, A);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { record: fixture() });
  const oldEtag = read.headers.get('ETag')!;
  assert.match(read.headers.get('Cache-Control')!, /no-transform/, 'The CDN must preserve the strong version used by If-Match');
  assert.equal((await handleRecordRequest(request(A, 'PUT', fixture()), env, A)).status, 428);
  const changed = { ...fixture(), koreanName: '수정된 표본' };
  delete changed.image;
  const saved = await handleRecordRequest(request(A, 'PUT', changed, { 'If-Match': oldEtag }), env, A);
  assert.equal(saved.status, 200);
  assert.notEqual(saved.headers.get('ETag'), oldEtag);
  assert.deepEqual(await (await handleRecordRequest(request(A), env, A)).json(), { record: changed });
  assert.equal((await handleRecordRequest(request(A, 'PUT', fixture(), { 'If-Match': oldEtag }), env, A)).status, 409);
  assert.equal((await handleRecordRequest(request(A, 'PUT', fixture(), { 'If-None-Match': '*' }), env, A)).status, 409);
  const created = await handleRecordRequest(request(B, 'PUT', fixture(B), { 'If-None-Match': '*' }), env, B);
  assert.equal(created.status, 200);
  assert.equal((await handleRecordRequest(request(B, 'DELETE'), env, B)).status, 428);
  const deleted = await handleRecordRequest(request(B, 'DELETE', undefined, { 'If-Match': created.headers.get('ETag')! }), env, B);
  assert.equal(deleted.status, 200);
  assert.equal((await handleRecordRequest(request(B), env, B)).status, 404);
  assert.equal((await handleRecordRequest(request(B, 'PUT', fixture(B), { 'If-Match': deleted.headers.get('ETag')! }), env, B)).status, 409);
  assert.equal((await restoreRecord(env, B)).status, 200);
  assert.deepEqual(await (await handleRecordRequest(request(B), env, B)).json(), { record: fixture(B) });
  assert.equal((await restoreRecord(env, B)).status, 409);
  for (const { body } of bucket.values.values()) {
    assert.doesNotMatch(body, /격리|Fixture plant|images\.example|isolated-record-test|deletedAt/);
    assert.equal(JSON.parse(body).algorithm, 'aes-256-gcm');
  }
});

test('list pagination bounds reads to 25 objects and returns a cursor even for deleted-only pages', async () => {
  const { bucket, env } = setup();
  const records = Array.from({ length: 30 }, (_, index) => fixture(`INCH-PT${String(index).padStart(5, '0')}`));
  assert.equal((await initializeRecordStore(env, records)).status, 200);
  for (const record of records.slice(0, 25)) {
    const read = await handleRecordRequest(request(record.id), env, record.id);
    assert.equal((await handleRecordRequest(request(record.id, 'DELETE', undefined, { 'If-Match': read.headers.get('ETag')! }), env, record.id)).status, 200);
  }
  bucket.gets = 0;
  bucket.maxConcurrentGets = 0;
  const first = await handleRecordRequest(request(), env);
  const firstPage = await first.json() as { records: unknown[]; cursor: string | null };
  assert.deepEqual(firstPage.records, []);
  assert.ok(firstPage.cursor);
  assert.equal(bucket.gets, 26, 'One manifest plus at most 25 object reads');
  assert.equal(bucket.listed[0].limit, 25);
  assert.ok(bucket.maxConcurrentGets <= 4);
  const second = await handleRecordRequest(request(undefined, 'GET', undefined, undefined, firstPage.cursor!), env);
  const secondPage = await second.json() as { records: unknown[]; cursor: string | null };
  assert.equal(secondPage.records.length, 5);
  assert.equal(secondPage.cursor, null);
  const before = bucket.listed.length;
  assert.equal((await handleRecordRequest(request(undefined, 'GET', undefined, undefined, 'bad\ncursor'), env)).status, 400);
  assert.equal(bucket.listed.length, before);
});

test('invalid input, cross-record ciphertext and failed conditional writes never corrupt data', async () => {
  const { bucket, env } = setup();
  assert.equal((await initializeRecordStore(env, [fixture(), fixture(B)])).status, 200);
  const before = bucket.writes.length;
  for (const id of ['../other', 'INCH-PT00001/other', 'INCH-PT1']) assert.equal((await handleRecordRequest(request(), env, id)).status, 400);
  for (const record of [null, [], { ...fixture(), collectionNo: B }, { ...fixture(), project: 'other' }, { ...fixture(), image: null }, { ...fixture(), location: 123 }]) {
    assert.equal((await handleRecordRequest(request(A, 'PUT', record, { 'If-None-Match': '*' }), env, A)).status, 400);
  }
  assert.equal(bucket.writes.length, before);
  const read = await handleRecordRequest(request(A), env, A);
  const snapshot = bucket.values.get(`${PREFIX}${A}.json`);
  bucket.conflictKeyOnce = `${PREFIX}${A}.json`;
  assert.equal((await handleRecordRequest(request(A, 'PUT', { ...fixture(), koreanName: '충돌' }, { 'If-Match': read.headers.get('ETag')! }), env, A)).status, 409);
  assert.equal(bucket.values.get(`${PREFIX}${A}.json`), snapshot);
  bucket.values.set(`${PREFIX}${A}.json`, bucket.values.get(`${PREFIX}${B}.json`)!);
  assert.equal((await handleRecordRequest(request(A), env, A)).status, 503, 'AAD must bind ciphertext to its record path');
  assert.equal((await handleRecordRequest(request(B), { ...env, TOTP_STORE_ENCRYPTION_KEY: 'another-isolated-key-value-at-least-32-characters' }, B)).status, 503);
});
