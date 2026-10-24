import { ChangeSet, Text } from '@codemirror/state';
import { t } from '../i18n';

// 設計書 §8: ツリー型・無制限の履歴。
// 各ノードは「親 → 自分」の forward と「自分 → 親」の inverse を CodeMirror の ChangeSet(JSON) で持つ。

export type Origin = 'init' | 'typing' | 'diagram-op' | 'paste' | 'file-load' | 'restore';

export interface Sel {
  anchor: number;
  head: number;
}

export interface HistoryNode {
  id: string;
  docId: string;
  parentId: string | null;
  children: string[];
  /** redo で進む子。最後に訪れた子を覚えておく */
  lastChild: string | null;
  depth: number;
  forward: unknown;
  inverse: unknown;
  label: string;
  origin: Origin;
  /** 同じ groupKey の連続した編集は 1 ステップにまとめられる（§8.3） */
  groupKey: string | null;
  selBefore: Sel;
  selAfter: Sel;
  ts: number;
  /** SNAPSHOT_INTERVAL ステップごとの全文。ルートは常に持つ */
  snapshot: string | null;
  /** 名前付きチェックポイント（§8.4）。付いていれば履歴ビューで折りたたまない */
  name?: string;
}

export interface CommitMeta {
  origin: Origin;
  label: string;
  groupKey: string | null;
  selBefore: Sel;
  selAfter: Sel;
  ts: number;
  /** true なら新しいノードを作らず head にまとめる */
  coalesce: boolean;
}

/** 履歴を移動したときにエディタへ適用する変更 */
export interface Step {
  changes: ChangeSet;
  selection: Sel;
  nodeId: string;
}

export const SNAPSHOT_INTERVAL = 20;
/** これより遠いジャンプはスナップショットから復元する */
const SNAPSHOT_JUMP_THRESHOLD = 50;

const newId = () => crypto.randomUUID();

export class HistoryTree {
  readonly docId: string;
  readonly nodes = new Map<string, HistoryNode>();
  rootId: string;
  headId: string;
  /** IndexedDB にまだ書いていないノード */
  readonly dirty = new Set<string>();
  private cache = new Map<string, { fwd: ChangeSet; inv: ChangeSet }>();

  private constructor(docId: string, rootId: string, headId: string) {
    this.docId = docId;
    this.rootId = rootId;
    this.headId = headId;
  }

  static create(docId: string, text: string, ts: number, label = t('history.create')): HistoryTree {
    const len = text.length;
    const root: HistoryNode = {
      id: newId(),
      docId,
      parentId: null,
      children: [],
      lastChild: null,
      depth: 0,
      forward: ChangeSet.empty(0).toJSON(),
      inverse: ChangeSet.empty(len).toJSON(),
      label,
      origin: 'init',
      groupKey: null,
      selBefore: { anchor: 0, head: 0 },
      selAfter: { anchor: 0, head: 0 },
      ts,
      snapshot: text,
    };
    const tree = new HistoryTree(docId, root.id, root.id);
    tree.nodes.set(root.id, root);
    tree.dirty.add(root.id);
    return tree;
  }

  static load(docId: string, nodes: HistoryNode[], headId: string): HistoryTree {
    const root = nodes.find((n) => n.parentId === null);
    if (!root) throw new Error('history has no root');
    const tree = new HistoryTree(docId, root.id, headId);
    for (const n of nodes) tree.nodes.set(n.id, n);
    if (!tree.nodes.has(headId)) tree.headId = root.id;
    return tree;
  }

  get head(): HistoryNode {
    return this.get(this.headId);
  }

  get(id: string): HistoryNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown history node ${id}`);
    return n;
  }

  private sets(node: HistoryNode) {
    let c = this.cache.get(node.id);
    if (!c) {
      c = { fwd: ChangeSet.fromJSON(node.forward), inv: ChangeSet.fromJSON(node.inverse) };
      this.cache.set(node.id, c);
    }
    return c;
  }

  private touch(node: HistoryNode) {
    this.dirty.add(node.id);
  }

  /** docBefore は head 時点の文書。変更を記録して head を進める（またはまとめる） */
  commit(changes: ChangeSet, docBefore: Text, meta: CommitMeta): HistoryNode {
    const head = this.head;
    const docAfter = changes.apply(docBefore);

    if (meta.coalesce && head.parentId !== null && head.children.length === 0) {
      const { fwd, inv } = this.sets(head);
      const fwd2 = fwd.compose(changes);
      const inv2 = changes.invert(docBefore).compose(inv);
      head.forward = fwd2.toJSON();
      head.inverse = inv2.toJSON();
      this.cache.set(head.id, { fwd: fwd2, inv: inv2 });
      head.selAfter = meta.selAfter;
      head.ts = meta.ts;
      head.label = meta.label;
      if (head.snapshot !== null) head.snapshot = docAfter.toString();
      this.touch(head);
      return head;
    }

    const depth = head.depth + 1;
    const node: HistoryNode = {
      id: newId(),
      docId: this.docId,
      parentId: head.id,
      children: [],
      lastChild: null,
      depth,
      forward: changes.toJSON(),
      inverse: changes.invert(docBefore).toJSON(),
      label: meta.label,
      origin: meta.origin,
      groupKey: meta.groupKey,
      selBefore: meta.selBefore,
      selAfter: meta.selAfter,
      ts: meta.ts,
      snapshot: depth % SNAPSHOT_INTERVAL === 0 ? docAfter.toString() : null,
    };
    this.nodes.set(node.id, node);
    head.children.push(node.id);
    head.lastChild = node.id;
    this.headId = node.id;
    this.touch(head);
    this.touch(node);
    return node;
  }

  canUndo(): boolean {
    return this.head.parentId !== null;
  }

  canRedo(): boolean {
    return this.head.children.length > 0;
  }

  undo(): Step | null {
    const node = this.head;
    if (node.parentId === null) return null;
    const parent = this.get(node.parentId);
    parent.lastChild = node.id;
    this.touch(parent);
    this.headId = parent.id;
    return { changes: this.sets(node).inv, selection: node.selBefore, nodeId: parent.id };
  }

  redo(): Step | null {
    const node = this.head;
    const childId = node.lastChild ?? node.children.at(-1);
    if (!childId) return null;
    const child = this.get(childId);
    this.headId = child.id;
    return { changes: this.sets(child).fwd, selection: child.selAfter, nodeId: child.id };
  }

  /** ルートから id までのノード列 */
  pathFromRoot(id: string): HistoryNode[] {
    const path: HistoryNode[] = [];
    for (let n: HistoryNode | undefined = this.get(id); n; n = n.parentId ? this.get(n.parentId) : undefined) {
      path.push(n);
      // 壊れた履歴（親が循環している）で終わらなくならないように
      if (path.length > this.nodes.size) throw new Error('history has a cycle');
    }
    return path.reverse();
  }

  /** 任意のノードの時点のテキストを、最寄りのスナップショットから復元する */
  textAt(id: string): string {
    const path = this.pathFromRoot(id);
    let i = path.length - 1;
    while (path[i].snapshot === null) i--;
    let doc = Text.of(path[i].snapshot!.split('\n'));
    for (let j = i + 1; j < path.length; j++) doc = this.sets(path[j]).fwd.apply(doc);
    return doc.toString();
  }

  /** currentDoc は head 時点の文書 */
  jumpTo(targetId: string, currentDoc: Text): Step | null {
    if (targetId === this.headId) return null;
    const target = this.get(targetId);
    const from = this.pathFromRoot(this.headId);
    const to = this.pathFromRoot(targetId);
    let common = 0;
    while (common < from.length && common < to.length && from[common].id === to[common].id) common++;
    const ups = from.slice(common).reverse();
    const downs = to.slice(common);

    // redo が今回通った道をたどるように lastChild を更新する
    for (const n of downs) {
      const parent = this.get(n.parentId!);
      if (parent.lastChild !== n.id) {
        parent.lastChild = n.id;
        this.touch(parent);
      }
    }
    this.headId = targetId;

    let changes: ChangeSet;
    if (ups.length + downs.length > SNAPSHOT_JUMP_THRESHOLD) {
      changes = minimalReplace(currentDoc, this.textAt(targetId));
    } else {
      changes = ChangeSet.empty(currentDoc.length);
      for (const n of ups) changes = changes.compose(this.sets(n).inv);
      for (const n of downs) changes = changes.compose(this.sets(n).fwd);
    }
    return { changes, selection: target.selAfter, nodeId: targetId };
  }

  /** 名前付きチェックポイントにする（空文字なら名前を外す） */
  setName(id: string, name: string) {
    const n = this.get(id);
    if (name.trim()) n.name = name.trim();
    else delete n.name;
    this.touch(n);
  }

  /**
   * 今の版（head）に至らない分岐を消す（§8.5 古い分岐の整理）。
   * 残すのは、ルートから head までの道と、head の子孫（redo で進める先）。消したノードの id を返す
   */
  pruneBranches(): string[] {
    const keep = new Set(this.pathFromRoot(this.headId).map((n) => n.id));
    const stack = [this.headId];
    while (stack.length) {
      const n = this.get(stack.pop()!);
      keep.add(n.id);
      stack.push(...n.children);
    }
    const removed = [...this.nodes.keys()].filter((id) => !keep.has(id));
    for (const id of removed) {
      this.nodes.delete(id);
      this.cache.delete(id);
      this.dirty.delete(id);
    }
    for (const n of this.nodes.values()) {
      const kids = n.children.filter((c) => keep.has(c));
      if (kids.length !== n.children.length) {
        n.children = kids;
        if (n.lastChild && !keep.has(n.lastChild)) n.lastChild = kids.at(-1) ?? null;
        this.touch(n);
      }
    }
    return removed;
  }

  takeDirty(): HistoryNode[] {
    const out = [...this.dirty].map((id) => this.get(id));
    this.dirty.clear();
    return out;
  }
}

/** 先頭と末尾の共通部分を除いた最小の置換 */
export function minimalReplace(doc: Text, next: string): ChangeSet {
  const cur = doc.toString();
  let start = 0;
  const max = Math.min(cur.length, next.length);
  while (start < max && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endA = cur.length;
  let endB = next.length;
  while (endA > start && endB > start && cur.charCodeAt(endA - 1) === next.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return ChangeSet.of({ from: start, to: endA, insert: next.slice(start, endB) }, cur.length);
}
