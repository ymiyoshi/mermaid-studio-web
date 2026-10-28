import type { ChangeSpec } from '@codemirror/state';
import type { ActionResult, DiagramPlugin, DiagramTarget, ElementRef, PropertyField, SourceRange } from './types';
import { withGeneric } from './generic';
import { bodyLines, indentOf, splitLines, type SourceLine } from './source';
import { removeLines } from './lineOps';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { matchInOrder } from './svg';
import { t } from '../i18n';

// railroad（構文図）のプラグイン（設計書 §7.3）。
// 書き方は 4 通り（railroad-beta の関数形式・EBNF・ABNF・PEG）で、描かれる図は同じ。
// 規則は「名前 = 定義 ;」で、空白・改行は意味を持たない（1 つの規則が複数行にわたることも、1 行に複数の規則を書くこともある）。
// そのため行ではなく、mermaid の字句（@mermaid-js/parser の正規表現）に合わせた小さな字句解析で、規則の範囲と定義の中の記号を読む。
// SVG の規則（g.railroad-rule）は描かれた名前「NAME =」で、規則の中の箱（終端・非終端・特殊）は、種類と文字が一致するものを出てくる順に対応付ける。

export type Dialect = 'rr' | 'ebnf' | 'abnf' | 'peg';

const HEADER = /^\s*(railroad(?:-(?:ebnf|abnf|peg))?-beta)(?![\w-])/;
const DIALECTS: Record<string, Dialect> = {
  'railroad-beta': 'rr',
  'railroad-ebnf-beta': 'ebnf',
  'railroad-abnf-beta': 'abnf',
  'railroad-peg-beta': 'peg',
};

/** 規則の名前（ASCII だけ。ABNF は _ を使えず、先頭は英字） */
const NAME: Record<Dialect, RegExp> = {
  rr: /^[A-Z_a-z][\w-]*$/,
  ebnf: /^[A-Z_a-z][\w-]*$/,
  abnf: /^[A-Za-z][A-Za-z0-9-]*$/,
  peg: /^[A-Z_a-z][\w-]*$/,
};

// ---- 字句解析 ----

interface Tok {
  type: 'id' | 'str' | 'special' | 'numval' | 'repeat' | 'punct' | 'meta' | 'error';
  from: number;
  to: number;
  text: string;
}

interface Comment {
  from: number;
  to: number;
  /** 行末まで続くコメント（%% … / PEG の # … / ABNF の ; …） */
  line: boolean;
}

const WS = /[\t \r\n]+/y;
const DIRECTIVE = /[\t ]*%%\{[\s\S]*?\}%%/y;
const PCT_COMMENT = /%%[^\n\r]*/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//y;
const ISO_COMMENT = /\(\*[\s\S]*?\*\)/y;
const HASH_COMMENT = /#[^\n\r]*/y;
const SEMI_COMMENT = /;[^\n\r]*/y;
// title・accTitle・accDescr は、どこに現れても行末までを 1 つの字句として読む（mermaid と同じ）
const META = [
  /title(?:[\t ][^\n\r]*?(?=%%)|[\t ][^\n\r]*|)/y,
  /accTitle[\t ]*:(?:[^\n\r]*?(?=%%)|[^\n\r]*)/y,
  /accDescr(?:[\t ]*:(?:[^\n\r]*?(?=%%)|[^\n\r]*)|\s*\{[^}]*\})/y,
];
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y;
const ABNF_STRING = /"[^"]*"/y;
const SPECIAL = /\?(?=[^?;]*[^?\s;][^?;]*\?)[^?;]*\?/y;
const NUMVAL = /%[xXdDbB][0-9A-Fa-f]+(?:-[0-9A-Fa-f]+|\.[0-9A-Fa-f]+)*/y;
const REPEAT = /[0-9]*\*[0-9]*|[0-9]+/y;
const ID = /[A-Z_a-z][\w-]*/y;
const ABNF_ID = /[A-Za-z][A-Za-z0-9-]*/y;

function stickyAt(re: RegExp, s: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(s);
  return m && m[0].length > 0 ? m[0] : null;
}

function lex(s: string, start: number, d: Dialect): { toks: Tok[]; comments: Comment[] } {
  const toks: Tok[] = [];
  const comments: Comment[] = [];
  const blockComments = d === 'ebnf' ? [BLOCK_COMMENT, ISO_COMMENT] : d === 'rr' ? [BLOCK_COMMENT] : [];
  let i = start;
  const tok = (type: Tok['type'], text: string) => {
    toks.push({ type, from: i, to: i + text.length, text });
    i += text.length;
  };
  const comment = (text: string, line: boolean) => {
    comments.push({ from: i, to: i + text.length, line });
    i += text.length;
  };
  outer: while (i < s.length) {
    let m = stickyAt(WS, s, i);
    if (m) {
      i += m.length;
      continue;
    }
    if ((m = stickyAt(DIRECTIVE, s, i))) {
      comment(m, false);
      continue;
    }
    if ((m = stickyAt(PCT_COMMENT, s, i))) {
      comment(m, true);
      continue;
    }
    for (const re of blockComments) {
      if ((m = stickyAt(re, s, i))) {
        comment(m, false);
        continue outer;
      }
    }
    if (d === 'peg' && (m = stickyAt(HASH_COMMENT, s, i))) {
      comment(m, true);
      continue;
    }
    if (d === 'abnf' && s[i] === ';') {
      // ABNF の ; は、直後が改行か文書の終わりなら規則の終わり。そうでなければ行末までのコメント（空白が続くだけでもコメントになる）
      m = stickyAt(SEMI_COMMENT, s, i)!;
      if (m.length > 1) comment(m, true);
      else tok('punct', ';');
      continue;
    }
    for (const re of META) {
      if ((m = stickyAt(re, s, i))) {
        tok('meta', m);
        continue outer;
      }
    }
    if ((m = stickyAt(d === 'abnf' ? ABNF_STRING : STRING, s, i))) {
      tok('str', m);
      continue;
    }
    if (d === 'ebnf' && (m = stickyAt(SPECIAL, s, i))) {
      tok('special', m);
      continue;
    }
    if (d === 'abnf' && (m = stickyAt(NUMVAL, s, i))) {
      tok('numval', m);
      continue;
    }
    if (d === 'abnf' && (m = stickyAt(REPEAT, s, i))) {
      tok('repeat', m);
      continue;
    }
    if ((m = stickyAt(d === 'abnf' ? ABNF_ID : ID, s, i))) {
      tok('id', m);
      continue;
    }
    if (d === 'ebnf' && s.startsWith('::=', i)) {
      tok('punct', '::=');
      continue;
    }
    if (d === 'peg' && s.startsWith('<-', i)) {
      tok('punct', '<-');
      continue;
    }
    // 閉じていない引用符や、使えない文字
    tok(/[\p{L}\p{N}"'`\\]/u.test(s[i]) ? 'error' : 'punct', s[i]);
  }
  return { toks, comments };
}

// ---- 定義の中の記号（描かれる箱） ----

type LeafClass = 'terminal' | 'nonterminal' | 'special';

/** 図に描かれる箱 1 つ */
export interface Leaf {
  cls: LeafClass;
  /** mermaid が読んだ値（終端の文字列・規則の名前・特殊の文言）。図の文字は special だけ「? 値 ?」 */
  value: string;
  /** 図から編集できるソースの範囲（引用符の内側など）。ソースに書かれていない箱（EBNF の除外の -、PEG の !x・&x・.）は null */
  range: SourceRange | null;
  /** ソースでの書き方 */
  form: 'str' | 'id' | 'special' | 'numval' | 'none';
  quote?: string;
}

type Node = { k: 'leaf'; leaf: Leaf } | { k: 'seq' | 'choice'; items: Node[] } | { k: 'opt' | 'rep'; item: Node };

const collapse = (k: 'seq' | 'choice', items: Node[]): Node => (items.length === 1 ? items[0] : { k, items });
const leafNode = (leaf: Leaf): Node => ({ k: 'leaf', leaf });

function flatten(n: Node, out: Leaf[] = []): Leaf[] {
  if (n.k === 'leaf') out.push(n.leaf);
  else if ('items' in n) for (const x of n.items) flatten(x, out);
  else flatten(n.item, out);
  return out;
}

/** 引用符の中を読む（mermaid の decodeEscapedString と同じ。ABNF にはエスケープが無い） */
function decode(d: Dialect, quoted: string): string {
  const content = quoted.slice(1, -1);
  if (d === 'abnf') return content;
  let v = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '\\' && i + 1 < content.length) {
      const e = content[++i];
      v += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e;
    } else v += c;
  }
  return v;
}

/** 値を引用符の中に書ける形にする */
function encode(d: Dialect, value: string, quote: string): string {
  if (d === 'abnf') return value.replace(/["\r\n]/g, '');
  return value
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

class Parser {
  i = 0;
  constructor(
    readonly toks: Tok[],
    readonly d: Dialect,
  ) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  is(text: string): boolean {
    const x = this.toks[this.i];
    return !!x && x.type === 'punct' && x.text === text;
  }
  /** 区切り（これ以上この並びが続かない字句）か */
  stop(...texts: string[]): boolean {
    const x = this.toks[this.i];
    return !x || (x.type === 'punct' && texts.includes(x.text));
  }
  next(): Tok {
    const x = this.toks[this.i++];
    if (!x) throw new Error('end');
    return x;
  }
  expect(text: string) {
    if (!this.is(text)) throw new Error(`expected ${text}`);
    this.i++;
  }
  str(x: Tok): Leaf {
    return { cls: 'terminal', value: decode(this.d, x.text), range: { from: x.from + 1, to: x.to - 1 }, form: 'str', quote: x.text[0] };
  }
  id(x: Tok): Leaf {
    return { cls: 'nonterminal', value: x.text, range: { from: x.from, to: x.to }, form: 'id' };
  }
  /** 繰り返す選択（区切りの記号 sep で分けた並び） */
  list(sep: string, item: () => Node): Node {
    const items = [item()];
    while (this.is(sep)) {
      this.i++;
      items.push(item());
    }
    return collapse('choice', items);
  }
}

/** EBNF: Choice = Seq ("|" Seq)* / Seq = Term ([","] Term)* / Term = Primary ("?" | "*" | "+" | "-" Primary)* */
function parseEbnf(p: Parser): Node {
  const choice = (): Node => p.list('|', seq);
  const seq = (): Node => {
    const items: Node[] = [];
    while (!p.stop(';', '|', ')', ']', '}')) {
      if (p.is(',')) {
        p.i++;
        continue;
      }
      items.push(term());
    }
    if (!items.length) throw new Error('empty');
    return collapse('seq', items);
  };
  const term = (): Node => {
    let n = primary();
    for (;;) {
      if (p.is('?')) n = { k: 'opt', item: n };
      else if (p.is('*') || p.is('+')) n = { k: 'rep', item: n };
      else if (p.is('-')) {
        p.i++;
        // a - b は「a、- という終端、b」の並びとして描かれる
        const except = primary();
        n = { k: 'seq', items: [n, leafNode({ cls: 'terminal', value: '-', range: null, form: 'none' }), except] };
        continue;
      } else return n;
      p.i++;
    }
  };
  const primary = (): Node => {
    const x = p.next();
    if (x.type === 'str') return leafNode(p.str(x));
    if (x.type === 'id') return leafNode(p.id(x));
    if (x.type === 'special') {
      const inner = x.text.slice(1, -1);
      const value = inner.trim();
      const from = x.from + 1 + (inner.length - inner.trimStart().length);
      return leafNode({ cls: 'special', value, range: { from, to: from + value.length }, form: 'special' });
    }
    if (x.type === 'punct' && (x.text === '(' || x.text === '[' || x.text === '{')) {
      const inner = choice();
      p.expect(x.text === '(' ? ')' : x.text === '[' ? ']' : '}');
      return x.text === '(' ? inner : { k: x.text === '[' ? 'opt' : 'rep', item: inner };
    }
    throw new Error('primary');
  };
  return choice();
}

/** ABNF: Alt = Concat ("/" Concat)* / Concat = Element+ / Element = [repeat] Primary */
function parseAbnf(p: Parser): Node {
  const alt = (): Node => p.list('/', concat);
  const concat = (): Node => {
    const items: Node[] = [];
    while (!p.stop(';', '/', ')', ']')) items.push(element());
    if (!items.length) throw new Error('empty');
    return collapse('seq', items);
  };
  const element = (): Node => {
    const rep = p.peek()?.type === 'repeat' ? p.next().text : null;
    const inner = primary();
    if (rep === null) return inner;
    // mermaid の parseRepeat と同じ: 0 回か 1 回なら省略可、それ以外は繰り返しとして描く
    const [a, b] = rep.includes('*') ? rep.split('*') : [rep, rep];
    const min = a ? Number(a) : 0;
    const max = b ? Number(b) : Infinity;
    return { k: min === 0 && max === 1 ? 'opt' : 'rep', item: inner };
  };
  const primary = (): Node => {
    const x = p.next();
    if (x.type === 'str') return leafNode(p.str(x));
    if (x.type === 'numval') return leafNode({ cls: 'terminal', value: x.text, range: { from: x.from, to: x.to }, form: 'numval' });
    if (x.type === 'id') return leafNode(p.id(x));
    if (x.type === 'punct' && (x.text === '(' || x.text === '[')) {
      const inner = alt();
      p.expect(x.text === '(' ? ')' : ']');
      return x.text === '(' ? inner : { k: 'opt', item: inner };
    }
    throw new Error('primary');
  };
  return alt();
}

/** PEG: Choice = Seq ("/" Seq)* / Seq = Prefix+ / Prefix = ["&" | "!"] Suffix / Suffix = Primary ["?" | "*" | "+"] */
function parsePeg(p: Parser): Node {
  const choice = (): Node => p.list('/', seq);
  const seq = (): Node => {
    const items: Node[] = [];
    while (!p.stop(';', '/', ')')) items.push(prefix());
    if (!items.length) throw new Error('empty');
    return collapse('seq', items);
  };
  // mermaid は &x・!x を、中身をまとめた 1 つの特殊の箱として描く（中身の箱は描かない）
  const label = (n: Node): string =>
    n.k !== 'leaf' ? '(...)' : n.leaf.cls === 'terminal' ? `"${n.leaf.value}"` : n.leaf.value;
  const prefix = (): Node => {
    if (p.is('&') || p.is('!')) {
      const op = p.next().text;
      const inner = suffix();
      return leafNode({ cls: 'special', value: op + label(inner), range: null, form: 'none' });
    }
    return suffix();
  };
  const suffix = (): Node => {
    const inner = primary();
    if (p.is('?')) {
      p.i++;
      return { k: 'opt', item: inner };
    }
    if (p.is('*') || p.is('+')) {
      p.i++;
      return { k: 'rep', item: inner };
    }
    return inner;
  };
  const primary = (): Node => {
    const x = p.next();
    if (x.type === 'str') return leafNode(p.str(x));
    if (x.type === 'id') return leafNode(p.id(x));
    if (x.type === 'punct' && x.text === '.') return leafNode({ cls: 'special', value: '.', range: null, form: 'none' });
    if (x.type === 'punct' && x.text === '(') {
      const inner = choice();
      p.expect(')');
      return inner;
    }
    throw new Error('primary');
  };
  return choice();
}

const RR_LEAVES: Record<string, LeafClass> = { terminal: 'terminal', nonterminal: 'nonterminal', special: 'special' };

/** railroad-beta: terminal("…")・nonterminal("…")・special("…") が箱になる。入れ子の関数の引数は書いた順に描かれる */
function rrLeaves(toks: Tok[]): Leaf[] {
  const out: Leaf[] = [];
  for (let i = 0; i + 3 < toks.length; i++) {
    const [f, open, s, close] = toks.slice(i, i + 4);
    const cls = f.type === 'id' && Object.hasOwn(RR_LEAVES, f.text) ? RR_LEAVES[f.text] : undefined;
    if (!cls || open.text !== '(' || s.type !== 'str' || close.text !== ')') continue;
    out.push({ cls, value: decode('rr', s.text), range: { from: s.from + 1, to: s.to - 1 }, form: 'str', quote: s.text[0] });
  }
  return out;
}

function leavesOf(d: Dialect, toks: Tok[]): Leaf[] {
  if (d === 'rr') return rrLeaves(toks);
  const p = new Parser(toks, d);
  try {
    const n = d === 'ebnf' ? parseEbnf(p) : d === 'abnf' ? parseAbnf(p) : parsePeg(p);
    // 読み残しがあれば、mermaid でも構文の誤り（描かれない）
    return p.i === toks.length ? flatten(n) : [];
  } catch {
    return [];
  }
}

// ---- 規則 ----

export interface RailroadRule {
  index: number;
  /** 参照の ID（名前。同じ名前の 2 つ目からは「名前#2」） */
  id: string;
  name: SourceRange & { text: string };
  /** 名前から ; まで（; が無ければ最後の字句まで） */
  span: SourceRange;
  /** 定義（= と ; の間の、前後の空白を除いた範囲） */
  def: SourceRange;
  terminated: boolean;
  leaves: Leaf[];
  /** 定義の中で、他の規則を名前で指している所（名前の変更で一緒に書き換える） */
  refs: { range: SourceRange; name: string }[];
}

export interface RailroadDoc {
  dialect: Dialect;
  header: SourceLine;
  /** title・accTitle・accDescr */
  metas: Tok[];
  rules: RailroadRule[];
  toks: Tok[];
  comments: Comment[];
}

const isOp = (d: Dialect, x: Tok | undefined) =>
  !!x && x.type === 'punct' && (d === 'peg' ? x.text === '<-' : x.text === '=' || (d === 'ebnf' && x.text === '::='));

export function parseRailroad(source: string): RailroadDoc | null {
  const { header } = bodyLines(source);
  const m = header && HEADER.exec(header.text);
  if (!header || !m) return null;
  const d = DIALECTS[m[1]];
  const { toks, comments } = lex(source, header.from + m[0].length, d);
  const rules: RailroadRule[] = [];
  const metas: Tok[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  while (i < toks.length) {
    const x = toks[i];
    if (x.type === 'meta') metas.push(x);
    if (x.type !== 'id' || !isOp(d, toks[i + 1])) {
      i++;
      continue;
    }
    const op = toks[i + 1];
    let j = i + 2;
    while (j < toks.length && !(toks[j].type === 'punct' && toks[j].text === ';')) j++;
    const semi = toks[j];
    const body = toks.slice(i + 2, j);
    let from = op.to;
    let to = semi ? semi.from : (body.at(-1)?.to ?? op.to);
    while (from < to && /\s/.test(source[from])) from++;
    while (to > from && /\s/.test(source[to - 1])) to--;
    const k = (seen.get(x.text) ?? 0) + 1;
    seen.set(x.text, k);
    const leaves = leavesOf(d, body);
    const refs =
      d === 'rr'
        ? leaves.filter((l) => l.cls === 'nonterminal').map((l) => ({ range: l.range!, name: l.value }))
        : body.filter((b) => b.type === 'id').map((b) => ({ range: { from: b.from, to: b.to }, name: b.text }));
    rules.push({
      index: rules.length,
      id: k === 1 ? x.text : `${x.text}#${k}`,
      name: { from: x.from, to: x.to, text: x.text },
      span: { from: x.from, to: semi ? semi.to : to },
      def: { from, to },
      terminated: !!semi,
      leaves,
      refs,
    });
    i = j + 1;
  }
  return { dialect: d, header, metas, rules, toks, comments };
}

/** 規則の並び names の j 番目の参照の ID */
function idAt(names: string[], j: number): string {
  const k = names.slice(0, j).filter((n) => n === names[j]).length;
  return k === 0 ? names[j] : `${names[j]}#${k + 1}`;
}

const findRule = (doc: RailroadDoc, ref: ElementRef | null | undefined) => (ref?.kind === 'rule' ? doc.rules.find((r) => r.id === ref.id) : undefined);

function findTerm(doc: RailroadDoc, ref: ElementRef | null | undefined): { rule: RailroadRule; leaf: Leaf } | null {
  if (ref?.kind !== 'term') return null;
  const [ri, k] = ref.id.split(':').map(Number);
  const rule = doc.rules[ri];
  const leaf = rule?.leaves[k];
  return rule && leaf ? { rule, leaf } : null;
}

/** 図に描かれる文字 */
const drawn = (l: Leaf) => (l.cls === 'special' ? `? ${l.value} ?` : l.value);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---- 書き換え ----

function lineAt(lines: SourceLine[], pos: number): SourceLine {
  return lines.find((l) => pos >= l.from && pos <= l.to) ?? lines[lines.length - 1];
}

/** 新しい規則の名前（ASCII で、まだ規則や参照に使われていないもの） */
function newName(doc: RailroadDoc): string {
  const used = new Set<string>();
  for (const r of doc.rules) {
    used.add(r.name.text);
    for (const x of r.refs) used.add(x.name);
  }
  const base = doc.dialect === 'peg' ? 'Rule' : 'rule';
  for (let k = 1; ; k++) if (!used.has(`${base}${k}`)) return `${base}${k}`;
}

/** 新しい規則の文。EBNF は、近くの規則と同じ記号（= か ::=）を使う */
function newRuleText(doc: RailroadDoc, source: string, name: string, near: RailroadRule | undefined): string {
  switch (doc.dialect) {
    case 'rr':
      return `${name} = terminal("a");`;
    case 'abnf':
      return `${name} = "a";`;
    case 'peg':
      return `${name} <- "a";`;
    case 'ebnf': {
      const op = near && /^\s*::=/.test(source.slice(near.name.to, near.def.from)) ? '::=' : '=';
      return `${name} ${op} "a" ;`;
    }
  }
}

/** 規則 r の後ろに、新しい規則を差し込む変更 */
function insertAfterRule(source: string, doc: RailroadDoc, r: RailroadRule, text: string): ChangeSpec {
  const lines = splitLines(source);
  const end = r.span.to;
  const line = lineAt(lines, end);
  const indent = indentOf(lineAt(lines, r.name.from).text);
  // 同じ行の後ろに次の規則が続く（1 行に複数の規則）なら、; の直後に続けて書く
  const next = doc.toks.find((x) => x.from >= end);
  if (doc.dialect !== 'abnf' && next && next.from <= line.to) return { from: end, insert: ` ${text}` };
  // ; の後ろから次の行以降まで続くコメントがあれば、その後ろの行に
  let last = end;
  for (const c of doc.comments) if (c.from >= end && c.from <= line.to) last = Math.max(last, c.to);
  return { from: lineAt(lines, last).to, insert: `\n${indent}${text}` };
}

/** 図の最後に規則を足す変更 */
function appendRule(source: string, doc: RailroadDoc, text: string): ChangeSpec {
  const lastRule = doc.rules.at(-1);
  if (lastRule) return insertAfterRule(source, doc, lastRule, text);
  const lines = splitLines(source);
  const lastMeta = doc.metas.at(-1);
  const after = lastMeta ? lineAt(lines, lastMeta.to) : doc.header;
  const indent = lastMeta ? indentOf(lineAt(lines, lastMeta.from).text) : '';
  return { from: after.to, insert: `\n${indent}${text}` };
}

/** 規則を消す変更。規則だけの行なら行ごと消し、同じ行に他の字句があれば規則の部分だけを消す */
function deleteRule(source: string, doc: RailroadDoc, r: RailroadRule): ChangeSpec {
  const lines = splitLines(source);
  const first = lineAt(lines, r.span.from);
  const last = lineAt(lines, r.span.to);
  const before = source.slice(first.from, r.span.from);
  const tailTok = doc.toks.some((x) => x.from >= r.span.to && x.from < last.to);
  const tailOpenComment = doc.comments.some((c) => c.from >= r.span.to && c.from < last.to && c.to > last.to);
  if (!before.trim() && !tailTok && !tailOpenComment) return removeLines(source, first, last);
  if (tailTok || tailOpenComment) {
    const spaces = /^[\t ]*/.exec(source.slice(r.span.to))![0].length;
    return { from: r.span.from, to: r.span.to + spaces };
  }
  const spaces = /[\t ]*$/.exec(before)![0].length;
  return { from: r.span.from - spaces, to: r.span.to };
}

/** 規則 i を、並びの中の newOrder の位置へ動かす（規則の文の中身だけを入れ替え、間の空白・コメントには触れない） */
function reorderRules(source: string, doc: RailroadDoc, order: number[], moved: number): ActionResult | null {
  const changes: ChangeSpec[] = [];
  for (let p = 0; p < order.length; p++) {
    if (order[p] === p) continue;
    const at = doc.rules[p];
    const from = doc.rules[order[p]];
    // ; が無い規則（書きかけ）は動かさない（ABNF では ; の後ろが改行であることも保たれる）
    if (!at.terminated || !from.terminated) return null;
    changes.push({ from: at.span.from, to: at.span.to, insert: source.slice(from.span.from, from.span.to) });
  }
  if (!changes.length) return null;
  const names = order.map((k) => doc.rules[k].name.text);
  const r = doc.rules[moved];
  return { change: changes, label: t('rr.history.move', { name: r.name.text }), select: { kind: 'rule', id: idAt(names, order.indexOf(moved)) } };
}

function moveBy(source: string, ref: ElementRef, delta: number): ActionResult | null {
  const doc = parseRailroad(source);
  const r = doc && findRule(doc, ref);
  if (!doc || !r) return null;
  const j = r.index + delta;
  if (j < 0 || j >= doc.rules.length) return null;
  const order = doc.rules.map((x) => x.index);
  [order[r.index], order[j]] = [order[j], order[r.index]];
  return reorderRules(source, doc, order, r.index);
}

const TITLE: KeywordSpec = { id: 'title', label: t('rr.field.title'), keyword: 'title', quoted: true };

/** 規則の名前を変える。同じ名前の規則が他に無ければ、定義の中の参照も一緒に変える */
function renameRule(doc: RailroadDoc, r: RailroadRule, value: string): ChangeSpec | null {
  const v = value.trim();
  if (!NAME[doc.dialect].test(v) || v === r.name.text) return null;
  // 他の規則と同じ名前にすると、その規則への参照と区別できなくなる
  if (doc.rules.some((o) => o !== r && o.name.text === v)) return null;
  const changes: ChangeSpec[] = [{ from: r.name.from, to: r.name.to, insert: v }];
  if (doc.rules.filter((o) => o.name.text === r.name.text).length === 1) {
    for (const o of doc.rules) for (const x of o.refs) if (x.name === r.name.text) changes.push({ ...x.range, insert: v });
  }
  return changes;
}

/** 定義を置き換える。; や行末までのコメントを含む値は、規則の区切りを変えてしまうので受け付けない */
function setDefinition(doc: RailroadDoc, r: RailroadRule, value: string): ChangeSpec | null {
  const v = value.trim();
  if (!v || /[\r\n]/.test(v) || r.def.from === r.def.to) return null;
  const { toks, comments } = lex(v, 0, doc.dialect);
  if (toks.some((x) => x.type === 'error' || x.type === 'meta' || (x.type === 'punct' && x.text === ';')) || comments.some((c) => c.line)) return null;
  return { from: r.def.from, to: r.def.to, insert: v };
}

/** 箱の文字を変える */
function setLeaf(d: Dialect, leaf: Leaf, value: string): ChangeSpec | null {
  if (!leaf.range) return null;
  const { from, to } = leaf.range;
  switch (leaf.form) {
    case 'str':
      return { from, to, insert: encode(d, value, leaf.quote ?? '"') };
    case 'id': {
      const v = value.trim();
      return NAME[d].test(v) ? { from, to, insert: v } : null;
    }
    case 'special': {
      // EBNF の ? … ?: 中に ? と ; は書けない
      const v = value.trim();
      return v && !/[?;\r\n]/.test(v) ? { from, to, insert: v } : null;
    }
    case 'numval': {
      const v = value.trim();
      NUMVAL.lastIndex = 0;
      return NUMVAL.exec(v)?.[0] === v ? { from, to, insert: v } : null;
    }
    default:
      return null;
  }
}

export const railroadPlugin: DiagramPlugin = {
  type: 'railroad',

  mapTargets(svg, source) {
    const doc = parseRailroad(source);
    const mapped: DiagramTarget[] = [];
    if (doc) {
      const groups = [...svg.querySelectorAll('g.railroad-rule')];
      const nameEl = (g: Element) => g.querySelector('text.railroad-rule-name');
      // 図の規則名は「NAME =」（書き方によらず =）
      const nameOf = (g: Element) => norm(nameEl(g)?.textContent ?? '').replace(/\s*=$/, '');
      const ruleOf = matchInOrder(groups, doc.rules, (g, r) => nameOf(g) === r.name.text);
      groups.forEach((g, gi) => {
        const r = doc.rules[ruleOf[gi]];
        if (!r) return;
        mapped.push({ id: `railroad-rule-${r.index}`, el: g, labelEl: nameEl(g) ?? g, label: r.name.text, range: null, ref: { kind: 'rule', id: r.id } });
        const boxes = [...g.querySelectorAll('g.railroad-terminal, g.railroad-nonterminal, g.railroad-special')];
        const leafOf = matchInOrder(boxes, r.leaves, (el, l) => el.classList.contains(`railroad-${l.cls}`) && norm(el.querySelector('text')?.textContent ?? '') === norm(drawn(l)));
        boxes.forEach((el, bi) => {
          const k = leafOf[bi];
          const l = r.leaves[k];
          if (!l) return;
          const labelEl = el.querySelector('text') ?? el;
          mapped.push({
            id: `railroad-term-${r.index}-${k}`,
            el,
            labelEl,
            // 図の文字はエスケープを読んだ後の値なので、ソースの書き方のままを出す
            label: l.range ? source.slice(l.range.from, l.range.to) : norm(labelEl.textContent ?? ''),
            range: l.range,
            ref: { kind: 'term', id: `${r.index}:${k}` },
          });
        });
      });
    }
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    if (!ref) return keywordFields(source, [TITLE]);
    const doc = parseRailroad(source);
    if (!doc) return [];
    const r = findRule(doc, ref);
    if (r) {
      const def = source.slice(r.def.from, r.def.to);
      return [
        { id: 'name', label: t('rr.field.name'), type: 'text', value: r.name.text, commitOnBlur: true },
        // 入力欄は 1 行なので、複数行の定義は表示だけ（書き換えるとコメントや改行が崩れる）
        { id: 'definition', label: t('rr.field.definition'), type: 'text', value: /[\r\n]/.test(def) ? norm(def) : def, readonly: /[\r\n]/.test(def), commitOnBlur: true },
      ];
    }
    const term = findTerm(doc, ref);
    if (!term) return [];
    const { leaf } = term;
    return [
      { id: 'kind', label: t('rr.field.kind'), type: 'text', value: t(`rr.kind.${leaf.cls}`), readonly: true },
      { id: 'text', label: t(`rr.field.${leaf.cls}`), type: 'text', value: leaf.value, readonly: !leaf.range || /[\r\n]/.test(leaf.value), commitOnBlur: leaf.form === 'id' },
    ];
  },

  setProperty(source, ref, field, value) {
    if (!ref) return field === 'title' ? setKeyword(source, TITLE, value.trim()) : null;
    const doc = parseRailroad(source);
    if (!doc) return null;
    const r = findRule(doc, ref);
    if (r) {
      if (field === 'name') return renameRule(doc, r, value);
      if (field === 'definition') return setDefinition(doc, r, value);
      return null;
    }
    const term = findTerm(doc, ref);
    return term && field === 'text' ? setLeaf(doc.dialect, term.leaf, value) : null;
  },

  actions: [
    {
      id: 'add-rule',
      title: t('rr.action.addRule'),
      arity: 0,
      run(source) {
        const doc = parseRailroad(source);
        if (!doc) return null;
        const name = newName(doc);
        const change = appendRule(source, doc, newRuleText(doc, source, name, doc.rules.at(-1)));
        return { change, label: t('rr.history.add', { name }), select: { kind: 'rule', id: name } };
      },
    },
    {
      id: 'add-next',
      title: t('rr.action.addNext'),
      arity: 1,
      appliesTo: ['rule', 'term'],
      key: 'Tab',
      run(source, [ref]) {
        const doc = parseRailroad(source);
        const r = doc && (findRule(doc, ref) ?? findTerm(doc, ref)?.rule);
        if (!doc || !r) return null;
        const name = newName(doc);
        const change = insertAfterRule(source, doc, r, newRuleText(doc, source, name, r));
        return { change, label: t('rr.history.add', { name }), select: { kind: 'rule', id: name } };
      },
    },
    {
      id: 'move-up',
      title: '↑',
      arity: 1,
      appliesTo: ['rule'],
      run: (source, [ref]) => moveBy(source, ref, -1),
    },
    {
      id: 'move-down',
      title: '↓',
      arity: 1,
      appliesTo: ['rule'],
      run: (source, [ref]) => moveBy(source, ref, 1),
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['rule'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const doc = parseRailroad(source);
        const r = doc && findRule(doc, ref);
        if (!doc || !r) return null;
        return { change: deleteRule(source, doc, r), label: t('rr.history.delete', { name: r.name.text }) };
      },
    },
  ],

  // 規則は上から順に並ぶので、上下のドラッグで並べ替える
  reorder: {
    axis(source, ref) {
      const doc = parseRailroad(source);
      return doc && findRule(doc, ref) ? 'y' : null;
    },
    accepts: (ref, target) => ref.kind === 'rule' && target.kind === 'rule',
    move(source, ref, target, before) {
      const doc = parseRailroad(source);
      const r = doc && findRule(doc, ref);
      const tr = doc && findRule(doc, target);
      if (!doc || !r || !tr || r === tr) return null;
      const order = doc.rules.map((x) => x.index).filter((k) => k !== r.index);
      const at = order.indexOf(tr.index) + (before ? 0 : 1);
      order.splice(at, 0, r.index);
      return reorderRules(source, doc, order, r.index);
    },
  },
};
