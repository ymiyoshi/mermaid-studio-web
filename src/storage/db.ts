import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
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

/** 図とローカルファイルの結び付き（設計書 §9.3） */
export interface FileBinding {
  docId: string;
  /** ファイル名（拡張子つき） */
  name: string;
  kind: 'mermaid' | 'markdown';
  /** markdown のとき、何番目の ```mermaid ブロックか */
  blockIndex: number;
  /** File System Access API のハンドル。使えないブラウザでは null（保存はダウンロードになる） */
  handle: FileSystemFileHandle | null;
  /** 最後に読み書きしたときのファイルの更新時刻 */
  lastModified: number;
  /** 最後に読み書きした図のテキスト（未保存の変更があるかの判定に使う） */
  savedText: string;
  /** handle が無いときの markdown 全体（ダウンロードで保存するときに使う） */
  markdown: string | null;
}

/** IndexedDB に置く形。長いスナップショットは圧縮して snapshotZ に入れる（§8.5） */
type StoredNode = HistoryNode & { snapshotZ?: Uint8Array };

/** これより長いスナップショットは圧縮する */
const COMPRESS_MIN = 512;

export function encodeNode(n: HistoryNode): StoredNode {
  if (n.snapshot === null || n.snapshot.length < COMPRESS_MIN) return n;
  return { ...n, snapshot: null, snapshotZ: deflateSync(strToU8(n.snapshot)) };
}

export function decodeNode(n: StoredNode): HistoryNode {
  if (!n.snapshotZ) return n;
  const { snapshotZ, ...rest } = n;
  return { ...rest, snapshot: strFromU8(inflateSync(snapshotZ)) };
}

/** 図の一覧に出すサムネイル（最後に正常に描画できた SVG） */
export interface Thumb {
  docId: string;
  svg: string;
  updatedAt: number;
}

interface StudioDB extends DBSchema {
  documents: { key: string; value: DocRecord };
  thumbs: { key: string; value: Thumb };
  files: { key: string; value: FileBinding };
  history: { key: [string, string]; value: StoredNode; indexes: { byDoc: string } };
  settings: { key: string; value: { key: string; value: unknown } };
}

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null;

export function db(name = 'mermaid-studio'): Promise<IDBPDatabase<StudioDB>> {
  dbPromise ??= openDB<StudioDB>(name, 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('documents', { keyPath: 'id' });
        const h = d.createObjectStore('history', { keyPath: ['docId', 'id'] });
        h.createIndex('byDoc', 'docId');
        d.createObjectStore('settings', { keyPath: 'key' });
      }
      if (oldVersion < 2) d.createObjectStore('files', { keyPath: 'docId' });
      if (oldVersion < 3) d.createObjectStore('thumbs', { keyPath: 'docId' });
    },
    // 新しい版のアプリが別のタブで開かれたら、古い接続を閉じて読み込み直す
    blocking() {
      void dbPromise?.then((d) => d.close());
      dbPromise = null;
      if (typeof location !== 'undefined') location.reload();
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
  return (await (await db()).getAllFromIndex('history', 'byDoc', docId)).map(decodeNode);
}

/** 履歴ノードを消す（古い分岐の整理） */
export async function deleteHistoryNodes(docId: string, ids: string[]): Promise<void> {
  const tx = (await db()).transaction('history', 'readwrite');
  await Promise.all([...ids.map((id) => tx.store.delete([docId, id])), tx.done]);
}

/**
 * 文書の現在のテキスト・headId と、新しく変わった履歴ノードを 1 つのトランザクションで書く（§8.5）。
 * 途中でクラッシュしても、テキストと履歴が食い違わない。
 *
 * existing を付けると、すでにある文書の保存として扱う。別のタブで完全に削除されていたら何も書かずに null を返し
 * （履歴のルートが無いまま作り直さない）、ゴミ箱に入れられていたらゴミ箱のまま書く（保存で復活させない）。
 * 書いた文書を返す。
 */
export async function saveDocAndNodes(
  doc: DocRecord,
  nodes: HistoryNode[],
  opts: { existing?: boolean } = {},
): Promise<DocRecord | null> {
  const tx = (await db()).transaction(['documents', 'history'], 'readwrite');
  const docs = tx.objectStore('documents');
  let rec = doc;
  if (opts.existing) {
    const prev = await docs.get(doc.id);
    if (!prev) {
      await tx.done;
      return null;
    }
    rec = { ...doc, deletedAt: prev.deletedAt };
  }
  const hs = tx.objectStore('history');
  await Promise.all([docs.put(rec), ...nodes.map((n) => hs.put(encodeNode(n))), tx.done]);
  return rec;
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
  const tx = (await db()).transaction(['documents', 'history', 'files', 'thumbs'], 'readwrite');
  const hs = tx.objectStore('history');
  const keys = await hs.index('byDoc').getAllKeys(id);
  await Promise.all([
    tx.objectStore('documents').delete(id),
    tx.objectStore('files').delete(id),
    tx.objectStore('thumbs').delete(id),
    ...keys.map((k) => hs.delete(k)),
    tx.done,
  ]);
}

export async function listThumbs(): Promise<Thumb[]> {
  return (await db()).getAll('thumbs');
}

export async function putThumb(t: Thumb): Promise<void> {
  await (await db()).put('thumbs', t);
}

export async function getFileBinding(docId: string): Promise<FileBinding | undefined> {
  return (await db()).get('files', docId);
}

export async function listFileBindings(): Promise<FileBinding[]> {
  return (await db()).getAll('files');
}

export async function putFileBinding(b: FileBinding): Promise<void> {
  await (await db()).put('files', b);
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
