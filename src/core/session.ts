import { create } from 'zustand';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import { HistoryTree, type Origin, type Sel } from './history';
import { describeTyping, shouldCoalesce, typingGroupKey } from './coalesce';
import { TEMPLATES } from './templates';
import { validate, type Theme } from '../render/mermaid';
import * as store from '../storage/db';
import { acquireDocLock, broadcast, onBroadcast, type DocLock } from '../storage/tabLock';
import { t } from '../i18n';

// 設計書 §3: テキストが唯一の正。テキスト入力も図の操作もすべて ChangeSet になり、
// applyChanges() という 1 本の経路で「適用 → 履歴に記録 → 保存の予約」される。

export interface CurrentDoc {
  id: string;
  title: string;
  text: Text;
  tree: HistoryTree;
  readOnly: boolean;
  createdAt: number;
  tags: string[];
  /** 結び付いたローカルファイル（§9.3） */
  file: store.FileBinding | null;
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

interface State {
  ready: boolean;
  docs: store.DocRecord[];
  current: CurrentDoc | null;
  /** 文書か履歴が変わるたびに増える（履歴ビューの再描画用） */
  rev: number;
  selection: Sel;
  theme: Theme;
  storage: StorageInfo | null;
  toast: { id: number; message: string } | null;
}

export const useSession = create<State>(() => ({
  ready: false,
  docs: [],
  current: null,
  rev: 0,
  selection: { anchor: 0, head: 0 },
  theme: 'default',
  storage: null,
  toast: null,
}));

const get = useSession.getState;
const set = useSession.setState;

// ---- エディタへの通知 ----------------------------------------------------

export type EditorEvent =
  | { type: 'reset'; text: string; selection: Sel; readOnly: boolean }
  | { type: 'apply'; changes: ChangeSet; selection: Sel }
  | { type: 'select'; selection: Sel; scroll: boolean };

const editorListeners = new Set<(e: EditorEvent) => void>();

export const editorBus = {
  on(fn: (e: EditorEvent) => void) {
    editorListeners.add(fn);
    return () => editorListeners.delete(fn);
  },
  emit(e: EditorEvent) {
    editorListeners.forEach((fn) => fn(e));
  },
};

function emitReset(cur: CurrentDoc, selection: Sel) {
  editorBus.emit({ type: 'reset', text: cur.text.toString(), selection, readOnly: cur.readOnly });
}

// ---- 変更の適用 ----------------------------------------------------------

// エディタが IME 変換中の変更をためている場合、履歴を動かす前に確定させる。
// そうしないと、ためた変更と履歴のステップが別々の文書を前提にしてしまう。
let flushEditor: (() => void) | null = null;

export function registerEditorFlush(fn: (() => void) | null) {
  flushEditor = fn;
}

export interface ApplyMeta {
  origin: Origin;
  label?: string;
  groupKey?: string | null;
  selBefore?: Sel;
  selAfter?: Sel;
  /** エディタ自身の変更なら true（エディタへ送り返さない） */
  fromEditor?: boolean;
  ts?: number;
}

export const normalize = (s: string) => s.replace(/\r\n?/g, '\n');
const toText = (s: string) => Text.of(normalize(s).split('\n'));

function mapSel(sel: Sel, changes: ChangeSet): Sel {
  return { anchor: changes.mapPos(sel.anchor, 1), head: changes.mapPos(sel.head, 1) };
}

export function applyChanges(changes: ChangeSet, meta: ApplyMeta): boolean {
  const cur = get().current;
  if (!cur || cur.readOnly || changes.empty) return false;
  const ts = meta.ts ?? Date.now();
  const docBefore = cur.text;
  const selBefore = meta.selBefore ?? get().selection;
  const selAfter = meta.selAfter ?? mapSel(selBefore, changes);
  const groupKey = meta.origin === 'typing' ? typingGroupKey(changes) : (meta.groupKey ?? null);

  const coalesce = shouldCoalesce(cur.tree.head, {
    origin: meta.origin,
    groupKey,
    changes,
    docBefore,
    selBefore,
    ts,
  });
  const label =
    meta.label ?? (meta.origin === 'paste' ? t('history.paste') : meta.origin === 'typing' ? '' : t('history.edit'));
  const node = cur.tree.commit(changes, docBefore, {
    origin: meta.origin,
    label,
    groupKey,
    selBefore,
    selAfter,
    ts,
    coalesce,
  });
  if (meta.origin === 'typing') node.label = describeTyping(ChangeSet.fromJSON(node.forward));

  set({ current: { ...cur, text: changes.apply(docBefore) }, selection: selAfter, rev: get().rev + 1 });
  if (!meta.fromEditor) editorBus.emit({ type: 'apply', changes, selection: selAfter });
  schedulePersist();
  return true;
}

/**
 * 図からの操作。コミット前に mermaid.parse で検証し、通ったときだけ適用する（§6.2）。
 * 失敗した操作は履歴に残らない。
 */
export async function applyDiagramChange(
  spec: ChangeSpec,
  meta: { label: string; groupKey?: string | null; selAfter?: Sel },
): Promise<'ok' | 'invalid' | 'stale'> {
  flushEditor?.();
  const cur = get().current;
  if (!cur || cur.readOnly) return 'stale';
  const base = cur.text;
  const changes = ChangeSet.of(spec, base.length);
  const r = await validate(changes.apply(base).toString());
  if (!r.ok) return 'invalid';
  // 検証中に文書が変わっていたら適用しない
  if (get().current?.text !== base) return 'stale';
  applyChanges(changes, { origin: 'diagram-op', ...meta });
  return 'ok';
}

function moveHistory(step: { changes: ChangeSet; selection: Sel } | null) {
  const cur = get().current;
  if (!cur || !step) return;
  const text = step.changes.apply(cur.text);
  set({ current: { ...cur, text }, selection: step.selection, rev: get().rev + 1 });
  editorBus.emit({ type: 'apply', changes: step.changes, selection: step.selection });
  schedulePersist();
}

export function undo() {
  flushEditor?.();
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  moveHistory(cur.tree.undo());
}

export function redo() {
  flushEditor?.();
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  moveHistory(cur.tree.redo());
}

export function jumpTo(nodeId: string) {
  flushEditor?.();
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  moveHistory(cur.tree.jumpTo(nodeId, cur.text));
}

/** 図のタグを変える（§9.2） */
export function setTags(tags: string[]) {
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  const clean = [...new Set(tags.map((x) => x.trim().replace(/^#/, '')).filter(Boolean))];
  set({ current: { ...cur, tags: clean } });
  schedulePersist();
}

/** 履歴のノードを名前付きチェックポイントにする */
export function nameCheckpoint(nodeId: string, name: string) {
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  cur.tree.setName(nodeId, name);
  set({ rev: get().rev + 1 });
  schedulePersist();
}

/** 今の版に至らない分岐を消す。消したステップの数を返す */
export async function pruneBranches(): Promise<number> {
  const cur = get().current;
  if (!cur || cur.readOnly) return 0;
  await flush();
  const removed = cur.tree.pruneBranches();
  if (removed.length === 0) return 0;
  await store.deleteHistoryNodes(cur.id, removed);
  set({ rev: get().rev + 1 });
  schedulePersist();
  return removed.length;
}

export function setSelection(selection: Sel) {
  const s = get().selection;
  if (s.anchor !== selection.anchor || s.head !== selection.head) set({ selection });
}

/** 図で選んだ要素のソース範囲をエディタで選択する */
export function revealRange(from: number, to: number) {
  const selection = { anchor: from, head: to };
  set({ selection });
  editorBus.emit({ type: 'select', selection, scroll: true });
}

// ---- 保存 ---------------------------------------------------------------

const PERSIST_DELAY_MS = 300;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let docDirty = false;

function schedulePersist() {
  docDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => void flush(), PERSIST_DELAY_MS);
}

export async function flush(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const cur = get().current;
  if (!cur || cur.readOnly || (!docDirty && cur.tree.dirty.size === 0)) return;
  docDirty = false;
  const nodes = cur.tree.takeDirty();
  const record: store.DocRecord = {
    id: cur.id,
    title: cur.title,
    text: cur.text.toString(),
    headId: cur.tree.headId,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
    deletedAt: null,
    tags: cur.tags,
  };
  try {
    await store.saveDocAndNodes(record, nodes);
    set({ docs: upsertDoc(get().docs, record) });
    broadcast({ type: 'saved', docId: cur.id });
  } catch (e) {
    // 次回の保存で再試行する
    nodes.forEach((n) => cur.tree.dirty.add(n.id));
    docDirty = true;
    showToast(String((e as Error)?.message ?? e));
  }
  void refreshStorageInfo();
}

function upsertDoc(docs: store.DocRecord[], d: store.DocRecord): store.DocRecord[] {
  return [d, ...docs.filter((x) => x.id !== d.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---- 文書の管理 -----------------------------------------------------------

let currentLock: DocLock | null = null;

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

export async function openDoc(id: string): Promise<void> {
  await flush();
  currentLock?.release();
  currentLock = null;

  const lock = await acquireDocLock(id);
  const cur = await loadDoc(id, !lock.acquired);
  if (!cur) {
    lock.release();
    return;
  }
  currentLock = lock;
  const selection = cur.tree.head.selAfter;
  set({ current: cur, selection, rev: get().rev + 1 });
  emitReset(cur, selection);
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
  if (!cur) return;
  const selection = cur.tree.head.selAfter;
  set({ current: cur, selection, rev: get().rev + 1 });
  emitReset(cur, selection);
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

export async function renameCurrent(title: string) {
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  set({ current: { ...cur, title } });
  schedulePersist();
}

export async function trashDoc(id: string) {
  if (get().current?.id === id) await flush();
  const rec = await store.updateDocMeta(id, { deletedAt: Date.now() });
  if (!rec) return;
  set({ docs: get().docs.map((d) => (d.id === id ? rec : d)) });
  broadcast({ type: 'docs-changed' });
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
  if (!rec) return;
  set({ docs: get().docs.map((d) => (d.id === id ? rec : d)) });
  broadcast({ type: 'docs-changed' });
}

export async function purgeDoc(id: string) {
  await store.purgeDoc(id);
  set({ docs: get().docs.filter((d) => d.id !== id) });
  broadcast({ type: 'docs-changed' });
}

// ---- 設定・通知 -----------------------------------------------------------

export function setTheme(theme: Theme) {
  set({ theme });
  void store.putSetting('theme', theme);
}

let toastSeq = 0;
export function showToast(message: string) {
  const id = ++toastSeq;
  set({ toast: { id, message } });
  setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, 4000);
}

const STORAGE_WARN_RATIO = 0.8;
let storageWarned = false;

async function refreshStorageInfo() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
  const info = { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  set({ storage: info });
  if (!storageWarned && info.quota > 0 && info.usage / info.quota > STORAGE_WARN_RATIO) {
    storageWarned = true;
    showToast(t('storage.warn', { pct: String(Math.round((info.usage / info.quota) * 100)) }));
  }
}

// ---- 起動 ---------------------------------------------------------------

export async function init() {
  // 無制限の履歴を保つため、永続ストレージを要求する（§8.5）
  await navigator.storage?.persist?.().catch(() => false);
  await store.purgeExpiredTrash();

  const theme = (await store.getSetting<Theme>('theme')) ?? 'default';
  const docs = await store.listDocs();
  set({ docs, theme });

  const lastOpened = await store.getSetting<string>('lastOpened');
  const alive = docs.filter((d) => d.deletedAt === null);
  const target = alive.find((d) => d.id === lastOpened) ?? alive[0];
  if (target) await openDoc(target.id);
  else await createFromTemplate('flowchart');

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
