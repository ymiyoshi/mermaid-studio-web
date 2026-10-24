import { ChangeSet } from '@codemirror/state';
import type { HistoryNode } from '../core/history';
import { flush, reloadDocList, showToast } from '../core/session';
import * as store from '../storage/db';
import type { DocRecord } from '../storage/db';
import { download, isAbortError, pickFileWithInput } from './download';
import { t } from '../i18n';

// 全図のバックアップ（履歴つき）。図はこのブラウザの IndexedDB にしか無いので、
// 別のブラウザへの移行や、ブラウザのデータ消去に備えて JSON に書き出せるようにする。

export const BACKUP_FORMAT = 'mermaid-studio-backup';
export const BACKUP_VERSION = 1;

export interface BackupEntry {
  doc: DocRecord;
  history: HistoryNode[];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  docs: BackupEntry[];
}

export function buildBackup(entries: BackupEntry[], now = Date.now()): BackupFile {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: now, docs: entries };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isSel = (v: unknown) => isObj(v) && Number.isInteger(v.anchor) && Number.isInteger(v.head);
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';

/** 1 つのノードの形（各項目の型）を確かめる */
function validNodeShape(n: unknown): n is HistoryNode {
  return (
    isObj(n) &&
    typeof n.id === 'string' &&
    isStrOrNull(n.parentId) &&
    Array.isArray(n.children) &&
    n.children.every((c) => typeof c === 'string') &&
    isStrOrNull(n.lastChild) &&
    Number.isInteger(n.depth) &&
    typeof n.label === 'string' &&
    typeof n.origin === 'string' &&
    isStrOrNull(n.groupKey) &&
    typeof n.ts === 'number' &&
    isSel(n.selBefore) &&
    isSel(n.selAfter) &&
    isStrOrNull(n.snapshot) &&
    'forward' in n &&
    'inverse' in n
  );
}

/**
 * 履歴がツリーとして正しいかを確かめる。バックアップは信頼できない入力なので、
 * 循環（開くと履歴のたどりが終わらずタブが固まる）や、適用できない変更を含むものは拒否する。
 * 条件: id が重複しない・ルートがちょうど 1 つ・親と子の対応が両側でそろう・すべてのノードがルートから届く・
 * 各ノードの forward / inverse が親と自分の長さに合う・スナップショットの長さが合う
 */
function validHistory(history: unknown[]): history is HistoryNode[] {
  if (!history.every(validNodeShape)) return false;
  const byId = new Map<string, HistoryNode>();
  for (const n of history) {
    if (byId.has(n.id)) return false;
    byId.set(n.id, n);
  }
  const roots = history.filter((n) => n.parentId === null);
  if (roots.length !== 1 || roots[0].snapshot === null) return false;
  for (const n of history) {
    if (n.parentId !== null && !byId.get(n.parentId)?.children.includes(n.id)) return false;
    if (new Set(n.children).size !== n.children.length) return false;
    if (n.children.some((c) => byId.get(c)?.parentId !== n.id)) return false;
    if (n.lastChild !== null && !n.children.includes(n.lastChild)) return false;
  }
  // ルートから幅優先にたどり、各ノードの文書の長さを求めながら変更を確かめる
  const lengths = new Map<string, number>([[roots[0].id, roots[0].snapshot!.length]]);
  const queue = [roots[0]];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    const parentLen = lengths.get(parent.id)!;
    for (const id of parent.children) {
      const n = byId.get(id)!;
      let fwd: ChangeSet, inv: ChangeSet;
      try {
        fwd = ChangeSet.fromJSON(n.forward);
        inv = ChangeSet.fromJSON(n.inverse);
      } catch {
        return false;
      }
      if (fwd.length !== parentLen || inv.length !== fwd.newLength || inv.newLength !== parentLen) return false;
      if (n.snapshot !== null && n.snapshot.length !== fwd.newLength) return false;
      lengths.set(n.id, fwd.newLength);
      queue.push(n);
    }
  }
  // 親子の対応がそろっていても、ルートから切り離された循環は届かない
  return lengths.size === history.length;
}

function validEntry(e: unknown): e is BackupEntry {
  if (!isObj(e) || !isObj(e.doc) || !Array.isArray(e.history)) return false;
  const d = e.doc;
  if (typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.text !== 'string') return false;
  if (typeof d.createdAt !== 'number' || typeof d.updatedAt !== 'number') return false;
  return validHistory(e.history);
}

/** JSON を読み、形式を確かめる。不正なら Error を投げる */
export function parseBackup(json: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(t('backup.invalid'));
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT || !Array.isArray(data.docs)) throw new Error(t('backup.invalid'));
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) throw new Error(t('backup.newer'));
  if (!data.docs.every(validEntry)) throw new Error(t('backup.invalid'));
  return data as unknown as BackupFile;
}

/**
 * 復元する図に新しい docId を振る（既存の図を上書きしないため）。
 * 履歴ノードの id は docId と組で一意なのでそのまま使える。
 */
export function remapEntry(entry: BackupEntry, newId: string): BackupEntry {
  const history = entry.history.map((n) => ({ ...n, docId: newId }));
  const root = history.find((n) => n.parentId === null);
  const headOk = history.some((n) => n.id === entry.doc.headId);
  return {
    doc: {
      ...entry.doc,
      id: newId,
      headId: headOk ? entry.doc.headId : (root?.id ?? entry.doc.headId),
      deletedAt: null,
      tags: Array.isArray(entry.doc.tags) ? entry.doc.tags.filter((x) => typeof x === 'string') : [],
    },
    history,
  };
}

export async function exportBackup() {
  await flush();
  const docs = (await store.listDocs()).filter((d) => d.deletedAt === null);
  const entries = await Promise.all(docs.map(async (doc) => ({ doc, history: await store.loadHistory(doc.id) })));
  const json = JSON.stringify(buildBackup(entries));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  download(new Blob([json], { type: 'application/json' }), `mermaid-studio-backup-${date}.json`);
  showToast(t('backup.exported', { n: String(entries.length) }));
}

export async function importBackup() {
  try {
    const file = await pickFileWithInput('.json,application/json');
    if (file) await importBackupFile(file);
  } catch (e) {
    if (!isAbortError(e)) showToast(String((e as Error)?.message ?? e));
  }
}

export async function importBackupFile(file: File) {
  try {
    const backup = parseBackup(await file.text());
    for (const entry of backup.docs) {
      const { doc, history } = remapEntry(entry, crypto.randomUUID());
      await store.saveDocAndNodes(doc, history);
    }
    await reloadDocList();
    showToast(t('backup.imported', { n: String(backup.docs.length) }));
  } catch (e) {
    showToast(String((e as Error)?.message ?? e));
  }
}
