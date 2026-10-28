import { t } from '../i18n';
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
): RowSchema {
  return { kind, title, fields, parse: regexParser(re), format, defaults, encode };
}

const quoted = (_f: string, v: string) => quoteSafe(v);

function dataPlugin(type: string, keywords: KeywordSpec[], tables: TableDef[]): DiagramPlugin {
  return {
    type,
    mapTargets: (svg, source) => genericTargets(svg, source),
    inspect: (source, ref) => (ref ? [] : keywordFields(source, keywords)),
    setProperty: (source, ref, field, value) => {
      if (ref) return null;
      const spec = keywords.find((k) => k.id === field);
      return spec ? setKeyword(source, spec, value) : null;
    },
    tables,
  };
}

const TITLE: KeywordSpec = { id: 'title', label: t('data.title'), keyword: 'title' };
const SECTION = rx('section', t('data.section'), /^section\s+(?<name>.+?)\s*$/d, [text('name', t('data.name'))], (v) => `section ${v.name}`, {
  name: t('data.section.new'),
});

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
        SECTION,
        rx(
          'period',
          t('data.timeline.period'),
          /^(?<period>[^:]+?)\s*:\s*(?<events>.+?)\s*$/d,
          [text('period', t('data.timeline.period'), { width: 0.7 }), text('events', t('data.timeline.eventsField'), { width: 2 })],
          (v) => `${v.period} : ${v.events}`,
          { period: t('data.timeline.period.new'), events: t('data.timeline.event') },
        ),
        rx('event', t('data.timeline.continued'), /^:\s*(?<event>.+?)\s*$/d, [text('event', t('data.timeline.event'))], (v) => `: ${v.event}`, {
          event: t('data.timeline.event'),
        }),
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
      title: t('data.task'),
      schemas: [
        SECTION,
        rx(
          'task',
          t('data.task'),
          /^(?<name>[^:]+?)\s*:\s*(?<score>\d+)\s*:\s*(?<actors>.*?)\s*$/d,
          [text('name', t('data.name'), { width: 1.5 }), select('score', t('data.journey.score'), ['1', '2', '3', '4', '5'], { width: 0.6 }), text('actors', t('data.journey.actors'))],
          (v) => `${v.name}: ${v.score}: ${v.actors}`,
          { name: t('data.task.new'), score: '3', actors: t('data.journey.actor.default') },
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
          defaults: { id: '', tag: '', type: 'NORMAL' },
        },
        {
          kind: 'branch',
          title: 'branch',
          fields: [text('name', t('data.git.branch'))],
          parse: gitParser(/^branch\s+([^\s]+)/d, [], true),
          format: (v) => `branch ${v.name}`,
          defaults: { name: 'feature' },
        },
        {
          kind: 'checkout',
          title: 'checkout',
          fields: [text('name', t('data.git.branch'))],
          parse: gitParser(/^(?:checkout|switch)\s+([^\s]+)/d, [], true),
          format: (v) => `checkout ${v.name}`,
          defaults: { name: 'main' },
        },
        {
          kind: 'merge',
          title: 'merge',
          fields: [text('name', t('data.git.branch')), text('tag', t('data.tag'), { optional: true })],
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
        rx(
          'point',
          t('data.quadrant.point'),
          /^(?<name>[^:]+?)\s*:\s*\[\s*(?<x>[\d.]+)\s*,\s*(?<y>[\d.]+)\s*\](?<style>.*?)\s*$/d,
          [text('name', t('data.name'), { width: 1.5 }), num('x', t('data.quadrant.x01')), num('y', t('data.quadrant.y01'))],
          (v) => `${v.name}: [${v.x}, ${v.y}]${v.style ?? ''}`,
          { name: t('data.quadrant.point.new'), x: '0.5', y: '0.5', style: '' },
        ),
      ],
    },
  ],
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
);

export const packetPlugin = dataPlugin(
  'packet',
  [TITLE],
  [
    {
      id: 'fields',
      title: t('data.packet.fields'),
      schemas: [
        rx(
          'range',
          t('data.packet.range'),
          /^(?<start>\d+)(?:-(?<end>\d+))?\s*:\s*"(?<label>[^"]*)"\s*$/d,
          [num('start', t('data.packet.start')), num('end', t('data.packet.end'), { optional: true }), text('label', t('data.name'), { width: 2 })],
          (v) => `${v.start}${v.end ? `-${v.end}` : ''}: "${quoteSafe(v.label)}"`,
          { start: '0', end: '7', label: t('data.packet.field.new') },
          quoted,
        ),
        rx(
          'bits',
          t('data.packet.bits'),
          /^\+(?<bits>\d+)\s*:\s*"(?<label>[^"]*)"\s*$/d,
          [num('bits', t('data.packet.bits')), text('label', t('data.name'), { width: 2 })],
          (v) => `+${v.bits}: "${quoteSafe(v.label)}"`,
          { bits: '8', label: t('data.packet.field.new') },
          quoted,
        ),
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
        rx(
          'item',
          t('data.treemap.item'),
          /^"(?<name>[^"]*)"(?:\s*:\s*(?<value>[\d.]+))?\s*$/d,
          [text('name', t('data.name'), { width: 2 }), num('value', t('data.treemap.leafValue'), { optional: true })],
          (v) => `"${quoteSafe(v.name)}"${v.value ? `: ${v.value}` : ''}`,
          { name: t('data.item.new'), value: '10' },
          quoted,
        ),
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
          format: (v) => `${v.type} ${v.name} {\n    id: ${v.name}\n    text: ${t('data.req.text.default')}\n    risk: medium\n    verifymethod: test\n}`,
          defaults: { type: 'requirement', name: 'req1' },
        },
        {
          kind: 'element',
          title: t('data.req.element'),
          fields: [text('name', t('data.name'))],
          parse: regexParser(/^element\s+(?<name>[^\s{]+)\s*\{\s*$/d),
          format: (v) => `element ${v.name} {\n    type: simulation\n}`,
          defaults: { name: 'element1' },
        },
        rx(
          'relation',
          t('data.req.relation'),
          /^(?<a>[^\s-]+)\s+-\s*(?<rel>contains|copies|derives|satisfies|verifies|refines|traces)\s*->\s*(?<b>\S+)\s*$/d,
          [text('a', t('data.from')), select('rel', t('data.req.relation'), ['contains', 'copies', 'derives', 'satisfies', 'verifies', 'refines', 'traces']), text('b', t('data.to'))],
          (v) => `${v.a} - ${v.rel} -> ${v.b}`,
          { a: 'element1', rel: 'satisfies', b: 'req1' },
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
  { plugin: usecasePlugin },
];
