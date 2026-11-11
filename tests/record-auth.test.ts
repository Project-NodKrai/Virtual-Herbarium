import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../worker/index';

// Per-process fixtures only. These keys never authenticate to a live service.
const AUTH_SECRET = `fixture-signing-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const WRONG_SECRET = `fixture-wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const ID = 'INCH-PT00001';
const MANIFEST_KEY = 'virtual-herbarium/records/v1/_manifest.json';
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
let networkRequests = 0;

beforeEach(() => {
  networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests += 1;
    throw new Error('No network access is permitted in record authorization tests');
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  assert.equal(networkRequests, 0, 'R2 record routes must not request Google credentials or use the network');
});

function fixture(allowManifestRead = false) {
  const bucketCalls: Array<{ method: string; key: unknown }> = [];
  let credentialReads = 0;
  const bucket = new Proxy({}, {
    get(_target, method) {
      return async (key: unknown) => {
        bucketCalls.push({ method: String(method), key });
        if (allowManifestRead && method === 'get' && key === MANIFEST_KEY) return null;
        throw new Error('Unauthorized bucket access');
      };
    },
  });
  const env = { AUTH_TOKEN_SECRET: AUTH_SECRET, HERBARIUM_BUCKET: bucket };
  Object.defineProperty(env, 'FIREBASE_SERVICE_ACCOUNT', {
    get() {
      credentialReads += 1;
      throw new Error('The R2 routes must not read Firebase credentials');
    },
  });
  return {
    env: env as unknown as Env,
    bucketCalls,
    assertNoCredentials: () => assert.equal(credentialReads, 0),
  };
}

async function signPayload(payload: Record<string, unknown>, secret = AUTH_SECRET): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}

function mutationPayload(admin = false, exp = Math.floor(Date.now() / 1000) + 60) {
  return { purpose: 'mutation', sub: admin ? 'admin' : 'fixture-user', admin, exp, nonce: 'fixture-only' };
}

function request(method: string, path = `/api/records/${ID}`, token?: string, body?: unknown): Request {
  return new Request(`https://herbarium.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test('public list and detail reach the uninitialized R2 store without OTP', async () => {
  const state = fixture(true);
  for (const path of ['/api/records', `/api/records/${ID}`]) {
    const result = await worker.fetch(request('GET', path), state.env);
    assert.equal(result.status, 503, 'A public read should reach the store rather than an OTP gate');
    assert.match((await result.json() as { error: string }).error, /초기/);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(state.bucketCalls, [
    { method: 'get', key: MANIFEST_KEY },
    { method: 'get', key: MANIFEST_KEY },
  ]);
  state.assertNoCredentials();
});

test('PUT and DELETE without authorization never access the bucket', async () => {
  const state = fixture();
  for (const method of ['PUT', 'DELETE']) {
    const result = await worker.fetch(request(method), state.env);
    assert.equal(result.status, 401);
  }
  assert.deepEqual(state.bucketCalls, []);
  state.assertNoCredentials();
});

test('setup-purpose tokens cannot authorize record mutations', async () => {
  const state = fixture();
  const setupToken = await signPayload({
    purpose: 'totp-setup', username: 'fixture-user', secretHash: 'fixture-hash',
    exp: Math.floor(Date.now() / 1000) + 60, nonce: 'fixture-only',
  });
  for (const method of ['PUT', 'DELETE']) {
    const result = await worker.fetch(request(method, undefined, setupToken), state.env);
    assert.equal(result.status, 403);
  }
  assert.deepEqual(state.bucketCalls, []);
  state.assertNoCredentials();
});

test('expired and incorrectly signed mutation tokens are rejected before storage access', async () => {
  const state = fixture();
  const expired = await signPayload(mutationPayload(false, Math.floor(Date.now() / 1000) - 1));
  const invalidSignature = await signPayload(mutationPayload(), WRONG_SECRET);
  for (const token of [expired, invalidSignature]) {
    for (const method of ['PUT', 'DELETE']) {
      const result = await worker.fetch(request(method, undefined, token), state.env);
      assert.equal(result.status, 401);
    }
  }
  assert.deepEqual(state.bucketCalls, []);
  state.assertNoCredentials();
});

test('ordinary OTP mutation tokens reach the R2 mutation handler', async () => {
  const state = fixture(true);
  const token = await signPayload(mutationPayload());
  for (const method of ['PUT', 'DELETE']) {
    const result = await worker.fetch(request(method, undefined, token), state.env);
    assert.equal(result.status, 503, 'The missing initialization must be distinct from an authorization failure');
  }
  assert.equal(state.bucketCalls.length, 2);
  state.assertNoCredentials();
});

test('initial import requires an administrator mutation token', async () => {
  const state = fixture();
  const ordinaryToken = await signPayload(mutationPayload());
  const setupToken = await signPayload({ purpose: 'totp-setup', exp: Math.floor(Date.now() / 1000) + 60, nonce: 'fixture-only' });
  for (const [token, expectedStatus] of [[undefined, 401], [ordinaryToken, 403], [setupToken, 403]] as const) {
    const result = await worker.fetch(request('POST', '/api/records/initialize', token, { records: [] }), state.env);
    assert.equal(result.status, expectedStatus);
  }
  assert.deepEqual(state.bucketCalls, []);
  state.assertNoCredentials();
});

test('administrator import reaches record validation and R2 configuration without Firebase credentials', async () => {
  const state = fixture(true);
  const adminToken = await signPayload(mutationPayload(true));
  for (const records of ['invalid-array', [{ id: '../other-object' }]]) {
    const result = await worker.fetch(request('POST', '/api/records/initialize', adminToken, { records }), state.env);
    assert.equal(result.status, 400, 'An administrator should reach the import validation');
  }
  assert.deepEqual(state.bucketCalls, []);

  // This fixture intentionally omits the R2 encryption secret. A valid source
  // reaches its configuration check, but cannot write any object.
  const validRecords = [{ id: ID, collectionNo: ID, scientificName: 'Fixture plant' }];
  const result = await worker.fetch(request('POST', '/api/records/initialize', adminToken, { records: validRecords }), state.env);
  assert.equal(result.status, 503);
  assert.match((await result.json() as { error: string }).error, /암호화/);
  assert.deepEqual(state.bucketCalls, [{ method: 'get', key: MANIFEST_KEY }]);
  state.assertNoCredentials();
});

test('restore requires an administrator mutation token before reading the store', async () => {
  const denied = fixture();
  const ordinaryToken = await signPayload(mutationPayload());
  const setupToken = await signPayload({ purpose: 'totp-setup', exp: Math.floor(Date.now() / 1000) + 60, nonce: 'fixture-only' });
  const path = `/api/records/${ID}/restore`;
  for (const [token, expectedStatus] of [[undefined, 401], [ordinaryToken, 403], [setupToken, 403]] as const) {
    const result = await worker.fetch(request('POST', path, token), denied.env);
    assert.equal(result.status, expectedStatus);
  }
  assert.deepEqual(denied.bucketCalls, []);
  denied.assertNoCredentials();

  const allowed = fixture(true);
  const adminToken = await signPayload(mutationPayload(true));
  const result = await worker.fetch(request('POST', path, adminToken), allowed.env);
  assert.equal(result.status, 503, 'An administrator may reach the uninitialized store');
  assert.deepEqual(allowed.bucketCalls, [{ method: 'get', key: MANIFEST_KEY }]);
  allowed.assertNoCredentials();
});
