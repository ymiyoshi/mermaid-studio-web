import { t } from '../i18n';
import { bodyLines, isComment, type SourceLine } from './source';

// flowchart の文（ノードとリンクの並び）を、ソース上の位置つきで読む。
// 構文の正しさは mermaid.parse に任せ、ここでは書き換える位置を特定することだけを目的にする。
// 読めない文は null にして、その文には触れない。

export interface Shape {
  open: string;
  close: string;
  /** 括弧も含めた範囲（文書の座標） */
  from: number;
  to: number;
  /** ラベルの範囲（引用符の内側） */
  labelFrom: number;
  labelTo: number;
}

/** 新しい形の書き方 A@{ shape: doc, label: "…" } */
export interface Meta {
  /** @{ から } までの範囲 */
  from: number;
  to: number;
  shape: { from: number; to: number; value: string } | null;
  /** ラベルの範囲（引用符があればその内側） */
  label: { from: number; to: number } | null;
}

export interface NodeRef {
  id: string;
  /** ノード参照全体（:::class や形も含む）の範囲 */
  from: number;
  to: number;
  idTo: number;
  shape: Shape | null;
  meta: Meta | null;
  /** :::class の class 名の範囲 */
  cls: { from: number; to: number; value: string } | null;
}

/** 行の文の中身（前後の空白と末尾の ; を除く） */
export const statementText = (text: string) => text.trim().replace(/;$/, '').trim();

/** 形やラベルを定義している参照か */
export const isDefinition = (r: NodeRef) => r.shape !== null || r.meta !== null;

export interface Link {
  from: number;
  to: number;
  /** 矢印の部分（-->, -.-> など）。ラベルが矢印の中にある形（-- text -->）では、その全体 */
  arrowFrom: number;
  arrowTo: number;
  /** ラベルを除いた矢印の種類 */
  arrow: string;
  label: { from: number; to: number; style: 'pipe' | 'inline' } | null;
}

export interface Statement {
  line: SourceLine;
  from: number;
  to: number;
  /** groups[i] と groups[i+1] を links[i] がつなぐ。& でまとめたノードは同じ group に入る */
  groups: NodeRef[][];
  links: Link[];
}

export interface Subgraph {
  /** サブグラフの ID（題名だけの書き方では題名がそのまま ID になる） */
  id: string;
  /** ID のソース上の範囲。題名から ID が決まる書き方では null（ID を変えられない） */
  idRange: { from: number; to: number } | null;
  /** 題名の範囲（括弧・引用符の内側） */
  title: { from: number; to: number } | null;
  line: SourceLine;
  end: SourceLine | null;
  /** 中の direction の行と、向きの範囲 */
  direction: { line: SourceLine; from: number; to: number; value: string } | null;
}

type Ranged = { from: number; to: number; value: string };

export interface StyleLine {
  line: SourceLine;
  /** style の対象の ID */
  id: Ranged;
  /** fill:#f96,stroke:#333 の部分 */
  props: Ranged;
}

export interface ClassLine {
  line: SourceLine;
  /** class A,B hot の A,B（カンマ区切りの 1 つずつ） */
  ids: Ranged[];
  name: Ranged;
}

export interface ClassDefLine {
  line: SourceLine;
  names: Ranged;
  props: Ranged;
}

export interface LinkStyleLine {
  line: SourceLine;
  /** 0,2 や default の部分 */
  indices: Ranged;
  props: Ranged;
}

export interface FlowEdge {
  /** mermaid が数える順のエッジ番号 */
  index: number;
  from: string;
  to: string;
  statement: Statement;
  link: number;
}

/** 形の開き括弧と閉じ括弧。長いものから順に試す */
export const SHAPES: { open: string; close: string[]; name: string; label: string }[] = [
  { open: '(((', close: [')))'], name: 'double-circle', label: t('fc.shape.double-circle') },
  { open: '([', close: ['])'], name: 'stadium', label: t('fc.shape.stadium') },
  { open: '[[', close: [']]'], name: 'subroutine', label: t('fc.shape.subroutine') },
  { open: '[(', close: [')]'], name: 'cylinder', label: t('fc.shape.cylinder') },
  { open: '((', close: ['))'], name: 'circle', label: t('fc.shape.circle') },
  { open: '{{', close: ['}}'], name: 'hexagon', label: t('fc.shape.hexagon') },
  { open: '[/', close: ['/]', '\\]'], name: 'lean', label: t('fc.shape.lean') },
  { open: '[\\', close: ['\\]', '/]'], name: 'lean-l', label: t('fc.shape.lean-l') },
  { open: '[', close: [']'], name: 'rect', label: t('fc.shape.rect') },
  { open: '(', close: [')'], name: 'round', label: t('fc.shape.round') },
  { open: '{', close: ['}'], name: 'rhombus', label: t('fc.shape.rhombus') },
  { open: '>', close: [']'], name: 'asymmetric', label: t('fc.shape.asymmetric') },
];

/** 形の選択肢（プロパティパネル用）。open/close は新しく付けるときの括弧 */
export const SHAPE_CHOICES: { name: string; label: string; open: string; close: string }[] = [
  { name: 'rect', label: t('fc.shape.rect'), open: '[', close: ']' },
  { name: 'round', label: t('fc.shape.round'), open: '(', close: ')' },
  { name: 'stadium', label: t('fc.shape.stadium'), open: '([', close: '])' },
  { name: 'subroutine', label: t('fc.shape.subroutine'), open: '[[', close: ']]' },
  { name: 'cylinder', label: t('fc.shape.cylinder'), open: '[(', close: ')]' },
  { name: 'circle', label: t('fc.shape.circle'), open: '((', close: '))' },
  { name: 'double-circle', label: t('fc.shape.double-circle'), open: '(((', close: ')))' },
  { name: 'rhombus', label: t('fc.shape.rhombus'), open: '{', close: '}' },
  { name: 'hexagon', label: t('fc.shape.hexagon'), open: '{{', close: '}}' },
  { name: 'lean', label: t('fc.shape.lean'), open: '[/', close: '/]' },
  { name: 'lean-l', label: t('fc.shape.lean-l'), open: '[\\', close: '\\]' },
  { name: 'trapezoid', label: t('fc.shape.trapezoid'), open: '[/', close: '\\]' },
  { name: 'trapezoid-alt', label: t('fc.shape.trapezoid-alt'), open: '[\\', close: '/]' },
  { name: 'asymmetric', label: t('fc.shape.asymmetric'), open: '>', close: ']' },
];

/** 括弧の形に対応する、新しい書き方（@{ shape: … }）の名前 */
export const CLASSIC_TO_META: Record<string, string> = {
  rect: 'rect',
  round: 'rounded',
  stadium: 'stadium',
  subroutine: 'fr-rect',
  cylinder: 'cyl',
  circle: 'circle',
  'double-circle': 'dbl-circ',
  rhombus: 'diam',
  hexagon: 'hex',
  lean: 'lean-r',
  'lean-l': 'lean-l',
  trapezoid: 'trap-b',
  'trapezoid-alt': 'trap-t',
  asymmetric: 'odd',
};

/** 新しい書き方でしか書けない形（値は「@名前」。括弧の形の名前と区別するため） */
export const META_SHAPES: { name: string; label: string }[] = [
  { name: 'doc', label: t('fc.meta.doc') },
  { name: 'docs', label: t('fc.meta.docs') },
  { name: 'lin-doc', label: t('fc.meta.lin-doc') },
  { name: 'tag-doc', label: t('fc.meta.tag-doc') },
  { name: 'notch-rect', label: t('fc.meta.notch-rect') },
  { name: 'lin-rect', label: t('fc.meta.lin-rect') },
  { name: 'div-rect', label: t('fc.meta.div-rect') },
  { name: 'st-rect', label: t('fc.meta.st-rect') },
  { name: 'tag-rect', label: t('fc.meta.tag-rect') },
  { name: 'sl-rect', label: t('fc.meta.sl-rect') },
  { name: 'bow-rect', label: t('fc.meta.bow-rect') },
  { name: 'win-pane', label: t('fc.meta.win-pane') },
  { name: 'h-cyl', label: t('fc.meta.h-cyl') },
  { name: 'lin-cyl', label: t('fc.meta.lin-cyl') },
  { name: 'datastore', label: t('fc.meta.datastore') },
  { name: 'delay', label: t('fc.meta.delay') },
  { name: 'curv-trap', label: t('fc.meta.curv-trap') },
  { name: 'notch-pent', label: t('fc.meta.notch-pent') },
  { name: 'tri', label: t('fc.meta.tri') },
  { name: 'flip-tri', label: t('fc.meta.flip-tri') },
  { name: 'hourglass', label: t('fc.meta.hourglass') },
  { name: 'flag', label: t('fc.meta.flag') },
  { name: 'bolt', label: t('fc.meta.bolt') },
  { name: 'sm-circ', label: t('fc.meta.sm-circ') },
  { name: 'fr-circ', label: t('fc.meta.fr-circ') },
  { name: 'f-circ', label: t('fc.meta.f-circ') },
  { name: 'cross-circ', label: t('fc.meta.cross-circ') },
  { name: 'fork', label: t('fc.meta.fork') },
  { name: 'brace', label: t('fc.meta.brace') },
  { name: 'brace-r', label: t('fc.meta.brace-r') },
  { name: 'braces', label: t('fc.meta.braces') },
  { name: 'text', label: t('fc.meta.text') },
  { name: 'folder', label: t('fc.meta.folder') },
  { name: 'bucket', label: t('fc.meta.bucket') },
  { name: 'console', label: t('fc.meta.console') },
  { name: 'browser', label: t('fc.meta.browser') },
  { name: 'person', label: t('fc.meta.person') },
  { name: 'cloud', label: t('fc.meta.cloud') },
  { name: 'bang', label: t('fc.meta.bang') },
];

/** 新しい書き方の形の名前を、選択肢の値（括弧の形の名前か「@名前」）にする */
export function metaShapeValue(name: string): string {
  const classic = Object.entries(CLASSIC_TO_META).find(([, v]) => v === name);
  return classic ? classic[0] : `@${name}`;
}

export function shapeName(shape: Shape): string {
  return SHAPE_CHOICES.find((s) => s.open === shape.open && s.close === shape.close)?.name ?? 'rect';
}

/** 矢印の選択肢 */
export const ARROWS: { value: string; label: string }[] = [
  { value: '-->', label: t('fc.arrow.arrow') },
  { value: '---', label: t('fc.arrow.line') },
  { value: '-.->', label: t('fc.arrow.dottedArrow') },
  { value: '-.-', label: t('fc.arrow.dotted') },
  { value: '==>', label: t('fc.arrow.thickArrow') },
  { value: '===', label: t('fc.arrow.thick') },
  { value: '--o', label: t('fc.arrow.circle') },
  { value: '--x', label: t('fc.arrow.cross') },
  { value: '<-->', label: t('fc.arrow.both') },
];

/** ノード参照・リンク以外の行（スタイル指定やサブグラフの宣言など） */
const NON_STATEMENT = /^\s*(subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|%%)\b/;

// ID の途中の - は、後ろが英数字のときだけ ID の一部とみなす（A-->B の -- は矢印）
const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?=[\p{L}\p{N}_]))*/u;
/** ノード・サブグラフの ID として使える文字列（読み取りの ID の規則と同じ） */
export const VALID_ID = new RegExp(`${ID.source}$`, 'u');
// リンク: 矢印の後ろに |ラベル| が付くことがある
const ARROW = /^([<ox]?)(-{2,}|={2,}|-\.+-|~{3,})([>ox]?)/;
// ラベルが矢印の中にある形: -- text -->、== text ==>、-. text .->
const INLINE = /^([<ox]?)(--|==|-\.)\s+(.+?)\s+(-{2,}[>ox-]?|={2,}[>ox=]?|\.+-[>ox]?)(?=\s|[\p{L}\p{N}_])/u;

class Reader {
  pos = 0;
  constructor(
    readonly text: string,
    readonly base: number,
  ) {}
  get rest() {
    return this.text.slice(this.pos);
  }
  ws() {
    while (this.pos < this.text.length && /[ \t]/.test(this.text[this.pos])) this.pos++;
  }
  done() {
    this.ws();
    return this.pos >= this.text.length || this.text[this.pos] === ';';
  }
}

function readShape(r: Reader): Shape | null {
  const at = r.pos;
  const s = SHAPES.find((x) => r.text.startsWith(x.open, at));
  if (!s) return null;
  let i = at + s.open.length;
  let labelFrom = i;
  let labelTo: number;
  if (r.text[i] === '"') {
    const end = r.text.indexOf('"', i + 1);
    if (end < 0) return null;
    labelFrom = i + 1;
    labelTo = end;
    i = end + 1;
    const close = s.close.find((c) => r.text.startsWith(c, i));
    if (!close) return null;
    r.pos = i + close.length;
    return { open: s.open, close, from: r.base + at, to: r.base + r.pos, labelFrom: r.base + labelFrom, labelTo: r.base + labelTo };
  }
  let best = -1;
  let close = '';
  for (const c of s.close) {
    const k = r.text.indexOf(c, i);
    if (k >= 0 && (best < 0 || k < best)) {
      best = k;
      close = c;
    }
  }
  if (best < 0) return null;
  labelTo = best;
  r.pos = best + close.length;
  return { open: s.open, close, from: r.base + at, to: r.base + r.pos, labelFrom: r.base + labelFrom, labelTo: r.base + labelTo };
}

function readNode(r: Reader): NodeRef | null {
  r.ws();
  const m = ID.exec(r.rest);
  if (!m) return null;
  const start = r.pos;
  const id = m[0];
  r.pos += id.length;
  const idTo = r.pos;
  let shape: Shape | null = null;
  let meta: Meta | null = null;
  if (r.text.startsWith('@{', r.pos)) {
    meta = readMeta(r);
    if (!meta) return null;
  } else {
    shape = readShape(r);
  }
  let cls: NodeRef['cls'] = null;
  const c = /^:::([\p{L}\p{N}_-]+)/u.exec(r.rest);
  if (c) {
    cls = { from: r.base + r.pos + 3, to: r.base + r.pos + c[0].length, value: c[1] };
    r.pos += c[0].length;
  }
  return { id, from: r.base + start, to: r.base + r.pos, idTo: r.base + idTo, shape, meta, cls };
}

/** A@{ shape: doc, label: "…" } の @{ … } を読む（引用符の中の } では終わらない） */
function readMeta(r: Reader): Meta | null {
  const at = r.pos;
  let i = at + 2;
  let inQuote = false;
  for (; i < r.text.length; i++) {
    const ch = r.text[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === '}' && !inQuote) break;
  }
  if (i >= r.text.length) return null;
  r.pos = i + 1;
  const body = r.text.slice(at, r.pos);
  const abs = (k: number) => r.base + at + k;
  const s = /\bshape\s*:\s*([\w-]+)/d.exec(body);
  const shape = s ? { from: abs(s.indices![1]![0]), to: abs(s.indices![1]![1]), value: s[1] } : null;
  const l = /\blabel\s*:\s*"([^"]*)"/d.exec(body) ?? /\blabel\s*:\s*([^,}"]*?)\s*(?=[,}])/d.exec(body);
  const label = l ? { from: abs(l.indices![1]![0]), to: abs(l.indices![1]![1]) } : null;
  return { from: r.base + at, to: r.base + r.pos, shape, label };
}

function readLink(r: Reader): Link | null {
  r.ws();
  const start = r.pos;
  const inline = INLINE.exec(r.rest);
  if (inline) {
    const labelStart = r.pos + inline[0].indexOf(inline[3], inline[1].length + inline[2].length);
    r.pos += inline[0].length;
    const head = inline[4].slice(-1);
    const body = inline[2] === '==' ? '==' : inline[2] === '-.' ? '-.-' : '--';
    const arrow = inline[1] + body + (/[>ox]/.test(head) ? head : body === '-.-' ? '' : body[0]);
    return {
      from: r.base + start,
      to: r.base + r.pos,
      arrowFrom: r.base + start,
      arrowTo: r.base + r.pos,
      arrow,
      label: { from: r.base + labelStart, to: r.base + labelStart + inline[3].length, style: 'inline' },
    };
  }
  const m = ARROW.exec(r.rest);
  if (!m) return null;
  r.pos += m[0].length;
  const arrowTo = r.pos;
  let label: Link['label'] = null;
  const save = r.pos;
  r.ws();
  if (r.text[r.pos] === '|') {
    const end = r.text.indexOf('|', r.pos + 1);
    if (end < 0) return null;
    label = { from: r.base + r.pos + 1, to: r.base + end, style: 'pipe' };
    r.pos = end + 1;
  } else {
    r.pos = save;
  }
  return { from: r.base + start, to: r.base + r.pos, arrowFrom: r.base + start, arrowTo: r.base + arrowTo, arrow: m[0], label };
}

function readGroup(r: Reader): NodeRef[] | null {
  const group: NodeRef[] = [];
  for (;;) {
    const node = readNode(r);
    if (!node) return null;
    group.push(node);
    r.ws();
    if (r.text[r.pos] !== '&') return group;
    r.pos++;
  }
}

/** 1 行の中の文（; で区切られていることもある） */
function readStatements(line: SourceLine): Statement[] | null {
  const out: Statement[] = [];
  const r = new Reader(line.text, line.from);
  while (!r.done()) {
    const from = r.base + r.pos;
    const first = readGroup(r);
    if (!first) return null;
    const groups = [first];
    const links: Link[] = [];
    for (;;) {
      if (r.done()) break;
      const link = readLink(r);
      if (!link) return null;
      const g = readGroup(r);
      if (!g) return null;
      links.push(link);
      groups.push(g);
    }
    out.push({ line, from, to: r.base + r.pos, groups, links });
    if (r.text[r.pos] === ';') r.pos++;
  }
  return out;
}

export interface FlowDoc {
  header: SourceLine | null;
  statements: Statement[];
  /** 読めなかった文の行（ここに出てくるノードやエッジは書き換えない） */
  unknown: SourceLine[];
  edges: FlowEdge[];
  /** 開始の行の順 */
  subgraphs: Subgraph[];
  styles: StyleLine[];
  classes: ClassLine[];
  classDefs: ClassDefLine[];
  linkStyles: LinkStyleLine[];
  /** 図本体の行（frontmatter・宣言行・コメント・空行を除く） */
  body: SourceLine[];
}

const SUBGRAPH = /^(\s*)subgraph\s+(.*?)\s*$/d;
const SUBGRAPH_END = /^\s*end\s*;?\s*$/;
const DIRECTION = /^\s*direction\s+(TB|TD|BT|RL|LR)\b/d;
const STYLE = /^\s*style\s+(?<id>[^\s,]+)\s+(?<props>.*?)\s*;?\s*$/d;
const CLASS = /^\s*class\s+(?<ids>\S+)\s+(?<name>[^\s;]+)\s*;?\s*$/d;
const CLASS_DEF = /^\s*classDef\s+(?<names>\S+)\s+(?<props>.*?)\s*;?\s*$/d;
const LINK_STYLE = /^\s*linkStyle\s+(?<indices>\S+)\s+(?<props>.*?)\s*;?\s*$/d;

const ranged = (line: SourceLine, m: RegExpExecArray, group: string): Ranged => {
  const [a, b] = m.indices!.groups![group]!;
  return { from: line.from + a, to: line.from + b, value: m.groups![group] };
};

/** カンマ区切りの値を 1 つずつの範囲に分ける */
export function splitList(r: Ranged): Ranged[] {
  const out: Ranged[] = [];
  let at = r.from;
  for (const part of r.value.split(',')) {
    out.push({ from: at, to: at + part.length, value: part });
    at += part.length + 1;
  }
  return out;
}

/** subgraph の行の、ID と題名 */
function readSubgraph(line: SourceLine, m: RegExpExecArray): Subgraph {
  const restFrom = line.from + m.indices![2]![0];
  const rest = m[2];
  const base = { line, end: null, direction: null };
  // ID [題名] / ID["題名"]
  const b = /^([^\s[\]"]+)\s*\[\s*(?:"([^"]*)"|([^\]]*?))\s*\]$/d.exec(rest);
  if (b) {
    const t = (b.indices![2] ?? b.indices![3])!;
    return { ...base, id: b[1], idRange: { from: restFrom, to: restFrom + b[1].length }, title: { from: restFrom + t[0], to: restFrom + t[1] } };
  }
  // "題名"（題名がそのまま ID になる）
  const q = /^"([^"]*)"$/.exec(rest);
  if (q) return { ...base, id: q[1], idRange: null, title: { from: restFrom + 1, to: restFrom + 1 + q[1].length } };
  // ID だけ
  if (!/\s/.test(rest)) return { ...base, id: rest, idRange: { from: restFrom, to: restFrom + rest.length }, title: null };
  // 空白を含む題名（題名がそのまま ID になる）
  return { ...base, id: rest, idRange: null, title: { from: restFrom, to: restFrom + rest.length } };
}

// 同じソースを何度も読まないよう、直前の結果を使い回す（プロパティパネル・描画のたびの対応付け・操作が同じソースを読む）。
// 返す FlowDoc は読み取り専用として扱い、呼び出し側で書き換えない
let lastSource: string | null = null;
let lastDoc: FlowDoc | null = null;

export function parseFlowchart(source: string): FlowDoc {
  if (source !== lastSource || !lastDoc) {
    lastDoc = readFlowchart(source);
    lastSource = source;
  }
  return lastDoc;
}

function readFlowchart(source: string): FlowDoc {
  const { header, body } = bodyLines(source);
  const statements: Statement[] = [];
  const unknown: SourceLine[] = [];
  const doc: Omit<FlowDoc, 'edges'> = { header, statements, unknown, subgraphs: [], styles: [], classes: [], classDefs: [], linkStyles: [], body };
  const stack: Subgraph[] = [];
  for (const line of body) {
    if (isComment(line.text)) continue;
    let m: RegExpExecArray | null;
    if ((m = SUBGRAPH.exec(line.text))) {
      const sg = readSubgraph(line, m);
      doc.subgraphs.push(sg);
      stack.push(sg);
      continue;
    }
    if (SUBGRAPH_END.test(line.text)) {
      const sg = stack.pop();
      if (sg) sg.end = line;
      continue;
    }
    if ((m = DIRECTION.exec(line.text))) {
      const sg = stack.at(-1);
      if (sg) sg.direction = { line, from: line.from + m.indices![1]![0], to: line.from + m.indices![1]![1], value: m[1] };
      continue;
    }
    if ((m = STYLE.exec(line.text))) {
      doc.styles.push({ line, id: ranged(line, m, 'id'), props: ranged(line, m, 'props') });
      continue;
    }
    if ((m = CLASS_DEF.exec(line.text))) {
      doc.classDefs.push({ line, names: ranged(line, m, 'names'), props: ranged(line, m, 'props') });
      continue;
    }
    if ((m = CLASS.exec(line.text))) {
      doc.classes.push({ line, ids: splitList(ranged(line, m, 'ids')), name: ranged(line, m, 'name') });
      continue;
    }
    if ((m = LINK_STYLE.exec(line.text))) {
      doc.linkStyles.push({ line, indices: ranged(line, m, 'indices'), props: ranged(line, m, 'props') });
      continue;
    }
    if (NON_STATEMENT.test(line.text)) continue;
    const st = readStatements(line);
    if (st) statements.push(...st);
    else unknown.push(line);
  }
  const edges: FlowEdge[] = [];
  for (const st of statements) {
    st.links.forEach((_, i) => {
      for (const a of st.groups[i]) {
        for (const b of st.groups[i + 1]) {
          edges.push({ index: edges.length, from: a.id, to: b.id, statement: st, link: i });
        }
      }
    });
  }
  return { ...doc, edges };
}

/** 文がサブグラフの中（入れ子の中も含む）にあるか */
export function isInside(sg: Subgraph, line: SourceLine): boolean {
  return line.index > sg.line.index && (sg.end === null || line.index < sg.end.index);
}

/**
 * ノードが所属するサブグラフ。mermaid は閉じた順（内側が先）に、中で言及されたノードを自分のものにし、
 * 先に取られたノードは後のサブグラフに入らない
 */
export function subgraphOf(doc: FlowDoc, id: string): Subgraph | null {
  const closing = [...doc.subgraphs].sort((a, b) => (a.end?.index ?? Infinity) - (b.end?.index ?? Infinity));
  const refs = nodeRefs(doc, id);
  return closing.find((sg) => refs.some((r) => isInside(sg, r.statement.line))) ?? null;
}

type Refs = readonly { statement: Statement; ref: NodeRef }[];
/** 文書ごとの、ノード ID → 参照の索引（ノードごとに全文を走査しないため） */
const refIndex = new WeakMap<FlowDoc, Map<string, Refs>>();

/** ノード id の参照すべて（出てくる順） */
export function nodeRefs(doc: FlowDoc, id: string): Refs {
  let index = refIndex.get(doc);
  if (!index) {
    const map = new Map<string, { statement: Statement; ref: NodeRef }[]>();
    for (const statement of doc.statements) {
      for (const g of statement.groups) {
        for (const ref of g) {
          const list = map.get(ref.id);
          if (list) list.push({ statement, ref });
          else map.set(ref.id, [{ statement, ref }]);
        }
      }
    }
    index = map;
    refIndex.set(doc, index);
  }
  return index.get(id) ?? [];
}

/** ノードの定義（形とラベル）。mermaid と同じく最後の定義を使う */
export function nodeDefinition(doc: FlowDoc, id: string): NodeRef | null {
  let found: NodeRef | null = null;
  for (const { ref } of nodeRefs(doc, id)) if (isDefinition(ref)) found = ref;
  return found;
}
