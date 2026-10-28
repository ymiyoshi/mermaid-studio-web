import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { withValue, type DiagramPlugin, type DiagramTarget, type ElementRef, type PropertyField, type SourceRange } from './types';
import { withGeneric } from './generic';
import { applySpec, bodyLines, indentOf, insertLineAfter, type SourceLine } from './source';
import { removeLine, removeLineSet } from './lineOps';
import { addHitArea } from './svg';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { t } from '../i18n';

// cynefin 図（cynefin-beta）のプラグイン。
// 領域（complex など）の行に続けて、項目を "…" で書く（1 行に何個でも、領域の行に続けても書ける）。
// 遷移は「from --> to : "ラベル"」。同じ領域を 2 度書くと、後のものが前のものを置き換える（描かれるのは最後のものだけ）。
// SVG の項目は、領域の決まった順（complex・complicated・chaotic・clear・confusion）に、領域の中はソースの順に描かれるので、
// その順に並べて文言が合うことを確かめて対応付ける。遷移の線は、自分自身への遷移を除いたソースの順。

export const DOMAINS = ['complex', 'complicated', 'clear', 'chaotic', 'confusion'] as const;
export type Domain = (typeof DOMAINS)[number];
/** mermaid が項目を描く順 */
const DRAW_ORDER: Domain[] = ['complex', 'complicated', 'chaotic', 'clear', 'confusion'];
/** confusion の領域に描く項目の数（残りは「+N more」にまとめる） */
const MAX_CONFUSION_ITEMS = 3;

const NEW_ITEM = t('cyn.newItem');
const NEW_TRANSITION = t('cyn.newTransition');

const DOMAIN = '(?:complex|complicated|clear|chaotic|confusion)';
const STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const TRANSITION_RE = new RegExp(String.raw`^\s*(?<from>${DOMAIN})\s*-->\s*(?<to>${DOMAIN})(?<clause>\s*:\s*(?<label>${STRING}))?\s*(?:%%.*)?$`, 'd');
const DOMAIN_RE = new RegExp(String.raw`^\s*(?<name>${DOMAIN})(?=\s|"|'|%%|$)`);

export interface CynefinString {
  /** 引用符を外し、\ の書き方を戻した値（図に出る文字） */
  value: string;
  /** 引用符を含む範囲 */
  token: SourceRange;
  /** 引用符の内側の範囲 */
  range: SourceRange;
  quote: string;
  /** \ を含む（ソースの文字と図の文字が違う） */
  escaped: boolean;
}

export interface CynefinItem extends CynefinString {
  index: number;
  line: SourceLine;
  block: CynefinBlock;
}

export interface CynefinBlock {
  domain: Domain;
  /** 領域の名前の行 */
  line: SourceLine;
  /** 領域の名前の行と、項目だけの行 */
  lines: SourceLine[];
  items: CynefinItem[];
}

export interface CynefinTransition {
  index: number;
  line: SourceLine;
  from: { value: Domain; range: SourceRange };
  to: { value: Domain; range: SourceRange };
  label: CynefinString | null;
  /** : "ラベル" の部分（前の空白を含む） */
  clause: SourceRange | null;
}

export interface ParsedCynefin {
  blocks: CynefinBlock[];
  items: CynefinItem[];
  transitions: CynefinTransition[];
}

function unescape(raw: string): string {
  const map: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0' };
  return raw.replace(/\\(.)/gs, (_, c: string) => map[c] ?? c);
}

/** 文字列の値を、引用符 quote で囲んで書く形にする（改行は空白にし、\ と引用符は \ で書く） */
export function quoteString(value: string, quote = '"'): string {
  const v = value.replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`);
  return `${quote}${v}${quote}`;
}

function readString(line: SourceLine, at: number, raw: string): CynefinString {
  const from = line.from + at;
  return {
    value: unescape(raw.slice(1, -1)),
    token: { from, to: from + raw.length },
    range: { from: from + 1, to: from + raw.length - 1 },
    quote: raw[0],
    escaped: raw.includes('\\'),
  };
}

/** 行の at から後ろが、文字列だけ（とコメント）なら、その文字列。それ以外が混ざれば null */
function readStrings(line: SourceLine, at: number): CynefinString[] | null {
  const out: CynefinString[] = [];
  const re = new RegExp(String.raw`\s*(?:(${STRING})|(%%.*)|$)`, 'y');
  re.lastIndex = at;
  for (;;) {
    const m = re.exec(line.text);
    if (!m) return null;
    if (m[1] !== undefined) {
      out.push(readString(line, m.index + m[0].length - m[1].length, m[1]));
      continue;
    }
    return out;
  }
}

export function parseCynefin(source: string): ParsedCynefin {
  const out: ParsedCynefin = { blocks: [], items: [], transitions: [] };
  let block: CynefinBlock | null = null;
  let inAccDescr = false;
  for (const line of bodyLines(source).body) {
    if (inAccDescr) {
      if (line.text.includes('}')) inAccDescr = false;
      continue;
    }
    if (/^\s*accDescr\s*\{/.test(line.text)) {
      inAccDescr = !line.text.includes('}');
      block = null;
      continue;
    }
    const tr = TRANSITION_RE.exec(line.text);
    if (tr?.groups) {
      const g = tr.indices!.groups!;
      const at = (r: [number, number]) => ({ from: line.from + r[0], to: line.from + r[1] });
      out.transitions.push({
        index: out.transitions.length,
        line,
        from: { value: tr.groups.from as Domain, range: at(g.from!) },
        to: { value: tr.groups.to as Domain, range: at(g.to!) },
        label: g.label ? readString(line, g.label[0], tr.groups.label!) : null,
        clause: g.clause ? at(g.clause) : null,
      });
      block = null;
      continue;
    }
    const d = DOMAIN_RE.exec(line.text);
    const strings = d ? readStrings(line, d[0].length) : block ? readStrings(line, 0) : null;
    if (d && strings) {
      block = { domain: d.groups!.name as Domain, line, lines: [line], items: [] };
      out.blocks.push(block);
    } else if (block && strings && !d) {
      block.lines.push(line);
    } else {
      block = null;
      continue;
    }
    for (const s of strings) {
      const item: CynefinItem = { ...s, index: out.items.length, line, block };
      block.items.push(item);
      out.items.push(item);
    }
  }
  return out;
}

/** 描かれる（最後に書いた）領域のブロック */
const effectiveBlock = (p: ParsedCynefin, domain: Domain) => p.blocks.filter((b) => b.domain === domain).at(-1);

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const itemRef = (x: CynefinItem): ElementRef => ({ kind: 'item', id: String(x.index) });
const transitionRef = (x: CynefinTransition): ElementRef => ({ kind: 'transition', id: String(x.index) });
const isDomain = (v: string): v is Domain => (DOMAINS as readonly string[]).includes(v);
const DOMAIN_NAMES: Record<Domain, string> = {
  complex: t('cyn.domain.complex'),
  complicated: t('cyn.domain.complicated'),
  clear: t('cyn.domain.clear'),
  chaotic: t('cyn.domain.chaotic'),
  confusion: t('cyn.domain.confusion'),
};
const domainName = (d: Domain) => DOMAIN_NAMES[d];
const domainOptions = () => DOMAINS.map((d) => ({ value: d, label: domainName(d) }));

const findItem = (p: ParsedCynefin, r: ElementRef | null) => (r?.kind === 'item' ? p.items[Number(r.id)] : undefined);
const findTransition = (p: ParsedCynefin, r: ElementRef | null) => (r?.kind === 'transition' ? p.transitions[Number(r.id)] : undefined);

const num = (el: Element, a: string) => Number(el.getAttribute(a));

/** 領域の名前の要素と、その背景・説明文（クリックの当たり判定に使う） */
function domainTargets(svg: SVGSVGElement): DiagramTarget[] {
  const out: DiagramTarget[] = [];
  const rects = [...svg.querySelectorAll('g.cynefin-backgrounds rect.cynefinDomain')];
  const subtitles = [...svg.querySelectorAll('g.cynefin-subtitles text.cynefinSubtitle')];
  const overflow = svg.querySelector('g.cynefin-items rect.cynefinItemOverflow')?.parentElement;
  svg.querySelectorAll('g.cynefin-labels text.cynefinDomainLabel').forEach((label) => {
    const name = (label.textContent ?? '').trim().toLowerCase();
    if (!isDomain(name)) return;
    const x = num(label, 'x');
    const y = num(label, 'y');
    const hits: Element[] = [];
    if (name === 'confusion') {
      const area = svg.querySelector('path.cynefinConfusion');
      if (area) hits.push(area);
      hits.push(...subtitles.filter((s) => num(s, 'x') === x));
      if (overflow) hits.push(overflow);
    } else {
      const inside = (el: Element, ex: number, ey: number) =>
        ex >= num(el, 'x') && ex <= num(el, 'x') + num(el, 'width') && ey >= num(el, 'y') && ey <= num(el, 'y') + num(el, 'height');
      const rect = rects.find((r) => inside(r, x, y));
      if (rect) {
        hits.push(rect);
        hits.push(...subtitles.filter((s) => num(s, 'x') === x && inside(rect, num(s, 'x'), num(s, 'y'))));
      }
    }
    out.push({ id: `cynefin-domain-${name}`, el: label, hits, labelEl: label, label: label.textContent ?? '', range: null, ref: { kind: 'domain', id: name } });
  });
  return out;
}

/** 項目を消す変更（行に他の文字が無ければ行ごと消す。領域の名前の行は残す） */
function removeItem(source: string, x: CynefinItem): ChangeSpec {
  const onLine = x.block.items.filter((i) => i.line === x.line);
  if (onLine.length === 1 && x.line !== x.block.line && !/%%/.test(x.line.text.slice(x.token.to - x.line.from))) return removeLine(source, x.line);
  const before = /[ \t]*$/.exec(source.slice(x.line.from, x.token.from))![0].length;
  // 行の最初の項目なら、字下げを残して後ろの空白ごと消す
  if (x.token.from - before === x.line.from) {
    const after = /^[ \t]*/.exec(source.slice(x.token.to, x.line.to))![0].length;
    return { from: x.token.from, to: x.token.to + after };
  }
  return { from: x.token.from - before, to: x.token.to };
}

/** 領域 domain の最後に項目 token を足す変更（その領域が無ければ、領域の行ごと足す） */
function appendItem(source: string, p: ParsedCynefin, domain: Domain, token: string): { from: number; insert: string } {
  const b = effectiveBlock(p, domain);
  if (b) {
    const last = b.lines.at(-1)!;
    const indent = last !== b.line ? indentOf(last.text) : `${indentOf(b.line.text)}    `;
    return insertLineAfter(source, last, `${indent}${token}`);
  }
  // 最後のブロックの後ろ（無ければ本文の最後）に、領域の行と項目の行を足す
  const lastBlock = p.blocks.at(-1);
  const { header, body } = bodyLines(source);
  const after = lastBlock?.lines.at(-1) ?? body.at(-1) ?? header;
  const indent = lastBlock ? indentOf(lastBlock.line.text) : '';
  return insertLineAfter(source, after, `${indent}${domain}\n${indent}    ${token}`);
}

/** 変更を当てたソースで、差し込んだ位置 at 以降で最初の項目 */
function itemAfter(source: string, change: ChangeSpec, at: number): ElementRef | undefined {
  const item = parseCynefin(applySpec(source, change)).items.find((x) => x.token.from >= at);
  return item ? itemRef(item) : undefined;
}

/** 同じ領域の中で、項目を前後の項目と入れ替える */
function swapItem(source: string, r: ElementRef, delta: -1 | 1) {
  const p = parseCynefin(source);
  const x = findItem(p, r);
  if (!x) return null;
  const k = x.block.items.indexOf(x);
  const y = x.block.items[k + delta];
  if (!y) return null;
  const text = (s: CynefinItem) => source.slice(s.token.from, s.token.to);
  return {
    change: [
      { ...x.token, insert: text(y) },
      { ...y.token, insert: text(x) },
    ],
    label: t('cyn.history.move'),
    select: itemRef(y),
  };
}

/** 項目を別の項目の前（before）か後ろへ動かす（ドラッグでの移動。別の領域の項目の前後なら、その領域へ移す） */
function moveItem(source: string, r: ElementRef, target: ElementRef, before: boolean) {
  const p = parseCynefin(source);
  const x = findItem(p, r);
  const y = findItem(p, target);
  if (!x || !y || x === y) return null;
  const text = source.slice(x.token.from, x.token.to);
  const insert = before ? { from: y.token.from, insert: `${text} ` } : { from: y.token.to, insert: ` ${text}` };
  const change = [removeItem(source, x), insert];
  if (applySpec(source, change) === source) return null;
  const at = ChangeSet.of(change, source.length).mapPos(insert.from, -1) + (before ? 0 : 1);
  return { change, label: t('cyn.history.move'), select: itemAfter(source, change, at) };
}

const TITLE: KeywordSpec = { id: 'title', label: t('cyn.field.title'), keyword: 'title' };

export const cynefinPlugin: DiagramPlugin = {
  type: 'cynefin',

  mapTargets(svg, source) {
    const p = parseCynefin(source);
    const mapped: DiagramTarget[] = domainTargets(svg);
    // 項目: 描かれる順に並べ、文言が合うときだけ対応付ける
    const order: CynefinItem[] = [];
    for (const d of DRAW_ORDER) {
      const items = effectiveBlock(p, d)?.items ?? [];
      order.push(...(d === 'confusion' ? items.slice(0, MAX_CONFUSION_ITEMS) : items));
    }
    const groups = [...svg.querySelectorAll('g.cynefin-items > g')].filter((g) => !g.querySelector('.cynefinItemOverflow'));
    const texts = groups.map((g) => g.querySelector('text.cynefinItemText'));
    if (groups.length === order.length && order.every((x, i) => texts[i] && norm(texts[i]!.textContent ?? '') === norm(x.value))) {
      groups.forEach((g, i) => {
        const x = order[i];
        const labelEl = texts[i]!;
        // \ で書いた文字があると、ソースの文字と図の文字が違うので、図からは直接編集しない
        mapped.push({ id: `cynefin-item-${x.index}`, el: g, labelEl, label: labelEl.textContent ?? '', range: x.escaped ? null : x.range, ref: itemRef(x) });
      });
    }
    // 遷移: 自分自身への遷移は描かれない。ラベルのある遷移だけ、線の直後にラベルの text がある
    const drawn = p.transitions.filter((x) => x.from.value !== x.to.value);
    const paths = [...svg.querySelectorAll('g.cynefin-arrows path.cynefinArrowLine')];
    const labels = paths.map((path) => {
      const next = path.nextElementSibling;
      return next?.matches('text.cynefinArrowLabel') ? next : null;
    });
    const ok = paths.length === drawn.length && drawn.every((x, i) => (x.label?.value ? !!labels[i] && norm(labels[i]!.textContent ?? '') === norm(x.label.value) : !labels[i]));
    if (ok) {
      paths.forEach((path, i) => {
        const x = drawn[i];
        const labelEl = labels[i];
        const target: DiagramTarget = {
          id: `cynefin-transition-${x.index}`,
          el: path,
          hits: [addHitArea(path), ...(labelEl ? [labelEl] : [])],
          labelEl: labelEl ?? path,
          label: labelEl?.textContent ?? '',
          range: x.label && !x.label.escaped ? x.label.range : null,
          ref: transitionRef(x),
        };
        if (!x.label) target.insertAt = { at: x.to.range.to, prefix: ' : "', suffix: '"' };
        mapped.push(target);
      });
    }
    return withGeneric(svg, source, mapped);
  },

  inspect(source, r): PropertyField[] {
    if (!r) return keywordFields(source, [TITLE]);
    const p = parseCynefin(source);
    if (r.kind === 'domain' && isDomain(r.id)) {
      return [
        { id: 'name', label: t('cyn.field.domain'), type: 'text', value: domainName(r.id), readonly: true },
        { id: 'count', label: t('cyn.field.count'), type: 'text', value: String(effectiveBlock(p, r.id)?.items.length ?? 0), readonly: true },
      ];
    }
    const x = findItem(p, r);
    if (x) {
      return [
        { id: 'label', label: t('cyn.field.text'), type: 'text', value: x.value },
        { id: 'domain', label: t('cyn.field.domain'), type: 'select', value: x.block.domain, options: domainOptions() },
      ];
    }
    const tr = findTransition(p, r);
    if (!tr) return [];
    return [
      { id: 'from', label: t('cyn.field.from'), type: 'select', value: tr.from.value, options: withValue(domainOptions(), tr.from.value) },
      { id: 'to', label: t('cyn.field.to'), type: 'select', value: tr.to.value, options: withValue(domainOptions(), tr.to.value) },
      { id: 'label', label: t('cyn.field.label'), type: 'text', value: tr.label?.value ?? '' },
    ];
  },

  setProperty(source, r, field, value) {
    if (!r) return field === 'title' ? setKeyword(source, TITLE, value.replace(/[\r\n]+/g, ' ').replace(/%%/g, '%').trim()) : null;
    const p = parseCynefin(source);
    const x = findItem(p, r);
    if (x) {
      if (field === 'label') {
        // 空の項目は中身の無い札になるだけなので反映しない
        if (!value.trim()) return null;
        return { ...x.token, insert: quoteString(value, x.quote) };
      }
      if (field === 'domain') {
        if (!isDomain(value) || value === x.block.domain) return null;
        // 消してから、消した後のソースで足す（足す位置が消す行と重ならないように）
        const removal = ChangeSet.of(removeItem(source, x), source.length);
        const mid = applySpec(source, removal);
        const add = ChangeSet.of(appendItem(mid, parseCynefin(mid), value, source.slice(x.token.from, x.token.to)), mid.length);
        return removal.compose(add);
      }
      return null;
    }
    const tr = findTransition(p, r);
    if (!tr) return null;
    if (field === 'from' || field === 'to') {
      // 自分自身への遷移は mermaid が描かないので作らない
      if (!isDomain(value) || value === (field === 'from' ? tr.to.value : tr.from.value)) return null;
      return { ...tr[field].range, insert: value };
    }
    if (field === 'label') {
      const v = value.replace(/[\r\n]+/g, ' ').trim();
      if (!v) return tr.clause;
      if (tr.label) return { ...tr.label.token, insert: quoteString(v, tr.label.quote) };
      return { from: tr.to.range.to, insert: ` : ${quoteString(v)}` };
    }
    return null;
  },

  actions: [
    {
      id: 'add-item',
      title: t('cyn.action.addItem'),
      arity: 1,
      appliesTo: ['domain', 'item'],
      key: 'Tab',
      run(source, [r]) {
        const p = parseCynefin(source);
        const token = quoteString(NEW_ITEM);
        let change: { from: number; insert: string };
        const x = findItem(p, r);
        if (x) {
          const last = x.block.items.filter((i) => i.line === x.line).at(-1) === x;
          // 行の最後の項目なら次の行に、そうでなければ同じ行のすぐ後ろに足す（並びの順を保つ）
          change = last && x.line !== x.block.line ? insertLineAfter(source, x.line, `${indentOf(x.line.text)}${token}`) : { from: x.token.to, insert: ` ${token}` };
        } else if (r.kind === 'domain' && isDomain(r.id)) {
          change = appendItem(source, p, r.id, token);
        } else {
          return null;
        }
        const domain = x?.block.domain ?? (r.id as Domain);
        return { change, label: t('cyn.history.addItem', { domain: domainName(domain) }), focus: itemAfter(source, change, change.from) };
      },
    },
    {
      id: 'connect',
      title: t('cyn.action.connect'),
      arity: 2,
      appliesTo: ['domain'],
      targetKinds: ['domain'],
      prompt: t('cyn.prompt.connect'),
      run(source, [a, b]) {
        if (a.kind !== 'domain' || b.kind !== 'domain' || !isDomain(a.id) || !isDomain(b.id) || a.id === b.id) return null;
        const p = parseCynefin(source);
        const last = p.transitions.at(-1);
        const { header, body } = bodyLines(source);
        const indent = last ? indentOf(last.line.text) : p.blocks[0] ? indentOf(p.blocks[0].line.text) : '';
        const change = insertLineAfter(source, last?.line ?? body.at(-1) ?? header, `${indent}${a.id} --> ${b.id} : ${quoteString(NEW_TRANSITION)}`);
        const index = p.transitions.filter((x) => x.line.from < change.from + 1).length;
        return {
          change,
          label: t('cyn.history.connect', { from: domainName(a.id), to: domainName(b.id) }),
          focus: { kind: 'transition', id: String(index) },
        };
      },
    },
    {
      id: 'move-up',
      title: '↑',
      arity: 1,
      appliesTo: ['item'],
      run: (source, [r]) => swapItem(source, r, -1),
    },
    {
      id: 'move-down',
      title: '↓',
      arity: 1,
      appliesTo: ['item'],
      run: (source, [r]) => swapItem(source, r, 1),
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['item', 'transition'],
      key: 'Delete',
      danger: true,
      run(source, [r]) {
        const p = parseCynefin(source);
        const x = findItem(p, r);
        if (x) return { change: removeItem(source, x), label: t('cyn.history.deleteItem') };
        const tr = findTransition(p, r);
        if (tr) return { change: removeLine(source, tr.line), label: t('cyn.history.deleteTransition') };
        return null;
      },
    },
    {
      // 領域は背景も当たり判定なので、Delete キーでは消さない（何も無い所を押したつもりで項目をすべて消さないように）
      id: 'delete-domain',
      title: t('cyn.action.deleteDomain'),
      arity: 1,
      appliesTo: ['domain'],
      danger: true,
      menuOnly: true,
      run(source, [r]) {
        if (r.kind !== 'domain' || !isDomain(r.id)) return null;
        const p = parseCynefin(source);
        // 領域の項目をすべて消す（同じ領域を何度か書いていれば、そのすべて）
        const lines = new Set(p.blocks.filter((b) => b.domain === r.id).flatMap((b) => b.lines.map((l) => l.index)));
        if (lines.size === 0) return null;
        return { change: removeLineSet(source, lines), label: t('cyn.history.deleteDomain', { domain: domainName(r.id) }) };
      },
    },
  ],
  // ドラッグ: 項目を別の項目の前後へ（別の領域の項目なら、その領域へ）、または領域の中（最後）へ動かす
  reorder: {
    axis: (source, r) => (findItem(parseCynefin(source), r) ? 'y' : null),
    accepts: (r, target) => r.kind === 'item' && target.kind === 'item',
    move: moveItem,
    acceptsInto: (_source, r, container) => r.kind === 'item' && container?.kind === 'domain' && isDomain(container.id),
    into(source, r, container) {
      if (!container || !isDomain(container.id)) return null;
      const change = cynefinPlugin.setProperty!(source, r, 'domain', container.id);
      if (!change) return null;
      // 動かした項目は、移した領域の最後の項目になる
      const moved = parseCynefin(applySpec(source, change)).items.filter((x) => x.block.domain === container.id).at(-1);
      return { change, label: t('cyn.history.moveTo', { domain: domainName(container.id) }), select: moved && itemRef(moved) };
    },
  },
};

