import type { ChangeSpec } from '@codemirror/state';
import { bodyLines, isBlank, isComment, type SourceLine } from './source';

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
function childIndent(node: OutlineNode): string {
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
