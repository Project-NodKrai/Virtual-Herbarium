import type { HerbariumRecord } from './types';

const versions = new Map<string, string>();

async function readResponse(response: Response): Promise<any> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '표본 저장 서버에 연결하지 못했습니다. 다시 시도해주세요.');
  return data;
}

export async function getRecords(): Promise<HerbariumRecord[]> {
  const records: HerbariumRecord[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await fetch(`/api/records${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { cache: 'no-store' });
    const data = await readResponse(response);
    if (!Array.isArray(data.records)) throw new Error('표본 목록 응답이 올바르지 않습니다.');
    records.push(...data.records);
    cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
    if (cursor && cursors.has(cursor)) throw new Error('표본 목록을 끝까지 불러오지 못했습니다. 새로고침해주세요.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return records;
}

export async function getRecordById(id: string): Promise<HerbariumRecord | null> {
  const response = await fetch(`/api/records/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (response.status === 404) {
    versions.delete(id);
    return null;
  }
  const data = await readResponse(response);
  const etag = response.headers.get('ETag');
  if (!data.record || !etag) throw new Error('표본 정보를 읽지 못했습니다. 새로고침해주세요.');
  versions.set(id, etag);
  return data.record;
}

async function mutateRecord(id: string, sessionToken: string, method: 'PUT' | 'DELETE', record?: HerbariumRecord, create = false): Promise<void> {
  const etag = create ? undefined : versions.get(id);
  if (!create && !etag) {
    throw new Error(method === 'DELETE' ? '표본을 새로고침한 뒤 다시 삭제해주세요.' : '표본을 새로고침한 뒤 다시 수정해주세요.');
  }
  const response = await fetch(`/api/records/${encodeURIComponent(id)}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionToken}`,
      ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }),
    },
    ...(record ? { body: JSON.stringify(record) } : {}),
  });
  await readResponse(response);
  if (method === 'DELETE') versions.delete(id);
  else {
    const nextEtag = response.headers.get('ETag');
    if (!nextEtag) throw new Error('저장 결과를 다시 확인하려면 새로고침해주세요.');
    versions.set(id, nextEtag);
  }
}

export const saveRecord = (record: HerbariumRecord, sessionToken: string, options: { create: boolean }): Promise<void> => (
  mutateRecord(record.id, sessionToken, 'PUT', record, options.create)
);

export const deleteRecord = (id: string, sessionToken: string): Promise<void> => (
  mutateRecord(id, sessionToken, 'DELETE')
);
