import { db } from './firebase';
import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';
import { HerbariumRecord } from './types';

const COLLECTION_NAME = 'records';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(error instanceof Error ? error.message : String(error));
}

export const getRecords = async (): Promise<HerbariumRecord[]> => {
  try {
    const q = query(collection(db, COLLECTION_NAME));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => doc.data() as HerbariumRecord);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, COLLECTION_NAME);
  }
};

export const getRecordById = async (id: string): Promise<HerbariumRecord | null> => {
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const snapshot = await getDoc(docRef);
    if (snapshot.exists()) {
      return snapshot.data() as HerbariumRecord;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `${COLLECTION_NAME}/${id}`);
  }
};

async function mutateRecord(id: string, sessionToken: string, method: 'PUT' | 'DELETE', record?: HerbariumRecord): Promise<void> {
  const response = await fetch(`/api/records/${encodeURIComponent(id)}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
    ...(record ? { body: JSON.stringify(record) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '표본 저장 서버에 연결하지 못했습니다. 다시 시도해주세요.');
  }
}

export const saveRecord = (record: HerbariumRecord, sessionToken: string): Promise<void> => (
  mutateRecord(record.id, sessionToken, 'PUT', record)
);

export const deleteRecord = (id: string, sessionToken: string): Promise<void> => (
  mutateRecord(id, sessionToken, 'DELETE')
);
