import type { DiagramPlugin } from './types';
import { genericTargets } from './generic';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { quoteSafe, regexParser, type ParsedRow, type RowSchema, type TableDef, type TableField } from './table';

// データ系・その他の図種のプラグイン（設計書 §7.3 Phase 3・4）。
// 図からの直接編集はラベルの書き換え（汎用フォールバック）とし、行の追加・削除・並べ替え・値の変更は「表」で行う。
// 図全体の設定（title など）はプロパティパネルの「図全体」に出す。

const text = (name: string, label: string, extra: Partial<TableField> = {}): TableField => ({ name, label, type: 'text', ...extra });
const num = (name: string, label: string, extra: Partial<TableField> = {}): TableField => ({ name, label, type: 'number', width: 0.6, ...extra });
const select = (name: string, label: string, values: string[], extra: Partial<TableField> = {}): TableField => ({
  name,
  label,
  type: 'select',
  options: values.map((v) => ({ value: v, label: v || '（なし）' })),
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
): RowSchema {
  return { kind, title, fields, parse: regexParser(re), format, defaults, encode };
}

const quoted = (_f: string, v: string) => quoteSafe(v);

function dataPlugin(type: string, keywords: KeywordSpec[], tables: TableDef[]): DiagramPlugin {
  return {
    type,
    capabilities: ['label', 'props'],
    mapTargets: (svg, source) => genericTargets(svg, source),
    renameLabel: (_s, target, value) => (target.range ? { from: target.range.from, to: target.range.to, insert: value } : null),
    inspect: (source, ref) => (ref ? [] : keywordFields(source, keywords)),
    setProperty: (source, ref, field, value) => {
      if (ref) return null;
      const spec = keywords.find((k) => k.id === field);
      return spec ? setKeyword(source, spec, value) : null;
    },
    tables,
  };
}

const TITLE: KeywordSpec = { id: 'title', label: 'タイトル', keyword: 'title' };
const SECTION = rx('section', 'セクション', /^section\s+(?<name>.+?)\s*$/d, [text('name', '名前')], (v) => `section ${v.name}`, {
  name: '新しいセクション',
});

// ---- pie ----------------------------------------------------------------

export const piePlugin = dataPlugin(
  'pie',
  [{ ...TITLE, headerPattern: /^\s*pie(?:\s+showData)?\s+title\s+(.+?)\s*$/d }],
  [
    {
      id: 'slices',
      title: 'スライス',
      schemas: [
        rx(
          'slice',
          'スライス',
          /^"(?<label>[^"]*)"\s*:\s*(?<value>[-\d.]+)\s*$/d,
          [text('label', 'ラベル'), num('value', '値')],
          (v) => `"${quoteSafe(v.label)}" : ${v.value}`,
          { label: '新しい項目', value: '10' },
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
  title: 'タスク',
  fields: [
    text('name', '名前', { width: 1.6 }),
    text('status', '状態', { optional: true, width: 0.9 }),
    text('id', 'ID', { optional: true, width: 0.6 }),
    text('start', '開始', { optional: true }),
    text('end', '期間・終了', { width: 0.8 }),
  ],
  parse: parseGanttTask,
  format: (v) => `${v.name} :${[v.status, v.id, v.start, v.end].filter((x) => x && x.trim()).join(', ')}`,
  defaults: { name: '新しいタスク', status: '', id: '', start: '', end: '3d' },
};

export const ganttPlugin = dataPlugin(
  'gantt',
  [
    TITLE,
    { id: 'dateFormat', label: '日付の書式', keyword: 'dateFormat', placeholder: 'YYYY-MM-DD' },
    { id: 'axisFormat', label: '軸の書式', keyword: 'axisFormat', placeholder: '%m/%d' },
    { id: 'excludes', label: '除外する日', keyword: 'excludes', placeholder: 'weekends' },
  ],
  [{ id: 'tasks', title: 'タスク', schemas: [SECTION, ganttTask] }],
);

// ---- timeline / journey -------------------------------------------------

export const timelinePlugin = dataPlugin(
  'timeline',
  [TITLE],
  [
    {
      id: 'events',
      title: '出来事',
      schemas: [
        SECTION,
        rx(
          'period',
          '時期',
          /^(?<period>[^:]+?)\s*:\s*(?<events>.+?)\s*$/d,
          [text('period', '時期', { width: 0.7 }), text('events', '出来事（: で区切る）', { width: 2 })],
          (v) => `${v.period} : ${v.events}`,
          { period: '新しい時期', events: '出来事' },
        ),
        rx('event', '続きの出来事', /^:\s*(?<event>.+?)\s*$/d, [text('event', '出来事')], (v) => `: ${v.event}`, { event: '出来事' }),
      ],
    },
  ],
);

export const journeyPlugin = dataPlugin(
  'journey',
  [TITLE],
  [
    {
      id: 'tasks',
      title: 'タスク',
      schemas: [
        SECTION,
        rx(
          'task',
          'タスク',
          /^(?<name>[^:]+?)\s*:\s*(?<score>\d+)\s*:\s*(?<actors>.*?)\s*$/d,
          [text('name', '名前', { width: 1.5 }), select('score', '満足度', ['1', '2', '3', '4', '5'], { width: 0.6 }), text('actors', '人（, で区切る）')],
          (v) => `${v.name}: ${v.score}: ${v.actors}`,
          { name: '新しいタスク', score: '3', actors: 'ユーザー' },
        ),
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
      title: 'コマンド',
      schemas: [
        {
          kind: 'commit',
          title: 'commit',
          fields: [text('id', 'ID', { optional: true }), text('tag', 'タグ', { optional: true }), select('type', '種類', ['NORMAL', 'REVERSE', 'HIGHLIGHT'])],
          parse: gitParser(/^commit\b/d, [
            { name: 'id', quoted: true },
            { name: 'tag', quoted: true },
            { name: 'type', quoted: false },
          ]),
          format: (v) => `commit${gitAttrs(v)}`,
          defaults: { id: '', tag: '', type: 'NORMAL' },
        },
        {
          kind: 'branch',
          title: 'branch',
          fields: [text('name', 'ブランチ名')],
          parse: gitParser(/^branch\s+([^\s]+)/d, [], true),
          format: (v) => `branch ${v.name}`,
          defaults: { name: 'feature' },
        },
        {
          kind: 'checkout',
          title: 'checkout',
          fields: [text('name', 'ブランチ名')],
          parse: gitParser(/^(?:checkout|switch)\s+([^\s]+)/d, [], true),
          format: (v) => `checkout ${v.name}`,
          defaults: { name: 'main' },
        },
        {
          kind: 'merge',
          title: 'merge',
          fields: [text('name', 'ブランチ名'), text('tag', 'タグ', { optional: true })],
          parse: gitParser(/^merge\s+([^\s]+)/d, [{ name: 'tag', quoted: true }], true),
          format: (v) => `merge ${v.name}${v.tag ? ` tag: "${v.tag}"` : ''}`,
          defaults: { name: 'feature', tag: '' },
        },
      ],
    },
  ],
);

// ---- quadrantChart / xychart --------------------------------------------

export const quadrantPlugin = dataPlugin(
  'quadrantChart',
  [
    TITLE,
    { id: 'x', label: 'x 軸（左 --> 右）', keyword: 'x-axis' },
    { id: 'y', label: 'y 軸（下 --> 上）', keyword: 'y-axis' },
    { id: 'q1', label: '第 1 象限（右上）', keyword: 'quadrant-1' },
    { id: 'q2', label: '第 2 象限（左上）', keyword: 'quadrant-2' },
    { id: 'q3', label: '第 3 象限（左下）', keyword: 'quadrant-3' },
    { id: 'q4', label: '第 4 象限（右下）', keyword: 'quadrant-4' },
  ],
  [
    {
      id: 'points',
      title: '点',
      schemas: [
        rx(
          'point',
          '点',
          /^(?<name>[^:]+?)\s*:\s*\[\s*(?<x>[\d.]+)\s*,\s*(?<y>[\d.]+)\s*\](?<style>.*?)\s*$/d,
          [text('name', '名前', { width: 1.5 }), num('x', 'x（0〜1）'), num('y', 'y（0〜1）')],
          (v) => `${v.name}: [${v.x}, ${v.y}]${v.style ?? ''}`,
          { name: '新しい点', x: '0.5', y: '0.5', style: '' },
        ),
      ],
    },
  ],
);

export const xyPlugin = dataPlugin(
  'xychart',
  [
    { ...TITLE, quoted: true },
    { id: 'x', label: 'x 軸', keyword: 'x-axis' },
    { id: 'y', label: 'y 軸', keyword: 'y-axis' },
  ],
  [
    {
      id: 'series',
      title: '系列',
      schemas: [
        rx(
          'series',
          '系列',
          /^(?<kind>bar|line)\s+(?:"(?<name>[^"]*)"\s+)?\[(?<values>[^\]]*)\]\s*$/d,
          [select('kind', '種類', ['bar', 'line'], { width: 0.6 }), text('name', '名前', { optional: true }), text('values', '値（, で区切る）', { width: 2 })],
          (v) => `${v.kind} ${v.name ? `"${quoteSafe(v.name)}" ` : ''}[${v.values}]`,
          { kind: 'bar', name: '', values: '1, 2, 3' },
          quoted,
        ),
      ],
    },
  ],
);

// ---- sankey / packet / radar / treemap ------------------------------------

export const sankeyPlugin = dataPlugin(
  'sankey',
  [],
  [
    {
      id: 'flows',
      title: '流れ',
      schemas: [
        rx(
          'flow',
          '流れ',
          /^(?<source>[^,"]+),(?<target>[^,"]+),(?<value>[\d.]+)\s*$/d,
          [text('source', '流れ元'), text('target', '流れ先'), num('value', '量')],
          (v) => `${v.source},${v.target},${v.value}`,
          { source: 'A', target: 'B', value: '10' },
          (_f, v) => v.replace(/,/g, ''),
        ),
      ],
    },
  ],
);

export const packetPlugin = dataPlugin(
  'packet',
  [TITLE],
  [
    {
      id: 'fields',
      title: 'フィールド',
      schemas: [
        rx(
          'range',
          'ビット範囲',
          /^(?<start>\d+)(?:-(?<end>\d+))?\s*:\s*"(?<label>[^"]*)"\s*$/d,
          [num('start', '開始'), num('end', '終了', { optional: true }), text('label', '名前', { width: 2 })],
          (v) => `${v.start}${v.end ? `-${v.end}` : ''}: "${quoteSafe(v.label)}"`,
          { start: '0', end: '7', label: '新しいフィールド' },
          quoted,
        ),
        rx(
          'bits',
          'ビット数',
          /^\+(?<bits>\d+)\s*:\s*"(?<label>[^"]*)"\s*$/d,
          [num('bits', 'ビット数'), text('label', '名前', { width: 2 })],
          (v) => `+${v.bits}: "${quoteSafe(v.label)}"`,
          { bits: '8', label: '新しいフィールド' },
          quoted,
        ),
      ],
    },
  ],
);

export const radarPlugin = dataPlugin(
  'radar',
  [TITLE, { id: 'axis', label: '軸（axis）', keyword: 'axis', placeholder: 'a["A"], b["B"], c["C"]' }],
  [
    {
      id: 'curves',
      title: '曲線',
      schemas: [
        rx(
          'curve',
          '曲線',
          /^curve\s+(?<id>[\p{L}\p{N}_]+)(?:\["(?<label>[^"]*)"\])?\s*\{(?<values>[^}]*)\}\s*$/du,
          [text('id', 'ID', { width: 0.6 }), text('label', '名前', { optional: true }), text('values', '値（, で区切る）', { width: 2 })],
          (v) => `curve ${v.id}${v.label ? `["${quoteSafe(v.label)}"]` : ''}{${v.values}}`,
          { id: 'c1', label: '新しい曲線', values: '1, 2, 3' },
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
      title: '項目',
      schemas: [
        rx(
          'item',
          '項目',
          /^"(?<name>[^"]*)"(?:\s*:\s*(?<value>[\d.]+))?\s*$/d,
          [text('name', '名前', { width: 2 }), num('value', '値（葉のみ）', { optional: true })],
          (v) => `"${quoteSafe(v.name)}"${v.value ? `: ${v.value}` : ''}`,
          { name: '新しい項目', value: '10' },
          quoted,
        ),
      ],
    },
  ],
);

// ---- C4 / requirement / architecture / usecase ------------------------------

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
      title: '要素と関係',
      schemas: [
        rx(
          'element',
          '要素',
          /^(?<fn>[A-Za-z_]+)\(\s*(?<alias>[\p{L}\p{N}_]+)\s*,\s*"(?<label>[^"]*)"(?:\s*,\s*"(?<descr>[^"]*)")?(?<rest>[^)]*)\)\s*$/du,
          [select('fn', '種類', C4_ELEMENTS, { width: 0.9 }), text('alias', 'ID', { width: 0.6 }), text('label', '名前'), text('descr', '説明', { optional: true, width: 1.5 })],
          (v) => `${v.fn}(${v.alias}, "${quoteSafe(v.label)}"${v.descr ? `, "${quoteSafe(v.descr)}"` : ''}${v.rest ?? ''})`,
          { fn: 'System', alias: 'sys1', label: '新しいシステム', descr: '', rest: '' },
          quoted,
        ),
        rx(
          'rel',
          '関係',
          /^(?<fn>Rel|BiRel|Rel_U|Rel_D|Rel_L|Rel_R|Rel_Up|Rel_Down|Rel_Left|Rel_Right|Rel_Back)\(\s*(?<from>[\p{L}\p{N}_]+)\s*,\s*(?<to>[\p{L}\p{N}_]+)\s*,\s*"(?<label>[^"]*)"(?<rest>[^)]*)\)\s*$/du,
          [
            select('fn', '種類', ['Rel', 'BiRel', 'Rel_U', 'Rel_D', 'Rel_L', 'Rel_R', 'Rel_Back'], { width: 0.9 }),
            text('from', '元', { width: 0.6 }),
            text('to', '先', { width: 0.6 }),
            text('label', 'ラベル', { width: 1.5 }),
          ],
          (v) => `${v.fn}(${v.from}, ${v.to}, "${quoteSafe(v.label)}"${v.rest ?? ''})`,
          { fn: 'Rel', from: 'a', to: 'b', label: '使う', rest: '' },
          quoted,
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
      title: '要求と関係',
      schemas: [
        {
          kind: 'requirement',
          title: '要求',
          fields: [select('type', '種類', REQ_TYPES), text('name', '名前')],
          parse: regexParser(/^(?<type>requirement|functionalRequirement|interfaceRequirement|performanceRequirement|physicalRequirement|designConstraint)\s+(?<name>[^\s{]+)\s*\{\s*$/d),
          format: (v) => `${v.type} ${v.name} {\n    id: ${v.name}\n    text: 説明\n    risk: medium\n    verifymethod: test\n}`,
          defaults: { type: 'requirement', name: 'req1' },
        },
        {
          kind: 'element',
          title: '要素',
          fields: [text('name', '名前')],
          parse: regexParser(/^element\s+(?<name>[^\s{]+)\s*\{\s*$/d),
          format: (v) => `element ${v.name} {\n    type: simulation\n}`,
          defaults: { name: 'element1' },
        },
        rx(
          'relation',
          '関係',
          /^(?<a>[^\s-]+)\s+-\s*(?<rel>contains|copies|derives|satisfies|verifies|refines|traces)\s*->\s*(?<b>\S+)\s*$/d,
          [text('a', '元'), select('rel', '関係', ['contains', 'copies', 'derives', 'satisfies', 'verifies', 'refines', 'traces']), text('b', '先')],
          (v) => `${v.a} - ${v.rel} -> ${v.b}`,
          { a: 'element1', rel: 'satisfies', b: 'req1' },
        ),
      ],
    },
  ],
);

const ICONS = ['cloud', 'database', 'disk', 'internet', 'server'];

export const architecturePlugin = dataPlugin(
  'architecture',
  [],
  [
    {
      id: 'parts',
      title: '構成要素と接続',
      schemas: [
        rx(
          'group',
          'グループ',
          /^group\s+(?<id>[\p{L}\p{N}_]+)\((?<icon>[^)]*)\)\[(?<label>[^\]]*)\](?:\s+in\s+(?<parent>\S+))?\s*$/du,
          [text('id', 'ID', { width: 0.6 }), select('icon', 'アイコン', ICONS), text('label', '名前'), text('parent', '親グループ', { optional: true })],
          (v) => `group ${v.id}(${v.icon})[${v.label}]${v.parent ? ` in ${v.parent}` : ''}`,
          { id: 'g1', icon: 'cloud', label: '新しいグループ', parent: '' },
        ),
        rx(
          'service',
          'サービス',
          /^service\s+(?<id>[\p{L}\p{N}_]+)\((?<icon>[^)]*)\)\[(?<label>[^\]]*)\](?:\s+in\s+(?<parent>\S+))?\s*$/du,
          [text('id', 'ID', { width: 0.6 }), select('icon', 'アイコン', ICONS), text('label', '名前'), text('parent', 'グループ', { optional: true })],
          (v) => `service ${v.id}(${v.icon})[${v.label}]${v.parent ? ` in ${v.parent}` : ''}`,
          { id: 's1', icon: 'server', label: '新しいサービス', parent: '' },
        ),
        rx(
          'edge',
          '接続',
          /^(?<a>[\p{L}\p{N}_]+):(?<as>[LRTB])\s*(?<arrow><?-->?)\s*(?<bs>[LRTB]):(?<b>[\p{L}\p{N}_]+)\s*$/du,
          [text('a', '元', { width: 0.6 }), select('as', '元の辺', ['L', 'R', 'T', 'B'], { width: 0.5 }), select('arrow', '線', ['--', '-->', '<--', '<-->'], { width: 0.6 }), select('bs', '先の辺', ['L', 'R', 'T', 'B'], { width: 0.5 }), text('b', '先', { width: 0.6 })],
          (v) => `${v.a}:${v.as} ${v.arrow} ${v.bs}:${v.b}`,
          { a: 's1', as: 'R', arrow: '--', bs: 'L', b: 's2' },
        ),
      ],
    },
  ],
);

export const usecasePlugin = dataPlugin(
  'usecase',
  [],
  [
    {
      id: 'usecases',
      title: 'アクターとユースケース',
      schemas: [
        rx('actor', 'アクター', /^actor\s+(?<name>.+?)\s*$/d, [text('name', '名前')], (v) => `actor ${v.name}`, { name: 'User' }),
        rx(
          'link',
          'つながり',
          /^(?<a>[^\s-]+)\s*-->\s*(?<b>.+?)\s*$/d,
          [text('a', 'アクター'), text('b', 'ユースケース', { width: 2 })],
          (v) => `${v.a} --> ${v.b}`,
          { a: 'User', b: '"新しいユースケース"' },
        ),
      ],
    },
  ],
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
  { plugin: architecturePlugin },
  { plugin: usecasePlugin },
];
