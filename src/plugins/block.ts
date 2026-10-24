import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, isComment, uniqueId, type SourceLine } from './source';
import { removeLine, removeLines } from './lineOps';
import { addHitArea, matchInOrder } from './svg';

// block 図のプラグイン。1 行に並べたブロック（a["A"] b:2 など）、入れ子の block:ID … end、
// 列の数（columns）、矢印（a --> b）を図から編集する。
// SVG の g.node の id（…-<ID>）でブロックに、エッジの data-id（…-<始点>-<終点>）で矢印に対応付ける。

/** ブロックの形（括弧の組） */
export const BLOCK_SHAPES: { name: string; label: string; open: string; close: string }[] = [
  { name: 'rect', label: '四角', open: '[', close: ']' },
  { name: 'round', label: '角丸', open: '(', close: ')' },
  { name: 'stadium', label: 'スタジアム', open: '([', close: '])' },
  { name: 'subroutine', label: 'サブルーチン', open: '[[', close: ']]' },
  { name: 'cylinder', label: '円柱', open: '[(', close: ')]' },
  { name: 'circle', label: '円', open: '((', close: '))' },
  { name: 'double-circle', label: '二重丸', open: '(((', close: ')))' },
  { name: 'asymmetric', label: '旗', open: '>', close: ']' },
  { name: 'rhombus', label: 'ひし形', open: '{', close: '}' },
  { name: 'hexagon', label: '六角形', open: '{{', close: '}}' },
  { name: 'parallelogram', label: '平行四辺形', open: '[/', close: '/]' },
  { name: 'trapezoid', label: '台形', open: '[/', close: '\\]' },
];

/** 開き括弧の長いものから試す（[( を [ より先に） */
const OPENERS = [...new Set(BLOCK_SHAPES.map((s) => s.open))].sort((a, b) => b.length - a.length);

const ID = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*/u;
const ARROW = /^\s*(?<from>[\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*(?:--\s*"[^"]*"\s*)?(?<arrow><?-->|<?---|<?==>|<?-\.->)\s*(?<to>[\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*$/u;

export interface BlockItem {
  id: string;
  /** ブロック全体（ID から幅の指定まで）の範囲 */
  range: SourceRange;
  /** ラベルの中身の範囲。ラベルが無ければ null */
  label: SourceRange | null;
  /** 形の括弧（ラベルが無ければ null） */
  shape: { open: string; close: string; from: number; to: number } | null;
  /** 幅（:2 の 2）。無ければ null。width.range は「:2」全体 */
  width: { value: number; range: SourceRange } | null;
  line: SourceLine;
  /** 入れ子の block:ID … end の ID（トップレベルなら null） */
  parent: string | null;
}

export interface BlockGroup {
  id: string;
  open: SourceLine;
  close: SourceLine | null;
  parent: string | null;
  /** block:ID:3 の 3 の範囲 */
  width: { value: number; range: SourceRange } | null;
}

export interface BlockEdge {
  from: string;
  to: string;
  line: SourceLine;
}

export interface ParsedBlock {
  items: BlockItem[];
  groups: BlockGroup[];
  edges: BlockEdge[];
  /** columns の行（トップレベル、または入れ子の中） */
  columns: { value: string; range: SourceRange; line: SourceLine; parent: string | null }[];
}

/** 行の中の pos から、閉じ括弧 close までを読む（引用符の中は飛ばす）。閉じ括弧の位置を返す */
function findClose(text: string, pos: number, close: string): number {
  let quote = false;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === '"') quote = !quote;
    else if (!quote && text.startsWith(close, i)) return i;
  }
  return -1;
}

/** 1 行に並んだブロックを読む */
function readItems(line: SourceLine, parent: string | null): BlockItem[] {
  const out: BlockItem[] = [];
  const text = line.text;
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const m = ID.exec(text.slice(i));
    if (!m) return out;
    const start = i;
    const id = m[0];
    i += id.length;
    let label: SourceRange | null = null;
    let shape: BlockItem['shape'] = null;
    const open = OPENERS.find((o) => text.startsWith(o, i));
    if (open && id !== 'space') {
      // 同じ開き括弧で閉じ方が違う形（平行四辺形と台形）があるので、閉じ方の候補を順に試す
      const candidates = BLOCK_SHAPES.filter((s) => s.open === open);
      let closeAt = -1;
      let close = '';
      for (const c of candidates) {
        const k = findClose(text, i + open.length, c.close);
        if (k >= 0 && (closeAt < 0 || k < closeAt)) {
          closeAt = k;
          close = c.close;
        }
      }
      if (closeAt < 0) return out;
      const innerFrom = i + open.length;
      const inner = text.slice(innerFrom, closeAt);
      const q = /^"(.*)"$/s.exec(inner);
      label = q ? { from: line.from + innerFrom + 1, to: line.from + closeAt - 1 } : { from: line.from + innerFrom, to: line.from + closeAt };
      shape = { open, close, from: line.from + i, to: line.from + closeAt + close.length };
      i = closeAt + close.length;
    }
    let width: BlockItem['width'] = null;
    const w = /^:(\d+)/.exec(text.slice(i));
    if (w) {
      width = { value: Number(w[1]), range: { from: line.from + i, to: line.from + i + w[0].length } };
      i += w[0].length;
    }
    // ブロックの後は空白か行末でなければ、ブロックの並びではない
    if (i < text.length && !/\s/.test(text[i])) return out;
    if (id !== 'space') out.push({ id, range: { from: line.from + start, to: line.from + i }, label, shape, width, line, parent });
  }
  return out;
}

export function parseBlock(source: string): ParsedBlock {
  const { body } = bodyLines(source);
  const parsed: ParsedBlock = { items: [], groups: [], edges: [], columns: [] };
  const stack: BlockGroup[] = [];
  for (const line of body) {
    if (isComment(line.text)) continue;
    const t = line.text.trim();
    const parent = stack.at(-1)?.id ?? null;
    const g = /^block(?::([\p{L}\p{N}_][\p{L}\p{N}_-]*))?(:(\d+))?\s*$/u.exec(t);
    if (g) {
      const at = line.from + indentOf(line.text).length;
      const group: BlockGroup = {
        id: g[1] ?? `block@${line.index}`,
        open: line,
        close: null,
        parent,
        width: g[3] ? { value: Number(g[3]), range: { from: at + t.lastIndexOf(g[2]), to: at + t.lastIndexOf(g[2]) + g[2].length } } : null,
      };
      parsed.groups.push(group);
      stack.push(group);
      continue;
    }
    if (t === 'end') {
      const group = stack.pop();
      if (group) group.close = line;
      continue;
    }
    const c = /^columns\s+(\S+)/.exec(t);
    if (c) {
      const at = line.from + line.text.indexOf(c[1], indentOf(line.text).length + 'columns'.length);
      parsed.columns.push({ value: c[1], range: { from: at, to: at + c[1].length }, line, parent });
      continue;
    }
    if (/^(classDef|class|style)\b/.test(t)) continue;
    const e = ARROW.exec(line.text);
    if (e?.groups) {
      parsed.edges.push({ from: e.groups.from, to: e.groups.to, line });
      continue;
    }
    parsed.items.push(...readItems(line, parent));
  }
  return parsed;
}

const NEW_LABEL = '新しいブロック';

/** ブロック（または入れ子のブロック）を消す変更。矢印の行も消す */
function deleteBlock(source: string, id: string): ChangeSpec[] | null {
  const p = parseBlock(source);
  // 中身が空の入れ子と、何も無い図は書けないので、入れ子の最後の 1 つなら入れ子ごと消し、図の最後の 1 つは消さない
  const parentOf = (x: string) => p.items.find((i) => i.id === x)?.parent ?? p.groups.find((g) => g.id === x)?.parent ?? null;
  const siblings = (parent: string | null) => [...p.items, ...p.groups].filter((x) => x.parent === parent).length;
  const parent = parentOf(id);
  if (parent !== null && siblings(parent) === 1) return deleteBlock(source, parent);
  if (parent === null && siblings(null) === 1) return null;
  // 入れ子のブロックなら、中にあるブロックへの矢印も消す
  const inside = new Set([id]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const x of [...p.items, ...p.groups]) {
      if (x.parent !== null && inside.has(x.parent) && !inside.has(x.id)) {
        inside.add(x.id);
        grown = true;
      }
    }
  }
  const edgeLines = p.edges.filter((e) => inside.has(e.from) || inside.has(e.to)).map((e) => removeLine(source, e.line));
  const group = p.groups.find((g) => g.id === id);
  if (group) {
    return group.close ? [removeLines(source, group.open, group.close), ...edgeLines] : null;
  }
  const item = p.items.find((x) => x.id === id);
  if (!item) return null;
  const onLine = p.items.filter((x) => x.line.index === item.line.index);
  if (onLine.length === 1) return [removeLine(source, item.line), ...edgeLines];
  // 同じ行の他のブロックは残す。前の空白ごと消す（行頭のブロックなら後ろの空白ごと）
  const first = onLine[0] === item;
  const before = source.slice(item.line.from, item.range.from);
  const from = first ? item.range.from : item.line.from + before.trimEnd().length;
  let to = item.range.to;
  if (first) while (to < item.line.to && /\s/.test(source[to])) to++;
  return [{ from, to }, ...edgeLines];
}

/** トップレベルの最後のブロックの行（矢印や classDef より前に足すため） */
function lastTopItemLine(p: ParsedBlock): SourceLine | null {
  let last: SourceLine | null = null;
  for (const x of p.items) if (x.parent === null && (!last || x.line.index > last.index)) last = x.line;
  for (const g of p.groups) if (g.parent === null && g.close && (!last || g.close.index > last.index)) last = g.close;
  for (const c of p.columns) if (c.parent === null && (!last || c.line.index > last.index)) last = c.line;
  return last;
}

const svgId = (el: Element) => el.id.replace(/^mmd-render-\d+-/, '');

export const blockPlugin: DiagramPlugin = {
  type: 'block',

  mapTargets(svg, source) {
    const p = parseBlock(source);
    const mapped: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const id = svgId(g);
      const item = p.items.find((x) => x.id === id);
      const group = item ? null : p.groups.find((x) => x.id === id);
      if (!item && !group) return;
      const labelEl = g.querySelector('.label') ?? g;
      mapped.push({
        id: `block-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: item?.label ?? null,
        // ラベルの無いブロック（a だけ）は、a["…"] として差し込む
        insertAt: item && !item.label ? { at: item.range.from + item.id.length, prefix: '["', suffix: '"]' } : undefined,
        ref: { kind: 'block-item', id },
      });
    });
    // 矢印: data-id の末尾が「-<始点>-<終点>」
    const paths = [...svg.querySelectorAll('path[data-id]')].filter((x) => x.getAttribute('data-et') === 'edge');
    const order = matchInOrder(paths, p.edges, (el, e) => el.getAttribute('data-id')!.endsWith(`-${e.from}-${e.to}`));
    paths.forEach((el, i) => {
      const k = order[i];
      if (k < 0) return;
      mapped.push({ id: `block-edge-${i}`, el, hits: [addHitArea(el)], labelEl: el, label: '', range: null, ref: { kind: 'edge', id: String(k) } });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    const p = parseBlock(source);
    if (!ref) {
      const cols = p.columns.find((c) => c.parent === null);
      return [{ id: 'columns', label: '列の数', type: 'text', value: cols?.value ?? '', placeholder: '自動' }];
    }
    if (ref.kind === 'edge') {
      const e = p.edges[Number(ref.id)];
      return e ? [{ id: 'from', label: '元', type: 'text', value: e.from, readonly: true }, { id: 'to', label: '先', type: 'text', value: e.to, readonly: true }] : [];
    }
    const group = p.groups.find((g) => g.id === ref.id);
    if (group) {
      const cols = p.columns.find((c) => c.parent === group.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: group.id, readonly: true },
        { id: 'width', label: '幅（列の数）', type: 'number', value: group.width ? String(group.width.value) : '', placeholder: '1' },
        { id: 'columns', label: '中の列の数', type: 'text', value: cols?.value ?? '', placeholder: '自動' },
      ];
    }
    const item = p.items.find((x) => x.id === ref.id);
    if (!item) return [];
    const shape = item.shape ? (BLOCK_SHAPES.find((s) => s.open === item.shape!.open && s.close === item.shape!.close)?.name ?? 'rect') : 'rect';
    return [
      { id: 'id', label: 'ID', type: 'text', value: item.id, readonly: true },
      { id: 'label', label: 'ラベル', type: 'text', value: item.label ? source.slice(item.label.from, item.label.to) : '' },
      { id: 'shape', label: '形', type: 'select', value: shape, options: BLOCK_SHAPES.map((s) => ({ value: s.name, label: s.label })) },
      { id: 'width', label: '幅（列の数）', type: 'number', value: item.width ? String(item.width.value) : '', placeholder: '1' },
    ];
  },

  setProperty(source, ref, field, value) {
    const p = parseBlock(source);
    const v = value.trim();
    /** 幅: 空か 1 なら指定を消し、2 以上なら :N にする */
    const setWidth = (width: BlockItem['width'], at: number): ChangeSpec | null => {
      if (v !== '' && !/^\d+$/.test(v)) return null;
      const n = v === '' ? 1 : Number(v);
      if (n < 1) return null;
      if (width) return { from: width.range.from, to: width.range.to, insert: n === 1 ? '' : `:${n}` };
      return n === 1 ? null : { from: at, insert: `:${n}` };
    };
    /** 列の数: parent の中の columns の行を書き換える・足す・消す */
    const setColumns = (parent: string | null, after: SourceLine | null, indent: string): ChangeSpec | null => {
      if (v !== '' && v !== 'auto' && !/^\d+$/.test(v)) return null;
      const cols = p.columns.find((c) => c.parent === parent);
      if (cols) return v === '' ? removeLine(source, cols.line) : { from: cols.range.from, to: cols.range.to, insert: v };
      return v === '' ? null : insertLineAfter(source, after, `${indent}columns ${v}`);
    };

    if (!ref) {
      if (field !== 'columns') return null;
      const { header, body } = bodyLines(source);
      return setColumns(null, header, body[0] ? indentOf(body[0].text) || '    ' : '    ');
    }
    const group = p.groups.find((g) => g.id === ref.id);
    if (group) {
      if (field === 'width') return setWidth(group.width, group.open.from + group.open.text.trimEnd().length);
      if (field === 'columns') return setColumns(group.id, group.open, indentOf(group.open.text) + '    ');
      return null;
    }
    const item = p.items.find((x) => x.id === ref.id);
    if (!item) return null;
    if (field === 'width') return setWidth(item.width, item.shape?.to ?? item.range.from + item.id.length);
    if (field === 'label') {
      const text = value.replace(/"/g, "'");
      // 空のラベル（a[""]）は書けないので、括弧ごと外して ID だけにする
      if (text === '') return item.shape ? { from: item.shape.from, to: item.shape.to, insert: '' } : null;
      if (item.label && item.shape) {
        // 引用符の無いラベルは、引用符で囲み直す（括弧などを書けるように）
        const quoted = source[item.label.from - 1] === '"';
        return quoted ? { from: item.label.from, to: item.label.to, insert: text } : { from: item.label.from, to: item.label.to, insert: `"${text}"` };
      }
      return text === '' ? null : { from: item.range.from + item.id.length, insert: `["${text}"]` };
    }
    if (field === 'shape') {
      const s = BLOCK_SHAPES.find((x) => x.name === value);
      if (!s) return null;
      const label = item.label ? source.slice(item.label.from, item.label.to) : item.id;
      const insert = `${s.open}"${label}"${s.close}`;
      return item.shape ? { from: item.shape.from, to: item.shape.to, insert } : { from: item.range.from + item.id.length, insert };
    }
    return null;
  },

  actions: [
    {
      id: 'add-block',
      title: '＋ ブロック',
      arity: 0,
      run(source) {
        const p = parseBlock(source);
        const id = uniqueId(source, 'b');
        const last = lastTopItemLine(p);
        const { header, body } = bodyLines(source);
        const indent = last ? indentOf(last.text) : body[0] ? indentOf(body[0].text) || '    ' : '    ';
        const change = insertLineAfter(source, last ?? header, `${indent}${id}["${NEW_LABEL}"]`);
        return { change, label: `ブロック ${id} を追加`, focus: { kind: 'block-item', id } };
      },
    },
    {
      id: 'add-next',
      title: '＋ 次のブロック',
      arity: 1,
      appliesTo: ['block-item'],
      key: 'Tab',
      run(source, [ref]) {
        const p = parseBlock(source);
        const item = p.items.find((x) => x.id === ref.id);
        const group = p.groups.find((g) => g.id === ref.id);
        const id = uniqueId(source, 'b');
        const text = `${id}["${NEW_LABEL}"]`;
        // 同じ行の後ろに並べる（入れ子のブロックなら end の後ろの行に足す）
        const change = item ? { from: item.range.to, insert: ` ${text}` } : group?.close ? insertLineAfter(source, group.close, `${indentOf(group.close.text)}${text}`) : null;
        return change ? { change, label: `ブロック ${id} を ${ref.id} の次に追加`, focus: { kind: 'block-item', id } } : null;
      },
    },
    {
      id: 'add-inside',
      title: '＋ 中にブロック',
      arity: 1,
      appliesTo: ['block-item'],
      run(source, [ref]) {
        const group = parseBlock(source).groups.find((g) => g.id === ref.id);
        if (!group?.close) return null;
        const id = uniqueId(source, 'b');
        const change = { from: group.close.from, insert: `${indentOf(group.open.text)}    ${id}["${NEW_LABEL}"]\n` };
        return { change, label: `ブロック ${id} を ${ref.id} の中に追加`, focus: { kind: 'block-item', id } };
      },
    },
    {
      id: 'connect',
      title: '→ 矢印',
      arity: 2,
      appliesTo: ['block-item'],
      prompt: '矢印の先のブロックをクリックしてください（Esc で取り消し）',
      run(source, [a, b]) {
        const p = parseBlock(source);
        const last = [...p.edges.map((e) => e.line), lastTopItemLine(p)].filter((l): l is SourceLine => !!l).sort((x, y) => y.index - x.index)[0] ?? null;
        const indent = last ? indentOf(last.text) : '    ';
        return { change: insertLineAfter(source, last ?? bodyLines(source).header, `${indent}${a.id} --> ${b.id}`), label: `${a.id} → ${b.id} の矢印を追加` };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['block-item', 'edge'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'edge') {
          const e = parseBlock(source).edges[Number(ref.id)];
          return e ? { change: removeLine(source, e.line), label: `${e.from} → ${e.to} の矢印を削除` } : null;
        }
        const change = deleteBlock(source, ref.id);
        return change ? { change, label: `ブロック ${ref.id} を削除` } : null;
      },
    },
  ],
};

