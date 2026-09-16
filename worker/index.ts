import * as OTPAuth from 'otpauth';

interface TotpStoreDocument {
  schemaVersion: 1;
  revision: number;
  mutationId: string;
  secrets: Record<string, string>;
}

interface EncryptedTotpStore {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

interface AuthTokenPayload {
  purpose: 'mutation';
  sub: string;
  admin: boolean;
  exp: number;
  nonce: string;
}

interface SetupTokenPayload {
  purpose: 'totp-setup';
  username: string;
  secretHash: string;
  exp: number;
  nonce: string;
}

type SignedPayload = AuthTokenPayload | SetupTokenPayload;

const ADMIN_USER = 'admin';
const DEFAULT_TOTP_STORE_KEY = 'virtual-herbarium:totp-store:v1';
const DEFAULT_LOGO_OBJECT_KEY = 'virtual-herbarium/UI/logo.svg';
const IMAGE_PREFIX = 'virtual-herbarium/plant/';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 5 * 60;
const SETUP_TTL_SECONDS = 10 * 60;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid Base64 value');
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)));
}

async function getEncryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('TOTP_STORE_ENCRYPTION_KEY must contain at least 32 characters');
  const material = await sha256(`virtual-herbarium:totp-store:key:v1\0${secret}`);
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function validateUsername(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new HttpError(400, '사용자 이름 형식이 올바르지 않습니다.');
  }
  return value;
}

function validateSecret(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid TOTP secret');
  const secret = value.trim().toUpperCase();
  if (!/^[A-Z2-7]{16,256}$/.test(secret)) throw new Error('Invalid TOTP secret');
  OTPAuth.Secret.fromBase32(secret);
  return secret;
}

function validateSecretsRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid TOTP store');
  const result: Record<string, string> = {};
  for (const [username, secret] of Object.entries(value)) {
    validateUsername(username);
    result[username] = validateSecret(secret);
  }
  return result;
}

async function encryptStore(document: TotpStoreDocument, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode('virtual-herbarium:totp-store:v1'),
      tagLength: 128,
    },
    await getEncryptionKey(env.TOTP_STORE_ENCRYPTION_KEY),
    textEncoder.encode(JSON.stringify(document)),
  ));
  const authTag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  const envelope: EncryptedTotpStore = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
    ciphertext: bytesToBase64(ciphertext),
    updatedAt: new Date().toISOString(),
  };
  return JSON.stringify(envelope);
}

async function decryptStore(payload: string, env: Env): Promise<TotpStoreDocument> {
  const envelope = JSON.parse(payload) as Partial<EncryptedTotpStore>;
  if (
    envelope.version !== 1
    || envelope.algorithm !== 'aes-256-gcm'
    || typeof envelope.iv !== 'string'
    || typeof envelope.authTag !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Unsupported encrypted TOTP store');
  }
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const tag = base64ToBytes(envelope.authTag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: textEncoder.encode('virtual-herbarium:totp-store:v1'),
      tagLength: 128,
    },
    await getEncryptionKey(env.TOTP_STORE_ENCRYPTION_KEY),
    combined,
  );
  const candidate = JSON.parse(textDecoder.decode(plaintext)) as Partial<TotpStoreDocument>;
  if (
    candidate.schemaVersion !== 1
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision ?? 0) < 1
    || typeof candidate.mutationId !== 'string'
  ) {
    throw new Error('Invalid TOTP store document');
  }
  const secrets = validateSecretsRecord(candidate.secrets);
  if (!secrets[ADMIN_USER]) throw new Error('TOTP store has no admin user');
  return {
    schemaVersion: 1,
    revision: candidate.revision as number,
    mutationId: candidate.mutationId,
    secrets,
  };
}

function storeKey(env: Env): string {
  return env.TOTP_STORE_KEY?.trim() || DEFAULT_TOTP_STORE_KEY;
}

function bootstrapEnabled(env: Env): boolean {
  return String(env.TOTP_STORE_ALLOW_BOOTSTRAP).toLowerCase() === 'true';
}

async function readStore(env: Env): Promise<TotpStoreDocument | null> {
  const encrypted = await env.OTP_STATE.get(storeKey(env));
  return encrypted ? decryptStore(encrypted, env) : null;
}

async function writeStore(env: Env, secrets: Record<string, string>, revision: number): Promise<TotpStoreDocument> {
  const document: TotpStoreDocument = {
    schemaVersion: 1,
    revision,
    mutationId: crypto.randomUUID(),
    secrets: validateSecretsRecord(secrets),
  };
  if (!document.secrets[ADMIN_USER]) throw new Error('TOTP store has no admin user');
  await env.OTP_STATE.put(storeKey(env), await encryptStore(document, env));
  return document;
}

async function storeForRequest(env: Env): Promise<TotpStoreDocument | null> {
  const existing = await readStore(env);
  if (existing) return existing;
  if (!bootstrapEnabled(env)) return null;
  const bootstrapSecret = env.ADMIN_TOTP_SECRET?.trim();
  if (!bootstrapSecret) return null;
  return writeStore(env, { [ADMIN_USER]: validateSecret(bootstrapSecret) }, 1);
}

function createTotp(username: string, secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'VirtualHerbarium',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

function findTotpUser(store: TotpStoreDocument, token: string): string | null {
  if (!/^\d{6}$/.test(token)) return null;
  for (const [username, secret] of Object.entries(store.secrets)) {
    if (createTotp(username, secret).validate({ token, window: 2 }) !== null) return username;
  }
  return null;
}

async function getSigningKey(env: Env): Promise<CryptoKey> {
  if (env.AUTH_TOKEN_SECRET.length < 32) throw new Error('AUTH_TOKEN_SECRET must contain at least 32 characters');
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(env.AUTH_TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signPayload(payload: SignedPayload, env: Env): Promise<string> {
  const encodedPayload = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    await getSigningKey(env),
    textEncoder.encode(encodedPayload),
  ));
  return `${encodedPayload}.${bytesToBase64Url(signature)}`;
}

async function verifySignedPayload(token: string, env: Env): Promise<SignedPayload> {
  const [encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedPayload || !encodedSignature || extra) throw new HttpError(401, '인증 토큰이 올바르지 않습니다.');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await getSigningKey(env),
    base64UrlToBytes(encodedSignature),
    textEncoder.encode(encodedPayload),
  );
  if (!valid) throw new HttpError(401, '인증 토큰이 올바르지 않습니다.');
  const payload = JSON.parse(textDecoder.decode(base64UrlToBytes(encodedPayload))) as SignedPayload;
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, '인증 시간이 만료되었습니다. OTP를 다시 입력해주세요.');
  }
  return payload;
}

async function requireMutationToken(request: Request, env: Env, adminOnly = false): Promise<AuthTokenPayload> {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'OTP 인증이 필요합니다.');
  const payload = await verifySignedPayload(authorization.slice(7), env);
  if (payload.purpose !== 'mutation' || (adminOnly && !payload.admin)) {
    throw new HttpError(403, '이 작업을 수행할 권한이 없습니다.');
  }
  return payload;
}

async function issueMutationToken(username: string, env: Env): Promise<string> {
  return signPayload({
    purpose: 'mutation',
    sub: username,
    admin: username === ADMIN_USER,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  }, env);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  await requireMutationToken(request, env);
  const formData = await request.formData();
  const image = formData.get('image');
  if (!(image instanceof File)) throw new HttpError(400, '업로드할 이미지가 없습니다.');
  if (!image.type.startsWith('image/')) throw new HttpError(400, '이미지 파일만 업로드할 수 있습니다.');
  if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, '이미지는 15MB 이하만 업로드할 수 있습니다.');
  const extensionFromName = image.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const extension = extensionFromName && extensionFromName.length <= 5 ? extensionFromName : 'jpg';
  const objectKey = `${IMAGE_PREFIX}${crypto.randomUUID()}.${extension}`;
  await env.HERBARIUM_BUCKET.put(objectKey, image.stream(), {
    httpMetadata: { contentType: image.type, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const publicBase = env.R2_PUBLIC_URL.replace(/\/$/, '');
  return json({ url: `${publicBase}/${objectKey}` });
}

async function handleDeleteImage(request: Request, env: Env): Promise<Response> {
  await requireMutationToken(request, env);
  const body = await readJson(request);
  if (typeof body.imageUrl !== 'string') throw new HttpError(400, '이미지 URL이 제공되지 않았습니다.');
  const publicBase = new URL(env.R2_PUBLIC_URL);
  let imageUrl: URL;
  try {
    imageUrl = new URL(body.imageUrl);
  } catch {
    throw new HttpError(400, '이미지 URL이 올바르지 않습니다.');
  }
  if (imageUrl.origin !== publicBase.origin) throw new HttpError(400, '허용되지 않은 이미지 주소입니다.');
  const objectKey = decodeURIComponent(imageUrl.pathname.replace(/^\//, ''));
  if (!objectKey.startsWith(IMAGE_PREFIX) || objectKey.includes('..')) {
    throw new HttpError(400, '삭제할 수 없는 이미지 경로입니다.');
  }
  await env.HERBARIUM_BUCKET.delete(objectKey);
  return json({ success: true });
}

async function handleLogo(env: Env): Promise<Response> {
  const object = await env.HERBARIUM_BUCKET.get(env.LOGO_OBJECT_KEY || DEFAULT_LOGO_OBJECT_KEY);
  if (!object) throw new HttpError(404, '로고를 찾을 수 없습니다.');
  return new Response(object.body, {
    headers: {
      'content-type': object.httpMetadata?.contentType || 'image/svg+xml',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    },
  });
}

async function handleTotpStatus(env: Env): Promise<Response> {
  const store = await storeForRequest(env);
  if (!store && !bootstrapEnabled(env)) {
    return json({
      isRegistered: false,
      error: 'OTP 영구 저장소가 없고 초기 생성이 비활성화되어 있습니다.',
      persistence: { mode: 'kv-encrypted', healthy: false },
    }, 503);
  }
  return json({
    isRegistered: Boolean(store?.secrets[ADMIN_USER]),
    persistence: { mode: 'kv-encrypted', healthy: true },
  });
}

async function handleTotpSetup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const username = validateUsername(body.username ?? ADMIN_USER);
  const store = await storeForRequest(env);
  if (username === ADMIN_USER) {
    if (store?.secrets[ADMIN_USER]) throw new HttpError(409, '관리자 OTP가 이미 등록되어 있습니다.');
    if (!bootstrapEnabled(env)) {
      throw new HttpError(503, '관리자 OTP 최초 등록이 비활성화되어 있습니다.');
    }
  } else {
    await requireMutationToken(request, env, true);
    if (!store?.secrets[ADMIN_USER]) throw new HttpError(503, '관리자 OTP가 먼저 등록되어야 합니다.');
    if (store.secrets[username]) throw new HttpError(409, '이미 등록된 OTP 사용자입니다.');
  }

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const otpauthUrl = createTotp(username, secret).toString();
  const setupToken = await signPayload({
    purpose: 'totp-setup',
    username,
    secretHash: bytesToBase64Url(await sha256(secret)),
    exp: Math.floor(Date.now() / 1000) + SETUP_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  }, env);
  return json({ secret, otpauthUrl, setupToken, username });
}

async function handleVerifySetup(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const secret = validateSecret(body.secret);
  if (typeof body.setupToken !== 'string') throw new HttpError(400, '설정 세션이 없습니다.');
  const setup = await verifySignedPayload(body.setupToken, env);
  if (
    setup.purpose !== 'totp-setup'
    || setup.secretHash !== bytesToBase64Url(await sha256(secret))
  ) {
    throw new HttpError(400, '설정 세션이 올바르지 않습니다.');
  }
  if (createTotp(setup.username, secret).validate({ token, window: 2 }) === null) {
    return json({ success: false, error: '잘못된 인증 코드입니다.' });
  }
  const existing = await readStore(env);
  if (existing?.secrets[setup.username]) throw new HttpError(409, '이미 등록된 OTP 사용자입니다.');
  if (!existing && setup.username !== ADMIN_USER) throw new HttpError(503, '관리자 OTP가 먼저 등록되어야 합니다.');
  const secrets = { ...(existing?.secrets || {}), [setup.username]: secret };
  await writeStore(env, secrets, (existing?.revision || 0) + 1);
  return json({ success: true, username: setup.username });
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const store = await storeForRequest(env);
  if (!store) throw new HttpError(503, 'OTP 영구 저장소를 사용할 수 없습니다.');
  const body = await readJson(request);
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const username = findTotpUser(store, token);
  if (!username) return json({ success: false, error: '인증 코드가 올바르지 않습니다.' });
  return json({ success: true, username, sessionToken: await issueMutationToken(username, env) });
}

async function handleRemoveTotp(request: Request, env: Env): Promise<Response> {
  await requireMutationToken(request, env, true);
  const body = await readJson(request);
  const username = validateUsername(body.username);
  if (username === ADMIN_USER) throw new HttpError(400, '최고 관리자(admin) OTP는 삭제할 수 없습니다.');
  const store = await storeForRequest(env);
  if (!store) throw new HttpError(503, 'OTP 영구 저장소를 사용할 수 없습니다.');
  const secrets = { ...store.secrets };
  delete secrets[username];
  await writeStore(env, secrets, store.revision + 1);
  return json({ success: true });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'POST' && pathname === '/api/upload-image') return handleUpload(request, env);
  if (request.method === 'DELETE' && pathname === '/api/delete-image') return handleDeleteImage(request, env);
  if (request.method === 'GET' && pathname === '/api/proxy-logo') return handleLogo(env);
  if (request.method === 'GET' && pathname === '/api/totp/session') {
    return json({ authenticated: false, username: null, isAdmin: false });
  }
  if (request.method === 'GET' && pathname === '/api/totp/status') return handleTotpStatus(env);
  if (request.method === 'GET' && pathname === '/api/totp/users') {
    const store = await storeForRequest(env);
    if (!store) throw new HttpError(503, 'OTP 영구 저장소를 사용할 수 없습니다.');
    return json({ users: Object.keys(store.secrets) });
  }
  if (request.method === 'POST' && pathname === '/api/totp/setup') return handleTotpSetup(request, env);
  if (request.method === 'POST' && pathname === '/api/totp/cancel-setup') return json({ success: true });
  if (request.method === 'POST' && pathname === '/api/totp/verify-setup') return handleVerifySetup(request, env);
  if (request.method === 'POST' && pathname === '/api/totp/verify') return handleVerify(request, env);
  if (request.method === 'POST' && pathname === '/api/totp/remove') return handleRemoveTotp(request, env);
  if (request.method === 'POST' && pathname === '/api/totp/reset') {
    throw new HttpError(400, '관리자 OTP는 초기화할 수 없습니다.');
  }
  throw new HttpError(404, 'API 경로를 찾을 수 없습니다.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await routeApi(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Worker request failed:', error);
      return json({ error: '서버 처리 중 오류가 발생했습니다.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
