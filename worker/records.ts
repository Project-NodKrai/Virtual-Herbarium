const PREFIX = 'virtual-herbarium/records/v1/';
const MANIFEST_KEY = `${PREFIX}_manifest.json`;
const ID_PATTERN = /^INCH-PT\d{5}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const RECORD_FIELDS = new Set([
  'id', 'type', 'scientificName', 'koreanName', 'kingdom', 'divisionPhylum',
  'taxonomicClass', 'order', 'family', 'genus', 'collector', 'collDate',
  'collectionNo', 'detBy', 'location', 'specificLocality', 'habitatInformation',
  'latitude', 'longitude', 'altitudeDepth', 'specimenName', 'specimenNote', 'image',
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export interface RecordsEnv {
  HERBARIUM_BUCKET: R2Bucket;
  TOTP_STORE_ENCRYPTION_KEY: string;
}

type RecordData = Record<string, string>;
interface StoredRecord {
  schemaVersion: 1;
  record: RecordData;
  updatedAt: string;
  deletedAt?: string;
}
interface Manifest {
  schemaVersion: 1;
  state: 'initializing' | 'complete';
  sourceHash: string;
  ids: string[];
  startedAt: string;
  completedAt?: string;
}
interface EncryptedObject {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
}

class RecordError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function base64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

function unbase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function encryptionKey(env: RecordsEnv): Promise<CryptoKey> {
  if (typeof env.TOTP_STORE_ENCRYPTION_KEY !== 'string' || env.TOTP_STORE_ENCRYPTION_KEY.length < 32) {
    throw new RecordError(503, '표본 저장소의 암호화 설정을 사용할 수 없습니다.');
  }
  // Separate this key and AAD from the OTP store even though the root secret is shared.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`virtual-herbarium:records:key:v1\0${env.TOTP_STORE_ENCRYPTION_KEY}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(value: unknown, key: string, env: RecordsEnv): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`virtual-herbarium:records:v1\0${key}`) },
    await encryptionKey(env), encoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) } satisfies EncryptedObject);
}

async function decrypt<T>(object: R2ObjectBody, key: string, env: RecordsEnv): Promise<T> {
  try {
    if (object.size > MAX_RECORD_BYTES * 2) throw new Error('Oversized object');
    const envelope = await object.json<EncryptedObject>();
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm'
      || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error('Invalid envelope');
    const iv = unbase64(envelope.iv);
    if (iv.length !== 12) throw new Error('Invalid IV');
    const cleartext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`virtual-herbarium:records:v1\0${key}`) },
      await encryptionKey(env), unbase64(envelope.ciphertext),
    );
    return JSON.parse(decoder.decode(cleartext)) as T;
  } catch {
    throw new RecordError(503, '표본 저장소의 데이터를 안전하게 읽지 못했습니다. 관리자에게 문의해주세요.');
  }
}

function validateRecord(value: unknown, id: string): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordError(400, '표본 정보 형식이 올바르지 않습니다.');
  const source = value as Record<string, unknown>;
  if (source.id !== id || source.collectionNo !== id) throw new RecordError(400, '표본 ID와 채집 번호가 요청 주소와 일치해야 합니다.');
  const record: RecordData = {};
  for (const [field, content] of Object.entries(source)) {
    if (!RECORD_FIELDS.has(field) || typeof content !== 'string' || content.length > 32_000) {
      throw new RecordError(400, '표본 정보에 허용되지 않은 필드 또는 값이 있습니다.');
    }
  }
  // Normalize field order so migration retries compare records by content.
  for (const field of RECORD_FIELDS) if (typeof source[field] === 'string') record[field] = source[field];
  if (encoder.encode(JSON.stringify(record)).length > MAX_RECORD_BYTES) throw new RecordError(413, '표본 정보가 너무 큽니다.');
  return record;
}

function recordKey(id: string): string { return `${PREFIX}${id}.json`; }
function quotedEtag(etag: string): string { return `"${etag}"`; }

async function readManifest(env: RecordsEnv, mustBeComplete = true): Promise<{ manifest: Manifest; etag: string } | null> {
  const object = await env.HERBARIUM_BUCKET.get(MANIFEST_KEY);
  if (!object) {
    if (!mustBeComplete) return null;
    throw new RecordError(503, '표본 저장소의 초기 복사가 아직 완료되지 않았습니다.');
  }
  const manifest = await decrypt<Manifest>(object, MANIFEST_KEY, env);
  if (manifest.schemaVersion !== 1 || !['initializing', 'complete'].includes(manifest.state)
    || !Array.isArray(manifest.ids) || manifest.ids.some(id => typeof id !== 'string' || !ID_PATTERN.test(id))
    || typeof manifest.sourceHash !== 'string' || typeof manifest.startedAt !== 'string') {
    throw new RecordError(503, '표본 저장소의 초기화 정보를 읽지 못했습니다.');
  }
  if (mustBeComplete && manifest.state !== 'complete') throw new RecordError(503, '표본 저장소의 초기 복사가 아직 완료되지 않았습니다.');
  return { manifest, etag: object.etag };
}

async function readRecord(env: RecordsEnv, id: string): Promise<{ value: StoredRecord; etag: string } | null> {
  const key = recordKey(id);
  const object = await env.HERBARIUM_BUCKET.get(key);
  if (!object) return null;
  const value = await decrypt<StoredRecord>(object, key, env);
  try {
    if (value.schemaVersion !== 1 || typeof value.updatedAt !== 'string'
      || (value.deletedAt !== undefined && typeof value.deletedAt !== 'string')) throw new Error('Invalid record envelope');
    value.record = validateRecord(value.record, id);
  } catch {
    throw new RecordError(503, '표본 저장소에 올바르지 않은 데이터가 있습니다.');
  }
  return { value, etag: object.etag };
}

async function writeRecord(env: RecordsEnv, id: string, value: StoredRecord, previousEtag?: string): Promise<R2Object> {
  const key = recordKey(id);
  const onlyIf = previousEtag ? new Headers({ 'If-Match': quotedEtag(previousEtag) }) : new Headers({ 'If-None-Match': '*' });
  const result = await env.HERBARIUM_BUCKET.put(key, await encrypt(value, key, env), {
    onlyIf, httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
  });
  if (!result) throw new RecordError(409, '다른 작업에서 표본 정보가 변경되었습니다. 새로고침 후 다시 시도해주세요.');
  return result;
}

async function requestRecord(request: Request, id: string): Promise<RecordData> {
  const reader = request.body?.getReader();
  if (!reader) throw new RecordError(400, '표본 정보가 없습니다.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RECORD_BYTES) {
        await reader.cancel();
        throw new RecordError(413, '표본 정보가 너무 큽니다.');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(decoder.decode(bytes)); } catch { throw new RecordError(400, '표본 정보 JSON이 올바르지 않습니다.'); }
  return validateRecord(value, id);
}

async function listRecords(request: Request, env: RecordsEnv): Promise<Response> {
  const records: RecordData[] = [];
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (cursor !== null && !/^[\x21-\x7e]{1,2048}$/.test(cursor)) throw new RecordError(400, '표본 목록 페이지 정보가 올바르지 않습니다.');
  const page = await env.HERBARIUM_BUCKET.list({ prefix: PREFIX, limit: 25, ...(cursor ? { cursor } : {}) });
  // Bound storage reads and connection count even when a deleted-only page occurs.
  for (let index = 0; index < page.objects.length; index += 4) {
    const group = await Promise.all(page.objects.slice(index, index + 4).map(async object => {
      const name = object.key.slice(PREFIX.length);
      if (!object.key.startsWith(PREFIX) || !/^INCH-PT\d{5}\.json$/.test(name)) return null;
      const stored = await readRecord(env, name.slice(0, -5));
      return stored && !stored.value.deletedAt ? stored.value.record : null;
    }));
    for (const record of group) if (record) records.push(record);
  }
  if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new RecordError(503, '표본 목록의 다음 페이지를 읽지 못했습니다.');
  records.sort((left, right) => left.id.localeCompare(right.id));
  return json({ records, cursor: page.truncated ? page.cursor : null });
}

// The caller MUST check an OTP mutation token before forwarding PUT or DELETE.
export async function handleRecordRequest(request: Request, env: RecordsEnv, id?: string): Promise<Response> {
  try {
    if (id !== undefined && !ID_PATTERN.test(id)) throw new RecordError(400, '표본 ID 형식이 올바르지 않습니다.');
    if (id === undefined && request.method !== 'GET') return json({ error: '지원하지 않는 표본 요청입니다.' }, 405);
    if (!['GET', 'PUT', 'DELETE'].includes(request.method)) return json({ error: '지원하지 않는 표본 요청입니다.' }, 405);
    await readManifest(env);
    if (id === undefined) return await listRecords(request, env);
    const input = request.method === 'PUT' ? await requestRecord(request, id) : undefined;
    const previous = await readRecord(env, id);
    if (request.method === 'GET') {
      if (!previous || previous.value.deletedAt) return json({ error: '표본을 찾을 수 없습니다.' }, 404);
      return json({ record: previous.value.record }, 200, { ETag: quotedEtag(previous.etag) });
    }
    const ifMatch = request.headers.get('If-Match');
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifMatch && ifNoneMatch) throw new RecordError(400, '표본 변경 조건이 올바르지 않습니다.');
    if (!ifMatch && !(request.method === 'PUT' && ifNoneMatch === '*')) {
      throw new RecordError(428, '표본 정보를 먼저 불러온 뒤 다시 시도해주세요.');
    }
    if (ifMatch && (!previous || ifMatch !== quotedEtag(previous.etag))) {
      throw new RecordError(409, '표본 정보가 변경되었습니다. 새로고침 후 다시 시도해주세요.');
    }
    if (ifNoneMatch === '*' && previous) throw new RecordError(409, '이미 같은 번호의 표본이 있습니다.');
    if (input && previous?.value.deletedAt) throw new RecordError(409, '삭제된 표본은 관리자의 복구가 필요합니다.');
    const now = new Date().toISOString();
    if (input) {
      const written = await writeRecord(env, id, { schemaVersion: 1, record: input, updatedAt: now }, previous?.etag);
      return json({ success: true }, 200, { ETag: quotedEtag(written.etag) });
    }
    if (!previous) return json({ error: '표본을 찾을 수 없습니다.' }, 404);
    const written = previous.value.deletedAt ? null : await writeRecord(env, id, { ...previous.value, deletedAt: now, updatedAt: now }, previous.etag);
    return json({ success: true }, 200, { ETag: quotedEtag(written?.etag || previous.etag) });
  } catch (error) {
    if (error instanceof RecordError) return json({ error: error.message }, error.status);
    return json({ error: '표본 저장소와 통신하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
  }
}

// The caller MUST require an administrator mutation token. Restoration is explicit;
// ordinary PUT cannot overwrite a tombstone or accidentally resurrect a specimen.
export async function restoreRecord(env: RecordsEnv, id: string): Promise<Response> {
  try {
    if (!ID_PATTERN.test(id)) throw new RecordError(400, '표본 ID 형식이 올바르지 않습니다.');
    await readManifest(env);
    const previous = await readRecord(env, id);
    if (!previous) return json({ error: '복구할 표본을 찾을 수 없습니다.' }, 404);
    if (!previous.value.deletedAt) throw new RecordError(409, '삭제되지 않은 표본입니다.');
    const written = await writeRecord(env, id, {
      schemaVersion: 1, record: previous.value.record, updatedAt: new Date().toISOString(),
    }, previous.etag);
    return json({ success: true }, 200, { ETag: quotedEtag(written.etag) });
  } catch (error) {
    if (error instanceof RecordError) return json({ error: error.message }, error.status);
    return json({ error: '표본 복구를 완료하지 못했습니다. 다시 시도해주세요.' }, 502);
  }
}

// One-time import only. The caller MUST require an administrator mutation token.
// No prefix, bucket, or object key is accepted from the importing client.
export async function initializeRecordStore(env: RecordsEnv, source: unknown): Promise<Response> {
  try {
    if (!Array.isArray(source) || source.length > 1000) throw new RecordError(400, '초기 표본 목록 형식이 올바르지 않습니다.');
    const records = source.map(value => {
      const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new RecordError(400, '초기 표본 ID 형식이 올바르지 않습니다.');
      return validateRecord(value, id);
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(records.map(record => record.id)).size !== records.length) throw new RecordError(400, '중복된 초기 표본 번호가 있습니다.');
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(records)));
    const sourceHash = base64(new Uint8Array(digest));
    let existing = await readManifest(env, false);
    if (existing?.manifest.state === 'complete') throw new RecordError(409, '표본 저장소는 이미 초기화되어 있습니다.');
    if (existing && existing.manifest.sourceHash !== sourceHash) throw new RecordError(409, '진행 중인 초기 복사와 표본 목록이 다릅니다.');
    if (!existing) {
      const manifest: Manifest = { schemaVersion: 1, state: 'initializing', sourceHash, ids: records.map(record => record.id), startedAt: new Date().toISOString() };
      const created = await env.HERBARIUM_BUCKET.put(MANIFEST_KEY, await encrypt(manifest, MANIFEST_KEY, env), {
        onlyIf: new Headers({ 'If-None-Match': '*' }), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      if (!created) throw new RecordError(409, '다른 초기 복사가 시작되었습니다. 다시 시도해주세요.');
      existing = { manifest, etag: created.etag };
    }
    for (const record of records) {
      const previous = await readRecord(env, record.id);
      if (previous) {
        if (JSON.stringify(previous.value.record) !== JSON.stringify(record) || previous.value.deletedAt) throw new RecordError(409, '기존 표본과 초기 복사 내용이 일치하지 않습니다.');
      } else {
        await writeRecord(env, record.id, { schemaVersion: 1, record, updatedAt: existing.manifest.startedAt });
      }
    }
    const complete: Manifest = { ...existing.manifest, state: 'complete', completedAt: new Date().toISOString() };
    const finished = await env.HERBARIUM_BUCKET.put(MANIFEST_KEY, await encrypt(complete, MANIFEST_KEY, env), {
      onlyIf: new Headers({ 'If-Match': quotedEtag(existing.etag) }), httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    if (!finished) throw new RecordError(409, '초기 복사 상태가 변경되었습니다. 다시 확인해주세요.');
    return json({ success: true, imported: records.length });
  } catch (error) {
    if (error instanceof RecordError) return json({ error: error.message }, error.status);
    return json({ error: '표본 초기 복사를 완료하지 못했습니다. 다시 시도해주세요.' }, 502);
  }
}
