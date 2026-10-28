import type { ChangeSpec } from '@codemirror/state';
import { t } from '../i18n';
import type { ActionResult, DiagramAction, DiagramPlugin, DiagramTarget, ElementRef, PropertyField, ReorderSpec } from './types';
import { matchInOrder } from './svg';
import { applySpec, bodyLines, lastParse } from './source';
import { genericTargets } from './generic';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import {
  addRow,
  deleteRow,
  moveRow,
  moveRowInto,
  moveRowTo,
  quoteSafe,
  regexParser,
  rowScope,
  setCell,
  tableRows,
  type ParsedRow,
  type RowSchema,
  type TableDef,
  type TableField,
  type TableRow,
} from './table';

// データ系・その他の図種のプラグイン（設計書 §7.3 Phase 3・4）。
// 図のラベルはソース中の文字列と突き合わせ（汎用フォールバック）、表の行の中にあれば、その行を要素（kind: 'row'、id: 行番号）として選べる。
// 選んだ行は、プロパティパネルで値を変え、図の上のボタンで後ろに同じ種類の行を足す・前後と入れ替える・消す。
// 同じことは「表」でもでき、図全体の設定（title など）はプロパティパネルの「図全体」に出す。

const text = (name: string, label: string, extra: Partial<TableField> = {}): TableField => ({ name, label, type: 'text', ...extra });
const num = (name: string, label: string, extra: Partial<TableField> = {}): TableField => ({ name, label, type: 'number', width: 0.6, ...extra });
const select = (name: string, label: string, values: string[], extra: Partial<TableField> = {}): TableField => ({
  name,
  label,
  type: 'select',
  options: values.map((v) => ({ value: v, label: v || t('data.none') })),
  ...extra,
});

function rx(
  kind: string,
  title: string,
  re: RegExp,
  fields: TableField[],
  format: (v: Record<string, string>) => string,
  defaults: Record<string, string>,
  encode?: RowSchema['encode'],
  drag?: RowSchema['drag'],
): RowSchema {
  return { kind, title, fields, parse: regexParser(re), format, defaults, encode, drag };
}

const quoted = (_f: string, v: string) => quoteSafe(v);

/** 表の行を指す要素の種類。id は 1 始まりの行番号（エディタの行番号と同じ） */
export const ROW = 'row';

interface FoundRow {
  row: TableRow;
  /** 同じ表の行の並び */
  rows: TableRow[];
}

function allRows(source: string, tables: TableDef[]): FoundRow[] {
  return tables.flatMap((table) => {
    const rows = tableRows(source, table);
    return rows.map((row) => ({ row, rows }));
  });
}

function findRow(source: string, tables: TableDef[], ref: ElementRef | null | undefined): FoundRow | null {
  if (ref?.kind !== ROW) return null;
  return allRows(source, tables).find((x) => String(x.row.line.index + 1) === ref.id) ?? null;
}

const rowRef = (row: TableRow): ElementRef => ({ kind: ROW, id: String(row.line.index + 1) });

/** 表の行を図から操作する（後ろに同じ種類の行を足す・前後と入れ替える・消す） */
function rowActions(tables: TableDef[]): DiagramAction[] {
  const move =
    (dir: -1 | 1): DiagramAction['run'] =>
    (source, [ref]) => {
      const found = findRow(source, tables, ref);
      // 順に続く行（packet の欄）は、入れ替えると位置が合わなくなる
      if (!found || found.row.schema.appendOnly) return null;
      const { row, rows } = found;
      const i = rows.indexOf(row);
      const other = rows[i + dir];
      const change = moveRow(rows, i, dir);
      if (!change || !other) return null;
      // 動かした行の新しい最初の行。複数行のまとまり（要求図）があるので、行の数から求める
      const start = dir < 0 ? other.line.index : other.end.index - (row.end.index - row.line.index);
      return { change, label: t('table.move', { kind: row.schema.title }), select: { kind: ROW, id: String(start + 1) } };
    };
  return [
    {
      id: 'add-row',
      title: t('data.action.addAfter'),
      arity: 1,
      appliesTo: [ROW],
      key: 'Tab',
      run(source, [ref]) {
        const found = findRow(source, tables, ref);
        if (!found) return null;
        const { row, rows } = found;
        // 足す行は、選んだ行とそれに属する行（最後にしか足せない行なら表の最後の行）のすぐ後ろに入る（addRow と同じ）
        const anchor = row.schema.appendOnly ? rows.at(-1)! : rowScope(rows, row);
        const added: ElementRef = { kind: ROW, id: String(anchor.end.index + 2) };
        return { change: addRow(source, rows, row.schema, row), label: t('table.addRow', { kind: row.schema.title }), focus: added, select: added };
      },
    },
    { id: 'move-up', title: t('table.up'), arity: 1, appliesTo: [ROW], run: move(-1) },
    { id: 'move-down', title: t('table.down'), arity: 1, appliesTo: [ROW], run: move(1) },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: [ROW],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const found = findRow(source, tables, ref);
        // 順に続く行（packet の欄）は、途中を消すとすき間ができるので、最後の行だけを消せる。
        // 後ろの行が頼っている行（Git グラフの branch・checkout）は消さない
        if (!found || found.row.schema.canDelete?.(found.row, found.rows) === false || (found.row.schema.appendOnly && found.row !== found.rows.at(-1))) return null;
        return { change: deleteRow(source, found.row), label: t('table.deleteRow', { kind: found.row.schema.title }) };
      },
    },
  ];
}

/** 図の上のドラッグでの、行の動かし方（rowActions の上下の入れ替えを、離れた行の前後・入れ子の中・座標へ広げたもの） */
function rowReorder(tables: TableDef[]): ReorderSpec {
  const drag = (row: TableRow, source: string) => {
    if (row.schema.appendOnly) return null;
    const d = typeof row.schema.drag === 'function' ? row.schema.drag(source) : row.schema.drag;
    return d === undefined ? 'y' : d || null;
  };
  // 入れ子の行（treemap）が無い図種は、中へは落とさない
  const nested = tables.some((table) => table.schemas.some((s) => s.nested));
  // ドラッグを始めるとき、候補の行ごとに表を読み直さない
  const rowsOf = lastParse((source: string) => allRows(source, tables));
  const find = (source: string, ref: ElementRef) => (ref.kind === ROW ? (rowsOf(source).find((x) => String(x.row.line.index + 1) === ref.id) ?? null) : null);
  // 動かした後の行を選び続ける（行番号で指すので、動かした最初の行の位置から求める）
  const done = (source: string, row: TableRow, r: { change: ChangeSpec[]; at: number } | null): ActionResult | null =>
    r && { change: r.change, label: t('table.move', { kind: row.schema.title }), select: { kind: ROW, id: String(applySpec(source, r.change).slice(0, r.at).split('\n').length) } };
  // 同じ表の 2 つの行（表をまたいでは動かさない）。後ろの行が頼っている行（branch の前のただ 1 つのコミット）は、消せないのと同じく動かさない
  const pair = (source: string, a: ElementRef, b: ElementRef) => {
    const x = find(source, a);
    if (!x || !drag(x.row, source) || x.row.schema.canDelete?.(x.row, x.rows) === false) return null;
    const target = b.kind === ROW ? x.rows.find((r) => String(r.line.index + 1) === b.id) : undefined;
    return target && target !== x.row ? { rows: x.rows, row: x.row, target } : null;
  };
  return {
    axis(source, ref) {
      const found = find(source, ref);
      return found && found.row.schema.canDelete?.(found.row, found.rows) !== false ? drag(found.row, source) : null;
    },
    // 属する行を持つ行（section・timeline の期間）は、同じ種類の行の前後にだけ落とせる（moveRowTo と同じ決まり）
    accepts(ref, target, source) {
      const p = pair(source, ref, target);
      return !!p && !(p.row.schema.owns && p.target.schema.kind !== p.row.schema.kind);
    },
    move(source, ref, target, before) {
      const p = pair(source, ref, target);
      if (!p) return null;
      const flip = p.row.schema.reversed?.(source) ?? false;
      return done(source, p.row, moveRowTo(source, p.rows, p.row, p.target, flip ? !before : before));
    },
    acceptsInto(source, ref, container) {
      if (!nested) return false;
      const p = container && pair(source, ref, container);
      return !!p && !!p.row.schema.nested && !!p.target.schema.nested;
    },
    into(source, ref, container) {
      const p = container && pair(source, ref, container);
      return p ? done(source, p.row, moveRowInto(source, p.rows, p.row, p.target)) : null;
    },
    place(source, ref, svg, by) {
      const found = find(source, ref);
      const values = found?.row.schema.place?.(found.row, svg, by);
      if (!found || !values) return null;
      // 値の変わらない欄（横にだけ動かしたときの y など）は、書き方も変えない
      const change = Object.entries(values)
        .filter(([field, v]) => Number(v) !== Number(found.row.values[field]))
        .map(([field, v]) => setCell(found.row, field, v));
      return change.length ? { change, label: t('table.move', { kind: found.row.schema.title }), select: ref } : null;
    },
  };
}

function rowFields({ row }: FoundRow): PropertyField[] {
  return [
    { id: '#kind', label: t('data.kind'), type: 'text', value: row.schema.title, readonly: true },
    ...row.schema.fields.map(
      (f): PropertyField => ({
        id: f.name,
        label: f.label,
        type: f.type,
        value: row.values[f.name] ?? '',
        options: f.options,
        placeholder: f.optional ? t('misc.table.optional', { label: f.label }) : undefined,
      }),
    ),
  ];
}

/** ラベルでは決まらない図の要素（棒・線・点・箱）を、意味のある値（名前・端点・系列の番号など）で表の行に対応付ける */
type RowMatcher = (svg: SVGSVGElement, rows: TableRow[], source: string) => { el: Element; row: TableRow }[];

/** ラベルの範囲が、行の文字の欄（名前など）の中にあるか（数の欄は、図が計算した合計などと偶然一致することがある） */
function inTextField(row: TableRow, range: { from: number; to: number }): boolean {
  return row.schema.fields.some((f) => {
    const r = row.ranges[f.name];
    return f.type !== 'number' && !!r && range.from >= row.line.from + r[0] && range.to <= row.line.from + r[1];
  });
}

/**
 * 表で編集する図種のプラグイン。keywords は図全体の設定（title など）、tables は行の表。
 * 図のラベルが表の行の中にあれば、その行を図から選んで編集できる。match は、ラベルでは決まらない要素の対応付け
 */
export function dataPlugin(type: string, keywords: KeywordSpec[], tables: TableDef[], match?: RowMatcher): DiagramPlugin {
  return {
    type,
    mapTargets(svg, source) {
      const rows = allRows(source, tables);
      const inRow = (row: TableRow, range: { from: number; to: number }) => range.from >= row.line.from && range.to <= row.end.to;
      // 1 つの行に図の要素が 2 つ以上あるとき（C4 の名前と説明など）は、最初の要素を行の要素にする（残りはラベルだけ編集できる）
      const taken = new Set<TableRow>();
      let labels = genericTargets(svg, source);
      const matched: DiagramTarget[] = [];
      for (const { el, row } of match?.(svg, rows.map((x) => x.row), source) ?? []) {
        if (taken.has(row)) continue;
        taken.add(row);
        // 要素の中のラベル（要求の名前・利用者の名前など）は、要素と別に選ばれないよう 1 つにまとめ、行の中にあればラベルとして編集できる
        const inner = labels.filter((x) => el.contains(x.el));
        labels = labels.filter((x) => !inner.includes(x));
        const label = inner.find((x) => x.range && inRow(row, x.range));
        if (label) {
          matched.push({ id: `row-${row.line.index}`, el, labelEl: label.labelEl, label: label.label, range: label.range, ref: rowRef(row) });
          continue;
        }
        // ソースの中で一意に決まらないラベル（要求の名前は関係の行にも出てくる）は、図の上では書き換えない
        // （名前が参照を兼ねるので、宣言だけを変えると関係が切れる。名前はプロパティパネルや表で変える）
        const named = inner.find((x) => row.schema.fields.some((f) => row.values[f.name] === x.label));
        matched.push({ id: `row-${row.line.index}`, el, labelEl: named?.labelEl ?? el, label: named?.label ?? '', range: null, ref: rowRef(row) });
      }
      // ラベルから行を決める。名前などの文字の欄に当たるラベルを先に割り当てる（数のラベルは、treemap の合計のように、たまたま別の行の値と一致することがある）
      const assign = (pick: (row: TableRow, range: { from: number; to: number }) => boolean) =>
        (labels = labels.map((x) => {
          const range = x.range;
          const hit = !x.ref && range ? rows.find(({ row }) => !taken.has(row) && inRow(row, range) && pick(row, range)) : undefined;
          if (!hit) return x;
          taken.add(hit.row);
          return { ...x, ref: rowRef(hit.row) };
        }));
      assign(inTextField);
      assign(() => true);
      return [...matched, ...labels];
    },
    inspect(source, ref) {
      if (!ref) return keywordFields(source, keywords);
      const found = findRow(source, tables, ref);
      return found ? rowFields(found) : [];
    },
    setProperty(source, ref, field, value) {
      if (ref) {
        const found = findRow(source, tables, ref);
        return found?.row.schema.fields.some((f) => f.name === field) ? setCell(found.row, field, value) : null;
      }
      const spec = keywords.find((k) => k.id === field);
      return spec ? setKeyword(source, spec, value) : null;
    },
    actions: rowActions(tables),
    reorder: rowReorder(tables),
    tables,
  };
}

const TITLE: KeywordSpec = { id: 'title', label: t('data.title'), keyword: 'title' };
// section は、次の section までの行を持つ
const SECTION: RowSchema = {
  ...rx('section', t('data.section'), /^section\s+(?<name>.+?)\s*$/d, [text('name', t('data.name'))], (v) => `section ${v.name}`, {
    name: t('data.section.new'),
  }),
  owns: '*',
};

// ---- pie ----------------------------------------------------------------

export const piePlugin = dataPlugin(
  'pie',
  [{ ...TITLE, headerPattern: /^\s*pie(?:\s+showData)?\s+title\s+(.+?)\s*$/d }],
  [
    {
      id: 'slices',
      title: t('data.pie.slice'),
      schemas: [
        rx(
          'slice',
          t('data.pie.slice'),
          /^"(?<label>[^"]*)"\s*:\s*(?<value>[-\d.]+)\s*$/d,
          [text('label', t('data.label')), num('value', t('data.value'))],
          (v) => `"${quoteSafe(v.label)}" : ${v.value}`,
          { label: t('data.item.new'), value: '10' },
          (f, v) => (f === 'label' ? quoteSafe(v) : v),
        ),
      ],
    },
  ],
);

// ---- gantt --------------------------------------------------------------

const GANTT_KEYWORD = /^(title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|section|click|accTitle|accDescr|displayMode|inclusiveEndDates|topAxis)\b/;
const TAGS = new Set(['done', 'active', 'crit', 'milestone']);

/** gantt のタスク: 名前 :[状態, ][ID, ][開始, ]終了または期間 */
export function parseGanttTask(line: string): ParsedRow | null {
  if (GANTT_KEYWORD.test(line)) return null;
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const name = line.slice(0, colon).trimEnd();
  const tokens: { text: string; from: number; to: number }[] = [];
  let pos = colon + 1;
  for (const part of line.slice(colon + 1).split(',')) {
    const lead = part.length - part.trimStart().length;
    const t = part.trim();
    tokens.push({ text: t, from: pos + lead, to: pos + lead + t.length });
    pos += part.length + 1;
  }
  const tags = tokens.filter((t, i) => TAGS.has(t.text) && tokens.slice(0, i).every((x) => TAGS.has(x.text)));
  const rest = tokens.slice(tags.length);
  if (rest.length === 0 || rest.length > 3) return null;
  const [id, start, end] = rest.length === 3 ? rest : rest.length === 2 ? [null, rest[0], rest[1]] : [null, null, rest[0]];
  const values: Record<string, string> = {
    name,
    status: tags.map((t) => t.text).join(', '),
    id: id?.text ?? '',
    start: start?.text ?? '',
    end: end!.text,
  };
  const ranges: Record<string, [number, number]> = { name: [0, name.length], end: [end!.from, end!.to] };
  if (tags.length) ranges.status = [tags[0].from, tags[tags.length - 1].to];
  if (id) ranges.id = [id.from, id.to];
  if (start) ranges.start = [start.from, start.to];
  return { values, ranges };
}

const ganttTask: RowSchema = {
  kind: 'task',
  title: t('data.task'),
  fields: [
    text('name', t('data.name'), { width: 1.6 }),
    text('status', t('data.gantt.status'), { optional: true, width: 0.9 }),
    text('id', 'ID', { optional: true, width: 0.6 }),
    text('start', t('data.gantt.start'), { optional: true }),
    text('end', t('data.gantt.end'), { width: 0.8 }),
  ],
  parse: parseGanttTask,
  format: (v) => `${v.name} :${[v.status, v.id, v.start, v.end].filter((x) => x && x.trim()).join(', ')}`,
  defaults: { name: t('data.task.new'), status: '', id: '', start: '', end: '3d' },
};

export const ganttPlugin = dataPlugin(
  'gantt',
  [
    TITLE,
    { id: 'dateFormat', label: t('data.gantt.dateFormat'), keyword: 'dateFormat', placeholder: 'YYYY-MM-DD' },
    { id: 'axisFormat', label: t('data.gantt.axisFormat'), keyword: 'axisFormat', placeholder: '%m/%d' },
    { id: 'excludes', label: t('data.gantt.excludes'), keyword: 'excludes', placeholder: 'weekends' },
  ],
  [{ id: 'tasks', title: t('data.task'), schemas: [SECTION, ganttTask] }],
);

// ---- timeline / journey -------------------------------------------------

export const timelinePlugin = dataPlugin(
  'timeline',
  [TITLE],
  [
    {
      id: 'events',
      title: t('data.timeline.events'),
      schemas: [
        { ...SECTION, drag: 'x' },
        {
          ...rx(
            'period',
            t('data.timeline.period'),
            /^(?<period>[^:]+?)\s*:\s*(?<events>.+?)\s*$/d,
            [text('period', t('data.timeline.period'), { width: 0.7 }), text('events', t('data.timeline.eventsField'), { width: 2 })],
            (v) => `${v.period} : ${v.events}`,
            { period: t('data.timeline.period.new'), events: t('data.timeline.event') },
          ),
          // 「: 出来事」の続きの行は、前の期間に属する
          owns: ['event'],
          drag: 'x',
        },
        rx('event', t('data.timeline.continued'), /^:\s*(?<event>.+?)\s*$/d, [text('event', t('data.timeline.event'))], (v) => `: ${v.event}`, {
          event: t('data.timeline.event'),
        }),
      ],
    },
  ],
);

/** gitGraph の向き（宣言行の LR・TB・BT。無ければ LR） */
function gitOrientation(source: string): 'LR' | 'TB' | 'BT' {
  return (bodyLines(source).header?.text.match(/^\s*gitGraph\s+(LR|TB|BT)\b/)?.[1] as 'TB' | 'BT' | undefined) ?? 'LR';
}

export const journeyPlugin = dataPlugin(
  'journey',
  [TITLE],
  [
    {
      id: 'tasks',
      title: t('data.task'),
      schemas: [
        { ...SECTION, drag: 'x' },
        {
          ...rx(
            'task',
            t('data.task'),
            /^(?<name>[^:]+?)\s*:\s*(?<score>\d+)\s*:\s*(?<actors>.*?)\s*$/d,
            [text('name', t('data.name'), { width: 1.5 }), select('score', t('data.journey.score'), ['1', '2', '3', '4', '5'], { width: 0.6 }), text('actors', t('data.journey.actors'))],
            (v) => `${v.name}: ${v.score}: ${v.actors}`,
            { name: t('data.task.new'), score: '3', actors: t('data.journey.actor.default') },
          ),
          drag: 'x',
        },
      ],
    },
  ],
);

// ---- gitGraph -----------------------------------------------------------

function attr(rest: string, base: number, name: string, quotedValue: boolean) {
  const re = quotedValue ? new RegExp(`\\b${name}:\\s*"([^"]*)"`, 'd') : new RegExp(`\\b${name}:\\s*([A-Z_]+)`, 'd');
  const m = re.exec(rest);
  return m?.indices?.[1] ? { value: m[1], range: [base + m.indices[1][0], base + m.indices[1][1]] as [number, number] } : null;
}

function gitParser(command: RegExp, attrs: { name: string; quoted: boolean }[], nameGroup = false): RowSchema['parse'] {
  return (line) => {
    const m = command.exec(line);
    if (!m) return null;
    const values: Record<string, string> = {};
    const ranges: Record<string, [number, number]> = {};
    let restAt = m[0].length;
    if (nameGroup && m.indices?.[1]) {
      values.name = m[1];
      ranges.name = m.indices[1];
      restAt = m.indices[1][1];
    }
    const rest = line.slice(restAt);
    for (const a of attrs) {
      const found = attr(rest, restAt, a.name, a.quoted);
      values[a.name] = found?.value ?? (a.name === 'type' ? 'NORMAL' : '');
      if (found) ranges[a.name] = found.range;
    }
    return { values, ranges };
  };
}

const gitAttrs = (v: Record<string, string>) =>
  `${v.id ? ` id: "${v.id}"` : ''}${v.tag ? ` tag: "${v.tag}"` : ''}${v.type && v.type !== 'NORMAL' ? ` type: ${v.type}` : ''}`;

export const gitGraphPlugin = dataPlugin(
  'gitGraph',
  [],
  [
    {
      id: 'commands',
      title: t('data.git.commands'),
      schemas: [
        {
          kind: 'commit',
          title: 'commit',
          fields: [text('id', 'ID', { optional: true }), text('tag', t('data.tag'), { optional: true }), select('type', t('data.kind'), ['NORMAL', 'REVERSE', 'HIGHLIGHT'])],
          parse: gitParser(/^commit\b/d, [
            { name: 'id', quoted: true },
            { name: 'tag', quoted: true },
            { name: 'type', quoted: false },
          ]),
          format: (v) => `commit${gitAttrs(v)}`,
          // 縦向き（TB・BT）では、コミットは上下に並ぶ。BT は下から上へ
          drag: (source) => (gitOrientation(source) === 'LR' ? 'x' : 'y'),
          reversed: (source) => gitOrientation(source) === 'BT',
          // branch より前にコミットが 1 つも無いと、branch が読めない（最初の branch の前のただ 1 つのコミットは消さない）
          canDelete: (row, rows) => {
            const branch = rows.findIndex((r) => r.schema.kind === 'branch');
            const at = rows.indexOf(row);
            return branch < 0 || at > branch || rows.slice(0, branch).filter((r) => r.schema.kind === 'commit').length > 1;
          },
          defaults: { id: '', tag: '', type: 'NORMAL' },
        },
        {
          kind: 'branch',
          title: 'branch',
          fields: [text('name', t('data.git.branch'))],
          parse: gitParser(/^branch\s+([^\s]+)/d, [], true),
          // 後ろの checkout・merge が、このブランチに頼っている
          canDelete: () => false,
          drag: false,
          format: (v) => `branch ${v.name}`,
          defaults: { name: 'feature' },
        },
        {
          kind: 'checkout',
          title: 'checkout',
          fields: [text('name', t('data.git.branch'))],
          parse: gitParser(/^(?:checkout|switch)\s+([^\s]+)/d, [], true),
          // 消すと、後ろの commit・merge が別のブランチに付く（merge が自分自身になって壊れることがある）
          canDelete: () => false,
          drag: false,
          format: (v) => `checkout ${v.name}`,
          defaults: { name: 'main' },
        },
        {
          kind: 'merge',
          title: 'merge',
          fields: [text('name', t('data.git.branch')), text('tag', t('data.tag'), { optional: true })],
          parse: gitParser(/^merge\s+([^\s]+)/d, [{ name: 'tag', quoted: true }], true),
          format: (v) => `merge ${v.name}${v.tag ? ` tag: "${v.tag}"` : ''}`,
          drag: false,
          defaults: { name: 'feature', tag: '' },
        },
      ],
    },
  ],
  matchCommits,
);

/**
 * Git グラフのコミットの点を、commit・merge の行に順に対応付ける。
 * 点の class は「commit [種類の class] <コミットの ID> commit<ブランチの番号>」なので、最後から 2 つ目が ID
 * （ID が commit1 のような名前でも、種類の class と取り違えない）。
 * ID を書いたコミットは ID が合うことを確かめ、数が合わなければ（cherry-pick など読めない行があれば）対応付けない
 */
function matchCommits(svg: SVGSVGElement, rows: TableRow[]) {
  const commits = rows.filter((r) => r.schema.kind === 'commit' || r.schema.kind === 'merge');
  const byId = new Map<string, Element>();
  svg.querySelectorAll('circle.commit').forEach((c) => {
    const id = [...c.classList].at(-2);
    if (id && !byId.has(id)) byId.set(id, c);
  });
  const ids = [...byId.keys()];
  if (ids.length !== commits.length || commits.some((r, i) => r.values.id && r.values.id !== ids[i])) return [];
  return commits.map((row, i) => ({ el: byId.get(ids[i])!, row }));
}

// ---- quadrantChart / xychart --------------------------------------------

/** 0〜1 に収め、小数 2 桁にする */
const unit = (v: number) => String(Math.round(Math.min(1, Math.max(0, v)) * 100) / 100);

/** quadrantChart の点を、SVG の座標で by だけ動かした値。描く範囲は 4 つの象限の四角を合わせた範囲（y は上が 1） */
function placeQuadrantPoint(row: TableRow, svg: SVGSVGElement, by: { x: number; y: number }): Record<string, string> | null {
  const rects = [...svg.querySelectorAll('g.quadrants rect')].map((r) => ['x', 'y', 'width', 'height'].map((a) => Number(r.getAttribute(a))));
  if (rects.length === 0 || rects.some((r) => r.some((v) => !Number.isFinite(v)))) return null;
  const left = Math.min(...rects.map(([x]) => x));
  const top = Math.min(...rects.map(([, y]) => y));
  const width = Math.max(...rects.map(([x, , w]) => x + w)) - left;
  const height = Math.max(...rects.map(([, y, , h]) => y + h)) - top;
  if (width <= 0 || height <= 0) return null;
  return { x: unit(Number(row.values.x) + by.x / width), y: unit(Number(row.values.y) - by.y / height) };
}

export const quadrantPlugin = dataPlugin(
  'quadrantChart',
  [
    TITLE,
    { id: 'x', label: t('data.quadrant.x'), keyword: 'x-axis' },
    { id: 'y', label: t('data.quadrant.y'), keyword: 'y-axis' },
    { id: 'q1', label: t('data.quadrant.q1'), keyword: 'quadrant-1' },
    { id: 'q2', label: t('data.quadrant.q2'), keyword: 'quadrant-2' },
    { id: 'q3', label: t('data.quadrant.q3'), keyword: 'quadrant-3' },
    { id: 'q4', label: t('data.quadrant.q4'), keyword: 'quadrant-4' },
  ],
  [
    {
      id: 'points',
      title: t('data.quadrant.point'),
      schemas: [
        {
          ...rx(
            'point',
            t('data.quadrant.point'),
            /^(?<name>[^:]+?)\s*:\s*\[\s*(?<x>[\d.]+)\s*,\s*(?<y>[\d.]+)\s*\](?<style>.*?)\s*$/d,
            [text('name', t('data.name'), { width: 1.5 }), num('x', t('data.quadrant.x01')), num('y', t('data.quadrant.y01'))],
            (v) => `${v.name}: [${v.x}, ${v.y}]${v.style ?? ''}`,
            { name: t('data.quadrant.point.new'), x: '0.5', y: '0.5', style: '' },
          ),
          // 点の位置（0〜1）はそのまま Mermaid の書き方なので、ドラッグした位置に置く
          drag: 'free',
          place: placeQuadrantPoint,
        },
      ],
    },
  ],
  // 点（g.data-point の丸とラベル）は、ラベルの文字（名前）で行に対応付ける（描く順はソースの逆のことがある）。
  // 丸も行の要素にして、丸をつかんでドラッグできるようにする
  (svg, rows) =>
    [...svg.querySelectorAll('g.data-point')].flatMap((g) => {
      const name = g.querySelector('text')?.textContent?.trim();
      const row = rows.find((r) => r.schema.kind === 'point' && r.values.name === name);
      return row ? [{ el: g, row }] : [];
    }),
);

export const xyPlugin = dataPlugin(
  'xychart',
  [
    { ...TITLE, quoted: true },
    { id: 'x', label: t('data.xy.x'), keyword: 'x-axis' },
    { id: 'y', label: t('data.xy.y'), keyword: 'y-axis' },
  ],
  [
    {
      id: 'series',
      title: t('data.xy.series'),
      schemas: [
        rx(
          'series',
          t('data.xy.series'),
          /^(?<kind>bar|line)\s+(?:"(?<name>[^"]*)"\s+)?\[(?<values>[^\]]*)\]\s*$/d,
          [select('kind', t('data.kind'), ['bar', 'line'], { width: 0.6 }), text('name', t('data.name'), { optional: true }), text('values', t('data.values'), { width: 2 })],
          (v) => `${v.kind} ${v.name ? `"${quoteSafe(v.name)}" ` : ''}[${v.values}]`,
          { kind: 'bar', name: '', values: '1, 2, 3' },
          quoted,
        ),
      ],
    },
  ],
  // 系列の g（bar-plot-<番号> / line-plot-<番号>）の番号は、bar・line の行の順番。種類が合うことも確かめる。
  // 表で読めない bar・line の行（引用符の無い系列名など）があると番号がずれるので、そのときは対応付けない
  (svg, rows, source) => {
    const series = bodyLines(source).body.filter((l) => /^\s*(bar|line)\b/.test(l.text));
    if (series.length !== rows.length) return [];
    return [...svg.querySelectorAll('g.plot > g')].flatMap((g) => {
      const m = /^(bar|line)-plot-(\d+)$/.exec(g.getAttribute('class') ?? '');
      const row = m ? rows[Number(m[2])] : undefined;
      return row && row.values.kind === m![1] ? [{ el: g, row }] : [];
    });
  },
);

// ---- sankey / packet / radar / treemap ------------------------------------

export const sankeyPlugin = dataPlugin(
  'sankey',
  [],
  [
    {
      id: 'flows',
      title: t('data.sankey.flow'),
      schemas: [
        rx(
          'flow',
          t('data.sankey.flow'),
          /^(?<source>[^,"]+),(?<target>[^,"]+),(?<value>[\d.]+)\s*$/d,
          [text('source', t('data.sankey.source')), text('target', t('data.sankey.target')), num('value', t('data.sankey.value'))],
          (v) => `${v.source},${v.target},${v.value}`,
          { source: 'A', target: 'B', value: '10' },
          (_f, v) => v.replace(/,/g, ''),
        ),
      ],
    },
  ],
  matchFlows,
);

/**
 * サンキー図の流れ（g.link）を行に対応付ける。流れの色は元と先のノードの色のグラデーションなので、
 * ノードの名前（ラベルの 1 行目）と色から、端点が合う行を出てくる順に割り当てる
 */
function matchFlows(svg: SVGSVGElement, rows: TableRow[]) {
  const rects = [...svg.querySelectorAll('g.nodes > g.node > rect')];
  const names = [...svg.querySelectorAll('g.node-labels > text')].map((x) => (x.textContent ?? '').split('\n')[0].trim());
  if (rects.length !== names.length) return [];
  const color = new Map(names.map((n, i) => [n, rects[i].getAttribute('fill')]));
  const links = [...svg.querySelectorAll('g.links > g.link')];
  const stops = (el: Element) => [...el.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
  const found = matchInOrder(links, rows, (el, row) => {
    const [a, b] = stops(el);
    return !!a && a === color.get(row.values.source.trim()) && b === color.get(row.values.target.trim());
  });
  return links.flatMap((el, k) => (found[k] >= 0 ? [{ el, row: rows[found[k]] }] : []));
}

/** packet の次の欄の最初のビット（欄は前から順に、すき間なく続く） */
function nextBit(before: TableRow[]): number {
  let pos = 0;
  for (const r of before) pos = r.schema.kind === 'bits' ? pos + Number(r.values.bits) : Number(r.values.end || r.values.start) + 1;
  return pos;
}

export const packetPlugin = dataPlugin(
  'packet',
  [TITLE],
  [
    {
      id: 'fields',
      title: t('data.packet.fields'),
      schemas: [
        {
          ...rx(
            'range',
            t('data.packet.range'),
            /^(?<start>\d+)(?:-(?<end>\d+))?\s*:\s*"(?<label>[^"]*)"\s*$/d,
            [num('start', t('data.packet.start')), num('end', t('data.packet.end'), { optional: true }), text('label', t('data.name'), { width: 2 })],
            (v) => `${v.start}${v.end ? `-${v.end}` : ''}: "${quoteSafe(v.label)}"`,
            { start: '0', end: '7', label: t('data.packet.field.new') },
            quoted,
          ),
          // 途中に足すと、後ろの欄とビットの位置が重なる
          appendOnly: true,
          next: (before) => {
            const start = nextBit(before);
            return { start: String(start), end: String(start + 7), label: t('data.packet.field.new') };
          },
        },
        {
          ...rx(
            'bits',
            t('data.packet.bits'),
            /^\+(?<bits>\d+)\s*:\s*"(?<label>[^"]*)"\s*$/d,
            [num('bits', t('data.packet.bits')), text('label', t('data.name'), { width: 2 })],
            (v) => `+${v.bits}: "${quoteSafe(v.label)}"`,
            { bits: '8', label: t('data.packet.field.new') },
            quoted,
          ),
          appendOnly: true,
        },
      ],
    },
  ],
);

export const radarPlugin = dataPlugin(
  'radar',
  [TITLE, { id: 'axis', label: t('data.radar.axis'), keyword: 'axis', placeholder: 'a["A"], b["B"], c["C"]' }],
  [
    {
      id: 'curves',
      title: t('data.radar.curve'),
      schemas: [
        rx(
          'curve',
          t('data.radar.curve'),
          /^curve\s+(?<id>[\p{L}\p{N}_]+)(?:\["(?<label>[^"]*)"\])?\s*\{(?<values>[^}]*)\}\s*$/du,
          [text('id', 'ID', { width: 0.6 }), text('label', t('data.name'), { optional: true }), text('values', t('data.values'), { width: 2 })],
          (v) => `curve ${v.id}${v.label ? `["${quoteSafe(v.label)}"]` : ''}{${v.values}}`,
          { id: 'c1', label: t('data.radar.curve.new'), values: '1, 2, 3' },
          quoted,
        ),
      ],
    },
  ],
);

export const treemapPlugin = dataPlugin(
  'treemap',
  [],
  [
    {
      id: 'items',
      title: t('data.treemap.item'),
      schemas: [
        {
          ...rx(
            'item',
            t('data.treemap.item'),
            /^"(?<name>[^"]*)"(?:\s*:\s*(?<value>[\d.]+))?\s*$/d,
            [text('name', t('data.name'), { width: 2 }), num('value', t('data.treemap.leafValue'), { optional: true })],
            (v) => `"${quoteSafe(v.name)}"${v.value ? `: ${v.value}` : ''}`,
            { name: t('data.item.new'), value: '10' },
            quoted,
          ),
          // インデントで入れ子を表すので、深い後ろの行は子
          nested: true,
          drag: 'xy',
        },
      ],
    },
  ],
);

// ---- C4 / requirement / usecase ------------------------------

const C4_ELEMENTS = [
  'Person',
  'Person_Ext',
  'System',
  'System_Ext',
  'SystemDb',
  'SystemDb_Ext',
  'SystemQueue',
  'Container',
  'Container_Ext',
  'ContainerDb',
  'ContainerQueue',
  'Component',
  'Component_Ext',
  'ComponentDb',
];

export const c4Plugin = dataPlugin(
  'c4',
  [TITLE],
  [
    {
      id: 'elements',
      title: t('data.c4.table'),
      schemas: [
        rx(
          'element',
          t('data.c4.element'),
          /^(?<fn>[A-Za-z_]+)\(\s*(?<alias>[\p{L}\p{N}_]+)\s*,\s*"(?<label>[^"]*)"(?:\s*,\s*"(?<descr>[^"]*)")?(?<rest>[^)]*)\)\s*$/du,
          [select('fn', t('data.kind'), C4_ELEMENTS, { width: 0.9 }), text('alias', 'ID', { width: 0.6 }), text('label', t('data.name')), text('descr', t('data.c4.descr'), { optional: true, width: 1.5 })],
          (v) => `${v.fn}(${v.alias}, "${quoteSafe(v.label)}"${v.descr ? `, "${quoteSafe(v.descr)}"` : ''}${v.rest ?? ''})`,
          { fn: 'System', alias: 'sys1', label: t('data.c4.system.new'), descr: '', rest: '' },
          quoted,
          'xy',
        ),
        rx(
          'rel',
          t('data.c4.rel'),
          /^(?<fn>Rel|BiRel|Rel_U|Rel_D|Rel_L|Rel_R|Rel_Up|Rel_Down|Rel_Left|Rel_Right|Rel_Back)\(\s*(?<from>[\p{L}\p{N}_]+)\s*,\s*(?<to>[\p{L}\p{N}_]+)\s*,\s*"(?<label>[^"]*)"(?<rest>[^)]*)\)\s*$/du,
          [
            select('fn', t('data.kind'), ['Rel', 'BiRel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R', 'Rel_Back'], { width: 0.9 }),
            text('from', t('data.from'), { width: 0.6 }),
            text('to', t('data.to'), { width: 0.6 }),
            text('label', t('data.label'), { width: 1.5 }),
          ],
          (v) => `${v.fn}(${v.from}, ${v.to}, "${quoteSafe(v.label)}"${v.rest ?? ''})`,
          { fn: 'Rel', from: 'a', to: 'b', label: t('data.c4.rel.default'), rest: '' },
          quoted,
          false,
        ),
      ],
    },
  ],
);

const REQ_TYPES = ['requirement', 'functionalRequirement', 'interfaceRequirement', 'performanceRequirement', 'physicalRequirement', 'designConstraint'];

export const requirementPlugin = dataPlugin(
  'requirement',
  [],
  [
    {
      id: 'blocks',
      title: t('data.req.table'),
      schemas: [
        {
          kind: 'requirement',
          title: t('data.req.requirement'),
          fields: [select('type', t('data.kind'), REQ_TYPES), text('name', t('data.name'))],
          parse: regexParser(/^(?<type>requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint)\s+(?<name>[^\s{]+)\s*\{\s*$/d),
          block: true,
          format: (v) => `${v.type} ${v.name} {\n    id: ${v.name}\n    text: "${t('data.req.text.default')}"\n    risk: medium\n    verifymethod: test\n}`,
          defaults: { type: 'requirement', name: 'req1' },
          drag: 'xy',
        },
        {
          kind: 'element',
          title: t('data.req.element'),
          fields: [text('name', t('data.name'))],
          parse: regexParser(/^element\s+(?<name>[^\s{]+)\s*\{\s*$/d),
          block: true,
          format: (v) => `element ${v.name} {\n    type: simulation\n}`,
          defaults: { name: 'element1' },
          drag: 'xy',
        },
        rx(
          'relation',
          t('data.req.relation'),
          /^(?<a>[^\s-]+)\s+-\s*(?<rel>contains|copies|derives|satisfies|verifies|refines|traces)\s*->\s*(?<b>\S+)\s*$/d,
          [text('a', t('data.from')), select('rel', t('data.req.relation'), ['contains', 'copies', 'derives', 'satisfies', 'verifies', 'refines', 'traces']), text('b', t('data.to'))],
          (v) => `${v.a} - ${v.rel} -> ${v.b}`,
          { a: 'element1', rel: 'satisfies', b: 'req1' },
          undefined,
          false,
        ),
      ],
    },
  ],
  // 要求・要素の g.node は id（<SVG の id>-<名前>）、関係の線は data-id（<元>-<先>-<連番>）の端点で対応付ける
  (svg, rows) => {
    const out: { el: Element; row: TableRow }[] = [];
    svg.querySelectorAll('g.node').forEach((g) => {
      const row = rows.find((r) => r.schema.kind !== 'relation' && g.id === `${svg.id}-${r.values.name}`);
      if (row) out.push({ el: g, row });
    });
    const relations = rows.filter((r) => r.schema.kind === 'relation');
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const found = matchInOrder(paths, relations, (el, r) => (el.getAttribute('data-id') ?? '').startsWith(`${r.values.a}-${r.values.b}-`));
    paths.forEach((el, k) => found[k] >= 0 && out.push({ el, row: relations[found[k]] }));
    return out;
  },
);

export const usecasePlugin = dataPlugin(
  'usecase',
  [],
  [
    {
      id: 'usecases',
      title: t('data.usecase.table'),
      schemas: [
        rx('actor', t('data.usecase.actor'), /^actor\s+(?<name>.+?)\s*$/d, [text('name', t('data.name'))], (v) => `actor ${v.name}`, { name: 'User' }),
        rx(
          'link',
          t('data.usecase.link'),
          /^(?<a>[^\s-]+)\s*-->\s*(?<b>.+?)\s*$/d,
          [text('a', t('data.usecase.actor')), text('b', t('data.usecase.usecase'), { width: 2 })],
          (v) => `${v.a} --> ${v.b}`,
          { a: 'User', b: `"${t('data.usecase.usecase.new')}"` },
          undefined,
          false,
        ),
      ],
    },
  ],
  // 利用者の g は data-usecase-id に名前を持つ（ユースケースの楕円の id は名前から作られないので、ラベルで対応付ける）
  (svg, rows) =>
    [...svg.querySelectorAll('g[data-usecase-kind="actor"]')].flatMap((g) => {
      const row = rows.find((r) => r.schema.kind === 'actor' && r.values.name === g.getAttribute('data-usecase-id'));
      return row ? [{ el: g, row }] : [];
    }),
);

export const DATA_PLUGINS: { plugin: DiagramPlugin; aliases?: string[] }[] = [
  { plugin: piePlugin },
  { plugin: ganttPlugin },
  { plugin: timelinePlugin },
  { plugin: journeyPlugin },
  { plugin: gitGraphPlugin },
  { plugin: quadrantPlugin },
  { plugin: xyPlugin },
  { plugin: sankeyPlugin },
  { plugin: packetPlugin },
  { plugin: radarPlugin },
  { plugin: treemapPlugin },
  { plugin: c4Plugin },
  { plugin: requirementPlugin },
  { plugin: usecasePlugin },
];
