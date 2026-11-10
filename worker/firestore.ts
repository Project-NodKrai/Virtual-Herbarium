const PROJECT_ID = 'hypnagogic-charmer-8cf5x';
const DATABASE_ID = 'ai-studio-virtualherbarium-457a0c18-aee3-4c39-ac7f-d22db488f2e4';
const DOCUMENTS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/records`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const RECORD_FIELDS = [
  'id', 'type', 'scientificName', 'koreanName', 'kingdom', 'divisionPhylum',
  'taxonomicClass', 'order', 'family', 'genus', 'collector', 'collDate',
  'collectionNo', 'detBy', 'location', 'specificLocality', 'habitatInformation',
  'latitude', 'longitude', 'altitudeDepth', 'specimenName', 'specimenNote', 'image',
] as const;
const allowedFields = new Set<string>(RECORD_FIELDS);
const encoder = new TextEncoder();

export interface FirestoreEnv {
  FIREBASE_SERVICE_ACCOUNT?: string;
}

interface ServiceAccount {
  type: string;
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

class RecordError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let tokenCache: { credential: string; token: string; expiresAt: number } | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseCredential(raw: string | undefined): ServiceAccount {
  if (!raw) throw new RecordError(503, '표본 저장 서버 인증이 설정되지 않았습니다. 관리자에게 문의해주세요.');
  try {
    const account = JSON.parse(raw) as ServiceAccount;
    if (
      account.type !== 'service_account'
      || account.project_id !== PROJECT_ID
      || typeof account.client_email !== 'string'
      || !account.client_email.endsWith(`@${PROJECT_ID}.iam.gserviceaccount.com`)
      || typeof account.private_key !== 'string'
      || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
    ) throw new Error('Invalid service account');
    return account;
  } catch {
    throw new RecordError(503, '표본 저장 서버 인증 설정이 올바르지 않습니다. 관리자에게 문의해주세요.');
  }
}

async function accessToken(env: FirestoreEnv): Promise<string> {
  const account = parseCredential(env.FIREBASE_SERVICE_ACCOUNT);
  const credential = env.FIREBASE_SERVICE_ACCOUNT!;
  if (tokenCache?.credential === credential && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  let assertion: string;
  try {
    const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, '')), ch => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = base64url(encoder.encode(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })));
    const unsigned = `${header}.${claims}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
    assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  } catch {
    throw new RecordError(503, '표본 저장 서버 인증 키를 사용할 수 없습니다. 관리자에게 문의해주세요.');
  }
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.ok) throw new RecordError(503, '표본 저장 서버 인증에 실패했습니다. 관리자에게 문의해주세요.');
  const payload = await result.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token || typeof payload.expires_in !== 'number' || payload.expires_in <= 0) {
    throw new RecordError(503, '표본 저장 서버의 인증 응답이 올바르지 않습니다.');
  }
  tokenCache = { credential, token: payload.access_token, expiresAt: Date.now() + Math.min(payload.expires_in, 3600) * 1000 };
  return payload.access_token;
}

async function recordFields(request: Request, id: string): Promise<Record<string, { stringValue: string }>> {
  const source = await request.text();
  if (encoder.encode(source).length > 128 * 1024) throw new RecordError(413, '표본 정보가 너무 큽니다.');
  let record: Record<string, unknown>;
  try { record = JSON.parse(source); } catch { throw new RecordError(400, '표본 정보 JSON이 올바르지 않습니다.'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== id || record.collectionNo !== id) {
    throw new RecordError(400, '표본 ID와 채집 번호가 요청 주소와 일치해야 합니다.');
  }
  const fields: Record<string, { stringValue: string }> = {};
  for (const [field, value] of Object.entries(record)) {
    if (!allowedFields.has(field) || typeof value !== 'string' || value.length > 32_000) {
      throw new RecordError(400, '표본 정보에 허용되지 않은 필드 또는 값이 있습니다.');
    }
    fields[field] = { stringValue: value };
  }
  return fields;
}

// The caller must verify the Worker's OTP mutation token before invoking this.
// No project, database, collection, or arbitrary document path is accepted from a client.
export async function handleRecordRequest(request: Request, env: FirestoreEnv, id: string): Promise<Response> {
  try {
    if (!/^INCH-PT\d{5}$/.test(id)) return json({ error: '표본 ID 형식이 올바르지 않습니다.' }, 400);
    if (request.method !== 'PUT' && request.method !== 'DELETE') return json({ error: '지원하지 않는 표본 요청입니다.' }, 405);
    const fields = request.method === 'PUT' ? await recordFields(request, id) : undefined;
    const token = await accessToken(env);
    const target = new URL(`${DOCUMENTS_URL}/${id}`);
    if (fields) {
      // Explicitly clear omitted model fields (e.g. a removed image), preserving any
      // unrelated server metadata rather than replacing unknown document fields.
      for (const field of RECORD_FIELDS) target.searchParams.append('updateMask.fieldPaths', field);
    }
    const result = await fetch(target.toString(), {
      method: fields ? 'PATCH' : 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: fields ? JSON.stringify({ fields }) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (result.status === 401 || result.status === 403) {
      tokenCache = undefined;
      return json({ error: '표본 저장 서버의 데이터베이스 접근 권한이 없습니다. 관리자에게 문의해주세요.' }, 503);
    }
    if (!result.ok) return json({ error: '표본 정보를 저장소에 반영하지 못했습니다. 다시 시도해주세요.' }, 502);
    return json({ success: true });
  } catch (error) {
    if (error instanceof RecordError) return json({ error: error.message }, error.status);
    // Never log or return credentials, OAuth assertions, tokens, or upstream bodies.
    return json({ error: '표본 저장소와 통신하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
  }
}
