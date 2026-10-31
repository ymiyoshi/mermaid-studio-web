import { create } from 'zustand';
import { showToast } from '../core/session';
import * as store from '../storage/db';
import { isAbortError } from './download';
import { importFromHandle } from './files';
import { findMermaidBlocks } from './markdown';
import { t } from '../i18n';

// 設計書 §17.9: フォルダを開く。リポジトリの docs/ などを開き、中の .mmd・.mermaid と、mermaid のブロックがある .md を
// 一覧に並べる。開くと、ふつうのファイルを開いたときと同じ結び付きができ、上書き保存は元のファイルに書く。
// フォルダのハンドルは IndexedDB に持ち、次に起動したときも一覧に出す（読む許可は、ボタンを押してもらって取り直す）。

export interface FolderFile {
  /** フォルダからの相対パス（/ 区切り） */
  path: string;
  handle: FileSystemFileHandle;
}

export interface FolderView {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  /** ready: 読めた / permission: 許可を取り直す必要がある / scanning: 読んでいる / error: 読めなかった */
  status: 'ready' | 'permission' | 'scanning' | 'error';
  files: FolderFile[];
  /** 数が多すぎて途中でやめた */
  truncated: boolean;
}

export const useFolders = create<{ folders: FolderView[] }>(() => ({ folders: [] }));

export const hasDirectoryAccess = () => typeof window !== 'undefined' && !!window.showDirectoryPicker;

/** 読まないフォルダ（大きいだけで図は無い） */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor']);
const MERMAID_FILE = /\.(mmd|mermaid)$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;
/** 一覧に出すファイルの上限と、たどる深さ */
const MAX_FILES = 500;
const MAX_DEPTH = 8;
/** これより大きい Markdown は、mermaid のブロックを探すために読まない（ログなどの巨大なファイルで固まらないように） */
const MAX_MARKDOWN_BYTES = 2_000_000;

const update = (id: string, patch: Partial<FolderView>) =>
  useFolders.setState((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

/** フォルダの中の図のファイルを集める（パスの順） */
export async function scanDirectory(dir: FileSystemDirectoryHandle): Promise<{ files: FolderFile[]; truncated: boolean }> {
  const files: FolderFile[] = [];
  let truncated = false;
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    const entries: (FileSystemFileHandle | FileSystemDirectoryHandle)[] = [];
    for await (const e of d.values()) entries.push(e);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const path = prefix + e.name;
      if (e.kind === 'directory') {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || depth >= MAX_DEPTH) continue;
        await walk(e as FileSystemDirectoryHandle, `${path}/`, depth + 1);
      } else if (MERMAID_FILE.test(e.name)) {
        files.push({ path, handle: e as FileSystemFileHandle });
      } else if (MARKDOWN_FILE.test(e.name)) {
        // Markdown は、mermaid のブロックがあるものだけ
        const file = await (e as FileSystemFileHandle).getFile();
        if (file.size > MAX_MARKDOWN_BYTES) continue;
        const text = await file.text();
        if (findMermaidBlocks(text).length > 0) files.push({ path, handle: e as FileSystemFileHandle });
      }
    }
  };
  await walk(dir, '', 0);
  return { files, truncated };
}

async function permitted(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  if (!ask || !handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** フォルダを読み直す。ask: 許可が無ければ尋ねる（ボタンを押したときだけ。ユーザーの操作の中でしか尋ねられない） */
export async function rescanFolder(id: string, ask = false) {
  const f = useFolders.getState().folders.find((x) => x.id === id);
  if (!f) return;
  try {
    if (!(await permitted(f.handle, ask))) return update(id, { status: 'permission' });
    update(id, { status: 'scanning' });
    const r = await scanDirectory(f.handle);
    update(id, { status: 'ready', ...r });
  } catch {
    update(id, { status: 'error', files: [] });
  }
}

/** 起動時: 前に開いたフォルダを一覧に出す（許可が残っていれば読む） */
export async function loadFolders() {
  const records = await store.listFolders();
  useFolders.setState({
    folders: records.map((r) => ({ id: r.id, name: r.name, handle: r.handle, status: 'permission', files: [], truncated: false })),
  });
  await Promise.all(records.map((r) => rescanFolder(r.id)));
}

/** フォルダを選んで開く。もう開いているフォルダなら読み直す */
export async function openFolder() {
  if (!hasDirectoryAccess()) return;
  try {
    const handle = await window.showDirectoryPicker!({ id: 'mermaid-studio-folder', mode: 'readwrite' });
    for (const f of useFolders.getState().folders) {
      if (await f.handle.isSameEntry(handle)) {
        // 保存してあるハンドルは許可が切れていることがあるので、いま選んだハンドルに置き換える
        update(f.id, { handle });
        await store.putFolder({ id: f.id, name: f.name, handle, addedAt: Date.now() });
        return rescanFolder(f.id);
      }
    }
    const rec: store.FolderRecord = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now() };
    await store.putFolder(rec);
    useFolders.setState((s) => ({ folders: [...s.folders, { id: rec.id, name: rec.name, handle, status: 'scanning', files: [], truncated: false }] }));
    await rescanFolder(rec.id);
  } catch (e) {
    if (!isAbortError(e)) showToast(t('file.error', { message: String((e as Error)?.message ?? e) }));
  }
}

/** フォルダを一覧から外す（ファイルには触れない。開いた図とファイルの結び付きも残す） */
export async function closeFolder(id: string) {
  await store.deleteFolder(id);
  useFolders.setState((s) => ({ folders: s.folders.filter((f) => f.id !== id) }));
}

/** フォルダの中のファイルを開く（もう開いていれば、その図を開く） */
export async function openFolderFile(file: FolderFile) {
  try {
    await importFromHandle(file.handle);
  } catch (e) {
    if (!isAbortError(e)) showToast(t('file.error', { message: String((e as Error)?.message ?? e) }));
  }
}
