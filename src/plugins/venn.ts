import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import type { ActionResult, DiagramPlugin, DiagramTarget, ElementRef, PropertyField, SourceRange } from './types';
import { withGeneric } from './generic';
import { applySpec, bodyLines, indentOf, insertLineAfter, uniqueId, type SourceLine } from './source';
import { removeLineSet } from './lineOps';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { t } from '../i18n';

// venn 図（venn-beta）のプラグイン。
// 1 行が 1 つの文で、set（集合）・union（重なり）・text（領域の中の項目）・style・title を書く。
// 字下げした「text <ID>[…]」は、直前の set / union に付く（mermaid の字句解析の状態で決まる。set / union の後、
// 字下げした text・空行・コメントだけが続く間）。それ以外の文がはさまると付かないので、行を足す位置はこの決まりに合わせる。
// SVG の集合・重なりは data-venn-sets（ID を並べ替えて _ でつないだもの）で、項目は領域ごとの並びとラベルで対応付ける。

const NEW_SET = t('ven.newSet');
const NEW_UNION = t('ven.newUnion');
const NEW_TEXT = t('ven.newText');

const ID = String.raw`(?:[A-Za-z_][A-Za-z0-9\-_]*|"[^"]*")`;
const NUM = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const LABEL = String.raw`(?<label>\["[^"]*"\]|\[[^\]"]+\])`;
const IDS = String.raw`(?<ids>${ID}(?:\s*,\s*${ID})*)`;
const END = String.raw`\s*(?:%%.*)?$`;
const SET_RE = new RegExp(String.raw`^\s*(?<kw>set|union)\s+${IDS}\s*${LABEL}?\s*(?<size>:\s*(?<num>${NUM}))?${END}`, 'di');
const ATTACHED_TEXT_RE = new RegExp(String.raw`^\s*text\s+(?<tid>${ID}|${NUM})\s*${LABEL}?${END}`, 'di');
const TEXT_RE = new RegExp(String.raw`^\s*text\s+${IDS}\s+(?<tid>${ID}|${NUM})\s*${LABEL}?${END}`, 'di');
const STYLE_RE = new RegExp(String.raw`^\s*style\s+${IDS}\s+(?<rest>.*?)\s*(?:%%.*)?$`, 'di');

export const VALID_VENN_ID = /^[A-Za-z_][A-Za-z0-9\-_]*$/;
const VALID_NUM = new RegExp(`^${NUM}$`);
const VALID_COLOR = /^(?:#[0-9a-fA-F]{3,8}|[A-Za-z_][A-Za-z0-9\-_]*|rgba?\(\s*[0-9.]+(?:\s*,\s*[0-9.]+){2,3}\s*\))$/;

export interface VennId {
  /** 引用符を外した値 */
  value: string;
  /** 引用符を含む範囲 */
  range: SourceRange;
}

export interface VennLabel {
  value: string;
  /** 前後の空白を除いた中身の範囲 */
  range: SourceRange;
  /** [ ] を含む範囲 */
  outer: SourceRange;
  quoted: boolean;
}

export interface VennSubset {
  kind: 'set' | 'union';
  line: SourceLine;
  ids: VennId[];
  /** 並べ替えた ID を , でつないだもの（集合なら ID そのもの） */
  key: string;
  label: VennLabel | null;
  /** :<大きさ>。clause は前の空白から数の終わりまで */
  size: { value: string; range: SourceRange; clause: SourceRange } | null;
  /** ID の並びの終わり（ラベル・大きさを足す位置） */
  idsEnd: number;
  /** この文に付いた（字下げした）text */
  texts: VennText[];
}

export interface VennText {
  index: number;
  line: SourceLine;
  /** 直前の set / union に付いた text か */
  owner: VennSubset | null;
  /** 書かれた集合の ID（付いた text では空） */
  ids: VennId[];
  /** 領域（並べ替えた ID を , でつないだもの） */
  key: string;
  tid: VennId;
  label: VennLabel | null;
}

interface StyleEntry {
  key: string;
  value: string;
  valueRange: SourceRange;
  /** key:value の範囲 */
  range: SourceRange;
}

export interface VennStyle {
  line: SourceLine;
  ids: VennId[];
  key: string;
  entries: StyleEntry[];
}

export interface ParsedVenn {
  subsets: VennSubset[];
  texts: VennText[];
  styles: VennStyle[];
}

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
const keyOf = (ids: string[]) => [...ids].sort().join(',');

function readIds(line: SourceLine, m: RegExpExecArray): VennId[] {
  const [start] = m.indices!.groups!.ids!;
  const text = m.groups!.ids!;
  const out: VennId[] = [];
  const re = new RegExp(ID, 'g');
  for (let x = re.exec(text); x; x = re.exec(text)) {
    out.push({ value: unquote(x[0]), range: { from: line.from + start + x.index, to: line.from + start + x.index + x[0].length } });
  }
  return out;
}

function readLabel(line: SourceLine, m: RegExpExecArray): VennLabel | null {
  const r = m.indices!.groups!.label;
  if (!r) return null;
  const raw = m.groups!.label!;
  const quoted = raw.startsWith('["');
  const q = quoted ? 2 : 1;
  const inner = raw.slice(q, raw.length - q);
  const lead = /^\s*/.exec(inner)![0].length;
  const value = inner.trim();
  const from = line.from + r[0] + q + lead;
  return { value, range: { from, to: from + value.length }, outer: { from: line.from + r[0], to: line.from + r[1] }, quoted };
}

function readTid(line: SourceLine, m: RegExpExecArray): VennId {
  const [a, b] = m.indices!.groups!.tid!;
  return { value: unquote(m.groups!.tid!), range: { from: line.from + a, to: line.from + b } };
}

/** style の key:value の並び（, で区切る。rgb(…) の中の , では区切らない） */
function readEntries(line: SourceLine, m: RegExpExecArray): StyleEntry[] {
  const [start] = m.indices!.groups!.rest!;
  const rest = m.groups!.rest!;
  const out: StyleEntry[] = [];
  let depth = 0;
  let quote = false;
  let from = 0;
  const push = (to: number) => {
    const part = rest.slice(from, to);
    const e = /^(\s*)([A-Za-z_][A-Za-z0-9\-_]*)\s*:\s*(.*?)\s*$/.exec(part);
    if (e) {
      const a = line.from + start + from + e[1].length;
      const vFrom = line.from + start + from + part.indexOf(e[3], e[1].length + e[2].length);
      out.push({ key: e[2], value: unquote(e[3]), valueRange: { from: vFrom, to: vFrom + e[3].length }, range: { from: a, to: vFrom + e[3].length } });
    }
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '"') quote = !quote;
    else if (quote) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(rest.length);
  return out;
}

export function parseVenn(source: string): ParsedVenn {
  const out: ParsedVenn = { subsets: [], texts: [], styles: [] };
  // mermaid の字句解析と同じく、set / union の後は字下げした text をその文に付ける。ほかの文が来たら付けない
  let owner: VennSubset | null = null;
  for (const line of bodyLines(source).body) {
    const indented = /^[ \t]/.test(line.text);
    if (indented && owner && /^\s*text\b/i.test(line.text)) {
      const m = ATTACHED_TEXT_RE.exec(line.text);
      if (m?.groups) {
        const text: VennText = { index: out.texts.length, line, owner, ids: [], key: owner.key, tid: readTid(line, m), label: readLabel(line, m) };
        out.texts.push(text);
        owner.texts.push(text);
      }
      continue;
    }
    owner = null;
    const s = SET_RE.exec(line.text);
    if (s?.groups) {
      const kind = s.groups.kw!.toLowerCase() as 'set' | 'union';
      const ids = readIds(line, s);
      if ((kind === 'set') !== (ids.length === 1)) continue;
      const label = readLabel(line, s);
      const g = s.indices!.groups!;
      const subset: VennSubset = {
        kind,
        line,
        ids,
        key: keyOf(ids.map((x) => x.value)),
        label,
        size: g.size
          ? {
              value: s.groups.num!,
              range: { from: line.from + g.num![0], to: line.from + g.num![1] },
              clause: { from: (label?.outer.to ?? ids.at(-1)!.range.to), to: line.from + g.num![1] },
            }
          : null,
        idsEnd: ids.at(-1)!.range.to,
        texts: [],
      };
      out.subsets.push(subset);
      owner = subset;
      continue;
    }
    const x = TEXT_RE.exec(line.text);
    if (x?.groups) {
      const ids = readIds(line, x);
      out.texts.push({ index: out.texts.length, line, owner: null, ids, key: keyOf(ids.map((i) => i.value)), tid: readTid(line, x), label: readLabel(line, x) });
      continue;
    }
    const st = STYLE_RE.exec(line.text);
    if (st?.groups) {
      const ids = readIds(line, st);
      out.styles.push({ line, ids, key: keyOf(ids.map((i) => i.value)), entries: readEntries(line, st) });
    }
  }
  return out;
}

/** ラベルの比較用（venn.js は空白で折り返し、行ごとに tspan に分ける） */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function svgLabel(text: Element): string {
  const spans = [...text.querySelectorAll('tspan')];
  return norm(spans.length ? spans.map((s) => s.textContent ?? '').join(' ') : (text.textContent ?? ''));
}

const subsetRef = (s: VennSubset): ElementRef => ({ kind: s.kind, id: s.kind === 'set' ? s.ids[0].value : s.key });
const textRef = (x: VennText): ElementRef => ({ kind: 'vtext', id: String(x.index) });
/** 項目に出る文字（ラベルが無ければ ID） */
const shown = (x: VennText) => norm(x.label?.value ?? x.tid.value);

function findSubset(p: ParsedVenn, r: ElementRef | null): VennSubset | undefined {
  if (!r || (r.kind !== 'set' && r.kind !== 'union')) return undefined;
  return p.subsets.find((s) => s.kind === r.kind && subsetRef(s).id === r.id);
}

const findText = (p: ParsedVenn, r: ElementRef | null) => (r?.kind === 'vtext' ? p.texts[Number(r.id)] : undefined);

/** 文とそれに付いた text の最後の行 */
const blockEnd = (s: VennSubset) => s.texts.at(-1)?.line ?? s.line;

/** 新しい set / union を置く位置（最後の set / union と、それに付いた text の後ろ。無ければ本文の最後） */
function subsetInsertPoint(source: string, p: ParsedVenn): { after: SourceLine | null; indent: string } {
  const last = p.subsets.at(-1);
  const { header, body } = bodyLines(source);
  if (last) return { after: blockEnd(last), indent: indentOf(last.line.text) };
  return { after: body.at(-1) ?? header, indent: body[0] ? indentOf(body[0].text) || '    ' : '    ' };
}

/** ラベルに書けない文字（" と改行）を置き換える */
const cleanLabel = (v: string) => v.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();

/** ラベルを変える変更。label が無ければ at に ["…"] を差し込む。空なら [ ] ごと消す */
function labelChange(label: VennLabel | null, at: number, value: string): ChangeSpec | null {
  const v = cleanLabel(value);
  if (!label) return v ? { from: at, insert: `["${v}"]` } : null;
  if (!v) return label.outer;
  if (!label.quoted && /[\]]/.test(v)) return { ...label.outer, insert: `["${v}"]` };
  return { ...label.range, insert: v };
}

/** 大きさを変える変更 */
function sizeChange(s: VennSubset, value: string): ChangeSpec | null {
  const v = value.trim();
  if (!v) return s.size ? s.size.clause : null;
  if (!VALID_NUM.test(v) || !(Number(v) >= 0) || (s.kind === 'set' && Number(v) === 0)) return null;
  if (s.size) return { ...s.size.range, insert: v };
  return { from: s.label?.outer.to ?? s.idsEnd, insert: `:${v}` };
}

/** 領域（key）の塗りの色。後に書いた style が勝つ */
function fillOf(p: ParsedVenn, key: string): { style: VennStyle; entry: StyleEntry } | null {
  let found: { style: VennStyle; entry: StyleEntry } | null = null;
  for (const style of p.styles) {
    if (style.key !== key) continue;
    for (const entry of style.entries) if (entry.key.toLowerCase() === 'fill') found = { style, entry };
  }
  return found;
}

function fillChange(source: string, p: ParsedVenn, s: VennSubset, value: string): ChangeSpec | null {
  const v = value.trim();
  const cur = fillOf(p, s.key);
  if (!v) {
    if (!cur) return null;
    const { style, entry } = cur;
    if (style.entries.length === 1) return removeLineSet(source, new Set([style.line.index]));
    // 他の指定は残す（前の , ごと消す。最初の指定なら後ろの , ごと）
    const i = style.entries.indexOf(entry);
    if (i > 0) return { from: style.entries[i - 1].range.to, to: entry.range.to };
    return { from: entry.range.from, to: style.entries[1].range.from };
  }
  if (!VALID_COLOR.test(v)) return null;
  if (cur) return { ...cur.entry.valueRange, insert: v };
  const same = p.styles.filter((x) => x.key === s.key && x.entries.length > 0).at(-1);
  if (same) return { from: same.entries.at(-1)!.range.to, insert: `, fill:${v}` };
  const { header, body } = bodyLines(source);
  const indent = body[0] ? indentOf(body[0].text) : '    ';
  return insertLineAfter(source, body.at(-1) ?? header, `${indent}style ${s.ids.map((x) => source.slice(x.range.from, x.range.to)).join(',')} fill:${v}`);
}

/** 集合の ID をすべて変える（宣言・union・text・style の ID の並び） */
function renameSet(p: ParsedVenn, from: string, to: string): ChangeSpec[] | null {
  if (to === from || !VALID_VENN_ID.test(to) || p.subsets.some((s) => s.kind === 'set' && s.ids[0].value === to)) return null;
  const out: ChangeSpec[] = [];
  const lists = [...p.subsets.map((s) => s.ids), ...p.texts.map((x) => x.ids), ...p.styles.map((x) => x.ids)];
  for (const ids of lists) for (const id of ids) if (id.value === from) out.push({ ...id.range, insert: to });
  return out.length ? out : null;
}

const TITLE: KeywordSpec = { id: 'title', label: t('ven.field.title'), keyword: 'title' };

/** 足した行の中の要素（変更を当てたソースを読み直し、差し込んだ位置にある要素） */
function addedAt<T extends { line: SourceLine }>(source: string, change: { from: number; insert: string }, pick: (p: ParsedVenn) => T[]): T | undefined {
  const after = parseVenn(applySpec(source, change));
  const at = change.from + 1;
  return pick(after).find((x) => x.line.from === at);
}

/**
 * 項目（text）を、集合・重なり r の領域へ移す（ドラッグでの移動）。
 * 元の行を消し、移す先の set / union の行に付く字下げした text として書き直す（add-text と同じ位置）
 */
function moveText(source: string, tr: ElementRef, r: ElementRef): ActionResult | null {
  const p = parseVenn(source);
  const x = findText(p, tr);
  const s = findSubset(p, r);
  if (!x || !s || x.key === s.key) return null;
  const statement = `text ${source.slice(x.tid.range.from, x.line.to).trimEnd()}`;
  // 消してから、消した後のソースで足す（足す位置が消す行と重ならないように）
  const removal = ChangeSet.of(removeLineSet(source, new Set([x.line.index])), source.length);
  const mid = applySpec(source, removal);
  const q = parseVenn(mid);
  const to = findSubset(q, r);
  if (!to) return null;
  const indent = to.texts.length ? indentOf(to.texts.at(-1)!.line.text) : `${indentOf(to.line.text)}    `;
  const insert = insertLineAfter(mid, blockEnd(to), `${indent}${statement}`);
  const change = removal.compose(ChangeSet.of(insert, mid.length));
  const moved = addedAt(mid, insert, (z) => z.texts);
  return { change, label: t('ven.history.moveText'), select: moved ? textRef(moved) : undefined };
}

export const vennPlugin: DiagramPlugin = {
  type: 'venn',

  mapTargets(svg, source) {
    const p = parseVenn(source);
    const mapped: DiagramTarget[] = [];
    // 集合・重なり: data-venn-sets は並べ替えた ID を _ でつないだもの（ID に _ を含みうるので、分けずに文字列として比べる）
    const used = new Set<VennSubset>();
    svg.querySelectorAll('g.venn-area[data-venn-sets]').forEach((g, i) => {
      const key = g.getAttribute('data-venn-sets')!;
      const kind = g.classList.contains('venn-circle') ? 'set' : 'union';
      const cands = p.subsets.filter((s) => s.kind === kind && [...s.ids.map((x) => x.value)].sort().join('_') === key);
      // 同じ領域を 2 度書いたものは、どちらの行か決められないので対応付けない
      if (cands.length !== 1 || used.has(cands[0])) return;
      const s = cands[0];
      used.add(s);
      const labelEl = g.querySelector('text') ?? g;
      const label = svgLabel(labelEl);
      const target: DiagramTarget = { id: `venn-${kind}-${i}`, el: g, labelEl, label, range: null, ref: subsetRef(s) };
      if (s.label) {
        if (norm(s.label.value) === label) target.range = s.label.range;
      } else {
        target.insertAt = { at: s.idsEnd, prefix: '["', suffix: '"]' };
      }
      mapped.push(target);
    });
    // 項目: 領域ごとに、ソースで最初に出てきた順に描かれる。領域の中はソースの順。並びのラベルが合う領域を前から探す
    const areas: VennText[][] = [];
    const byKey = new Map<string, VennText[]>();
    for (const x of p.texts) {
      let list = byKey.get(x.key);
      if (!list) {
        list = [];
        byKey.set(x.key, list);
        areas.push(list);
      }
      list.push(x);
    }
    let next = 0;
    svg.querySelectorAll('g.venn-text-area').forEach((area) => {
      const fos = [...area.querySelectorAll('foreignObject')];
      const labels = fos.map((fo) => norm(fo.textContent ?? ''));
      const k = areas.findIndex((list, j) => j >= next && list.length === labels.length && list.every((x, n) => shown(x) === labels[n]));
      if (k < 0) return;
      next = k + 1;
      areas[k].forEach((x, n) => {
        const fo = fos[n];
        const target: DiagramTarget = { id: `venn-text-${x.index}`, el: fo, labelEl: fo, label: labels[n], range: null, ref: textRef(x) };
        if (x.label) target.range = x.label.range;
        else target.insertAt = { at: x.tid.range.to, prefix: '["', suffix: '"]' };
        mapped.push(target);
      });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, r): PropertyField[] {
    if (!r) return keywordFields(source, [TITLE]);
    const p = parseVenn(source);
    const s = findSubset(p, r);
    if (s) {
      const fields: PropertyField[] = [];
      if (s.kind === 'set') fields.push({ id: 'id', label: t('ven.field.id'), type: 'text', value: s.ids[0].value, commitOnBlur: true });
      else fields.push({ id: 'sets', label: t('ven.field.sets'), type: 'text', value: s.ids.map((x) => x.value).join(', '), readonly: true });
      fields.push(
        { id: 'label', label: t('ven.field.label'), type: 'text', value: s.label?.value ?? '', placeholder: s.kind === 'set' ? s.ids[0].value : '' },
        { id: 'size', label: t('ven.field.size'), type: 'number', value: s.size?.value ?? '' },
        { id: 'fill', label: t('ven.field.fill'), type: 'color', value: fillOf(p, s.key)?.entry.value ?? '' },
      );
      return fields;
    }
    const x = findText(p, r);
    if (!x) return [];
    return [
      { id: 'label', label: t('ven.field.label'), type: 'text', value: x.label?.value ?? '', placeholder: x.tid.value },
      { id: 'sets', label: t('ven.field.area'), type: 'text', value: x.key.split(',').join(', '), readonly: true },
    ];
  },

  setProperty(source, r, field, value) {
    if (!r) {
      // title は # と ; を書けない（mermaid の字句の規則）
      return field === 'title' ? setKeyword(source, TITLE, value.replace(/[#;\r\n]+/g, ' ').trim()) : null;
    }
    const p = parseVenn(source);
    const s = findSubset(p, r);
    if (s) {
      if (field === 'id' && s.kind === 'set') return renameSet(p, s.ids[0].value, value.trim());
      if (field === 'label') return labelChange(s.label, s.idsEnd, value);
      if (field === 'size') return sizeChange(s, value);
      if (field === 'fill') return fillChange(source, p, s, value);
      return null;
    }
    const x = findText(p, r);
    if (x && field === 'label') return labelChange(x.label, x.tid.range.to, value);
    return null;
  },

  actions: [
    {
      id: 'add-set',
      title: t('ven.action.addSet'),
      arity: 0,
      run(source) {
        const p = parseVenn(source);
        const id = uniqueId(source, 'S');
        const { after, indent } = subsetInsertPoint(source, p);
        const change = insertLineAfter(source, after, `${indent}set ${id}["${NEW_SET}"]`);
        return { change, label: t('ven.history.addSet', { id }), focus: { kind: 'set', id } };
      },
    },
    {
      id: 'add-next',
      title: t('ven.action.addNext'),
      arity: 1,
      appliesTo: ['set'],
      key: 'Tab',
      run(source, [r]) {
        const p = parseVenn(source);
        const s = findSubset(p, r);
        if (!s) return null;
        const id = uniqueId(source, 'S');
        // 選んだ集合に付いた項目の後ろに置く（間に置くと、項目が新しい集合に付いてしまう）
        const change = insertLineAfter(source, blockEnd(s), `${indentOf(s.line.text)}set ${id}["${NEW_SET}"]`);
        return { change, label: t('ven.history.addSet', { id }), focus: { kind: 'set', id } };
      },
    },
    {
      id: 'add-union',
      title: t('ven.action.addUnion'),
      arity: 2,
      appliesTo: ['set'],
      targetKinds: ['set'],
      prompt: t('ven.prompt.union'),
      run(source, [ra, rb]) {
        const p = parseVenn(source);
        const a = findSubset(p, ra);
        const b = findSubset(p, rb);
        if (!a || !b || a === b || a.kind !== 'set' || b.kind !== 'set') return null;
        const key = keyOf([a.ids[0].value, b.ids[0].value]);
        if (p.subsets.some((s) => s.key === key)) return null;
        // どちらの集合よりも後ろに置く（union は宣言済みの集合しか使えない）
        const { after, indent } = subsetInsertPoint(source, p);
        const raw = (s: VennSubset) => source.slice(s.ids[0].range.from, s.ids[0].range.to);
        const change = insertLineAfter(source, after, `${indent}union ${raw(a)},${raw(b)}["${NEW_UNION}"]`);
        const ids = `${a.ids[0].value}, ${b.ids[0].value}`;
        return { change, label: t('ven.history.addUnion', { ids }), focus: { kind: 'union', id: key } };
      },
    },
    {
      id: 'add-text',
      title: t('ven.action.addText'),
      arity: 1,
      appliesTo: ['set', 'union', 'vtext'],
      run(source, [r]) {
        const p = parseVenn(source);
        const x = findText(p, r);
        const tid = uniqueId(source, 't');
        let change: { from: number; insert: string };
        if (x && !x.owner) {
          // 領域を書いた項目の次に、同じ領域の項目を足す（字下げしない。字下げすると前の文に付いてしまう）
          const ids = x.ids.map((i) => source.slice(i.range.from, i.range.to)).join(',');
          change = insertLineAfter(source, x.line, `text ${ids} ${tid}["${NEW_TEXT}"]`);
        } else {
          const s = x?.owner ?? findSubset(p, r);
          if (!s) return null;
          const indent = s.texts.length ? indentOf(s.texts.at(-1)!.line.text) : `${indentOf(s.line.text)}    `;
          change = insertLineAfter(source, blockEnd(s), `${indent}text ${tid}["${NEW_TEXT}"]`);
        }
        const added = addedAt(source, change, (q) => q.texts);
        return { change, label: t('ven.history.addText'), focus: added ? textRef(added) : undefined };
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['set', 'union', 'vtext'],
      key: 'Delete',
      danger: true,
      run(source, [r]) {
        const p = parseVenn(source);
        const x = findText(p, r);
        if (x) return { change: removeLineSet(source, new Set([x.line.index])), label: t('ven.history.deleteText') };
        const s = findSubset(p, r);
        if (!s) return null;
        const lines = new Set<number>();
        // 集合を消すときは、それを含む重なりも消す（宣言の無い集合を union に書くと、構文の誤りになる）
        const gone = s.kind === 'set' ? p.subsets.filter((u) => u.ids.some((i) => i.value === s.ids[0].value)) : [s];
        const goneKeys = new Set(gone.map((u) => u.key));
        for (const u of gone) {
          lines.add(u.line.index);
          // 付いた項目も消す（残すと、前の文に付いてしまう）
          for (const t2 of u.texts) lines.add(t2.line.index);
        }
        // 消した領域を指す style と項目も消す
        const touches = (key: string) => goneKeys.has(key) || (s.kind === 'set' && key.split(',').includes(s.ids[0].value));
        for (const st of p.styles) if (touches(st.key)) lines.add(st.line.index);
        for (const t2 of p.texts) if (!t2.owner && touches(t2.key)) lines.add(t2.line.index);
        const label = s.kind === 'set' ? t('ven.history.deleteSet', { id: s.ids[0].value }) : t('ven.history.deleteUnion', { ids: s.ids.map((i) => i.value).join(', ') });
        return { change: removeLineSet(source, lines), label };
      },
    },
  ],

  // ドラッグ: 項目を、集合・重なりの領域の中へ移す（領域の位置と大きさは mermaid が決めるので、領域の間の移動だけ）
  reorder: {
    axis: (source, r) => (findText(parseVenn(source), r) ? 'xy' : null),
    acceptsInto: (_source, r, container) => r.kind === 'vtext' && (container?.kind === 'set' || container?.kind === 'union'),
    into: (source, r, container) => (container ? moveText(source, r, container) : null),
    shaped: true,
  },
};
