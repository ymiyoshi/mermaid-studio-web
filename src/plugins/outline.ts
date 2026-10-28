import type { ChangeSpec } from '@codemirror/state';
import type { ElementRef, ReorderSpec } from './types';
import { moveLines } from './lineOps';
import { bodyLines, isBlank, isComment, lastParse, type SourceLine } from './source';

// インデントで木構造を表す図種（mindmap / kanban / treemap）の共通処理。
// 子の追加・兄弟の追加・部分木の削除・兄弟のあいだの移動を、行の差し込み・削除・入れ替えで行う。

export interface OutlineNode {
  index: number;
  line: SourceLine;
  /** インデントの幅（タブは 4 として数える） */
  width: number;
  depth: number;
  parent: OutlineNode | null;
  children: OutlineNode[];
  /** 兄弟の並び（親の children、親が無ければ最上位のノードの並び） */
  siblings: OutlineNode[];
  /** ノードに付いている行（mindmap の ::icon() や ::: class の行） */
  attached: SourceLine[];
}

const widthOf = (text: string) => {
  let w = 0;
  for (const c of text) {
    if (c === ' ') w++;
    else if (c === '\t') w += 4;
    else break;
  }
  return w;
};

/** isAttached: 直前のノードに付く行（ノードとして数えない行）か */
export function parseOutline(source: string, isAttached: (text: string) => boolean = () => false): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const line of bodyLines(source).body) {
    if (isBlank(line.text) || isComment(line.text)) continue;
    if (isAttached(line.text.trim()) && nodes.length) {
      nodes[nodes.length - 1].attached.push(line);
      continue;
    }
    const width = widthOf(line.text);
    while (stack.length && stack[stack.length - 1].width >= width) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const siblings = parent ? parent.children : roots;
    const node: OutlineNode = { index: nodes.length, line, width, depth: stack.length, parent, children: [], siblings, attached: [] };
    siblings.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

/** ノードとその子孫の最後の行 */
export function subtreeEnd(node: OutlineNode): SourceLine {
  let n = node;
  while (n.children.length) n = n.children[n.children.length - 1];
  return n.attached.at(-1) ?? n.line;
}

/** 子のインデントの増え方（既存の子から推定。無ければ親から 2 つ深く） */
export function childIndent(node: OutlineNode): string {
  const firstChild = node.children[0];
  if (firstChild) return /^\s*/.exec(firstChild.line.text)![0];
  const own = /^\s*/.exec(node.line.text)![0];
  const unit = node.parent ? own.slice(/^\s*/.exec(node.parent.line.text)![0].length) || '  ' : '  ';
  return own + unit;
}

export function addChild(node: OutlineNode, text: string): { from: number; insert: string } {
  return { from: subtreeEnd(node).to, insert: `\n${childIndent(node)}${text}` };
}

export function addSibling(node: OutlineNode, text: string): { from: number; insert: string } {
  return { from: subtreeEnd(node).to, insert: `\n${/^\s*/.exec(node.line.text)![0]}${text}` };
}

export function deleteSubtree(source: string, node: OutlineNode): ChangeSpec {
  const end = subtreeEnd(node);
  return end.to < source.length ? { from: node.line.from, to: end.to + 1 } : { from: Math.max(0, node.line.from - 1), to: end.to };
}

/** 兄弟のあいだで 1 つ前・後ろへ移動する（部分木ごと入れ替える） */
export function moveSibling(source: string, node: OutlineNode, dir: -1 | 1): ChangeSpec | null {
  const siblings = node.siblings;
  const i = siblings.indexOf(node);
  const other = siblings[i + dir];
  if (!other) return null;
  const [a, b] = dir < 0 ? [other, node] : [node, other];
  const aText = source.slice(a.line.from, subtreeEnd(a).to);
  const bText = source.slice(b.line.from, subtreeEnd(b).to);
  const between = source.slice(subtreeEnd(a).to, b.line.from);
  return { from: a.line.from, to: subtreeEnd(b).to, insert: bText + between + aText };
}

/** ノードの部分木に含まれる行番号 */
export function subtreeLineIndexes(node: OutlineNode): Set<number> {
  const out = new Set<number>();
  const walk = (n: OutlineNode) => {
    out.add(n.line.index);
    n.attached.forEach((l) => out.add(l.index));
    n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** moveSibling の後のノードの番号（番号で指す要素を、動かした後も選び続けるため）。動かせなければ null */
export function movedIndex(node: OutlineNode, dir: -1 | 1): number | null {
  const other = node.siblings[node.siblings.indexOf(node) + dir];
  if (!other) return null;
  if (dir < 0) return other.index;
  let last = other;
  while (last.children.length) last = last.children[last.children.length - 1];
  return node.index + (last.index - other.index + 1);
}

/** node が root の部分木に含まれるか（root 自身を含む） */
export function inSubtree(node: OutlineNode, root: OutlineNode): boolean {
  for (let n: OutlineNode | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}

/**
 * 部分木を target の前・後ろ（兄弟として）か、中（最後の子として）へ動かす（ドラッグでの移動）。
 * 部分木の行の字下げは、動かす先に合わせて付け替える（間のコメントも一緒に動かす）。
 * 動かせない（自分の部分木の中へ動かす）・動かしても変わらないときは null。index は動かした後のノードの番号
 */
export function moveSubtree(
  source: string,
  node: OutlineNode,
  target: OutlineNode,
  place: 'before' | 'after' | 'into',
): { change: ChangeSpec[]; index: number } | null {
  if (inSubtree(target, node)) return null;
  const newIndent = place === 'into' ? childIndent(target) : /^\s*/.exec(target.line.text)![0];
  const r = moveLines(source, node.line, subtreeEnd(node), place === 'before' ? target.line : subtreeEnd(target), place === 'before', newIndent);
  if (!r) return null;
  const change = r.change;
  // ノードの並び（番号）は行の順なので、動かす先の番号から求める
  const size = lastOf(node).index - node.index + 1;
  const dest = place === 'before' ? target.index : lastOf(target).index + 1;
  return { change, index: dest > node.index ? dest - size : dest };
}

function lastOf(node: OutlineNode): OutlineNode {
  let n = node;
  while (n.children.length) n = n.children[n.children.length - 1];
  return n;
}

type Place = 'before' | 'after' | 'into';

/**
 * インデントの木（mindmap・kanban・ishikawa・treeView）のドラッグでの移動。
 * 要素の前後（兄弟にする）と、要素の中（最後の子にする）へ、部分木ごと動かす
 */
export function outlineReorder<N extends OutlineNode>(o: {
  /** 木を読む。動かせない書き方なら null（罫線で書いた treeView など） */
  parse(source: string): N[] | null;
  find(nodes: N[], ref: ElementRef): N | undefined;
  /** 並びの向き。動かせない要素（根など）は null */
  axis(n: N): 'x' | 'y' | 'xy' | null;
  accepts(ref: ElementRef, target: ElementRef): boolean;
  /** n を target の中・前後に置けるか（根の兄弟にはできない、ファイルの中には入れない など） */
  allowed(n: N, target: N, place: Place): boolean;
  /** 動かした後の履歴の説明と、選び続ける要素（index は動かした後の番号） */
  result(n: N, index: number): { label: string; select: ElementRef };
}): ReorderSpec {
  // ドラッグを始めるとき、候補ごとに同じソースを読み直さない
  const parse = lastParse(o.parse);
  const run = (source: string, ref: ElementRef, target: ElementRef, place: Place) => {
    const nodes = parse(source);
    const n = nodes && o.find(nodes, ref);
    const to = nodes && o.find(nodes, target);
    if (!n || !to || !o.allowed(n, to, place)) return null;
    const r = moveSubtree(source, n, to, place);
    return r && { change: r.change, ...o.result(n, r.index) };
  };
  return {
    axis(source, ref) {
      const nodes = parse(source);
      const n = nodes && o.find(nodes, ref);
      return n ? o.axis(n) : null;
    },
    accepts: o.accepts,
    move: (source, ref, target, before) => run(source, ref, target, before ? 'before' : 'after'),
    acceptsInto(source, ref, container) {
      const nodes = container && parse(source);
      const n = nodes && o.find(nodes, ref);
      const to = nodes && container && o.find(nodes, container);
      return !!n && !!to && !inSubtree(to, n) && o.allowed(n, to, 'into');
    },
    into: (source, ref, container) => (container ? run(source, ref, container, 'into') : null),
  };
}
