import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { withValue, type ActionResult, type DiagramPlugin, type DiagramTarget, type ElementRef, type PropertyField, type SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { applySpec, bodyLines, escapeRe, indentOf, insertLineAfter, rangeInInserted, uniqueId, type SourceLine } from './source';
import { addHitArea, matchInOrder } from './svg';
import { appendTopLevel, removeLine, removeLines, VALID_NAME } from './lineOps';

// sequenceDiagram のプラグイン。
// ソースを文（参加者の宣言・メッセージ・注釈・枠など）に分け、SVG の要素とは意味のある値で対応付ける:
// 参加者は data-id / name、メッセージは端点（data-from / data-to）、注釈は本文、枠（loop / alt など）は種類と条件。

const NEW_PARTICIPANT = '新しい参加者';
const NEW_MESSAGE = 'メッセージ';
const NEW_NOTE = 'メモ';
const NEW_CONDITION = '条件';
const DEFAULT_INDENT = '    ';

/** mermaid が受け付ける矢印（字句解析器の規則と同じもの）。長いものから試す */
const ARROW_TOKENS = [
  '->>', '<<->>', '-->>', '<<-->>', '->', '-->', '-x', '--x', '-)', '--)',
  '--|\\', '--|/', '--\\\\', '--//', '/|--', '\\|--', '//--', '\\\\--',
  '-|\\', '-|/', '-\\\\', '-//', '/|-', '\\|-', '//-', '\\\\-',
];
const ARROW_RE = [...ARROW_TOKENS].sort((a, b) => b.length - a.length).map(escapeRe).join('|');

const MESSAGE = new RegExp(
  `^(?<indent>\\s*)(?<from>[^\\s:<>+\\-/\\\\]+?)\\s*(?<arrow>${ARROW_RE})(?<act>[+-]?)\\s*(?<to>[^\\s:+\\-/\\\\]+?)\\s*:(?<sp>\\s?)(?<text>.*)$`,
  'd',
);
const DECLARATION = /^(?<indent>\s*)(?:(?<create>create)\s+)?(?<kw>participant|actor)\s+(?<id>[^\s<>:,;@]+?)(?<meta>\s*@\{[^}]*\})?(?:\s+as\s+(?<alias>.*?))?\s*$/d;
const NOTE = /^(?<indent>\s*)note\s+(?<pos>left of|right of|over)\s+(?<parts>[^:]+?)\s*:\s?(?<text>.*)$/di;
const REFERENCE = /^\s*(?:activate|deactivate|destroy|links?|properties|details)\s+(?<id>[^\s:]+)/di;
const OPENER = /^(?<indent>\s*)(?<kw>loop|alt|opt|par_over|par|critical|break|rect|box)\b\s*(?<cond>.*?)\s*$/di;
const SECTION = /^(?<indent>\s*)(?<kw>else|and|option)\b\s*(?<cond>.*?)\s*$/di;
const END = /^\s*end\s*$/i;
const AUTONUMBER = /^\s*autonumber\b/i;
const TITLE = /^\s*title:?\s+(?<text>.*?)\s*$/di;

export const MESSAGE_ARROWS = [
  { value: '->>', label: '→ 実線の矢印' },
  { value: '-->>', label: '⇢ 点線の矢印' },
  { value: '->', label: '― 実線' },
  { value: '-->', label: '┄ 点線' },
  { value: '-x', label: '→× 実線・バツ' },
  { value: '--x', label: '⇢× 点線・バツ' },
  { value: '-)', label: '→) 非同期' },
  { value: '--)', label: '⇢) 点線・非同期' },
  { value: '<<->>', label: '↔ 双方向' },
  { value: '<<-->>', label: '⇠⇢ 点線・双方向' },
  { value: '-|\\', label: '⇀ 実線・半分（上）' },
  { value: '-|/', label: '⇁ 実線・半分（下）' },
  { value: '--|\\', label: '⇀ 点線・半分（上）' },
  { value: '--|/', label: '⇁ 点線・半分（下）' },
];

export const PARTICIPANT_TYPES = [
  { value: 'participant', label: '箱（participant）' },
  { value: 'actor', label: '人（actor）' },
  { value: 'boundary', label: '境界（boundary）' },
  { value: 'control', label: '制御（control）' },
  { value: 'entity', label: '実体（entity）' },
  { value: 'database', label: 'データベース（database）' },
  { value: 'collections', label: '集まり（collections）' },
  { value: 'queue', label: 'キュー（queue）' },
];

const ACTIVATIONS = [
  { value: '', label: 'なし' },
  { value: '+', label: '受け手を活性化（+）' },
  { value: '-', label: '送り手を非活性化（-）' },
];

const NOTE_POSITIONS = [
  { value: 'right of', label: '右（right of）' },
  { value: 'left of', label: '左（left of）' },
  { value: 'over', label: '上に重ねる（over）' },
];

/** 図から作れる枠の種類（rect の条件は色、box は参加者のまとまりなので除く） */
const BLOCK_KINDS = [
  { value: 'loop', label: '繰り返し（loop）' },
  { value: 'alt', label: '分岐（alt）' },
  { value: 'opt', label: '省略可（opt）' },
  { value: 'par', label: '並行（par）' },
  { value: 'critical', label: '重要（critical）' },
  { value: 'break', label: '中断（break）' },
];

/** 枠の種類ごとの区切りのキーワード */
const SECTION_KEYWORD: Record<string, string> = { alt: 'else', par: 'and', par_over: 'and', critical: 'option' };

type Ranged = SourceRange & { value: string };

interface Decl {
  line: SourceLine;
  create: boolean;
  id: string;
  idRange: SourceRange;
  /** participant / actor / boundary など */
  type: string;
  keyword: Ranged;
  /** @{ ... } の範囲（前の空白を含む） */
  meta: SourceRange | null;
  /** 表示名の範囲（as の後ろ、または @{} の "alias" の値） */
  alias: SourceRange | null;
  aliasInMeta: boolean;
}

interface Message {
  index: number;
  line: SourceLine;
  from: string;
  to: string;
  fromRange: SourceRange;
  toRange: SourceRange;
  arrow: Ranged;
  act: Ranged;
  text: SourceRange;
}

interface Note {
  index: number;
  line: SourceLine;
  pos: Ranged;
  parts: Ranged;
  text: SourceRange;
}

interface Section {
  line: SourceLine;
  keyword: string;
  cond: SourceRange;
}

interface Block {
  index: number;
  keyword: Ranged;
  line: SourceLine;
  cond: SourceRange;
  sections: Section[];
  end: SourceLine | null;
}

/** 並べ替えの単位（1 行の文、または枠全体） */
interface Unit {
  first: SourceLine;
  last: SourceLine;
}

interface Seq {
  decls: Decl[];
  messages: Message[];
  notes: Note[];
  blocks: Block[];
  /** activate などで参加者を指す箇所 */
  refs: { line: SourceLine; id: string; range: SourceRange }[];
  autonumber: SourceLine | null;
  title: { line: SourceLine; text: SourceRange } | null;
  header: SourceLine | null;
  body: SourceLine[];
  /** 文の行番号 → 同じ区切りの中の並び */
  siblings: Map<number, Unit[]>;
}

const rangeOf = (line: SourceLine, m: RegExpExecArray, group: string): SourceRange => {
  const [a, b] = m.indices!.groups![group]!;
  return { from: line.from + a, to: line.from + b };
};

function parseDecl(line: SourceLine, m: RegExpExecArray, source: string): Decl {
  const g = m.groups!;
  const metaRange = g.meta ? rangeOf(line, m, 'meta') : null;
  const meta = g.meta ?? '';
  const metaType = /"type"\s*:\s*"([^"]*)"/.exec(meta)?.[1];
  let alias = g.alias ? rangeOf(line, m, 'alias') : null;
  let aliasInMeta = false;
  if (!alias && metaRange) {
    const am = /("alias"\s*:\s*")([^"]*)"/.exec(source.slice(metaRange.from, metaRange.to));
    if (am) {
      const at = metaRange.from + am.index + am[1].length;
      alias = { from: at, to: at + am[2].length };
      aliasInMeta = true;
    }
  }
  return {
    line,
    create: !!g.create,
    id: g.id,
    idRange: rangeOf(line, m, 'id'),
    type: g.kw === 'actor' ? 'actor' : (metaType ?? 'participant'),
    keyword: { ...rangeOf(line, m, 'kw'), value: g.kw },
    meta: metaRange,
    alias,
    aliasInMeta,
  };
}

/** ソースを文に分ける。枠（end で閉じるもの）の入れ子もたどる */
// 同じソースを何度も読まないよう、直前の結果を使い回す（プロパティパネル・描画のたびの対応付け・操作が同じソースを読む）。
// 返す Seq は読み取り専用として扱い、呼び出し側で書き換えない
let lastSource: string | null = null;
let lastSeq: Seq | null = null;

export function parseSequence(source: string): Seq {
  if (source !== lastSource || !lastSeq) {
    lastSeq = readSequence(source);
    lastSource = source;
  }
  return lastSeq;
}

function readSequence(source: string): Seq {
  const { header, body } = bodyLines(source);
  const seq: Seq = { decls: [], messages: [], notes: [], blocks: [], refs: [], autonumber: null, title: null, header, body, siblings: new Map() };
  const top: Unit[] = [];
  const stack: { block: Block; unit: Unit; units: Unit[] }[] = [];
  const scope = () => stack.at(-1)?.units ?? top;
  const addUnit = (line: SourceLine) => {
    const units = scope();
    units.push({ first: line, last: line });
    seq.siblings.set(line.index, units);
  };

  for (const line of body) {
    const text = line.text;
    let m: RegExpExecArray | null;
    if ((m = DECLARATION.exec(text))) {
      seq.decls.push(parseDecl(line, m, source));
    } else if ((m = MESSAGE.exec(text))) {
      const g = m.groups!;
      seq.messages.push({
        index: seq.messages.length,
        line,
        from: g.from,
        to: g.to,
        fromRange: rangeOf(line, m, 'from'),
        toRange: rangeOf(line, m, 'to'),
        arrow: { ...rangeOf(line, m, 'arrow'), value: g.arrow },
        act: { ...rangeOf(line, m, 'act'), value: g.act },
        text: rangeOf(line, m, 'text'),
      });
      addUnit(line);
    } else if ((m = NOTE.exec(text))) {
      const g = m.groups!;
      seq.notes.push({
        index: seq.notes.length,
        line,
        pos: { ...rangeOf(line, m, 'pos'), value: g.pos.toLowerCase() },
        parts: { ...rangeOf(line, m, 'parts'), value: g.parts },
        text: rangeOf(line, m, 'text'),
      });
      addUnit(line);
    } else if ((m = OPENER.exec(text))) {
      const g = m.groups!;
      const block: Block = {
        index: seq.blocks.length,
        keyword: { ...rangeOf(line, m, 'kw'), value: g.kw.toLowerCase() },
        line,
        cond: rangeOf(line, m, 'cond'),
        sections: [],
        end: null,
      };
      seq.blocks.push(block);
      const unit = { first: line, last: line };
      scope().push(unit);
      seq.siblings.set(line.index, scope());
      stack.push({ block, unit, units: [] });
    } else if ((m = SECTION.exec(text)) && stack.length > 0) {
      const g = m.groups!;
      const frame = stack.at(-1)!;
      frame.block.sections.push({ line, keyword: g.kw.toLowerCase(), cond: rangeOf(line, m, 'cond') });
      // 区切りごとに並びを分ける（区切りをまたいだ並べ替えはしない）
      frame.units = [];
    } else if (END.test(text) && stack.length > 0) {
      const frame = stack.pop()!;
      frame.block.end = line;
      frame.unit.last = line;
    } else if (AUTONUMBER.test(text)) {
      seq.autonumber = line;
    } else if ((m = TITLE.exec(text))) {
      seq.title = { line, text: rangeOf(line, m, 'text') };
    } else {
      if ((m = REFERENCE.exec(text))) seq.refs.push({ line, id: m.groups!.id, range: rangeOf(line, m, 'id') });
      addUnit(line);
    }
  }
  return seq;
}

export function parseMessages(source: string): Message[] {
  return parseSequence(source).messages;
}

/** 参加者の表示名のソース上の範囲。表示名が無ければ null（id を変えるとメッセージが壊れるため） */
export function findParticipantLabel(source: string, id: string): SourceRange | null {
  return parseSequence(source).decls.find((d) => d.id === id)?.alias ?? null;
}

/** 図に出てくる参加者の ID（宣言と、メッセージ・注釈で暗黙に現れるもの）を出てくる順に */
function participantIds(seq: Seq): string[] {
  const ids = new Set<string>();
  const items: { at: number; ids: string[] }[] = [
    ...seq.decls.map((d) => ({ at: d.line.from, ids: [d.id] })),
    ...seq.messages.map((m) => ({ at: m.line.from, ids: [m.from, m.to] })),
    ...seq.notes.map((n) => ({ at: n.line.from, ids: splitParts(n.parts).map((p) => p.value) })),
  ].sort((a, b) => a.at - b.at);
  for (const x of items) x.ids.forEach((id) => ids.add(id));
  return [...ids];
}

/** 注釈の「A,B」を参加者ごとの範囲に分ける */
function splitParts(parts: Ranged): Ranged[] {
  const out: Ranged[] = [];
  let at = parts.from;
  for (const raw of parts.value.split(',')) {
    const lead = raw.length - raw.trimStart().length;
    const value = raw.trim();
    out.push({ from: at + lead, to: at + lead + value.length, value });
    at += raw.length + 1;
  }
  return out;
}

const normalizeText = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function participantElements(svg: SVGSVGElement): { el: Element; id: string }[] {
  const out: { el: Element; id: string }[] = [];
  svg.querySelectorAll('g[data-et="participant"][data-id]').forEach((g) => {
    out.push({ el: g, id: g.getAttribute('data-id')! });
  });
  // 下側の参加者（箱の rect、または人などの g）
  svg.querySelectorAll('.actor-bottom[name]').forEach((bottom) => {
    const parent = bottom.parentElement;
    const el =
      bottom.tagName.toLowerCase() === 'rect' && parent && parent.tagName.toLowerCase() === 'g' && parent.querySelectorAll('rect.actor').length === 1
        ? parent
        : bottom;
    if (!out.some((x) => x.el === el || x.el.contains(el))) out.push({ el, id: bottom.getAttribute('name')! });
  });
  return out;
}

const lineIndent = (seq: Seq) => (seq.body[0] && indentOf(seq.body[0].text)) || DEFAULT_INDENT;

/** 枠の中を 1 段深くするときの字下げ */
function innerIndent(seq: Seq, outer: string): string {
  const step = seq.header ? lineIndent(seq).slice(indentOf(seq.header.text).length) : '';
  return outer + (step || DEFAULT_INDENT);
}

function newDeclaration(seq: Seq, source: string, text: string) {
  const last = seq.decls.at(-1);
  const after = last?.line ?? seq.header;
  const indent = (last && indentOf(last.line.text)) || lineIndent(seq);
  return insertLineAfter(source, after, indent + text);
}

/** 参加者を隣の前後へ動かす（← → の操作。ドラッグと同じ規則で動かす） */
function moveParticipantBy(source: string, id: string, dir: -1 | 1): ActionResult | null {
  const seq = parseSequence(source);
  const created = new Set(seq.decls.filter((d) => d.create).map((d) => d.id));
  const order = participantIds(seq).filter((x) => !created.has(x));
  const i = order.indexOf(id);
  const neighbour = i < 0 ? undefined : order[i + dir];
  const change = neighbour === undefined ? null : moveParticipantTo(seq, source, id, neighbour, dir < 0);
  return change && { change, label: `参加者 ${id} を${dir < 0 ? '左' : '右'}へ移動`, select: { kind: 'participant', id } };
}

/** 文（または枠）を、同じ区切りの中の隣の前後へ動かす（↑ ↓ の操作） */
function moveStatementBy(source: string, ref: ElementRef, dir: -1 | 1): ActionResult | null {
  const seq = parseSequence(source);
  const me = unitOf(seq, ref);
  const units = me && seq.siblings.get(me.first.index);
  const other = units?.[units.findIndex((u) => u.first.index === me!.first.index) + dir];
  return me && other ? moveUnit(source, ref, me, other, dir < 0, `${KIND_NAME[ref.kind]}を${dir < 0 ? '上' : '下'}へ移動`) : null;
}

function renameParticipant(seq: Seq, from: string, to: string): ChangeSpec[] | null {
  // - を含む ID は矢印と見分けられない（メッセージの行を読めなくなる）ので使わない
  if (!VALID_NAME.test(to) || to.includes('-') || participantIds(seq).includes(to)) return null;
  const out: ChangeSpec[] = [];
  const put = (r: SourceRange) => out.push({ from: r.from, to: r.to, insert: to });
  for (const d of seq.decls) if (d.id === from) put(d.idRange);
  for (const m of seq.messages) {
    if (m.from === from) put(m.fromRange);
    if (m.to === from) put(m.toRange);
  }
  for (const n of seq.notes) for (const p of splitParts(n.parts)) if (p.value === from) put(p);
  for (const r of seq.refs) if (r.id === from) put(r.range);
  return out;
}

export function deleteParticipant(source: string, id: string): ChangeSpec[] {
  const seq = parseSequence(source);
  const lines = new Map<number, SourceLine>();
  for (const d of seq.decls) if (d.id === id) lines.set(d.line.index, d.line);
  for (const m of seq.messages) if (m.from === id || m.to === id) lines.set(m.line.index, m.line);
  for (const n of seq.notes) if (splitParts(n.parts).some((p) => p.value === id)) lines.set(n.line.index, n.line);
  for (const r of seq.refs) if (r.id === id) lines.set(r.line.index, r.line);
  return [...lines.values()].map((l) => removeLine(source, l));
}

/** 宣言の種類・表示名を変えた後の @{ ... } */
function buildMeta(type: string, alias: string | null): string {
  const keys = [type !== 'participant' && type !== 'actor' ? `"type": "${type}"` : null, alias !== null ? `"alias": "${alias}"` : null].filter(Boolean);
  return keys.length ? `@{ ${keys.join(', ')} }` : '';
}

function setParticipantType(seq: Seq, source: string, id: string, type: string): ChangeSpec | null {
  const d = seq.decls.find((x) => x.id === id);
  if (!d) return newDeclaration(seq, source, type === 'actor' ? `actor ${id}` : type === 'participant' ? `participant ${id}` : `participant ${id}${buildMeta(type, null)}`);
  const changes: ChangeSpec[] = [{ from: d.keyword.from, to: d.keyword.to, insert: type === 'actor' ? 'actor' : 'participant' }];
  const aliasInMeta = d.aliasInMeta && d.alias ? source.slice(d.alias.from, d.alias.to) : null;
  const meta = buildMeta(type, aliasInMeta);
  if (d.meta) changes.push({ from: d.meta.from, to: d.meta.to, insert: meta });
  else if (meta) changes.push({ from: d.idRange.to, insert: meta });
  return changes;
}

function setParticipantAlias(seq: Seq, source: string, id: string, value: string): ChangeSpec | null {
  const d = seq.decls.find((x) => x.id === id);
  if (!d) return value ? newDeclaration(seq, source, `participant ${id} as ${value}`) : null;
  if (d.alias && (value || d.aliasInMeta)) {
    if (d.aliasInMeta && value.includes('"')) return null;
    return { from: d.alias.from, to: d.alias.to, insert: value };
  }
  // as の部分を足す・消す（宣言の行末）
  const end = d.meta?.to ?? d.idRange.to;
  return { from: end, to: d.line.to, insert: value ? ` as ${value}` : '' };
}

/** 選択中のメッセージ・注釈の後ろに 1 行足す */
function insertAfterLine(line: SourceLine, source: string, text: string) {
  return insertLineAfter(source, line, indentOf(line.text) + text);
}

/** 文を枠で囲む（文は 1 段深くする） */
function wrapInBlock(seq: Seq, line: SourceLine): { change: ChangeSpec[]; condAt: number } {
  const outer = indentOf(line.text);
  const opener = `${outer}loop ${NEW_CONDITION}\n`;
  return {
    change: [
      { from: line.from, to: line.from + outer.length, insert: opener + innerIndent(seq, outer) },
      { from: line.to, insert: `\n${outer}end` },
    ],
    condAt: line.from + opener.indexOf(NEW_CONDITION),
  };
}

const findBlock = (seq: Seq, id: string) => seq.blocks[Number(id)];
const findSection = (seq: Seq, id: string) => {
  const [b, k] = id.split(':').map(Number);
  return seq.blocks[b]?.sections[k];
};

/** 枠の種類（rect と box は図からは作らない） */
const isControl = (b: Block) => b.keyword.value !== 'rect' && b.keyword.value !== 'box';

export const sequencePlugin: DiagramPlugin = {
  type: 'sequence',

  mapTargets(svg, source) {
    const seq = parseSequence(source);
    const parts: DiagramTarget[] = participantElements(svg).map(({ el, id }, i) => {
      const labelEl = el.querySelector('text') ?? el.nextElementSibling ?? el;
      const decl = seq.decls.find((d) => d.id === id);
      return {
        id: `participant-${i}`,
        el,
        labelEl,
        label: labelText(labelEl),
        range: decl?.alias ?? null,
        // 表示名の無い宣言には「 as 表示名」を差し込む（宣言の無い参加者はパネルの表示名から）
        insertAt: decl && !decl.alias ? { at: decl.meta?.to ?? decl.idRange.to, prefix: ' as ', suffix: '' } : undefined,
        ref: { kind: 'participant', id },
      };
    });

    // メッセージ: 線の data-from / data-to でソースのメッセージに対応付ける。文字は線と同じ順に並ぶ
    const messages = seq.messages;
    const lines = [...svg.querySelectorAll('[data-et="message"]')];
    const texts = [...svg.querySelectorAll('text.messageText')];
    const msgTargets: DiagramTarget[] = [];
    const matched = matchInOrder(lines, messages, (el, m) => el.getAttribute('data-from') === m.from && el.getAttribute('data-to') === m.to);
    if (texts.length === lines.length) {
      lines.forEach((_, i) => {
        const j = matched[i];
        if (j < 0) return;
        const m = messages[j];
        msgTargets.push({
          id: `message-${i}`,
          el: lines[i],
          hits: [addHitArea(lines[i]), texts[i]],
          labelEl: texts[i],
          label: labelText(texts[i]),
          range: m.text,
          ref: { kind: 'message', id: String(j) },
        });
      });
    }

    // 注釈: 本文で対応付ける
    const noteEls = [...svg.querySelectorAll('g[data-et="note"]')];
    const noteText = (el: Element) => el.querySelector('text.noteText') ?? el;
    // 比べる値（本文）は先に 1 回だけ求める
    const noteKeys = new Map(noteEls.map((el) => [el, normalizeText(labelText(noteText(el)))]));
    const noteSources = seq.notes.map((n) => normalizeText(source.slice(n.text.from, n.text.to)));
    const noteMatch = matchInOrder(noteEls, seq.notes, (el, n) => noteKeys.get(el) === noteSources[n.index]);
    const noteTargets: DiagramTarget[] = [];
    noteEls.forEach((el, i) => {
      const n = seq.notes[noteMatch[i]];
      if (!n) return;
      const labelEl = noteText(el);
      noteTargets.push({ id: `note-${i}`, el, labelEl, label: labelText(labelEl), range: n.text, ref: { kind: 'note', id: String(n.index) } });
    });

    // 枠: 内側（先に閉じるもの）から順に描かれるので、end の順に並べて種類と条件で対応付ける
    const blockEls = [...svg.querySelectorAll('g[data-et="control-structure"]')];
    const blocks = seq.blocks.filter(isControl).sort((a, b) => (a.end?.index ?? Infinity) - (b.end?.index ?? Infinity));
    const condOf = (el: Element) => normalizeText(labelText(el).replace(/^\[|\]$/g, ''));
    // 比べる値（種類と条件）は先に 1 回だけ求める
    const keyOfEl = new Map(
      blockEls.map((el) => {
        const cond = el.querySelector('text.loopText');
        return [el, `${labelText(el.querySelector('text.labelText') ?? el)}\n${cond ? condOf(cond) : ''}`];
      }),
    );
    const keyOfBlock = new Map(blocks.map((b) => [b, `${b.keyword.value.replace('_over', '')}\n${normalizeText(source.slice(b.cond.from, b.cond.to))}`]));
    const blockMatch = matchInOrder(blockEls, blocks, (el, b) => keyOfEl.get(el) === keyOfBlock.get(b));
    const blockTargets: DiagramTarget[] = [];
    blockEls.forEach((el, i) => {
      const b = blocks[blockMatch[i]];
      if (!b) return;
      const labelEl = el.querySelector('text.loopText') ?? el.querySelector('text.labelText') ?? el;
      const hasCond = b.cond.to > b.cond.from;
      blockTargets.push({
        id: `block-${i}`,
        el,
        labelEl,
        label: hasCond ? source.slice(b.cond.from, b.cond.to) : '',
        range: hasCond ? b.cond : null,
        ref: { kind: 'block', id: String(b.index) },
      });
      const titles = [...el.querySelectorAll('text.sectionTitle')];
      if (titles.length !== b.sections.length) return;
      titles.forEach((title, k) => {
        const s = b.sections[k];
        const has = s.cond.to > s.cond.from;
        blockTargets.push({
          id: `section-${i}-${k}`,
          el: title,
          labelEl: title,
          label: has ? source.slice(s.cond.from, s.cond.to) : '',
          range: has ? s.cond : null,
          ref: { kind: 'section', id: `${b.index}:${k}` },
        });
      });
    });

    // 通し番号（autonumber）の数字は、本文の中の同じ数字と取り違えないよう汎用の対応付けから外す
    const mapped = [...parts, ...msgTargets, ...noteTargets, ...blockTargets];
    const exclude = [...mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]), ...svg.querySelectorAll('text.sequenceNumber')];
    return [...mapped, ...genericTargets(svg, source, exclude)];
  },

  inspect(source, ref): PropertyField[] {
    const seq = parseSequence(source);
    if (!ref) {
      return [
        { id: 'title', label: '題名', type: 'text', value: seq.title ? source.slice(seq.title.text.from, seq.title.text.to) : '' },
        {
          id: 'autonumber',
          label: '通し番号',
          type: 'select',
          value: seq.autonumber ? 'on' : 'off',
          options: [
            { value: 'off', label: '付けない' },
            { value: 'on', label: '付ける（autonumber）' },
          ],
        },
      ];
    }
    const ids = participantIds(seq).map((id) => ({ value: id, label: id }));
    if (ref.kind === 'participant') {
      const d = seq.decls.find((x) => x.id === ref.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'alias', label: '表示名', type: 'text', value: d?.alias ? source.slice(d.alias.from, d.alias.to) : '', placeholder: ref.id },
        { id: 'type', label: '種類', type: 'select', value: d?.type ?? 'participant', options: PARTICIPANT_TYPES },
      ];
    }
    if (ref.kind === 'message') {
      const m = seq.messages[Number(ref.id)];
      if (!m) return [];
      return [
        { id: 'from', label: '送り手', type: 'select', value: m.from, options: ids },
        { id: 'to', label: '受け手', type: 'select', value: m.to, options: ids },
        { id: 'text', label: '本文', type: 'text', value: source.slice(m.text.from, m.text.to) },
        { id: 'arrow', label: '矢印', type: 'select', value: m.arrow.value, options: withValue(MESSAGE_ARROWS, m.arrow.value) },
        { id: 'act', label: '活性化', type: 'select', value: m.act.value, options: ACTIVATIONS },
      ];
    }
    if (ref.kind === 'note') {
      const n = seq.notes[Number(ref.id)];
      if (!n) return [];
      return [
        { id: 'text', label: '本文', type: 'text', value: source.slice(n.text.from, n.text.to) },
        { id: 'pos', label: '位置', type: 'select', value: n.pos.value, options: NOTE_POSITIONS },
        { id: 'parts', label: '参加者（カンマ区切り）', type: 'text', value: n.parts.value, commitOnBlur: true },
      ];
    }
    if (ref.kind === 'block') {
      const b = findBlock(seq, ref.id);
      if (!b) return [];
      return [
        { id: 'kind', label: '種類', type: 'select', value: b.keyword.value, options: withValue(BLOCK_KINDS, b.keyword.value) },
        { id: 'cond', label: '条件', type: 'text', value: source.slice(b.cond.from, b.cond.to) },
      ];
    }
    if (ref.kind === 'section') {
      const s = findSection(seq, ref.id);
      if (!s) return [];
      return [{ id: 'cond', label: `条件（${s.keyword}）`, type: 'text', value: source.slice(s.cond.from, s.cond.to) }];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    const seq = parseSequence(source);
    if (!ref) {
      if (field === 'title') {
        if (seq.title) return value ? { from: seq.title.text.from, to: seq.title.text.to, insert: value } : removeLine(source, seq.title.line);
        return value ? insertLineAfter(source, seq.header, `${lineIndent(seq)}title ${value}`) : null;
      }
      if (field === 'autonumber') {
        if (value === 'on') return seq.autonumber ? null : insertLineAfter(source, seq.title?.line ?? seq.header, `${lineIndent(seq)}autonumber`);
        return seq.autonumber ? removeLine(source, seq.autonumber) : null;
      }
      return null;
    }
    if (ref.kind === 'participant') {
      if (field === 'id') return value === ref.id ? null : renameParticipant(seq, ref.id, value);
      if (field === 'type') return setParticipantType(seq, source, ref.id, value);
      if (field === 'alias') return setParticipantAlias(seq, source, ref.id, value);
      return null;
    }
    if (ref.kind === 'message') {
      const m = seq.messages[Number(ref.id)];
      if (!m) return null;
      if (field === 'text') return { from: m.text.from, to: m.text.to, insert: value };
      if (field === 'arrow') return { from: m.arrow.from, to: m.arrow.to, insert: value };
      if (field === 'act') return { from: m.act.from, to: m.act.to, insert: value };
      if (field === 'from') return { from: m.fromRange.from, to: m.fromRange.to, insert: value };
      if (field === 'to') return { from: m.toRange.from, to: m.toRange.to, insert: value };
      return null;
    }
    if (ref.kind === 'note') {
      const n = seq.notes[Number(ref.id)];
      if (!n) return null;
      if (field === 'text') return { from: n.text.from, to: n.text.to, insert: value };
      if (field === 'pos') {
        // 左右に置く注釈は参加者を 1 人しか取れないので、最初の参加者だけを残す
        const parts = splitParts(n.parts);
        if (value !== 'over' && parts.length > 1) return { from: n.pos.from, to: n.parts.to, insert: `${value} ${parts[0].value}` };
        return { from: n.pos.from, to: n.pos.to, insert: value };
      }
      if (field === 'parts') {
        const ids = value.split(',').map((x) => x.trim()).filter(Boolean);
        const max = n.pos.value === 'over' ? 2 : 1;
        if (ids.length === 0 || ids.length > max || !ids.every((x) => VALID_NAME.test(x))) return null;
        return { from: n.parts.from, to: n.parts.to, insert: ids.join(',') };
      }
      return null;
    }
    if (ref.kind === 'block') {
      const b = findBlock(seq, ref.id);
      if (!b) return null;
      if (field === 'kind') return { from: b.keyword.from, to: b.keyword.to, insert: value };
      if (field === 'cond') {
        // 条件が空の行に足すときは、キーワードとの間に空白を入れる
        if (b.cond.from === b.cond.to && value) return { from: b.keyword.to, to: b.line.to, insert: ` ${value}` };
        return { from: b.cond.from, to: b.cond.to, insert: value };
      }
      return null;
    }
    if (ref.kind === 'section') {
      const s = findSection(seq, ref.id);
      if (!s || field !== 'cond') return null;
      if (s.cond.from === s.cond.to && value) {
        const at = s.line.from + indentOf(s.line.text).length + s.keyword.length;
        return { from: at, to: s.line.to, insert: ` ${value}` };
      }
      return { from: s.cond.from, to: s.cond.to, insert: value };
    }
    return null;
  },

  actions: [
    {
      id: 'add-participant',
      title: '＋ 参加者',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'P');
        const change = newDeclaration(parseSequence(source), source, `participant ${id} as ${NEW_PARTICIPANT}`);
        return {
          change,
          label: `参加者 ${id} を追加`,
          selAfter: rangeInInserted(change, NEW_PARTICIPANT),
          focus: { kind: 'participant', id },
        };
      },
    },
    {
      id: 'add-message',
      title: '→ メッセージ',
      arity: 2,
      appliesTo: ['participant'],
      prompt: '送り先の参加者をクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        const change = appendTopLevel(source, `${from.id}->>${to.id}: ${NEW_MESSAGE}`);
        const selAfter = rangeInInserted(change, NEW_MESSAGE);
        return { change, label: `メッセージ ${from.id} → ${to.id} を追加`, selAfter, focusAt: selAfter.anchor };
      },
    },
    {
      id: 'add-next-message',
      title: '＋ 次のメッセージ',
      arity: 1,
      appliesTo: ['message'],
      key: 'Tab',
      run(source, [ref]) {
        const m = parseSequence(source).messages[Number(ref.id)];
        if (!m) return null;
        // 返事として、受け手から送り手へのメッセージを後ろに足す
        const change = insertAfterLine(m.line, source, `${m.to}-->>${m.from}: ${NEW_MESSAGE}`);
        const selAfter = rangeInInserted(change, NEW_MESSAGE);
        return { change, label: `メッセージ ${m.to} → ${m.from} を追加`, selAfter, focusAt: selAfter.anchor };
      },
    },
    {
      id: 'add-note',
      title: '注釈',
      arity: 1,
      appliesTo: ['participant', 'message'],
      run(source, [ref]) {
        const seq = parseSequence(source);
        let change;
        if (ref.kind === 'participant') {
          change = appendTopLevel(source, `Note right of ${ref.id}: ${NEW_NOTE}`);
        } else {
          const m = seq.messages[Number(ref.id)];
          if (!m) return null;
          const over = m.from === m.to ? m.from : `${m.from},${m.to}`;
          change = insertAfterLine(m.line, source, `Note over ${over}: ${NEW_NOTE}`);
        }
        const selAfter = rangeInInserted(change, NEW_NOTE);
        return { change, label: '注釈を追加', selAfter, focusAt: selAfter.anchor };
      },
    },
    {
      id: 'wrap',
      title: '枠で囲む',
      arity: 1,
      appliesTo: ['message', 'note'],
      run(source, [ref]) {
        const seq = parseSequence(source);
        const line = ref.kind === 'message' ? seq.messages[Number(ref.id)]?.line : seq.notes[Number(ref.id)]?.line;
        if (!line) return null;
        const { change, condAt } = wrapInBlock(seq, line);
        return {
          change,
          label: '枠（loop）で囲む',
          selAfter: { anchor: condAt, head: condAt + NEW_CONDITION.length },
          focusAt: condAt,
        };
      },
    },
    {
      id: 'add-section',
      title: '＋ 区切り',
      arity: 1,
      appliesTo: ['block', 'section'],
      run(source, [ref]) {
        const seq = parseSequence(source);
        const b = findBlock(seq, ref.id.split(':')[0]);
        const kw = b && SECTION_KEYWORD[b.keyword.value];
        if (!b?.end || !kw) return null;
        // 枠の最後（end の前）に、空の区切りを足す
        const text = `${indentOf(b.line.text)}${kw} ${NEW_CONDITION}\n`;
        const change = { from: b.end.from, insert: text };
        const at = b.end.from + text.indexOf(NEW_CONDITION);
        return { change, label: `区切り（${kw}）を追加`, selAfter: { anchor: at, head: at + NEW_CONDITION.length }, focusAt: at };
      },
    },
    {
      id: 'move-left',
      title: '← 左へ',
      arity: 1,
      appliesTo: ['participant'],
      run: (source, [ref]) => moveParticipantBy(source, ref.id, -1),
    },
    {
      id: 'move-right',
      title: '右へ →',
      arity: 1,
      appliesTo: ['participant'],
      run: (source, [ref]) => moveParticipantBy(source, ref.id, 1),
    },
    {
      id: 'move-up',
      title: '↑ 上へ',
      arity: 1,
      appliesTo: ['message', 'note', 'block'],
      key: 'ArrowUp',
      menuOnly: true,
      run: (source, [ref]) => moveStatementBy(source, ref, -1),
    },
    {
      id: 'move-down',
      title: '↓ 下へ',
      arity: 1,
      appliesTo: ['message', 'note', 'block'],
      key: 'ArrowDown',
      menuOnly: true,
      run: (source, [ref]) => moveStatementBy(source, ref, 1),
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['participant', 'message', 'note', 'section'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const seq = parseSequence(source);
        if (ref.kind === 'participant') {
          return { change: deleteParticipant(source, ref.id), label: `参加者 ${ref.id} を削除` };
        }
        if (ref.kind === 'section') {
          const s = findSection(seq, ref.id);
          return s && { change: removeLine(source, s.line), label: `区切り（${s.keyword}）を削除` };
        }
        const line = statementLine(seq, ref);
        return line && { change: removeLine(source, line), label: `${KIND_NAME[ref.kind]}を削除` };
      },
    },
    {
      id: 'unwrap',
      title: '枠を外す',
      arity: 1,
      appliesTo: ['block'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const b = findBlock(parseSequence(source), ref.id);
        if (!b?.end) return null;
        // 枠の行（開始・区切り・end）だけを消し、中のメッセージは残す
        const change = [b.line, ...b.sections.map((s) => s.line), b.end].map((l) => removeLine(source, l));
        return { change, label: `枠（${b.keyword.value}）を外す` };
      },
    },
    {
      id: 'delete-block',
      title: '中身ごと削除',
      arity: 1,
      appliesTo: ['block'],
      danger: true,
      menuOnly: true,
      run(source, [ref]) {
        const b = findBlock(parseSequence(source), ref.id);
        if (!b?.end) return null;
        return { change: removeLines(source, b.line, b.end), label: `枠（${b.keyword.value}）を中身ごと削除` };
      },
    },
  ],

  // ドラッグでの並べ替え: 参加者は左右、メッセージ・注釈・枠は上下（枠の中へも外へも動かせる）
  reorder: {
    axis(source, ref) {
      if (ref.kind === 'participant') return parseSequence(source).decls.some((d) => d.id === ref.id && d.create) ? null : 'x';
      if (STATEMENT_KINDS.includes(ref.kind)) return unitOf(parseSequence(source), ref) ? 'y' : null;
      return null;
    },
    accepts(ref, target) {
      if (ref.kind === 'participant') return target.kind === 'participant';
      return STATEMENT_KINDS.includes(ref.kind) && STATEMENT_KINDS.includes(target.kind);
    },
    move(source, ref, target, before) {
      const seq = parseSequence(source);
      if (ref.kind === 'participant') {
        const change = moveParticipantTo(seq, source, ref.id, target.id, before);
        return change && { change, label: `参加者 ${ref.id} を移動`, select: ref };
      }
      const me = unitOf(seq, ref);
      const to = unitOf(seq, target);
      return me && to ? moveUnit(source, ref, me, to, before, `${KIND_NAME[ref.kind]}を移動`) : null;
    },
  },
};

const STATEMENT_KINDS = ['message', 'note', 'block'];

/** 文（メッセージ・注釈・枠）の行の範囲。枠は開始の行から end の行まで */
function unitOf(seq: Seq, ref: { kind: string; id: string }): Unit | null {
  if (ref.kind === 'block') {
    const b = findBlock(seq, ref.id);
    return b?.end && isControl(b) ? { first: b.line, last: b.end } : null;
  }
  const line = statementLine(seq, ref);
  return line ? { first: line, last: line } : null;
}

/**
 * 文（ref の要素の行 me）を、別の文 to の前（before）か後ろへ動かす。字下げは to に合わせる（枠の中へ入れると深くなる）。
 * 動かした後の番号で ref の要素を選び続ける
 */
function moveUnit(source: string, ref: ElementRef, me: Unit, to: Unit, before: boolean, label: string): ActionResult | null {
  // 自分の中（枠の中の文）には落とせない。すぐ隣の前後に落としても位置は変わらない
  if (to.first.index >= me.first.index && to.last.index <= me.last.index) return null;
  if ((before && to.first.index === me.last.index + 1) || (!before && to.last.index === me.first.index - 1)) return null;
  const oldIndent = indentOf(me.first.text);
  const newIndent = indentOf(to.first.text);
  const text = source
    .slice(me.first.from, me.last.to)
    .split('\n')
    .map((l) => (l.startsWith(oldIndent) ? newIndent + l.slice(oldIndent.length) : l))
    .join('\n');
  let insert: { from: number; insert: string };
  if (before) insert = { from: to.first.from, insert: `${text}\n` };
  else if (to.last.to >= source.length) insert = { from: to.last.to, insert: `\n${text}` };
  else insert = { from: to.last.to + 1, insert: `${text}\n` };
  const change = [removeLines(source, me.first, me.last), insert];
  // 動かした文の先頭の行の、変更後の位置
  const at = ChangeSet.of(change, source.length).mapPos(insert.from, -1) + (insert.insert.startsWith('\n') ? 1 : 0);
  const i = itemsOf(parseSequence(applySpec(source, change)), ref.kind).findIndex((x) => x.line.from === at);
  return { change, label, select: i >= 0 ? { kind: ref.kind, id: String(i) } : undefined };
}

/** 宣言の行を含む box（無ければ null） */
const boxOf = (seq: Seq, line: SourceLine) =>
  seq.blocks.find((b) => b.keyword.value === 'box' && b.end && line.index > b.line.index && line.index < b.end.index) ?? null;

/**
 * 参加者を別の参加者の前（before）か後ろへ動かす。mermaid は参加者を最初に出てくる順に並べるので、
 * 宣言の行の並びで順番を決める（宣言の無い参加者は、順番を変える範囲の分だけ宣言を足す）。
 * box の中の参加者は、同じ box の中でだけ動かせる
 */
function moveParticipantTo(seq: Seq, source: string, id: string, targetId: string, before: boolean): ChangeSpec[] | null {
  const created = new Set(seq.decls.filter((d) => d.create).map((d) => d.id));
  if (id === targetId || created.has(id) || created.has(targetId)) return null;
  const declOf = (x: string) => seq.decls.find((d) => d.id === x && !d.create);
  const group = (x: string) => {
    const d = declOf(x);
    return d ? (boxOf(seq, d.line)?.index ?? -1) : -1;
  };
  const g = group(id);
  if (g !== group(targetId)) return null;

  const order = participantIds(seq).filter((x) => !created.has(x));
  const desired = order.filter((x) => x !== id);
  const k = desired.indexOf(targetId);
  if (k < 0) return null;
  desired.splice(before ? k : k + 1, 0, id);
  const members = desired.filter((x) => group(x) === g);
  const current = order.filter((x) => members.includes(x));
  let last = -1;
  members.forEach((x, i) => {
    if (current[i] !== x) last = i;
  });
  if (last < 0) return null;
  // 宣言のある参加者と、順番が変わる範囲の宣言の無い参加者を、望む順に宣言の行へ割り当てる
  const assigned = members.filter((x, i) => declOf(x) || i <= last);
  const slots = seq.decls.filter((d) => !d.create && members.includes(d.id)).map((d) => d.line);
  const textOf = (x: string) => declOf(x)?.line.text.trim() ?? `participant ${x}`;
  const changes: ChangeSpec[] = [];
  slots.forEach((slot, i) => {
    const text = indentOf(slot.text) + textOf(assigned[i]);
    if (text !== slot.text) changes.push({ from: slot.from, to: slot.to, insert: text });
  });
  const extra = assigned.slice(slots.length);
  if (extra.length) {
    const anchor = slots.at(-1) ?? seq.header;
    const indent = (slots.at(-1) && indentOf(slots.at(-1)!.text)) || lineIndent(seq);
    changes.push(insertLineAfter(source, anchor, extra.map((x) => indent + textOf(x)).join('\n')));
  }
  return changes;
}

const KIND_NAME: Record<string, string> = { message: 'メッセージ', note: '注釈', block: '枠' };

/** 要素の種類ごとの並び（参照の番号はこの並びの位置） */
function itemsOf(seq: Seq, kind: string): readonly { line: SourceLine }[] {
  return kind === 'message' ? seq.messages : kind === 'note' ? seq.notes : kind === 'block' ? seq.blocks : [];
}

/** メッセージ・注釈・枠の（先頭の）行 */
function statementLine(seq: Seq, ref: { kind: string; id: string }): SourceLine | null {
  return itemsOf(seq, ref.kind)[Number(ref.id)]?.line ?? null;
}
