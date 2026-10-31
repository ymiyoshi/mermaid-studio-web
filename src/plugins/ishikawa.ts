import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { treeDuplicate, treeStructure } from './structure';
import { withGeneric } from './generic';
import { bodyLines, indentOf, type SourceLine } from './source';
import { addChild, addSibling, deleteSubtree, movedIndex, moveSibling, outlineReorder, type OutlineNode } from './outline';
import { t } from '../i18n';

// ishikawa（特性要因図・フィッシュボーン）のプラグイン（設計書 §7.3）。
// 1 行が 1 つの要素で、最初の行が結果（頭）、残りが要因。要因の階層はインデントで表す。
// mermaid と同じく、インデントは最初の要因からの差で数え、親は「前にある、階層が浅い最も近い行」とする。
// 図の要素は、描画の順番（上側の要因は子を逆順にたどる）から求め、ラベルの文字列が一致することを確かめて対応付ける。

const NEW_CAUSE = t('ik.newCause');

export interface IshikawaNode extends OutlineNode {
  /** 0 が結果（頭）、1 が大骨（主な要因）、2 以降が小骨 */
  level: number;
  label: SourceRange;
}

/** 文字の数で数えたインデント（mermaid はタブも 1 文字として数える） */
const rawIndent = (text: string) => indentOf(text).length;

export function parseIshikawa(source: string): IshikawaNode[] {
  const { header, body } = bodyLines(source);
  const lines: { line: SourceLine; from: number }[] = [];
  // 頭は、宣言行の後ろに続けて書くこともできる（ishikawa-beta 結果）
  if (header) {
    const m = /^(\s*ishikawa(?:-beta)?[ \t]+)(\S.*?)\s*$/i.exec(header.text);
    if (m) lines.push({ line: header, from: m[1].length });
  }
  for (const line of body) lines.push({ line, from: rawIndent(line.text) });
  const nodes: IshikawaNode[] = [];
  let base: number | null = null;
  const stack: IshikawaNode[] = [];
  for (const { line, from } of lines) {
    const label = { from: line.from + from, to: line.from + line.text.trimEnd().length };
    // mermaid の階層の数え方（親を決めるためだけに使う。木の深さとは限らない）
    let width = 0;
    if (nodes.length > 0) {
      const raw = rawIndent(line.text);
      base ??= raw;
      width = Math.max(1, raw - base + 1);
    }
    while (stack.length && stack[stack.length - 1].width >= width) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const level = parent ? parent.level + 1 : 0;
    const node: IshikawaNode = { index: nodes.length, line, width, depth: level, parent, children: [], siblings: [], attached: [], level, label };
    node.siblings = parent ? parent.children : [];
    if (parent) parent.children.push(node);
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

/** ラベルの比較用（mermaid は <br> で改行し、長い文言は空白の位置で折り返す） */
const norm = (s: string) => s.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

/** SVG のラベル（折り返した行は tspan に分かれる） */
function svgLabel(text: Element): string {
  const spans = [...text.querySelectorAll('tspan')];
  return norm(spans.length ? spans.map((s) => s.textContent ?? '').join(' ') : (text.textContent ?? ''));
}

/** mermaid が描く順番: 頭、大骨を 2 本ずつ（偶数番目は上側で、子孫を逆順にたどる）、各大骨の後ろにその子孫 */
function drawOrder(nodes: IshikawaNode[]): IshikawaNode[] {
  const root = nodes[0];
  if (!root) return [];
  const out = [root];
  const walk = (n: IshikawaNode, reverse: boolean) => {
    out.push(n);
    const kids = n.children as IshikawaNode[];
    for (const c of reverse ? [...kids].reverse() : kids) walk(c, reverse);
  };
  (root.children as IshikawaNode[]).forEach((c, i) => walk(c, i % 2 === 0));
  return out;
}

const ref = (n: IshikawaNode) => ({ kind: n.level === 0 ? 'effect' : 'cause', id: String(n.index) });
const KINDS = ['effect', 'cause'];

export const ishikawaPlugin: DiagramPlugin = {
  type: 'ishikawa',

  mapTargets(svg, source) {
    const nodes = parseIshikawa(source);
    const groups = [...svg.querySelectorAll('g.ishikawa-head-group, g.ishikawa-label-group, g.ishikawa-sub-group')];
    const order = drawOrder(nodes);
    const mapped: DiagramTarget[] = [];
    const labels = groups.map((g) => g.querySelector('text'));
    const ok = order.length === groups.length && order.every((n, i) => labels[i] && svgLabel(labels[i]!) === norm(source.slice(n.label.from, n.label.to)));
    if (ok) {
      groups.forEach((g, i) => {
        const n = order[i];
        const labelEl = labels[i]!;
        // ラベルはソースの書き方のまま（図では <br> で改行し、長い文言は折り返す）
        mapped.push({ id: `ishikawa-${n.index}`, el: g, labelEl, label: source.slice(n.label.from, n.label.to), range: n.label, ref: ref(n) });
      });
    }
    return withGeneric(svg, source, mapped);
  },

  inspect(source, r): PropertyField[] {
    const n = r && KINDS.includes(r.kind) ? parseIshikawa(source)[Number(r.id)] : undefined;
    if (!n) return [];
    return [
      { id: 'label', label: t('ik.field.text'), type: 'text', value: source.slice(n.label.from, n.label.to) },
      { id: 'level', label: t('ik.field.level'), type: 'text', value: String(n.level), readonly: true },
    ];
  },

  setProperty(source, r, field, value) {
    const n = r && KINDS.includes(r.kind) ? parseIshikawa(source)[Number(r.id)] : undefined;
    // 改行は書けない（1 行が 1 つの要素）。空にすると要素が消えるので、空は反映しない
    const v = value.replace(/[\r\n]+/g, ' ').trim();
    if (!n || field !== 'label' || !v || /^%%/.test(v)) return null;
    return { from: n.label.from, to: n.label.to, insert: v };
  },

  actions: [
    {
      id: 'add-child',
      title: t('ik.action.addChild'),
      arity: 1,
      appliesTo: KINDS,
      key: 'Tab',
      run(source, [r]) {
        const nodes = parseIshikawa(source);
        const n = nodes[Number(r.id)];
        if (!n) return null;
        let change: { from: number; insert: string };
        if (n.level === 0 && n.children.length === 0) {
          // 最初の要因: 頭の行の後ろに、4 文字下げて足す
          change = { from: lastLine(n).to, insert: `\n${indentOf(n.line.text)}    ${NEW_CAUSE}` };
        } else {
          change = addChild(n, NEW_CAUSE);
        }
        return { change, label: t('ik.history.add'), focus: { kind: 'cause', id: String(lastIndex(n) + 1) } };
      },
    },
    {
      id: 'add-sibling',
      title: t('ik.action.addSibling'),
      arity: 1,
      appliesTo: ['cause'],
      run(source, [r]) {
        const n = parseIshikawa(source)[Number(r.id)];
        if (!n || n.level === 0) return null;
        return { change: addSibling(n, NEW_CAUSE), label: t('ik.history.add'), focus: { kind: 'cause', id: String(lastIndex(n) + 1) } };
      },
    },
    {
      id: 'move-up',
      title: '↑',
      arity: 1,
      appliesTo: ['cause'],
      run(source, [r]) {
        const n = parseIshikawa(source)[Number(r.id)];
        const change = n && moveSibling(source, n, -1);
        return change ? { change, label: t('ik.history.move'), select: { kind: 'cause', id: String(movedIndex(n, -1)) } } : null;
      },
    },
    {
      id: 'move-down',
      title: '↓',
      arity: 1,
      appliesTo: ['cause'],
      run(source, [r]) {
        const n = parseIshikawa(source)[Number(r.id)];
        const change = n && moveSibling(source, n, 1);
        return change ? { change, label: t('ik.history.move'), select: { kind: 'cause', id: String(movedIndex(n, 1)) } } : null;
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['cause'],
      key: 'Delete',
      danger: true,
      run(source, [r]) {
        const n = parseIshikawa(source)[Number(r.id)];
        // 頭は消さない（消すと最初の要因が頭になる）
        if (!n || n.level === 0) return null;
        return { change: deleteSubtree(source, n), label: t('ik.history.delete') };
      },
    },
  ],

  // ドラッグ: 要因の前後（兄弟にする）か、要因・頭の真ん中（その下の要因にする）へ部分木ごと動かす。
  // 骨は斜めにも左右にも並ぶので、並びは近い方の要因で決める
  reorder: outlineReorder({
    parse: parseIshikawa,
    find: (nodes, r) => (KINDS.includes(r.kind) ? nodes[Number(r.id)] : undefined),
    axis: (n) => (n.level > 0 ? 'xy' : null),
    accepts: (r, target) => r.kind === 'cause' && target.kind === 'cause',
    allowed: (_n, target, place) => place === 'into' || target.level > 0,
    result: (_n, index) => ({ label: t('ik.history.move'), select: { kind: 'cause', id: String(index) } }),
  }),

  structure: treeStructure((source) => parseIshikawa(source).map((n) => ({ node: n, ref: ref(n) }))),

  // 複製（設計書 §17.3）: 結果（頭）は 1 つなので、要因だけ
  duplicate: treeDuplicate({
    items: (source) => parseIshikawa(source).map((n) => ({ node: n, ref: ref(n) })),
    accepts: (r) => r.kind === 'cause',
    allowed: (n) => (n as IshikawaNode).level > 0,
    copyRef: (index) => ({ kind: 'cause', id: String(index) }),
  }),
};

/** 部分木の最後の要素 */
function lastNode(n: OutlineNode): OutlineNode {
  while (n.children.length) n = n.children[n.children.length - 1];
  return n;
}
const lastIndex = (n: OutlineNode) => lastNode(n).index;
const lastLine = (n: OutlineNode) => lastNode(n).line;
