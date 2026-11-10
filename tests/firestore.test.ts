import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { handleRecordRequest } from '../worker/firestore';

const PROJECT = 'hypnagogic-charmer-8cf5x';
const DATABASE = 'ai-studio-virtualherbarium-457a0c18-aee3-4c39-ac7f-d22db488f2e4';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ID = 'INCH-PT00001';
const originalFetch = globalThis.fetch;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const record = { id: ID, collectionNo: ID, scientificName: 'Fixture plant', koreanName: '표본' };
let nextAccount = 0;

afterEach(() => { globalThis.fetch = originalFetch; });

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account', project_id: PROJECT,
      client_email: `isolated-test-${nextAccount++}@${PROJECT}.iam.gserviceaccount.com`,
      private_key: privatePem, ...overrides,
    }),
  };
}

function request(body: unknown = record, method = 'PUT') {
  return new Request(`https://herbarium.example/api/records/${ID}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('service account JWT is signed and writes only the fixed specimen database', async () => {
  const env = credentials({ token_uri: 'https://untrusted.example/token' });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      assert.equal(init?.method, 'POST');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const parts = form.get('assertion')!.split('.');
      assert.equal(parts.length, 3);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url')), true);
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      assert.equal(header.alg, 'RS256');
      assert.equal(claims.aud, TOKEN_URL);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
      assert.equal(claims.exp - claims.iat, 3600);
      return json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    const target = new URL(url);
    assert.equal(target.origin, 'https://firestore.googleapis.com');
    assert.equal(target.pathname, `/v1/projects/${PROJECT}/databases/${DATABASE}/documents/records/${ID}`);
    assert.equal(init?.method, 'PATCH');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-access-token');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.fields.koreanName, { stringValue: '표본' });
    assert.equal('image' in body.fields, false);
    assert.ok(target.searchParams.getAll('updateMask.fieldPaths').includes('image'), 'An omitted image must be cleared');
    return json({});
  };
  const result = await handleRecordRequest(request(), env, ID);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true });
  assert.equal(calls.length, 2);
});

test('DELETE uses the same fixed collection and reuses only the matching credential token', async () => {
  const firstEnv = credentials();
  const secondEnv = credentials();
  let oauthRequests = 0;
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === TOKEN_URL) {
      oauthRequests += 1;
      return json({ access_token: `fixture-access-${oauthRequests}`, expires_in: 3600 });
    }
    assert.equal(String(input), `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/records/${ID}`);
    assert.equal(init?.method, 'DELETE');
    assert.equal(init?.body, undefined);
    deletes += 1;
    return json({});
  };
  assert.equal((await handleRecordRequest(request(null, 'DELETE'), firstEnv, ID)).status, 200);
  assert.equal((await handleRecordRequest(request(null, 'DELETE'), firstEnv, ID)).status, 200);
  assert.equal((await handleRecordRequest(request(null, 'DELETE'), secondEnv, ID)).status, 200);
  assert.equal(oauthRequests, 2);
  assert.equal(deletes, 3);
});

test('invalid paths, field types, unknown fields and mismatched IDs never reach Google', async () => {
  globalThis.fetch = async () => { throw new Error('No network request is permitted'); };
  const env = credentials();
  for (const id of ['../other', 'INCH-PT00001/other', 'INCH-PT1', 'other-project']) {
    assert.equal((await handleRecordRequest(request(), env, id)).status, 400);
  }
  for (const body of [null, [], { ...record, id: 'INCH-PT00002' }, { ...record, collectionNo: 'INCH-PT00002' }, { ...record, location: 123 }, { ...record, projectId: 'other-project' }, { ...record, image: null }]) {
    assert.equal((await handleRecordRequest(request(body), env, ID)).status, 400);
  }
  assert.equal((await handleRecordRequest(request(record, 'POST'), env, ID)).status, 405);
});

test('missing or foreign-project credentials produce a clear configuration error', async () => {
  globalThis.fetch = async () => { throw new Error('No network request is permitted'); };
  for (const env of [{}, { FIREBASE_SERVICE_ACCOUNT: 'invalid-json' }, credentials({ project_id: 'other-project' })]) {
    const result = await handleRecordRequest(request(), env, ID);
    assert.equal(result.status, 503);
    assert.match((await result.json() as { error: string }).error, /관리자/);
  }
});

test('database permission failures remain distinct from an invalid OTP and do not leak upstream details', async () => {
  const env = credentials();
  let oauthRequests = 0;
  globalThis.fetch = async input => {
    if (String(input) === TOKEN_URL) {
      oauthRequests += 1;
      return json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    return json({ error: { message: 'sensitive upstream diagnostic' } }, 403);
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await handleRecordRequest(request(), env, ID);
    assert.equal(result.status, 503);
    const body = await result.text();
    assert.match(body, /데이터베이스 접근 권한/);
    assert.doesNotMatch(body, /sensitive upstream|fixture-access-token|PRIVATE KEY/);
  }
  assert.equal(oauthRequests, 2, 'Rejected credentials must not leave a cached token active');
});
