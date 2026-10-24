import { splitLines, isComment, bodyLines, type SourceLine } from '../plugins/source';
import type { ParseError } from './mermaid';
import { t } from '../i18n';

// 構文エラーの説明と直し方の案。mermaid のエラーは英語で、場所もずれることがあるので、
// よくある間違いをソースから探して日本語で説明する。直し方は対象の範囲だけを書き換える変更にし、
// 画面で出す前に mermaid.parse を通るか確かめる（通らない案は出さない）。

export interface ErrorFix {
  label: string;
  spec: { from: number; to: number; insert: string };
}

export interface ErrorHelp {
  /** 日本語の説明 */
  summary: string;
  /** 問題のある行（1 始まり）。分からなければ null */
  line: number | null;
  fixes: ErrorFix[];
}

const KNOWN_TYPES = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'stateDiagram', 'erDiagram', 'journey', 'gantt',
  'pie', 'quadrantChart', 'requirementDiagram', 'gitGraph', 'C4Context', 'mindmap', 'timeline', 'sankey-beta', 'xychart-beta',
  'block-beta', 'packet-beta', 'kanban', 'architecture-beta', 'radar-beta', 'treemap-beta',
];

const OPEN_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
const CLOSERS = new Set([']', ')', '}']);

/** 大文字小文字を区別しない編集距離 */
function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

/** 行の中で閉じていない括弧か引用符。見つかれば、閉じる文字と差し込む位置を返す */
function unclosed(line: SourceLine): { open: string; close: string; at: number } | null {
  const stack: { ch: string; i: number }[] = [];
  let quote = -1;
  const s = line.text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote >= 0) {
      if (ch === '"') quote = -1;
      continue;
    }
    // エッジのラベル |…| の中は文字として読む
    if (ch === '|') {
      const k = s.indexOf('|', i + 1);
      if (k > 0) {
        i = k;
        continue;
      }
    }
    if (ch === '"') quote = i;
    else if (ch in OPEN_CLOSE) stack.push({ ch, i });
    else if (CLOSERS.has(ch) && stack.length && OPEN_CLOSE[stack[stack.length - 1].ch] === ch) stack.pop();
  }
  if (quote >= 0) {
    // 引用符は、後ろにある閉じ括弧の手前で閉じる（A["開始] → A["開始"]）
    const rest = s.slice(quote + 1);
    const k = rest.search(/[\])}]/);
    return { open: '"', close: '"', at: line.from + quote + 1 + (k >= 0 ? k : rest.length) };
  }
  const top = stack.pop();
  if (!top) return null;
  // 括弧は、後ろにある矢印の手前で閉じる（A[開始 --> B → A[開始] --> B）。矢印が無ければ行末
  const rest = s.slice(top.i + 1);
  const m = /\s*(<?[-=.]{2,}[>xo]?|~~~|-->|---)/.exec(rest);
  return { open: top.ch, close: OPEN_CLOSE[top.ch], at: line.from + top.i + 1 + (m ? m.index : rest.trimEnd().length) };
}

/** 枠を開く行と閉じる行（end）の対応。閉じていない枠と、余分な end を返す */
function blocks(lines: SourceLine[], opener: RegExp) {
  const stack: SourceLine[] = [];
  let extra: SourceLine | null = null;
  for (const l of lines) {
    if (isComment(l.text)) continue;
    if (opener.test(l.text)) stack.push(l);
    else if (/^\s*end\s*$/.test(l.text)) {
      if (stack.length) stack.pop();
      else extra ??= l;
    }
  }
  return { open: stack, extra };
}

const lineNo = (l: SourceLine) => l.index + 1;

export function explainError(source: string, error: ParseError): ErrorHelp {
  const lines = splitLines(source);
  const { header } = bodyLines(source);
  const kind = header ? (/^\s*([\w-]+)/.exec(header.text)?.[1] ?? '') : '';
  const msg = error.message;

  // 図種が分からない
  if (/No diagram type detected/i.test(msg) && header) {
    const m = /^(\s*)([\w-]+)/.exec(header.text);
    const word = m?.[2] ?? '';
    const best = KNOWN_TYPES.map((x) => ({ x, d: distance(word, x) })).sort((a, b) => a.d - b.d)[0];
    const fixes: ErrorFix[] =
      m && best && best.d > 0 && best.d <= Math.max(2, Math.floor(word.length / 3))
        ? [{ label: t('err.fixType', { type: best.x }), spec: { from: header.from + m[1].length, to: header.from + m[1].length + word.length, insert: best.x } }]
        : [];
    return { summary: t('err.unknownType', { word }), line: lineNo(header), fixes };
  }

  const isFlow = kind === 'flowchart' || kind === 'graph';
  const isSeq = kind === 'sequenceDiagram';
  const body = lines.filter((l) => !header || l.index > header.index);

  // フローチャート: 閉じていない括弧・引用符（エラーの行より前にあることが多いので、本体を上から探す）。
  // 他の図種では括弧が書き方の一部（ER 図の }o--o{、クラス図の { など）なので探さない
  for (const l of isFlow ? body : []) {
    if (isComment(l.text)) continue;
    const u = unclosed(l);
    if (u) {
      return {
        summary: t('err.unclosed', { line: String(lineNo(l)), open: u.open }),
        line: lineNo(l),
        fixes: [{ label: t('err.fixClose', { close: u.close }), spec: { from: u.at, to: u.at, insert: u.close } }],
      };
    }
  }

  // 閉じていない枠・余分な end
  const opener = isFlow ? /^\s*subgraph\b/ : isSeq ? /^\s*(loop|alt|opt|par|par_over|critical|break|rect|box)\b/ : null;
  if (opener) {
    const b = blocks(body, opener);
    if (b.extra) {
      const l = b.extra;
      const from = l.index > 0 ? l.from - 1 : l.from;
      return {
        summary: t('err.extraEnd', { line: String(lineNo(l)) }),
        line: lineNo(l),
        fixes: [{ label: t('err.fixRemoveLine'), spec: { from, to: l.index > 0 ? l.to : Math.min(l.to + 1, source.length), insert: '' } }],
      };
    }
    if (b.open.length) {
      const inner = b.open[b.open.length - 1];
      const word = /^\s*(\w+)/.exec(inner.text)![1];
      // 開いた順と逆に、開いた行のインデントで閉じる
      const ends = [...b.open].reverse().map((l) => `${/^\s*/.exec(l.text)![0]}end`).join('\n');
      const atEnd = source.endsWith('\n') ? `${ends}\n` : `\n${ends}`;
      return {
        summary: t('err.notClosed', { line: String(lineNo(inner)), word }),
        line: lineNo(inner),
        fixes: [{ label: t('err.fixAddEnd'), spec: { from: source.length, to: source.length, insert: atEnd } }],
      };
    }
  }

  // フローチャート: end をノードの名前に使っている
  if (isFlow && /got 'end'/.test(msg)) {
    const fixes: ErrorFix[] = [];
    for (const l of body) {
      if (/^\s*end\s*$/.test(l.text) || isComment(l.text)) continue;
      for (const m of l.text.matchAll(/(?<![\p{L}\p{N}_])end(?![\p{L}\p{N}_])/gu)) {
        const from = l.from + m.index!;
        fixes.push({ label: '', spec: { from, to: from + 3, insert: 'End' } });
      }
    }
    if (fixes.length) {
      // 1 つの変更にまとめられないので、最初の箇所だけ直す（残りは次のエラーで出る）
      const first = fixes[0];
      return { summary: t('err.reservedEnd'), line: lines.findIndex((l) => l.from <= first.spec.from && first.spec.from <= l.to) + 1, fixes: [{ ...first, label: t('err.fixRenameEnd') }] };
    }
  }

  // フローチャート: 矢印が -> になっている
  if (isFlow) {
    for (const l of body) {
      const m = /(?<=\s|\w)->(?=\s|\w)/.exec(l.text);
      if (m && !/--|==|-\./.test(l.text.slice(Math.max(0, m.index - 1), m.index + 2))) {
        const from = l.from + m.index;
        return { summary: t('err.flowArrow', { line: String(lineNo(l)) }), line: lineNo(l), fixes: [{ label: t('err.fixArrow'), spec: { from, to: from + 2, insert: '-->' } }] };
      }
    }
  }

  // シーケンス図: メッセージの本文の前に : が無い
  if (isSeq) {
    for (const l of body) {
      const m = /^(\s*[^\s:]+?(?:-{1,2}>{1,2}|-{1,2}[x)]|<<-{1,2}>>)[+-]?\s*[^\s:]+)\s+(?=\S)/.exec(l.text);
      if (m && !l.text.includes(':')) {
        const from = l.from + m[1].length;
        return { summary: t('err.seqColon', { line: String(lineNo(l)) }), line: lineNo(l), fixes: [{ label: t('err.fixColon'), spec: { from, to: from + (m[0].length - m[1].length), insert: ': ' } }] };
      }
    }
  }

  // 円グラフ: 値の前に : が無い
  if (kind === 'pie') {
    for (const l of body) {
      const m = /^(\s*"[^"]*")\s+(?=-?\d)/.exec(l.text);
      if (m) {
        const from = l.from + m[1].length;
        return { summary: t('err.pieColon', { line: String(lineNo(l)) }), line: lineNo(l), fixes: [{ label: t('err.fixColon'), spec: { from, to: from, insert: ' :' } }] };
      }
    }
  }

  // クラス図: { が閉じていない
  if (kind === 'classDiagram' && /EOF_IN_STRUCT/.test(msg)) {
    const atEnd = source.endsWith('\n') ? '  }\n' : '\n  }';
    return { summary: t('err.classBrace'), line: error.line, fixes: [{ label: t('err.fixClose', { close: '}' }), spec: { from: source.length, to: source.length, insert: atEnd } }] };
  }

  // それ以外は、エラーの文面を日本語に言い換えるだけ
  const got = /got '([^']+)'/.exec(msg)?.[1] ?? /but found `([^`]+)`/.exec(msg)?.[1];
  const where = error.line ? t('err.atLine', { line: String(error.line) }) : '';
  if (got === '1' || got === 'EOF') return { summary: where + t('err.unexpectedEnd'), line: error.line, fixes: [] };
  if (got) return { summary: where + t('err.unexpected', { token: got }), line: error.line, fixes: [] };
  return { summary: where + t('err.generic'), line: error.line, fixes: [] };
}
