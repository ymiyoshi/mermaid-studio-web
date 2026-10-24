import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';

// 図種プラグインが共通で使う、ソーステキストの行単位の操作。
// 変更は「行を 1 行差し込む」だけにして、既存の行（コメント・空行・インデント）には触れない（§6.2）。

export interface SourceLine {
  /** 0 始まりの行番号 */
  index: number;
  from: number;
  /** 改行を含まない行末 */
  to: number;
  text: string;
}

export function splitLines(source: string): SourceLine[] {
  const out: SourceLine[] = [];
  let from = 0;
  source.split('\n').forEach((text, index) => {
    out.push({ index, from, to: from + text.length, text });
    from += text.length + 1;
  });
  return out;
}

export const isComment = (text: string) => /^\s*%%/.test(text);
export const isBlank = (text: string) => text.trim() === '';
export const indentOf = (text: string) => /^\s*/.exec(text)![0];

/** 図本体の行（frontmatter・図種の宣言行・コメント・空行を除く） */
export function bodyLines(source: string): { header: SourceLine | null; body: SourceLine[] } {
  const lines = splitLines(source);
  let i = 0;
  if (/^---\s*$/.test(lines[0]?.text ?? '')) {
    const end = lines.findIndex((l, j) => j > 0 && /^---\s*$/.test(l.text));
    if (end > 0) i = end + 1;
  }
  while (i < lines.length && (isBlank(lines[i].text) || isComment(lines[i].text))) i++;
  const header = lines[i] ?? null;
  const body = lines.slice(i + 1).filter((l) => !isBlank(l.text) && !isComment(l.text));
  return { header, body };
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 変更を当てた後のソース（変更の前後を比べる操作で使う） */
export const applySpec = (source: string, spec: ChangeSpec) => ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();

/** id がトークンとして現れるか（前後が英数字・_ でない） */
export function tokenRegex(id: string, flags = 'u'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(id)}(?![\\p{L}\\p{N}_])`, flags);
}

/** prefix + 連番で、ソース中にまだ現れない ID を作る */
export function uniqueId(source: string, prefix: string): string {
  for (let k = 1; ; k++) {
    const id = `${prefix}${k}`;
    if (!tokenRegex(id).test(source)) return id;
  }
}

/** line の後ろに 1 行差し込む変更。line が null なら文書の末尾に足す */
export function insertLineAfter(source: string, line: SourceLine | null, text: string) {
  if (line) return { from: line.to, insert: `\n${text}` };
  const needsNewline = source.length > 0 && !source.endsWith('\n');
  return { from: source.length, insert: `${needsNewline ? '\n' : ''}${text}\n` };
}

/** 差し込んだ行の中で、文字列 part が置かれる範囲（挿入後の文書の座標） */
export function rangeInInserted(change: { from: number; insert: string }, part: string) {
  const at = change.insert.lastIndexOf(part);
  return { anchor: change.from + at, head: change.from + at + part.length };
}
