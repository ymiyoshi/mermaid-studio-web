import type { ChangeSpec } from '@codemirror/state';
import { bodyLines, indentOf, type SourceLine } from './source';
import { removeLine } from './lineOps';

// 設計書 §7.3: データ系の図種（pie / gantt / sankey など）は、行を表として編集する。
// 1 行 = 1 つの文。セルを変えると、その値の範囲だけを書き換える（行の他の部分や書式は変えない）。

export interface TableField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select';
  options?: { value: string; label: string }[];
  /** 省略できる値（空にすると行から取り除く） */
  optional?: boolean;
  /** 表示の幅の比率 */
  width?: number;
}

export interface ParsedRow {
  values: Record<string, string>;
  /** 値の行内での範囲。無い値（省略された値）は含まない */
  ranges: Record<string, [number, number]>;
}

export interface RowSchema {
  kind: string;
  /** 行の種類の表示名（「スライス」「タスク」など） */
  title: string;
  fields: TableField[];
  parse(text: string): ParsedRow | null;
  /** 値から行を組み立てる（インデントは含めない）。範囲の無い値を変えたときと、行を追加するときに使う */
  format(values: Record<string, string>): string;
  /** 追加する行の初期値 */
  defaults: Record<string, string>;
  /** セルの値をソースに書くときの変換（引用符のエスケープなど） */
  encode?(field: string, value: string): string;
}

export interface TableDef {
  id: string;
  title: string;
  schemas: RowSchema[];
  /** true なら補助の表（最初に開くタブにしない。要素のプロパティが主の図種で使う） */
  secondary?: boolean;
}

export interface TableRow {
  line: SourceLine;
  schema: RowSchema;
  values: Record<string, string>;
  ranges: Record<string, [number, number]>;
}

/** 名前付きグループと d フラグを使う正規表現から RowSchema の parse を作る */
export function regexParser(re: RegExp): RowSchema['parse'] {
  if (!re.hasIndices) throw new Error('regex needs the d flag');
  return (text) => {
    const m = re.exec(text);
    if (!m?.groups || !m.indices?.groups) return null;
    const values: Record<string, string> = {};
    const ranges: Record<string, [number, number]> = {};
    for (const [name, v] of Object.entries(m.groups)) {
      values[name] = v ?? '';
      const r = m.indices.groups[name];
      if (v !== undefined && r) ranges[name] = r;
    }
    return { values, ranges };
  };
}

export function tableRows(source: string, table: TableDef): TableRow[] {
  const rows: TableRow[] = [];
  for (const line of bodyLines(source).body) {
    const text = line.text.trim();
    for (const schema of table.schemas) {
      const parsed = schema.parse(text);
      if (!parsed) continue;
      // parse はインデントを除いた文字列に対して行うので、範囲を行の座標に直す
      const offset = line.text.indexOf(text);
      const ranges: Record<string, [number, number]> = {};
      for (const [k, [a, b]] of Object.entries(parsed.ranges)) ranges[k] = [a + offset, b + offset];
      rows.push({ line, schema, values: parsed.values, ranges });
      break;
    }
  }
  return rows;
}

export function setCell(row: TableRow, field: string, value: string): ChangeSpec {
  const encoded = row.schema.encode ? row.schema.encode(field, value) : value;
  const range = row.ranges[field];
  if (range && !(value === '' && row.schema.fields.find((f) => f.name === field)?.optional)) {
    return { from: row.line.from + range[0], to: row.line.from + range[1], insert: encoded };
  }
  // 範囲の無い値（省略されていた値）や、省略可能な値を空にしたときは、行を組み立て直す
  const indent = indentOf(row.line.text);
  return { from: row.line.from, to: row.line.to, insert: indent + row.schema.format({ ...row.values, [field]: value }) };
}

export function deleteRow(source: string, row: TableRow): ChangeSpec {
  return removeLine(source, row.line);
}

/** after の後ろ（null なら表の最後の行の後ろ、表が空なら図種の宣言行の後ろ）に行を足す */
export function addRow(source: string, rows: TableRow[], schema: RowSchema, after: TableRow | null): ChangeSpec {
  const ref = after ?? rows.at(-1) ?? null;
  const { header, body } = bodyLines(source);
  const anchor = ref?.line ?? body.at(-1) ?? header;
  const indent = ref ? indentOf(ref.line.text) : body[0] ? indentOf(body[0].text) || '    ' : '    ';
  const text = indent + schema.format(schema.defaults);
  if (!anchor) return { from: source.length, insert: (source.endsWith('\n') || source === '' ? '' : '\n') + text + '\n' };
  return { from: anchor.to, insert: '\n' + text };
}

/** rows[i] を前後の行と入れ替える */
export function moveRow(rows: TableRow[], i: number, dir: -1 | 1): ChangeSpec[] | null {
  const a = rows[i];
  const b = rows[i + dir];
  if (!a || !b) return null;
  const [first, second] = dir < 0 ? [b, a] : [a, b];
  return [
    { from: first.line.from, to: first.line.to, insert: second.line.text },
    { from: second.line.from, to: second.line.to, insert: first.line.text },
  ];
}

/** "..." で囲む値のエスケープ。mermaid は引用符の中の " を #quot; で書く */
export const quoteSafe = (v: string) => v.replace(/"/g, '#quot;');
