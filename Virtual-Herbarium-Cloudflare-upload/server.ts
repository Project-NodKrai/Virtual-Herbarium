import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import * as OTPAuth from "otpauth";
import qrcode from "qrcode";

dotenv.config();

const ADMIN_USER = 'admin';
const ADMIN_SECRET = process.env.ADMIN_TOTP_SECRET?.trim() || '';

// The local file is a cache/development fallback. Cloud Run and similar
// container filesystems are ephemeral, so configured deployments use an
// encrypted R2 object as the durable source of truth.
const DATA_DIR = path.join(process.cwd(), 'data');
const TOTP_STORE_FILE = path.join(DATA_DIR, 'totp-store.json');
const TOTP_STORE_OBJECT_KEY = process.env.TOTP_STORE_OBJECT_KEY?.trim()
  || 'virtual-herbarium/private/totp-store.v1.enc.json';
const TOTP_STORE_ENCRYPTION_SECRET = process.env.TOTP_STORE_ENCRYPTION_KEY?.trim()
  || process.env.R2_SECRET_ACCESS_KEY?.trim()
  || '';
const TOTP_STORE_BUCKET = process.env.R2_TOTP_BUCKET_NAME?.trim()
  || process.env.R2_BUCKET_NAME?.trim()
  || '';
const TOTP_STORE_MODE = process.env.TOTP_STORE_MODE?.trim().toLowerCase()
  || (process.env.NODE_ENV === 'production' ? 'r2' : 'local');
// A missing remote object is dangerous: treating a typo/deletion as an empty
// store would look exactly like an OTP reset. Creation is therefore opt-in.
const TOTP_STORE_ALLOW_BOOTSTRAP = process.env.TOTP_STORE_ALLOW_BOOTSTRAP?.trim().toLowerCase() === 'true';
const TOTP_STORE_AAD = Buffer.from('virtual-herbarium:totp-store:v1', 'utf8');
const TOTP_STORE_MAX_USERS = 1_000;
const TOTP_STORE_MAX_CIPHERTEXT_BYTES = 1_048_576;

const hasR2Config = Boolean(
  process.env.R2_ACCOUNT_ID
  && process.env.R2_ACCESS_KEY_ID
  && process.env.R2_SECRET_ACCESS_KEY
  && TOTP_STORE_BUCKET
);
const usesR2TotpStore = TOTP_STORE_MODE === 'r2';
const hasDurableTotpStore = usesR2TotpStore && hasR2Config && Boolean(TOTP_STORE_ENCRYPTION_SECRET);

interface EncryptedTotpStore {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

interface R2TotpSnapshot {
  secrets: Map<string, string>;
  etag: string | null;
  revision: number;
  mutationId: string;
}

interface TotpStoreDocument {
  schemaVersion: 1;
  revision: number;
  mutationId: string;
  secrets: Record<string, string>;
}

interface LocalTotpSnapshot {
  exists: boolean;
  secrets: Map<string, string>;
}

function recordToMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid TOTP store payload');
  }

  const entries = Object.entries(value);
  if (entries.length > TOTP_STORE_MAX_USERS) {
    throw new Error('TOTP store has too many users');
  }

  const map = new Map<string, string>();
  for (const [username, rawSecret] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(username)) {
      throw new Error('TOTP store contains an invalid username');
    }
    if (typeof rawSecret !== 'string') {
      throw new Error(`TOTP store contains an invalid secret for ${username}`);
    }

    const secret = rawSecret.trim().toUpperCase();
    if (!/^[A-Z2-7]{16,256}$/.test(secret)) {
      throw new Error(`TOTP store contains an invalid Base32 secret for ${username}`);
    }
    try {
      OTPAuth.Secret.fromBase32(secret);
    } catch {
      throw new Error(`TOTP store contains an invalid Base32 secret for ${username}`);
    }
    map.set(username, secret);
  }
  return map;
}

function mapToRecord(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries(map.entries());
}

function getTotpEncryptionKey(): Buffer {
  if (!TOTP_STORE_ENCRYPTION_SECRET) {
    throw new Error('TOTP store encryption key is not configured');
  }
  return createHash('sha256')
    .update('virtual-herbarium:totp-store:key:v1\0', 'utf8')
    .update(TOTP_STORE_ENCRYPTION_SECRET, 'utf8')
    .digest();
}

function encryptTotpStore(map: Map<string, string>, revision: number, mutationId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getTotpEncryptionKey(), iv);
  cipher.setAAD(TOTP_STORE_AAD);

  const document: TotpStoreDocument = {
    schemaVersion: 1,
    revision,
    mutationId,
    secrets: mapToRecord(map),
  };
  const plaintext = Buffer.from(JSON.stringify(document), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedTotpStore = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt: new Date().toISOString(),
  };

  return JSON.stringify(envelope);
}

function decodeBase64(value: string, fieldName: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${fieldName} encoding in encrypted TOTP store`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`Non-canonical ${fieldName} encoding in encrypted TOTP store`);
  }
  return decoded;
}

function parseTotpStoreDocument(value: unknown): Pick<R2TotpSnapshot, 'secrets' | 'revision' | 'mutationId'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid decrypted TOTP store document');
  }

  const candidate = value as Partial<TotpStoreDocument>;
  if ('schemaVersion' in candidate || 'secrets' in candidate) {
    if (
      candidate.schemaVersion !== 1
      || !Number.isSafeInteger(candidate.revision)
      || (candidate.revision as number) < 1
      || typeof candidate.mutationId !== 'string'
      || !/^[A-Za-z0-9_-]{8,128}$/.test(candidate.mutationId)
    ) {
      throw new Error('Unsupported or invalid TOTP store document');
    }
    return {
      secrets: recordToMap(candidate.secrets),
      revision: candidate.revision as number,
      mutationId: candidate.mutationId,
    };
  }

  // Backwards-compatible read of the earlier encrypted payload, which was a
  // bare username-to-secret record. The next successful mutation upgrades it.
  return {
    secrets: recordToMap(value),
    revision: 0,
    mutationId: 'legacy-v1',
  };
}

function decryptTotpStore(payload: string): Pick<R2TotpSnapshot, 'secrets' | 'revision' | 'mutationId'> {
  if (Buffer.byteLength(payload, 'utf8') > TOTP_STORE_MAX_CIPHERTEXT_BYTES * 2) {
    throw new Error('Encrypted TOTP store payload is too large');
  }
  const envelope = JSON.parse(payload) as Partial<EncryptedTotpStore>;
  if (
    envelope.version !== 1
    || envelope.algorithm !== 'aes-256-gcm'
    || typeof envelope.iv !== 'string'
    || typeof envelope.authTag !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('Unsupported or invalid encrypted TOTP store');
  }

  const iv = decodeBase64(envelope.iv, 'IV');
  const authTag = decodeBase64(envelope.authTag, 'authentication tag');
  const ciphertext = decodeBase64(envelope.ciphertext, 'ciphertext');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Encrypted TOTP store uses invalid AES-GCM parameters');
  }
  if (ciphertext.length === 0 || ciphertext.length > TOTP_STORE_MAX_CIPHERTEXT_BYTES) {
    throw new Error('Encrypted TOTP store ciphertext has an invalid size');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    getTotpEncryptionKey(),
    iv,
  );
  decipher.setAAD(TOTP_STORE_AAD);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');

  return parseTotpStoreDocument(JSON.parse(plaintext));
}

function loadLocalTotpSecrets(): LocalTotpSnapshot {
  if (!fs.existsSync(TOTP_STORE_FILE)) {
    return { exists: false, secrets: new Map() };
  }
  return {
    exists: true,
    secrets: recordToMap(JSON.parse(fs.readFileSync(TOTP_STORE_FILE, 'utf-8'))),
  };
}

function saveLocalTotpSecrets(map: Map<string, string>, required = false): void {
  const temporaryFile = `${TOTP_STORE_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(temporaryFile, JSON.stringify(mapToRecord(map), null, 2), 'utf-8');
    fs.renameSync(temporaryFile, TOTP_STORE_FILE);
  } catch (error) {
    console.error('Failed to save the local TOTP cache:', error);
    if (required) throw error;
  } finally {
    try {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function isMissingR2Object(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NoSuchKey'
    || candidate.name === 'NotFound'
    || candidate.$metadata?.httpStatusCode === 404;
}

async function loadR2TotpSecrets(s3Client: S3Client): Promise<R2TotpSnapshot | null> {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: TOTP_STORE_BUCKET,
      Key: TOTP_STORE_OBJECT_KEY,
    }));
    if (!response.Body) throw new Error('Encrypted TOTP store has no body');
    const decrypted = decryptTotpStore(await response.Body.transformToString());
    return {
      ...decrypted,
      etag: response.ETag || null,
    };
  } catch (error) {
    if (isMissingR2Object(error)) return null;
    throw error;
  }
}

async function saveR2TotpSecrets(
  s3Client: S3Client,
  map: Map<string, string>,
  expectedEtag: string | null,
  revision: number,
  mutationId: string,
): Promise<string | null> {
  const response = await s3Client.send(new PutObjectCommand({
    Bucket: TOTP_STORE_BUCKET,
    Key: TOTP_STORE_OBJECT_KEY,
    Body: encryptTotpStore(map, revision, mutationId),
    ContentType: 'application/json',
    CacheControl: 'no-store',
    ...(expectedEtag ? { IfMatch: expectedEtag } : { IfNoneMatch: '*' }),
  }));
  return response.ETag || null;
}

const totpSecrets = new Map<string, string>();
let totpSnapshotLoaded = false;
let durableTotpStoreHealthy = false;

function replaceTotpSecrets(next: Map<string, string>): void {
  totpSecrets.clear();
  for (const [username, secret] of next.entries()) {
    totpSecrets.set(username, secret);
  }
}

function addBootstrapAdmin(map: Map<string, string>): boolean {
  if (map.has(ADMIN_USER) || !ADMIN_SECRET) return false;
  const validated = recordToMap({ [ADMIN_USER]: ADMIN_SECRET });
  map.set(ADMIN_USER, validated.get(ADMIN_USER)!);
  return true;
}

function requireDurableAdmin(map: Map<string, string>): void {
  if (!map.has(ADMIN_USER)) {
    throw new Error('Encrypted TOTP store has no admin OTP');
  }
}

function mapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left.entries()) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'PreconditionFailed' || candidate.$metadata?.httpStatusCode === 412;
}

async function writeR2SnapshotWithReconciliation(
  s3Client: S3Client,
  secrets: Map<string, string>,
  expectedEtag: string | null,
  revision: number,
  mutationId: string,
): Promise<R2TotpSnapshot> {
  try {
    const etag = await saveR2TotpSecrets(
      s3Client,
      secrets,
      expectedEtag,
      revision,
      mutationId,
    );
    if (etag) return { secrets: new Map(secrets), etag, revision, mutationId };
  } catch (writeError) {
    // A timeout can hide a successful PUT. Read back once and compare the
    // operation id before reporting failure, so a committed change is not
    // falsely presented as rejected.
    try {
      const remote = await loadR2TotpSecrets(s3Client);
      if (
        remote
        && remote.revision === revision
        && remote.mutationId === mutationId
        && mapsEqual(remote.secrets, secrets)
      ) {
        return remote;
      }
    } catch (reconciliationError) {
      console.error('Failed to reconcile an uncertain R2 TOTP write:', reconciliationError);
    }
    throw writeError;
  }

  const remote = await loadR2TotpSecrets(s3Client);
  if (
    remote
    && remote.revision === revision
    && remote.mutationId === mutationId
    && mapsEqual(remote.secrets, secrets)
  ) {
    return remote;
  }
  throw new Error('R2 TOTP write returned no ETag and could not be confirmed');
}

async function initializeTotpSecrets(s3Client: S3Client): Promise<void> {
  if (totpSnapshotLoaded) return;

  durableTotpStoreHealthy = false;

  try {
    if (TOTP_STORE_MODE !== 'local' && TOTP_STORE_MODE !== 'r2') {
      throw new Error(`Unsupported TOTP_STORE_MODE: ${TOTP_STORE_MODE}`);
    }

    if (!usesR2TotpStore) {
      const local = loadLocalTotpSecrets();
      const selected = local.secrets;
      const changed = addBootstrapAdmin(selected);
      replaceTotpSecrets(selected);
      if (changed || !local.exists) saveLocalTotpSecrets(selected, true);
      totpSnapshotLoaded = true;
      durableTotpStoreHealthy = true;
      return;
    }

    if (!hasDurableTotpStore) {
      throw new Error('R2 TOTP persistence requires R2 credentials, a bucket, and an encryption secret');
    }

    const remote = await loadR2TotpSecrets(s3Client);
    let selected: Map<string, string>;
    if (remote) {
      // A persisted admin is authoritative. ADMIN_TOTP_SECRET is only used
      // when creating the store for the first time and never overwrites it.
      selected = remote.secrets;
      requireDurableAdmin(selected);
    } else {
      if (!TOTP_STORE_ALLOW_BOOTSTRAP) {
        throw new Error('Encrypted TOTP store is missing and bootstrap is disabled');
      }
      const local = loadLocalTotpSecrets();
      selected = local.secrets;
      addBootstrapAdmin(selected);
      requireDurableAdmin(selected);
      const confirmed = await writeR2SnapshotWithReconciliation(
        s3Client,
        selected,
        null,
        1,
        uuidv4(),
      );
      selected = confirmed.secrets;
    }

    replaceTotpSecrets(selected);
    saveLocalTotpSecrets(selected);
    totpSnapshotLoaded = true;
    durableTotpStoreHealthy = true;
  } catch (error) {
    // Wrong keys, corrupt payloads, permission failures, timeouts, and a
    // missing object without explicit bootstrap all fail closed. A stale
    // local cache is never promoted over an unknown remote state.
    console.error('Encrypted R2 TOTP store is unavailable:', error);
  }
}

async function ensureTotpStoreReady(s3Client: S3Client): Promise<boolean> {
  if (totpSnapshotLoaded) return true;
  await initializeTotpSecrets(s3Client);
  return totpSnapshotLoaded;
}

async function latestTotpSecretsForMutation(s3Client: S3Client): Promise<R2TotpSnapshot> {
  if (!usesR2TotpStore) {
    return { secrets: new Map(totpSecrets), etag: null, revision: 0, mutationId: 'local-dev' };
  }
  if (!hasDurableTotpStore) throw new Error('Encrypted R2 TOTP persistence is not configured');

  // Always re-read before a rare setup/remove mutation so a stale container
  // cannot erase changes written by another instance.
  const remote = await loadR2TotpSecrets(s3Client);
  if (!remote) throw new Error('Encrypted TOTP store is missing');
  requireDurableAdmin(remote.secrets);
  durableTotpStoreHealthy = true;
  return remote;
}

class TotpUserAlreadyExistsError extends Error {}

type TotpMutation =
  | { type: 'add'; username: string; secret: string }
  | { type: 'remove'; username: string };

function applyTotpMutation(base: Map<string, string>, mutation: TotpMutation): { next: Map<string, string>; changed: boolean } {
  const next = new Map(base);
  if (mutation.type === 'add') {
    const validatedSecret = recordToMap({ [mutation.username]: mutation.secret }).get(mutation.username)!;
    const existing = next.get(mutation.username);
    if (existing === validatedSecret) return { next, changed: false };
    if (existing) throw new TotpUserAlreadyExistsError('TOTP user already exists');
    next.set(mutation.username, validatedSecret);
    return { next, changed: true };
  }

  const changed = next.delete(mutation.username);
  return { next, changed };
}

function acceptCommittedSnapshot(snapshot: R2TotpSnapshot): void {
  replaceTotpSecrets(snapshot.secrets);
  saveLocalTotpSecrets(snapshot.secrets);
  totpSnapshotLoaded = true;
  durableTotpStoreHealthy = true;
}

async function commitTotpMutation(s3Client: S3Client, mutation: TotpMutation): Promise<void> {
  if (!totpSnapshotLoaded) throw new Error('TOTP snapshot is not loaded');

  if (!usesR2TotpStore) {
    const { next } = applyTotpMutation(totpSecrets, mutation);
    saveLocalTotpSecrets(next, true);
    replaceTotpSecrets(next);
    durableTotpStoreHealthy = true;
    return;
  }
  if (!hasDurableTotpStore) throw new Error('Encrypted R2 TOTP persistence is not configured');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await latestTotpSecretsForMutation(s3Client);
    const { next, changed } = applyTotpMutation(latest.secrets, mutation);
    if (!changed) {
      acceptCommittedSnapshot(latest);
      return;
    }

    try {
      const committed = await writeR2SnapshotWithReconciliation(
        s3Client,
        next,
        latest.etag,
        latest.revision + 1,
        uuidv4(),
      );
      acceptCommittedSnapshot(committed);
      return;
    } catch (error) {
      if (isPreconditionFailed(error) && attempt < 2) continue;
      durableTotpStoreHealthy = false;
      throw error;
    }
  }

  durableTotpStoreHealthy = false;
  throw new Error('Could not commit the TOTP mutation after concurrent updates');
}

function findTotpUser(token: string): string | null {
  for (const [user, secret] of totpSecrets.entries()) {
    const totp = new OTPAuth.TOTP({
      issuer: 'VirtualHerbarium',
      label: user,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    if (totp.validate({ token, window: 2 }) !== null) return user;
  }
  return null;
}

// Temporary pending setup sessions
interface PendingSetup {
  username: string;
  createdAt: number;
}
const pendingSetups = new Map<string, PendingSetup>();

function cleanPendingSetups() {
  const now = Date.now();
  for (const [secret, setup] of pendingSetups.entries()) {
    if (now - setup.createdAt > 10 * 60 * 1000) { // 10 minutes TTL
      pendingSetups.delete(secret);
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Cloudflare R2 setup
  const upload = multer({ storage: multer.memoryStorage() });
  
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    maxAttempts: 2,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    }
  });

  await initializeTotpSecrets(s3Client);

  // API Routes: Upload Image
  app.post("/api/upload-image", upload.single('image'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: '업로드할 이미지가 없습니다.' });
      
      const ext = file.originalname.split('.').pop() || 'jpg';
      const objectKey = `virtual-herbarium/plant/${uuidv4()}.${ext}`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      
      let publicUrlBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (publicUrlBase && !publicUrlBase.startsWith('http')) {
        publicUrlBase = `https://${publicUrlBase}`;
      }
      const publicUrl = `${publicUrlBase}/${objectKey}`;
      
      res.json({ url: publicUrl });
    } catch (error) {
      console.error('R2 upload error:', error);
      res.status(500).json({ error: '이미지 업로드에 실패했습니다.' });
    }
  });

  // API Routes: Delete Image
  app.delete("/api/delete-image", async (req, res) => {
    try {
      const { imageUrl } = req.body;
      if (!imageUrl) return res.status(400).json({ error: '이미지 URL이 제공되지 않았습니다.' });

      let publicUrlBase = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (publicUrlBase && !publicUrlBase.startsWith('http')) {
        publicUrlBase = `https://${publicUrlBase}`;
      }

      let objectKey = imageUrl;
      if (imageUrl.startsWith(publicUrlBase)) {
        objectKey = imageUrl.substring(publicUrlBase.length);
        if (objectKey.startsWith('/')) {
          objectKey = objectKey.substring(1);
        }
      } else {
        try {
          const parsedUrl = new URL(imageUrl);
          objectKey = parsedUrl.pathname.startsWith('/') ? parsedUrl.pathname.substring(1) : parsedUrl.pathname;
        } catch {
          const urlParts = imageUrl.split('/');
          objectKey = urlParts[urlParts.length - 1];
        }
      }

      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: objectKey,
      }));

      res.json({ success: true });
    } catch (error) {
      console.error('R2 delete error:', error);
      res.status(500).json({ error: '이미지 삭제에 실패했습니다.' });
    }
  });

  // Proxy Logo - with CORS header to prevent canvas taint
  app.get('/api/proxy-logo', async (_req, res) => {
    try {
      const response = await fetch("https://data-herbarium.columbina.kr/virtual-herbarium/UI/logo.svg");
      if (!response.ok) throw new Error("Failed to fetch logo");
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(buffer);
    } catch (error) {
      console.error('Logo proxy error:', error);
      res.status(500).send('Error proxying logo');
    }
  });

  // Check current session status (for backwards compatibility)
  app.get('/api/totp/session', (_req, res) => {
    res.json({ authenticated: false, username: null, isAdmin: false });
  });

  // TOTP Routes: Status check
  app.get('/api/totp/status', async (_req, res) => {
    if (!await ensureTotpStoreReady(s3Client)) {
      return res.status(503).json({
        isRegistered: false,
        error: 'OTP 영구 저장소를 사용할 수 없습니다. 서버 설정과 R2 연결을 확인해주세요.',
        persistence: { mode: usesR2TotpStore ? 'r2-encrypted' : 'local', healthy: false },
      });
    }
    const isRegistered = totpSecrets.has(ADMIN_USER);
    res.json({
      isRegistered,
      persistence: {
        mode: usesR2TotpStore ? 'r2-encrypted' : 'local',
        healthy: durableTotpStoreHealthy,
      },
    });
  });

  // List users
  app.get('/api/totp/users', async (_req, res) => {
    if (!totpSnapshotLoaded) {
      return res.status(503).json({ error: 'OTP 영구 저장소를 사용할 수 없습니다.' });
    }
    res.json({ users: Array.from(totpSecrets.keys()) });
  });

  // Generate Setup QR code
  app.post('/api/totp/setup', async (req, res) => {
    try {
      if (!totpSnapshotLoaded) {
        return res.status(503).json({ error: 'OTP 영구 저장소를 사용할 수 없습니다.' });
      }
      cleanPendingSetups();
      const { username = ADMIN_USER } = req.body || {};

      if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(username)) {
        return res.status(400).json({ error: '사용자 이름 형식이 올바르지 않습니다.' });
      }
      if (username === ADMIN_USER && totpSecrets.has(ADMIN_USER)) {
        return res.status(409).json({ error: '관리자 OTP가 이미 등록되어 있습니다.' });
      }
      
      // Clean any existing pending setup for the same username to avoid interference
      for (const [existingSecret, existingSetup] of pendingSetups.entries()) {
        if (existingSetup.username === username) {
          pendingSetups.delete(existingSecret);
        }
      }

      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      pendingSetups.set(secret, { username, createdAt: Date.now() });
      
      const totp = new OTPAuth.TOTP({
        issuer: 'VirtualHerbarium',
        label: username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
      });
      
      const otpauthUrl = totp.toString();
      const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);
      
      res.json({ secret, qrCodeUrl, username });
    } catch (error) {
      console.error('TOTP setup error:', error);
      res.status(500).json({ error: 'TOTP 생성에 실패했습니다.' });
    }
  });

  // Cancel pending setup
  app.post('/api/totp/cancel-setup', (req, res) => {
    const { secret, username } = req.body || {};
    if (secret && pendingSetups.has(secret)) {
      pendingSetups.delete(secret);
    }
    if (username) {
      for (const [sec, setup] of pendingSetups.entries()) {
        if (setup.username === username) {
          pendingSetups.delete(sec);
        }
      }
    }
    res.json({ success: true });
  });

  // Verify setup & register
  app.post('/api/totp/verify-setup', async (req, res) => {
    cleanPendingSetups();
    const { token, secret } = req.body;
    const pending = pendingSetups.get(secret);
    
    if (!pending) return res.status(400).json({ error: '설정 세션이 만료되었거나 존재하지 않습니다. 다시 시도해주세요.' });
    const username = pending.username;
    
    const totp = new OTPAuth.TOTP({
      issuer: 'VirtualHerbarium',
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret)
    });
    
    // Window of 2 periods (±60s) for robust time drift tolerance
    const delta = totp.validate({ token: String(token).trim(), window: 2 });
    const isValid = delta !== null;
    
    if (isValid) {
      try {
        await commitTotpMutation(s3Client, { type: 'add', username, secret });
        pendingSetups.delete(secret);
        
        res.json({
          success: true,
          username
        });
      } catch (error) {
        if (error instanceof TotpUserAlreadyExistsError) {
          return res.status(409).json({ error: '이미 등록된 OTP 사용자입니다.' });
        }
        console.error('Failed to persist TOTP registration:', error);
        res.status(503).json({
          success: false,
          error: 'OTP 영구 저장소에 연결할 수 없어 등록하지 않았습니다. 잠시 후 다시 시도해주세요.'
        });
      }
    } else {
      res.json({ success: false, error: '잘못된 인증 코드입니다.' });
    }
  });

  // Verify OTP for login
  app.post('/api/totp/verify', async (req, res) => {
    if (!totpSnapshotLoaded) {
      return res.status(503).json({ success: false, error: 'OTP 영구 저장소를 사용할 수 없습니다.' });
    }
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: '인증 코드를 입력해주세요.' });
    }
    
    if (totpSecrets.size === 0) {
      return res.status(400).json({ success: false, error: '등록된 OTP가 없습니다.' });
    }
    
    // Verification is deliberately memory-only. R2 is touched only at server
    // startup and during the rare setup/remove mutations.
    const validUser = findTotpUser(String(token).trim());
    
    if (validUser) {
      res.json({
        success: true,
        username: validUser
      });
    } else {
      res.json({ success: false, error: '인증 코드가 올바르지 않습니다.' });
    }
  });

  // Remove OTP
  app.post('/api/totp/remove', async (req, res) => {
    if (!totpSnapshotLoaded) {
      return res.status(503).json({ error: 'OTP 영구 저장소를 사용할 수 없습니다.' });
    }
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '사용자 이름이 필요합니다.' });
    if (username === ADMIN_USER) {
      return res.status(400).json({ error: '최고 관리자(admin) OTP는 삭제할 수 없습니다.' });
    }
    
    try {
      await commitTotpMutation(s3Client, { type: 'remove', username });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to persist TOTP removal:', error);
      res.status(503).json({ error: 'OTP 영구 저장소에 연결할 수 없어 삭제하지 않았습니다. 잠시 후 다시 시도해주세요.' });
    }
  });

  // Reset route
  app.post('/api/totp/reset', (_req, res) => {
    res.status(400).json({ error: '관리자 OTP는 초기화할 수 없습니다.' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
