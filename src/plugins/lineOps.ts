import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { applySpec, bodyLines, indentOf, insertLineAfter, isBlank, isComment, splitLines, tokenRegex, type SourceLine } from './source';

// 行単位の図種（class / state / ER など）で共通に使う書き換え。

/** 行を消す変更（改行も一緒に消す） */
export function removeLine(source: string, line: SourceLine): ChangeSpec {
  return line.to < source.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to };
}

/** 複数行（from 行から to 行まで）を消す変更 */
export function removeLines(source: string, first: SourceLine, last: SourceLine): ChangeSpec {
  return last.to < source.length ? { from: first.from, to: last.to + 1 } : { from: Math.max(0, first.from - 1), to: last.to };
}

/** 複数行の字下げを old から indent に付け替える（old で始まらない行・空行はそのまま） */
export function reindent(text: string, old: string, indent: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() !== '' && l.startsWith(old) ? indent + l.slice(old.length) : l))
    .join('\n');
}

/**
 * first から last までの行を、anchor の行の前（before）か後ろへ動かす（ドラッグでの移動）。
 * indent を渡すと、動かす行の字下げを first の字下げから付け替える（空行はそのまま）。
 * 動かす行の中なら null。ただし anchor が last で後ろへ（親の最後の子孫を親の中へ・親の後ろへ）なら、
 * すぐ隣（間が空行・コメントだけ）と同じく、その場で字下げだけを変える（変わらなければ null）。
 * at は、動かした最初の行の変更後の位置
 */
export function moveLines(
  source: string,
  first: SourceLine,
  last: SourceLine,
  anchor: SourceLine,
  before: boolean,
  indent?: string,
): { change: ChangeSpec[]; at: number } | null {
  const self = !before && anchor.index === last.index && indent !== undefined;
  if (!self && anchor.index >= first.index && anchor.index <= last.index) return null;
  const text = indent === undefined ? source.slice(first.from, last.to) : reindent(source.slice(first.from, last.to), indentOf(first.text), indent);
  // 動かす先が今の場所と空行・コメントしか隔てていなければ、並びは変わらない。その場で置き換える
  // （消す範囲と足す位置が重ならないように。コメントだけが動く変更を履歴に残さないように）
  const lines = splitLines(source);
  const filler = (a: number, b: number) => lines.slice(a, b).every((l) => isBlank(l.text) || isComment(l.text));
  if (self || (before ? anchor.index > last.index && filler(last.index + 1, anchor.index) : anchor.index < first.index && filler(anchor.index + 1, first.index))) {
    const change = [{ from: first.from, to: last.to, insert: text }];
    return applySpec(source, change) === source ? null : { change, at: first.from };
  }
  let insert: { from: number; insert: string };
  if (before) insert = { from: anchor.from, insert: `${text}\n` };
  else if (anchor.to >= source.length) insert = { from: anchor.to, insert: `\n${text}` };
  else insert = { from: anchor.to + 1, insert: `${text}\n` };
  const change = [removeLines(source, first, last), insert];
  if (applySpec(source, change) === source) return null;
  const at = ChangeSet.of(change, source.length).mapPos(insert.from, -1) + (insert.insert.startsWith('\n') ? 1 : 0);
  return { change, at };
}

/** 行番号の集まりの行をまとめて消す変更（隣り合う行は 1 つの範囲にまとめる。最後の行を消すときに、前の行の改行を消す変更と重ならないように） */
export function removeLineSet(source: string, indices: Set<number>): ChangeSpec[] {
  const lines = splitLines(source);
  const out: ChangeSpec[] = [];
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(removeLines(source, lines[sorted[i]], lines[sorted[j]]));
    i = j + 1;
  }
  return out;
}

/** 文の「頭」（: より前、引用符の外）だけを返す。: の後ろはラベルや説明なので ID の書き換えの対象にしない */
export function headOf(text: string): string {
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) return text.slice(0, i);
  }
  return text;
}

/** 引用符の中を同じ長さの空白に置き換える（位置を保ったまま、引用符の中の一致を避けるため） */
export function maskQuotes(text: string): string {
  return text.replace(/"[^"]*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"');
}

/** 行の頭に id がトークンとして現れるか */
export function mentions(line: SourceLine, id: string): boolean {
  return !isComment(line.text) && tokenRegex(id).test(maskQuotes(headOf(line.text)));
}

/** id をすべて別の名前に変える（各行の頭の部分だけ。ラベルや引用符の中は変えない） */
export function renameToken(source: string, from: string, to: string): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  const re = tokenRegex(from, 'gu');
  for (const line of bodyLines(source).body) {
    if (isComment(line.text)) continue;
    const head = maskQuotes(headOf(line.text));
    re.lastIndex = 0;
    for (let m = re.exec(head); m; m = re.exec(head)) {
      out.push({ from: line.from + m.index, to: line.from + m.index + from.length, insert: to });
    }
  }
  return out;
}

/** header 行から始まる { ... } のブロック（入れ子も数える）。最後の行は } の行 */
export function blockFrom(lines: SourceLine[], start: number): SourceLine[] | null {
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const text = maskQuotes(lines[i].text);
    for (const c of text) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth <= 0) return lines.slice(start, i + 1);
  }
  return null;
}

/** header が条件に合う最初のブロック */
export function findBlock(source: string, isHeader: (text: string) => boolean): SourceLine[] | null {
  const lines = bodyLines(source).body;
  const i = lines.findIndex((l) => isHeader(l.text) && l.text.includes('{'));
  return i < 0 ? null : blockFrom(lines, i);
}

/** ブロックの中の最後に 1 行足す（閉じ括弧の前） */
export function insertIntoBlock(block: SourceLine[], text: string): ChangeSpec {
  const close = block.at(-1)!;
  const inner = block.length > 2 ? indentOf(block[block.length - 2].text) : indentOf(block[0].text) + '    ';
  if (block.length === 1) {
    // { } が同じ行にある: 閉じ括弧の前に改行して入れる
    const at = close.from + close.text.lastIndexOf('}');
    return { from: at, insert: `\n${inner}${text}\n${indentOf(close.text)}` };
  }
  return { from: close.from, insert: `${inner}${text}\n` };
}

/** id が最後に現れる行（ブロックの中も含む） */
export function lastMention(source: string, id: string): SourceLine | null {
  const lines = bodyLines(source).body;
  for (let i = lines.length - 1; i >= 0; i--) if (mentions(lines[i], id)) return lines[i];
  return null;
}

/** ブロックの外のトップレベルの最後の行と、そのインデント */
export function topLevelEnd(source: string, fallbackIndent = '    ') {
  const { header, body } = bodyLines(source);
  const indent = body[0] ? indentOf(body[0].text) || fallbackIndent : fallbackIndent;
  return { after: body.at(-1) ?? header, indent };
}

/** 図の最後（ブロックの外のトップレベル）に 1 行足す */
export function appendTopLevel(source: string, text: string) {
  const { after, indent } = topLevelEnd(source);
  return insertLineAfter(source, after, indent + text);
}

export const VALID_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
