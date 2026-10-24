import { minimalReplace } from '../core/history';
import { applyChanges, createDoc, normalize, openDoc, openInitialDoc, setFileBinding, showToast, useSession } from '../core/session';
import * as store from '../storage/db';
import type { FileBinding } from '../storage/db';
import { findMermaidBlocks, replaceMermaidBlock, wrapAsMarkdown } from './markdown';
import { download, isAbortError, pickFileWithInput, safeFileName } from './download';
import { useIo } from './ioStore';
import { importBackupFile } from './backup';
import { t } from '../i18n';

// 設計書 §9.3: ローカルファイルの読み書き。
// Chromium 系は File System Access API で上書き保存まで行い、それ以外はアップロードとダウンロードで代用する。

const ACCEPT = '.mmd,.mermaid,.md,.markdown,.txt';
const PICKER_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Mermaid / Markdown',
    accept: { 'text/plain': ['.mmd', '.mermaid', '.md', '.markdown', '.txt'] },
  },
];

export const hasFileSystemAccess = () =>
  typeof window !== 'undefined' && !!window.showOpenFilePicker && !!window.showSaveFilePicker;

const kindOf = (name: string): FileBinding['kind'] => (/\.(md|markdown)$/i.test(name) ? 'markdown' : 'mermaid');
const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

function reportError(e: unknown) {
  if (isAbortError(e)) return;
  showToast(t('file.error', { message: String((e as Error)?.message ?? e) }));
}

async function ensurePermission(handle: FileSystemFileHandle, mode: 'read' | 'readwrite', ask: boolean) {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  if (!ask || !handle.requestPermission) return false;
  return (await handle.requestPermission({ mode })) === 'granted';
}

/** Markdown のどの mermaid ブロックを開くか。1 つならそれ、複数なら選んでもらう */
function chooseBlock(name: string, md: string): Promise<number | null> {
  const blocks = findMermaidBlocks(md);
  if (blocks.length === 0) {
    showToast(t('file.noBlock', { name }));
    return Promise.resolve(null);
  }
  if (blocks.length === 1) return Promise.resolve(0);
  return new Promise((resolve) =>
    useIo.setState({
      blockPicker: {
        name,
        blocks,
        resolve(index) {
          useIo.setState({ blockPicker: null });
          resolve(index);
        },
      },
    }),
  );
}

/** ファイルの中身から図のテキストを取り出す。Markdown なら blockIndex 番目のブロック */
function extract(binding: Pick<FileBinding, 'kind' | 'blockIndex'>, content: string): string | null {
  if (binding.kind === 'mermaid') return normalize(content);
  const block = findMermaidBlocks(content)[binding.blockIndex];
  return block ? normalize(block.text) : null;
}

// ---- 読み込み -------------------------------------------------------------

export async function openFile() {
  try {
    if (hasFileSystemAccess()) {
      const [handle] = await window.showOpenFilePicker!({ types: PICKER_TYPES, id: 'mermaid-studio' });
      await importFromHandle(handle);
    } else {
      const file = await pickFileWithInput(ACCEPT);
      if (file) await importFile(file, null);
    }
  } catch (e) {
    reportError(e);
  }
}

/** ファイルを開く処理は 1 本ずつ順に走らせる（同じファイルを続けて開いたときに、図が 2 つできないように） */
let importing: Promise<void> = Promise.resolve();

export function importFromHandle(handle: FileSystemFileHandle): Promise<void> {
  const run = importing.then(() => importFromHandleNow(handle));
  importing = run.catch(() => {});
  return run;
}

async function importFromHandleNow(handle: FileSystemFileHandle) {
  // 同じファイルを既に開いていれば、その図を開く（履歴を引き継ぐ）
  const docs = useSession.getState().docs;
  for (const b of await store.listFileBindings()) {
    if (!b.handle || !docs.some((d) => d.id === b.docId && d.deletedAt === null)) continue;
    if (await b.handle.isSameEntry(handle)) {
      await openDoc(b.docId);
      // いま渡されたハンドルに置き換える（保存してあるハンドルは、再起動の後などに許可が切れていることがある）
      if (b.handle !== handle && useSession.getState().current?.id === b.docId) await setFileBinding({ ...b, handle });
      await checkExternalChange(true);
      return;
    }
  }
  await importFile(await handle.getFile(), handle);
}

export async function importFile(file: File, handle: FileSystemFileHandle | null) {
  if (/\.json$/i.test(file.name)) return importBackupFile(file);
  const raw = await file.text();
  const kind = kindOf(file.name);
  const blockIndex = kind === 'markdown' ? await chooseBlock(file.name, raw) : 0;
  if (blockIndex === null) return;
  const text = extract({ kind, blockIndex }, raw)!;
  const multiple = kind === 'markdown' && findMermaidBlocks(raw).length > 1;
  const title = baseName(file.name) + (multiple ? ` #${blockIndex + 1}` : '');
  const docId = await createDoc(text, title, t('history.fileLoad'));
  await setFileBinding({
    docId,
    name: file.name,
    kind,
    blockIndex,
    handle,
    lastModified: file.lastModified,
    savedText: text,
    markdown: handle === null && kind === 'markdown' ? raw : null,
  });
}

/** OS から渡されたファイルを、順に開く（フォルダは無視する） */
export async function openLaunchedFiles(files: readonly FileSystemHandle[]) {
  for (const handle of files) {
    if (handle.kind !== 'file') continue;
    try {
      await importFromHandle(handle as FileSystemFileHandle);
    } catch (e) {
      reportError(e);
    }
  }
}

/**
 * OS から渡されたファイルを開く（PWA のファイルの関連付け。manifest の file_handlers）。
 * アプリとしてインストールした Chromium 系で、.mmd / .mermaid をこのアプリで開いたときに渡される。
 * 起動処理より前に呼ぶ（起動処理が途中で失敗しても、受け取りは止めない）。ファイルは ready（起動処理の完了）の後に開く。
 * 返り値: 起動時にファイルを渡されたか（渡されたなら、起動処理は最初の図を開かない）
 */
export function watchLaunchFiles(ready: Promise<void>): Promise<boolean> {
  const queue = window.launchQueue;
  if (!queue) return Promise.resolve(false);
  let launched!: (v: boolean) => void;
  const result = new Promise<boolean>((r) => (launched = r));
  queue.setConsumer((params) => {
    const files = params.files.filter((h) => h.kind === 'file');
    launched(files.length > 0);
    void ready.then(async () => {
      await openLaunchedFiles(files);
      // 起動時に渡されたファイルを 1 つも開けなかったら（読めなかったなど）、いつもの最初の図を開く
      if (!useSession.getState().current) await openInitialDoc();
    });
  });
  // 起動時のファイルは setConsumer の直後に渡される。アプリとして起動したときだけ少し待つ（ブラウザのタブでは待たない）
  const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  setTimeout(() => launched(false), standalone ? 100 : 0);
  return result;
}
/** ドラッグ＆ドロップで読み込む。getAsFileSystemHandle はイベント中に同期的に呼ぶ必要がある */
export function importFromDrop(e: DragEvent) {
  const item = [...(e.dataTransfer?.items ?? [])].find((i) => i.kind === 'file');
  if (!item) return;
  const file = item.getAsFile();
  const handlePromise = (item.getAsFileSystemHandle?.() ?? Promise.resolve(null)).catch(() => null);
  void (async () => {
    try {
      const handle = await handlePromise;
      if (handle && handle.kind === 'file' && !/\.json$/i.test(handle.name)) {
        await importFromHandle(handle as FileSystemFileHandle);
      } else if (file) {
        await importFile(file, null);
      }
    } catch (err) {
      reportError(err);
    }
  })();
}

// ---- 保存 ---------------------------------------------------------------

/** 保存先が無い・別名で保存・ハンドルが使えない場合は保存先を選んでもらう */
export async function saveFile(opts: { saveAs?: boolean; force?: boolean } = {}) {
  const cur = useSession.getState().current;
  if (!cur) return;
  const text = cur.text.toString();
  try {
    if (!hasFileSystemAccess()) return saveByDownload(cur.id, cur.title, text, cur.file);

    let binding = cur.file;
    let content: string;
    if (!binding?.handle || opts.saveAs) {
      const suggestedName = binding?.name ?? `${safeFileName(cur.title)}.mmd`;
      const handle = await window.showSaveFilePicker!({ suggestedName, types: PICKER_TYPES, id: 'mermaid-studio' });
      const kind = kindOf(handle.name);
      // Markdown から読み込んだ図なら、同じ番号のブロックを差し替える
      const preferred = binding?.kind === 'markdown' ? binding.blockIndex : 0;
      const md = kind === 'markdown' ? markdownWithDiagram(await (await handle.getFile()).text(), text, preferred) : null;
      binding = {
        docId: cur.id,
        name: handle.name,
        kind,
        blockIndex: md?.blockIndex ?? 0,
        handle,
        lastModified: 0,
        savedText: '',
        markdown: null,
      };
      content = md ? md.content : text;
    } else {
      const handle = binding.handle;
      if (!(await ensurePermission(handle, 'readwrite', true))) return showToast(t('file.permission'));
      const file = await handle.getFile();
      if (!opts.force && file.lastModified > binding.lastModified) {
        // 外部で変更されている: 上書きしてよいか確認する
        useIo.setState({ conflict: { docId: cur.id, name: binding.name, localChanges: true } });
        return;
      }
      if (binding.kind === 'markdown') {
        const replaced = replaceMermaidBlock(await file.text(), binding.blockIndex, text);
        if (replaced === null) return showToast(t('file.blockMissing', { name: binding.name }));
        content = replaced;
      } else {
        content = text;
      }
    }

    const writable = await binding.handle!.createWritable();
    await writable.write(content);
    await writable.close();
    const written = await binding.handle!.getFile();
    await setFileBinding({ ...binding, lastModified: written.lastModified, savedText: text });
    useIo.setState({ conflict: null });
    showToast(t('file.saved', { name: binding.name }));
  } catch (e) {
    reportError(e);
  }
}

/**
 * 既存の .md を保存先に選んだ場合は、preferred 番目（無ければ最初）の mermaid ブロックを差し替える。
 * mermaid ブロックが 1 つも無ければ末尾に足す。Markdown の他の部分は消さない
 */
export function markdownWithDiagram(existing: string, text: string, preferred: number) {
  if (existing.trim() === '') return { content: wrapAsMarkdown(text), blockIndex: 0 };
  const count = findMermaidBlocks(existing).length;
  if (count > 0) {
    const blockIndex = preferred < count ? preferred : 0;
    return { content: replaceMermaidBlock(existing, blockIndex, text)!, blockIndex };
  }
  return { content: existing.replace(/\n*$/, '\n\n') + wrapAsMarkdown(text), blockIndex: 0 };
}

async function saveByDownload(docId: string, title: string, text: string, binding: FileBinding | null) {
  const isMd = binding?.kind === 'markdown' && binding.markdown !== null;
  const content = isMd ? (replaceMermaidBlock(binding!.markdown!, binding!.blockIndex, text) ?? wrapAsMarkdown(text)) : text;
  const name = binding?.name ?? `${safeFileName(title)}.mmd`;
  download(new Blob([content], { type: 'text/plain;charset=utf-8' }), name);
  await setFileBinding({
    docId,
    name,
    kind: binding?.kind ?? 'mermaid',
    blockIndex: binding?.blockIndex ?? 0,
    handle: null,
    lastModified: Date.now(),
    savedText: text,
    markdown: isMd ? content : null,
  });
}

// ---- 外部での変更 ---------------------------------------------------------

/**
 * 結び付いたファイルが外部で変更されていないか調べる（ウィンドウにフォーカスが戻ったときなど）。
 * 未保存の変更が無ければ黙って読み込み直し、あれば確認のバナーを出す。
 */
export async function checkExternalChange(ask = false) {
  const cur = useSession.getState().current;
  const b = cur?.file;
  if (!cur || !b?.handle || cur.readOnly) return;
  try {
    if (!(await ensurePermission(b.handle, 'read', ask))) return;
    const file = await b.handle.getFile();
    if (file.lastModified <= b.lastModified) return;
    const localChanges = cur.text.toString() !== b.savedText;
    if (localChanges) useIo.setState({ conflict: { docId: cur.id, name: b.name, localChanges } });
    else await reloadFromFile();
  } catch {
    // ファイルが移動・削除された場合など。結び付きはそのまま残す
  }
}

/** ファイルの内容で図を置き換える。履歴上は 1 ステップ（origin: file-load） */
export async function reloadFromFile() {
  const cur = useSession.getState().current;
  const b = cur?.file;
  if (!cur || !b?.handle) return;
  try {
    if (!(await ensurePermission(b.handle, 'read', true))) return showToast(t('file.permission'));
    const file = await b.handle.getFile();
    const text = extract(b, await file.text());
    if (text === null) return showToast(t('file.blockMissing', { name: b.name }));
    applyChanges(minimalReplace(cur.text, text), { origin: 'file-load', label: t('history.fileReload', { name: b.name }) });
    await setFileBinding({ ...b, lastModified: file.lastModified, savedText: text });
    useIo.setState({ conflict: null });
  } catch (e) {
    reportError(e);
  }
}

/** 外部での変更を無視する（次に保存するまで確認しない） */
export async function ignoreExternalChange() {
  const b = useSession.getState().current?.file;
  useIo.setState({ conflict: null });
  if (!b?.handle) return;
  const file = await b.handle.getFile().catch(() => null);
  if (file) await setFileBinding({ ...b, lastModified: file.lastModified });
}
