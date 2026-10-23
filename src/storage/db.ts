import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { HistoryNode } from '../core/history';

// 設計書 §9.1: IndexedDB のデータモデル。
// 履歴は docId に紐づける（ファイルハンドルには紐づけない）。

export interface DocRecord {
  id: string;
  title: string;
  text: string;
  headId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  tags: string[];
}

interface StudioDB extends DBSchema {
  documents: { key: string; value: DocRecord };
  history: { key: [string, string]; value: HistoryNode; indexes: { byDoc: string } };
  settings: { key: string; value: { key: string; value: unknown } };
}

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null;

export function db(name = 'mermaid-studio'): Promise<IDBPDatabase<StudioDB>> {
  dbPromise ??= openDB<StudioDB>(name, 1, {
    upgrade(d) {
      d.createObjectStore('documents', { keyPath: 'id' });
      const h = d.createObjectStore('history', { keyPath: ['docId', 'id'] });
      h.createIndex('byDoc', 'docId');
      d.createObjectStore('settings', { keyPath: 'key' });
    },
  });
  return dbPromise;
}

/** テスト用: 接続を閉じて次回は開き直す */
export async function resetDbConnection() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

export async function listDocs(): Promise<DocRecord[]> {
  const all = await (await db()).getAll('documents');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id: string): Promise<DocRecord | undefined> {
  return (await db()).get('documents', id);
}

export async function loadHistory(docId: string): Promise<HistoryNode[]> {
  return (await db()).getAllFromIndex('history', 'byDoc', docId);
}

/**
 * 文書の現在のテキスト・headId と、新しく変わった履歴ノードを 1 つのトランザクションで書く（§8.5）。
 * 途中でクラッシュしても、テキストと履歴が食い違わない。
 */
export async function saveDocAndNodes(doc: DocRecord, nodes: HistoryNode[]): Promise<void> {
  const tx = (await db()).transaction(['documents', 'history'], 'readwrite');
  const hs = tx.objectStore('history');
  await Promise.all([tx.objectStore('documents').put(doc), ...nodes.map((n) => hs.put(n)), tx.done]);
}

export async function updateDocMeta(id: string, patch: Partial<Omit<DocRecord, 'id'>>): Promise<DocRecord | undefined> {
  const tx = (await db()).transaction('documents', 'readwrite');
  const cur = await tx.store.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  await Promise.all([tx.store.put(next), tx.done]);
  return next;
}

export async function purgeDoc(id: string): Promise<void> {
  const tx = (await db()).transaction(['documents', 'history'], 'readwrite');
  const hs = tx.objectStore('history');
  const keys = await hs.index('byDoc').getAllKeys(id);
  await Promise.all([tx.objectStore('documents').delete(id), ...keys.map((k) => hs.delete(k)), tx.done]);
}

/** ゴミ箱で保持期間を過ぎた図を完全に削除する */
export async function purgeExpiredTrash(now = Date.now()): Promise<number> {
  const docs = await listDocs();
  const expired = docs.filter((d) => d.deletedAt !== null && now - d.deletedAt > TRASH_RETENTION_MS);
  for (const d of expired) await purgeDoc(d.id);
  return expired.length;
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('settings', key))?.value as T | undefined;
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', { key, value });
}
