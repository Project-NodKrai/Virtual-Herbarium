import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getRecordById, getRecords, saveRecord, deleteRecord } from '../src/db';
import type { HerbariumRecord } from '../src/types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reply = (body: unknown, etag?: string, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
});

test('list reads every cursor page, including a deleted-only page', async () => {
  const paths: string[] = [];
  globalThis.fetch = async input => {
    paths.push(String(input));
    if (paths.length === 1) return reply({ records: [{ id: 'INCH-PT00001' }], cursor: 'page-two' });
    if (paths.length === 2) return reply({ records: [], cursor: 'page-three' });
    return reply({ records: [{ id: 'INCH-PT00002' }], cursor: null });
  };
  assert.deepEqual((await getRecords()).map(record => record.id), ['INCH-PT00001', 'INCH-PT00002']);
  assert.deepEqual(paths, ['/api/records', '/api/records?cursor=page-two', '/api/records?cursor=page-three']);
});

test('create, update and delete use the versions issued by the server', async () => {
  const record = { id: 'INCH-PT00101', collectionNo: 'INCH-PT00101', koreanName: 'Fixture' } as HerbariumRecord;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_input, options) => {
    calls.push(options!);
    if (calls.length === 1) return reply({ success: true }, '"created"');
    if (calls.length === 2) return reply({ record }, '"loaded"');
    if (calls.length === 3) return reply({ success: true }, '"updated"');
    return reply({ success: true });
  };
  await saveRecord(record, 'fixture-token', { create: true });
  await getRecordById(record.id);
  await saveRecord({ ...record, koreanName: 'Updated' }, 'fixture-token', { create: false });
  await deleteRecord(record.id, 'fixture-token');
  assert.equal(new Headers(calls[0].headers).get('If-None-Match'), '*');
  assert.equal(new Headers(calls[2].headers).get('If-Match'), '"loaded"');
  assert.equal(new Headers(calls[3].headers).get('If-Match'), '"updated"');
  assert.equal(new Headers(calls[3].headers).get('Authorization'), 'Bearer fixture-token');
});

test('a stale update reports the server conflict and never retries as an overwrite', async () => {
  const record = { id: 'INCH-PT00102', collectionNo: 'INCH-PT00102' } as HerbariumRecord;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? reply({ record }, '"old"') : reply({ error: '새로고침 후 다시 시도해주세요.' }, undefined, 409);
  await getRecordById(record.id);
  await assert.rejects(saveRecord(record, 'fixture-token', { create: false }), /새로고침/);
  assert.equal(calls, 2);
});

test('a missing record returns null and duplicate pagination is rejected', async () => {
  globalThis.fetch = async () => reply({}, undefined, 404);
  assert.equal(await getRecordById('INCH-PT00103'), null);
  globalThis.fetch = async () => reply({ records: [], cursor: 'repeated' });
  await assert.rejects(getRecords(), /끝까지/);
});

test('creating a previously viewed ID never uses its cached update version', async () => {
  const record = { id: 'INCH-PT00104', collectionNo: 'INCH-PT00104', koreanName: 'Existing fixture' } as HerbariumRecord;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_input, options) => {
    calls.push(options!);
    if (options?.method !== 'PUT') return reply({ record }, '"existing-version"');
    const headers = new Headers(options.headers);
    return headers.get('If-None-Match') === '*'
      ? reply({ error: '이미 같은 번호의 표본이 있습니다.' }, undefined, 409)
      : reply({ success: true }, '"overwritten-version"');
  };
  await getRecordById(record.id);
  await assert.rejects(saveRecord({ ...record, koreanName: 'New fixture' }, 'fixture-token', { create: true }), /같은 번호/);
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[1].headers).get('If-None-Match'), '*');
  assert.equal(new Headers(calls[1].headers).get('If-Match'), null);
});

test('updating without a loaded version fails locally instead of creating a record', async () => {
  const record = { id: 'INCH-PT00105', collectionNo: 'INCH-PT00105' } as HerbariumRecord;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return reply({ success: true }, '"unexpected-created-version"');
  };
  await assert.rejects(saveRecord(record, 'fixture-token', { create: false }), /새로고침/);
  assert.equal(calls, 0);
});
