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

function validEntry(e: unknown): e is BackupEntry {
  if (!isObj(e) || !isObj(e.doc) || !Array.isArray(e.history)) return false;
  const d = e.doc;
  if (typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.text !== 'string') return false;
  return e.history.every(
    (n) => isObj(n) && typeof n.id === 'string' && (n.parentId === null || typeof n.parentId === 'string') && 'forward' in n && 'inverse' in n,
  );
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
      tags: Array.isArray(entry.doc.tags) ? entry.doc.tags : [],
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
