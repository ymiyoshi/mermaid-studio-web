import type { ChangeSpec } from '@codemirror/state';
import { bodyLines, indentOf, type SourceLine } from './source';
import { moveLines, removeLine, removeLines } from './lineOps';

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

export type DragAxis = 'x' | 'y' | 'xy' | 'free' | false;

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
  /** 追加する行の初期値を、前にある行から決める（packet のビットの位置など）。無ければ defaults */
  next?(before: TableRow[]): Record<string, string>;
  /** 表の最後にしか足せない行（packet: ビットの位置は前から順に続くので、途中に足すと重なる） */
  appendOnly?: boolean;
  /** 行が { から } までの複数行のまとまり（requirementDiagram の要求・要素）。足す・消す・動かすは、まとまりごと */
  block?: boolean;
  /**
   * 後ろに続く行のうち、この行に属する行の種類（'*' は自分と違う種類すべて。section は次の section まで、timeline の期間は続きの出来事）。
   * この行の次に足す行は、属する行の後ろに入れる（間に入れると、属する行を新しい行が取ってしまう）
   */
  owns?: string[] | '*';
  /** インデントが深い後ろの行が、この行に属する（treemap の入れ子） */
  nested?: boolean;
  /**
   * 図の上でドラッグしたときの動き（x・y・xy: その向きの並べ替え、free: 落とした位置の座標を place で書く、false: 動かさない）。
   * 無ければ上下の並べ替え。appendOnly の行は動かさない。図の向きで変わるもの（gitGraph）は、ソースから求める
   */
  drag?: DragAxis | ((source: string) => DragAxis);
  /** 図の上で後ろの行ほど上・左に描かれるか（gitGraph の BT）。ドラッグで落とす前後を逆にする */
  reversed?(source: string): boolean;
  /** drag が free の行を、SVG の座標で by だけ動かしたときの新しい値（quadrantChart の点の x・y）。動かせなければ null */
  place?(row: TableRow, svg: SVGSVGElement, by: { x: number; y: number }): Record<string, string> | null;
  /** 図から消してよいか（Git グラフの branch・checkout や最初のコミットは、後ろの行が頼っている）。無ければ消してよい */
  canDelete?(row: TableRow, rows: TableRow[]): boolean;
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
  /** 行の最後の行（block のときは } の行。それ以外は line と同じ） */
  end: SourceLine;
  /** line から end までの文字列 */
  text: string;
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
  const body = bodyLines(source).body;
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const text = line.text.trim();
    for (const schema of table.schemas) {
      const parsed = schema.parse(text);
      if (!parsed) continue;
      // parse はインデントを除いた文字列に対して行うので、範囲を行の座標に直す
      const offset = line.text.indexOf(text);
      const ranges: Record<string, [number, number]> = {};
      for (const [k, [a, b]] of Object.entries(parsed.ranges)) ranges[k] = [a + offset, b + offset];
      // まとまりの行は、次の } の行までを 1 つの行とし、中の行は読み飛ばす
      let end = line;
      if (schema.block) {
        const close = body.findIndex((l, j) => j > i && l.text.trim() === '}');
        if (close < 0) break;
        end = body[close];
        i = close;
      }
      rows.push({ line, end, text: source.slice(line.from, end.to), schema, values: parsed.values, ranges });
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
  return row.end === row.line ? removeLine(source, row.line) : removeLines(source, row.line, row.end);
}

/** row と、row に属する後ろの行（owns・nested）のうち最後の行 */
export function rowScope(rows: TableRow[], row: TableRow): TableRow {
  const { owns, nested, kind } = row.schema;
  const width = indentOf(row.line.text).length;
  let i = rows.indexOf(row);
  while (i >= 0 && i + 1 < rows.length) {
    const next = rows[i + 1];
    const owned = (owns === '*' ? next.schema.kind !== kind : !!owns?.includes(next.schema.kind)) || (nested && indentOf(next.line.text).length > width);
    if (!owned) break;
    i++;
  }
  return rows[i] ?? row;
}

/**
 * after の後ろ（null なら表の最後の行の後ろ、表が空なら図種の宣言行の後ろ）に行を足す。
 * after に属する行（section の中のタスクなど）があれば、その後ろに足す。
 * 表の最後にしか足せない行（appendOnly）は、after にかかわらず最後に足す
 */
export function addRow(source: string, rows: TableRow[], schema: RowSchema, after: TableRow | null): ChangeSpec {
  const own = schema.appendOnly ? null : after;
  const ref = own ? rowScope(rows, own) : (rows.at(-1) ?? null);
  const { header, body } = bodyLines(source);
  const anchor = ref?.end ?? body.at(-1) ?? header;
  const like = own ?? ref;
  const indent = like ? indentOf(like.line.text) : body[0] ? indentOf(body[0].text) || '    ' : '    ';
  const before = ref ? rows.slice(0, rows.indexOf(ref) + 1) : [];
  const text = indent + schema.format(schema.next ? schema.next(before) : schema.defaults);
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
    { from: first.line.from, to: first.end.to, insert: second.text },
    { from: second.line.from, to: second.end.to, insert: first.text },
  ];
}

/** "..." で囲む値のエスケープ。mermaid は引用符の中の " を #quot; で書く */
export const quoteSafe = (v: string) => v.replace(/"/g, '#quot;');

/** 子の行（nested: インデントが深い後ろの行）を持てる行の、子の字下げ */
function childIndentOf(rows: TableRow[], row: TableRow): string {
  const next = rows[rows.indexOf(row) + 1];
  const own = indentOf(row.line.text);
  return next && indentOf(next.line.text).length > own.length ? indentOf(next.line.text) : `${own}  `;
}

/**
 * row とそれに属する行（owns・nested）を、target の前（before）か後ろへ動かす（ドラッグでの移動）。
 * 属する行を持つ行（section など）は、同じ種類の行の前後にだけ動かす。
 * 後ろに落とすとき、target が row の種類の行を持つなら（section の後ろにタスク）、target のすぐ後ろ（最初の行）に入れ、
 * そうでなければ target に属する行の後ろに入れる。入れ子（treemap）は、字下げを target に合わせる。at は動かした最初の行の変更後の位置
 */
export function moveRowTo(source: string, rows: TableRow[], row: TableRow, target: TableRow, before: boolean): { change: ChangeSpec[]; at: number } | null {
  if (row.schema.appendOnly || (row.schema.owns && target.schema.kind !== row.schema.kind)) return null;
  const takes = (x: TableRow) => (x.schema.owns === '*' ? x.schema.kind !== row.schema.kind : !!x.schema.owns?.includes(row.schema.kind));
  const anchor = before ? target.line : takes(target) ? target.end : rowScope(rows, target).end;
  return moveLines(source, row.line, rowScope(rows, row).end, anchor, before, row.schema.nested ? indentOf(target.line.text) : undefined);
}

/** row とその子を、入れ子の行（treemap）container の最後の子にする */
export function moveRowInto(source: string, rows: TableRow[], row: TableRow, container: TableRow): { change: ChangeSpec[]; at: number } | null {
  if (!row.schema.nested || !container.schema.nested) return null;
  return moveLines(source, row.line, rowScope(rows, row).end, rowScope(rows, container).end, false, childIndentOf(rows, container));
}
