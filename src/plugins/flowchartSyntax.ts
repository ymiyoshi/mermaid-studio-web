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

export interface NodeRef {
  id: string;
  /** ノード参照全体（:::class や形も含む）の範囲 */
  from: number;
  to: number;
  idTo: number;
  shape: Shape | null;
}

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
  { open: '(((', close: [')))'], name: 'double-circle', label: '二重丸' },
  { open: '([', close: ['])'], name: 'stadium', label: 'スタジアム' },
  { open: '[[', close: [']]'], name: 'subroutine', label: 'サブルーチン' },
  { open: '[(', close: [')]'], name: 'cylinder', label: '円柱（DB）' },
  { open: '((', close: ['))'], name: 'circle', label: '円' },
  { open: '{{', close: ['}}'], name: 'hexagon', label: '六角形' },
  { open: '[/', close: ['/]', '\\]'], name: 'lean', label: '平行四辺形' },
  { open: '[\\', close: ['\\]', '/]'], name: 'lean-l', label: '平行四辺形（逆）' },
  { open: '[', close: [']'], name: 'rect', label: '四角' },
  { open: '(', close: [')'], name: 'round', label: '角丸' },
  { open: '{', close: ['}'], name: 'rhombus', label: 'ひし形' },
  { open: '>', close: [']'], name: 'asymmetric', label: '旗' },
];

/** 形の選択肢（プロパティパネル用）。open/close は新しく付けるときの括弧 */
export const SHAPE_CHOICES: { name: string; label: string; open: string; close: string }[] = [
  { name: 'rect', label: '四角', open: '[', close: ']' },
  { name: 'round', label: '角丸', open: '(', close: ')' },
  { name: 'stadium', label: 'スタジアム', open: '([', close: '])' },
  { name: 'subroutine', label: 'サブルーチン', open: '[[', close: ']]' },
  { name: 'cylinder', label: '円柱（DB）', open: '[(', close: ')]' },
  { name: 'circle', label: '円', open: '((', close: '))' },
  { name: 'double-circle', label: '二重丸', open: '(((', close: ')))' },
  { name: 'rhombus', label: 'ひし形', open: '{', close: '}' },
  { name: 'hexagon', label: '六角形', open: '{{', close: '}}' },
  { name: 'lean', label: '平行四辺形', open: '[/', close: '/]' },
  { name: 'lean-l', label: '平行四辺形（逆）', open: '[\\', close: '\\]' },
  { name: 'trapezoid', label: '台形', open: '[/', close: '\\]' },
  { name: 'trapezoid-alt', label: '台形（逆）', open: '[\\', close: '/]' },
  { name: 'asymmetric', label: '旗', open: '>', close: ']' },
];

export function shapeName(shape: Shape): string {
  return SHAPE_CHOICES.find((s) => s.open === shape.open && s.close === shape.close)?.name ?? 'rect';
}

/** 矢印の選択肢 */
export const ARROWS: { value: string; label: string }[] = [
  { value: '-->', label: '→ 矢印' },
  { value: '---', label: '― 線' },
  { value: '-.->', label: '⇢ 点線の矢印' },
  { value: '-.-', label: '┄ 点線' },
  { value: '==>', label: '⇒ 太い矢印' },
  { value: '===', label: '━ 太い線' },
  { value: '--o', label: '→○ 丸' },
  { value: '--x', label: '→× バツ' },
  { value: '<-->', label: '↔ 双方向' },
];

/** ノード参照・リンク以外の行（スタイル指定やサブグラフの宣言など） */
const NON_STATEMENT = /^\s*(subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr|%%)\b/;

// ID の途中の - は、後ろが英数字のときだけ ID の一部とみなす（A-->B の -- は矢印）
const ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?=[\p{L}\p{N}_]))*/u;
// リンク: 矢印の後ろに |ラベル| が付くことがある
const ARROW = /^([<ox]?)(-{2,}|={2,}|-\.+-)([>ox]?)/;
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
  // 新しい形の書き方 A@{ shape: ... } は形を読まずに読み飛ばす
  if (r.text.startsWith('@{', r.pos)) {
    const end = r.text.indexOf('}', r.pos);
    if (end < 0) return null;
    r.pos = end + 1;
  } else {
    shape = readShape(r);
  }
  const cls = /^:::[\p{L}\p{N}_-]+/u.exec(r.rest);
  if (cls) r.pos += cls[0].length;
  return { id, from: r.base + start, to: r.base + r.pos, idTo: r.base + idTo, shape };
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
}

export function parseFlowchart(source: string): FlowDoc {
  const { header, body } = bodyLines(source);
  const statements: Statement[] = [];
  const unknown: SourceLine[] = [];
  for (const line of body) {
    if (isComment(line.text) || NON_STATEMENT.test(line.text)) continue;
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
  return { header, statements, unknown, edges };
}

/** ノード id の参照すべて */
export function nodeRefs(doc: FlowDoc, id: string): { statement: Statement; ref: NodeRef }[] {
  const out: { statement: Statement; ref: NodeRef }[] = [];
  for (const statement of doc.statements) {
    for (const g of statement.groups) for (const ref of g) if (ref.id === id) out.push({ statement, ref });
  }
  return out;
}

/** ノードの定義（形とラベル）。mermaid と同じく最後の定義を使う */
export function nodeDefinition(doc: FlowDoc, id: string): NodeRef | null {
  let found: NodeRef | null = null;
  for (const { ref } of nodeRefs(doc, id)) if (ref.shape) found = ref;
  return found;
}
