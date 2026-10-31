import { mindNodes } from './mindmap';
import { nameToken, parseTreeView } from './treeView';
import { parseIshikawa } from './ishikawa';
import type { OutlineNode } from './outline';
import { bodyLines } from './source';
import { t } from '../i18n';

// 木の図種（mindmap・treeView・ishikawa）の相互変換（設計書 §17.7）。
// どれも字下げで木を書くので、ラベルの木として読み、別の図種の書き方で書き直す。
// 形・アイコン・クラス・説明など、行き先の図種に無いものは落とす（変換は履歴 1 ステップなので、元に戻せる）。

export type TreeKind = 'mindmap' | 'treeView' | 'ishikawa';

export const TREE_KINDS: TreeKind[] = ['mindmap', 'treeView', 'ishikawa'];

export interface LabelTree {
  label: string;
  children: LabelTree[];
}

/** OutlineNode の木を、ラベルの木にする（最上位のノードの並び） */
function toTrees<N extends OutlineNode>(nodes: N[], label: (n: N) => string): LabelTree[] {
  const conv = (n: N): LabelTree => ({ label: label(n), children: (n.children as N[]).map(conv) });
  return nodes.filter((n) => n.parent === null).map(conv);
}

/** 図種の木を読む。読めなければ null（罫線で書いた treeView など） */
export function readTree(source: string, kind: TreeKind): LabelTree[] | null {
  if (kind === 'mindmap') {
    const ms = mindNodes(source);
    const labels = new Map(ms.map((m) => [m.node, source.slice(m.label.from, m.label.to)]));
    return toTrees(
      ms.map((m) => m.node),
      (n) => labels.get(n) ?? '',
    );
  }
  if (kind === 'treeView') {
    const p = parseTreeView(source);
    if (p.boxed) return null;
    return toTrees(p.entries, (e) => source.slice(e.name.from, e.name.to));
  }
  return toTrees(parseIshikawa(source), (n) => source.slice(n.label.from, n.label.to));
}

/** 根が 1 つでなければならない図種のために、1 つにまとめる */
const singleRoot = (trees: LabelTree[]): LabelTree => (trees.length === 1 ? trees[0] : { label: t('convert.root'), children: trees });

const flat = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** mindmap のラベル。形の括弧と読まれる文字を含むときは ["…"] で囲む */
function mindLabel(label: string): string {
  const s = flat(label) || '…';
  return /[()[\]{}"]|^\s|::/.test(s) ? `["${s.replace(/"/g, "'")}"]` : s;
}

export function writeTree(trees: LabelTree[], kind: TreeKind): string {
  const lines: string[] = [];
  if (kind === 'mindmap') {
    lines.push('mindmap');
    const walk = (n: LabelTree, depth: number) => {
      lines.push(`${'  '.repeat(depth + 1)}${mindLabel(n.label)}`);
      n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(singleRoot(trees), 0);
  } else if (kind === 'treeView') {
    lines.push('treeView-beta');
    const walk = (n: LabelTree, depth: number) => {
      const name = flat(n.label).replace(/\/+$/, '') || '…';
      const token = nameToken(name, n.children.length > 0) ?? nameToken(name.replace(/["']/g, ''), n.children.length > 0) ?? '…';
      lines.push(`${'    '.repeat(depth + 1)}${token}`);
      n.children.forEach((c) => walk(c, depth + 1));
    };
    trees.forEach((n) => walk(n, 0));
  } else {
    lines.push('ishikawa-beta');
    const root = singleRoot(trees);
    lines.push(flat(root.label) || '…');
    const walk = (n: LabelTree, depth: number) => {
      lines.push(`${'    '.repeat(depth)}${flat(n.label) || '…'}`);
      n.children.forEach((c) => walk(c, depth + 1));
    };
    root.children.forEach((c) => walk(c, 1));
  }
  return lines.join('\n') + '\n';
}

/** 変換したテキスト。読めなければ null。frontmatter（テーマなど）と、宣言行より前のコメントは残す */
export function convertTree(source: string, from: TreeKind, to: TreeKind): string | null {
  const trees = readTree(source, from);
  if (!trees || trees.length === 0) return null;
  const header = bodyLines(source).header;
  return (header ? source.slice(0, header.from) : '') + writeTree(trees, to);
}

/** mermaid の diagramType から木の図種へ */
export const treeKindOf = (diagramType: string | null): TreeKind | null =>
  diagramType === 'mindmap' || diagramType === 'treeView' || diagramType === 'ishikawa' ? diagramType : null;
