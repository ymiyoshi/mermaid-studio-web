import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import type { HistoryNode, Origin, Sel } from './history';
import { describeTyping, shouldCoalesce, typingGroupKey } from './coalesce';
import { validate } from '../render/mermaid';
import * as store from '../storage/db';
import { get, set } from './state';
import { editorBus, flushPendingEditor } from './editorBus';
import { flush, schedulePersist } from './persistence';
import { t } from '../i18n';

// 設計書 §3: テキストが唯一の正。テキスト入力も図の操作もすべて ChangeSet になり、
// applyChanges() という 1 本の経路で「適用 → 履歴に記録 → 保存の予約」される。

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
export const toText = (s: string) => Text.of(normalize(s).split('\n'));

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
  // 入力の groupKey は変更の種類から決める。vi のエディタは編集単位の groupKey を渡す（§8.3）
  const groupKey = meta.origin === 'typing' ? (meta.groupKey ?? typingGroupKey(changes)) : (meta.groupKey ?? null);

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
  flushPendingEditor();
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

/** 編集できる現在の図（読み取り専用なら null）。履歴を動かす前に、エディタにためた変更を確定させる */
function editable() {
  flushPendingEditor();
  const cur = get().current;
  return cur && !cur.readOnly ? cur : null;
}

export function undo() {
  const cur = editable();
  if (cur) moveHistory(cur.tree.undo());
}

export function redo() {
  const cur = editable();
  if (cur) moveHistory(cur.tree.redo());
}

export function jumpTo(nodeId: string) {
  const cur = editable();
  if (cur) moveHistory(cur.tree.jumpTo(nodeId, cur.text));
}

/** 履歴の版を、作った順（時刻の順）に並べる。分岐をまたいで前後へたどるのに使う（vim の g- / g+。§16） */
function chronological(cur: { tree: { nodes: Map<string, HistoryNode> } }): HistoryNode[] {
  return [...cur.tree.nodes.values()].sort((a, b) => a.ts - b.ts || a.depth - b.depth);
}

/** 作った順で n 個後ろ（負なら前）の版へ移る。端を越えたら端で止まる */
export function travel(n: number) {
  const cur = editable();
  if (!cur || n === 0) return;
  const list = chronological(cur);
  const i = list.findIndex((x) => x.id === cur.tree.headId);
  const j = Math.min(Math.max(i + n, 0), list.length - 1);
  if (j !== i) moveHistory(cur.tree.jumpTo(list[j].id, cur.text));
}

/** 今の版の時刻から ms だけ後ろ（負なら前）の時点の版へ移る（:earlier 10m / :later 30s） */
export function travelTime(ms: number) {
  const cur = editable();
  if (!cur || ms === 0) return;
  const list = chronological(cur);
  const at = cur.tree.head.ts + ms;
  // その時点で最後に作られていた版。それより前に版が無ければ最初の版
  const target = list.filter((x) => x.ts <= at).at(-1) ?? list[0];
  if (target.id !== cur.tree.headId) moveHistory(cur.tree.jumpTo(target.id, cur.text));
}

export async function renameCurrent(title: string) {
  const cur = get().current;
  if (!cur || cur.readOnly) return;
  set({ current: { ...cur, title } });
  schedulePersist();
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
