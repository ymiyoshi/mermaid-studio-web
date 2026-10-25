import { HistoryTree, type Sel } from './history';
import { TEMPLATES } from './templates';
import type { Theme } from '../render/mermaid';
import * as store from '../storage/db';
import { acquireDocLock, broadcast, onBroadcast, type DocLock } from '../storage/tabLock';
import { get, set, type CurrentDoc } from './state';
import { editorBus } from './editorBus';
import { flush, upsertDoc } from './persistence';
import { refreshStorageInfo } from './notify';
import { normalize, toText } from './editing';
import { t } from '../i18n';

// 図（文書）の管理: 開く・作る・複製・ゴミ箱、複数タブの書き込み権、アプリの起動。

/** 開いている図の書き込み権（§8.5） */
let currentLock: DocLock | null = null;

function emitReset(cur: CurrentDoc, selection: Sel) {
  editorBus.emit({ type: 'reset', text: cur.text.toString(), selection, readOnly: cur.readOnly });
}

async function loadDoc(id: string, readOnly: boolean): Promise<CurrentDoc | null> {
  const rec = await store.getDoc(id);
  if (!rec) return null;
  const [nodes, file] = await Promise.all([store.loadHistory(id), store.getFileBinding(id)]);
  const tree =
    nodes.length > 0 ? HistoryTree.load(id, nodes, rec.headId) : HistoryTree.create(id, rec.text, rec.createdAt);
  return {
    id,
    title: rec.title,
    text: toText(rec.text),
    tree,
    readOnly,
    createdAt: rec.createdAt,
    tags: rec.tags,
    file: file ?? null,
  };
}

/** 読み込んだ図を現在の図にして、エディタを作り直す */
function show(cur: CurrentDoc) {
  const selection = cur.tree.head.selAfter;
  set({ current: cur, selection, rev: get().rev + 1 });
  emitReset(cur, selection);
}

/** 図を開く処理は 1 本ずつ順に走らせる（重なると、書き込み権を取ったまま手放さない図ができる） */
let opening: Promise<void> = Promise.resolve();

export function openDoc(id: string): Promise<void> {
  const run = opening.then(() => openDocNow(id));
  opening = run.catch(() => {});
  return run;
}

async function openDocNow(id: string): Promise<void> {
  // 今開いている図なら何もしない。書き込み権を手放してすぐ取り直すと、ブラウザによっては取れずに読み取り専用になる
  if (get().current?.id === id && currentLock) return;
  // 保存に失敗したら今の図に留まる。切り替えると、未保存の変更（履歴）がメモリから消えて失われる
  if (!(await flush())) return;
  currentLock?.release();
  currentLock = null;

  const lock = await acquireDocLock(id);
  const cur = await loadDoc(id, !lock.acquired);
  if (!cur) {
    lock.release();
    return;
  }
  currentLock = lock;
  show(cur);
  void store.putSetting('lastOpened', id);

  if (!lock.acquired) {
    // 別タブが閉じて書き込み権が空いたら、最新の内容で編集可能にする
    void lock.whenAcquired.then(() => {
      if (currentLock === lock && get().current?.id === id) void reloadCurrent(false);
    });
  }
}

async function reloadCurrent(readOnly: boolean) {
  const id = get().current?.id;
  if (!id) return;
  const cur = await loadDoc(id, readOnly);
  if (cur) show(cur);
}

export async function createDoc(text: string, title: string, label = t('history.create')): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const normalized = normalize(text);
  const tree = HistoryTree.create(id, normalized, now, label);
  const rec: store.DocRecord = {
    id,
    title,
    text: normalized,
    headId: tree.headId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    tags: [],
  };
  await store.saveDocAndNodes(rec, tree.takeDirty());
  set({ docs: upsertDoc(get().docs, rec) });
  broadcast({ type: 'docs-changed' });
  await openDoc(id);
  return id;
}

export async function createFromTemplate(templateId: string) {
  const tpl = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0];
  await createDoc(tpl.text, tpl.id === 'blank' ? t('doc.untitled') : tpl.name);
}

export async function duplicateDoc(id: string) {
  await flush();
  const rec = await store.getDoc(id);
  if (rec) await createDoc(rec.text, rec.title + t('doc.copySuffix'));
}

/** 履歴の任意の版を新しい図として複製する（§8.4） */
export async function duplicateFromHistory(nodeId: string) {
  const cur = get().current;
  if (!cur) return;
  await createDoc(cur.tree.textAt(nodeId), cur.title + t('doc.copySuffix'));
}

/** 現在の図にローカルファイルを結び付ける（保存・読み込みの後に呼ぶ） */
export async function setFileBinding(file: store.FileBinding) {
  await store.putFileBinding(file);
  const cur = get().current;
  if (cur && cur.id === file.docId) set({ current: { ...cur, file } });
}

/** IndexedDB に直接書き込んだ後（バックアップの復元など）に一覧を読み直す */
export async function reloadDocList() {
  set({ docs: await store.listDocs() });
  broadcast({ type: 'docs-changed' });
}

/** 一覧の文書を 1 件差し替えて、他のタブにも知らせる */
function replaceInList(rec: store.DocRecord) {
  set({ docs: get().docs.map((d) => (d.id === rec.id ? rec : d)) });
  broadcast({ type: 'docs-changed' });
}

export async function trashDoc(id: string) {
  if (get().current?.id === id) await flush();
  const rec = await store.updateDocMeta(id, { deletedAt: Date.now() });
  if (!rec) return;
  replaceInList(rec);
  if (get().current?.id === id) {
    currentLock?.release();
    currentLock = null;
    set({ current: null });
    const next = get().docs.find((d) => d.deletedAt === null);
    if (next) await openDoc(next.id);
    else await createFromTemplate('flowchart');
  }
}

export async function restoreDoc(id: string) {
  const rec = await store.updateDocMeta(id, { deletedAt: null });
  if (rec) replaceInList(rec);
}

export async function purgeDoc(id: string) {
  await store.purgeDoc(id);
  set({ docs: get().docs.filter((d) => d.id !== id) });
  broadcast({ type: 'docs-changed' });
}

export function setTheme(theme: Theme) {
  set({ theme });
  void store.putSetting('theme', theme);
}

// ---- 起動 ---------------------------------------------------------------

/** 最後に開いていた図を開く。無ければ見本のフローチャートを作る */
export async function openInitialDoc() {
  const lastOpened = await store.getSetting<string>('lastOpened');
  const alive = get().docs.filter((d) => d.deletedAt === null);
  const target = alive.find((d) => d.id === lastOpened) ?? alive[0];
  if (target) await openDoc(target.id);
  else await createFromTemplate('flowchart');
}

/**
 * skipInitialDoc が true になったら、最初の図を開かない（OS から渡されたファイルを開いて起動したとき。
 * 前回の図や見本の図を開いてから、すぐ別の図に切り替えることになるため）
 */
export async function init(opts: { skipInitialDoc?: Promise<boolean> } = {}) {
  // 無制限の履歴を保つため、永続ストレージを要求する（§8.5）
  await navigator.storage?.persist?.().catch(() => false);
  await store.purgeExpiredTrash();

  const theme = (await store.getSetting<Theme>('theme')) ?? 'default';
  const docs = await store.listDocs();
  set({ docs, theme });

  if (!(await opts.skipInitialDoc)) await openInitialDoc();

  onBroadcast(async (msg) => {
    if (msg.type === 'docs-changed' || msg.type === 'saved') set({ docs: await store.listDocs() });
    const cur = get().current;
    if (msg.type === 'saved' && cur && cur.readOnly && msg.docId === cur.id) await reloadCurrent(true);
  });

  const flushNow = () => void flush();
  addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  set({ ready: true });
  void refreshStorageInfo();
}
