import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { bodyLines, isComment } from '../plugins/source';
import { META_SHAPES } from '../plugins/flowchartSyntax';
import { t } from '../i18n';

// テキストエディタの入力補完。図種の宣言、図種ごとの書き方、文書の中にすでにある名前（ノードの ID など）、
// フローチャートの @{ shape: … } の形の名前を候補に出す。候補を選ぶのは入力と同じ扱い（履歴は入力としてまとまる）。

export interface Candidate {
  label: string;
  /** 候補の横に出す説明 */
  detail?: string;
  type: 'keyword' | 'type' | 'variable' | 'enum';
}

const DIAGRAM_TYPES: [string, string][] = [
  ['flowchart TD', t('misc.diagram.flowchart')],
  ['sequenceDiagram', t('misc.diagram.sequence')],
  ['classDiagram', t('misc.diagram.class')],
  ['stateDiagram-v2', t('misc.diagram.state')],
  ['erDiagram', t('misc.diagram.er')],
  ['gantt', t('misc.diagram.gantt')],
  ['pie', t('misc.diagram.pie')],
  ['mindmap', t('misc.diagram.mindmap')],
  ['timeline', t('misc.diagram.timeline')],
  ['journey', t('misc.diagram.journey')],
  ['gitGraph', t('misc.diagram.gitgraph')],
  ['quadrantChart', t('misc.diagram.quadrant')],
  ['xychart-beta', t('misc.diagram.xychart')],
  ['sankey-beta', t('misc.diagram.sankey')],
  ['packet-beta', t('misc.diagram.packet')],
  ['kanban', t('misc.diagram.kanban')],
  ['block-beta', t('misc.diagram.block')],
  ['architecture-beta', t('misc.diagram.architecture')],
  ['radar-beta', t('misc.diagram.radar')],
  ['treemap-beta', t('misc.diagram.treemap')],
  ['requirementDiagram', t('misc.diagram.requirement')],
  ['C4Context', t('misc.diagram.c4')],
];

/** 図種ごとの書き方（宣言行の最初の単語で引く） */
const KEYWORDS: Record<string, string[]> = {
  flowchart: ['subgraph', 'end', 'direction', 'classDef', 'class', 'style', 'linkStyle', 'click', 'TB', 'TD', 'BT', 'LR', 'RL'],
  sequenceDiagram: [
    'participant', 'actor', 'as', 'Note', 'left of', 'right of', 'over', 'loop', 'alt', 'else', 'opt', 'par', 'and',
    'critical', 'option', 'break', 'rect', 'end', 'activate', 'deactivate', 'autonumber', 'box', 'create', 'destroy', 'title',
  ],
  classDiagram: ['class', 'namespace', 'direction', 'note', 'note for', 'classDef', 'style', '<<interface>>', '<<abstract>>', '<<enumeration>>'],
  stateDiagram: ['state', 'direction', 'note', 'end note', 'left of', 'right of', '[*]', '<<choice>>', '<<fork>>', '<<join>>', 'classDef', 'class'],
  erDiagram: ['direction', 'PK', 'FK', 'UK'],
  gantt: ['title', 'dateFormat', 'axisFormat', 'tickInterval', 'excludes', 'weekend', 'section', 'todayMarker', 'done', 'active', 'crit', 'milestone', 'after'],
  pie: ['title', 'showData'],
  timeline: ['title', 'section'],
  journey: ['title', 'section'],
  gitGraph: ['commit', 'branch', 'checkout', 'merge', 'cherry-pick', 'id:', 'tag:', 'type:', 'HIGHLIGHT', 'REVERSE'],
  quadrantChart: ['title', 'x-axis', 'y-axis', 'quadrant-1', 'quadrant-2', 'quadrant-3', 'quadrant-4'],
  'xychart-beta': ['title', 'x-axis', 'y-axis', 'bar', 'line', 'horizontal'],
  kanban: ['@{ ticket: }', '@{ assigned: }', '@{ priority: }'],
  'block-beta': ['columns', 'block', 'end', 'space', 'classDef', 'class', 'style'],
  'architecture-beta': ['group', 'service', 'junction', 'in'],
  requirementDiagram: ['requirement', 'element', 'id:', 'text:', 'risk:', 'verifymethod:', 'type:', 'satisfies', 'traces', 'contains', 'derives', 'refines', 'verifies', 'copies'],
};
KEYWORDS.graph = KEYWORDS.flowchart;
KEYWORDS['stateDiagram-v2'] = KEYWORDS.stateDiagram;

const COMMON = ['accTitle:', 'accDescr:', '%%'];

/** 名前に使えない語（書き方そのもの） */
const RESERVED = new Set(Object.values(KEYWORDS).flat().concat(DIAGRAM_TYPES.map(([x]) => x.split(' ')[0])));

/** 文書の中にある名前（2 文字以上の語）。数が多い順に並べる。いま打っている語（at の位置）は数えない */
function namesIn(source: string, skipFrom: number, skipTo: number): string[] {
  const count = new Map<string, number>();
  for (const m of source.matchAll(/[\p{L}_][\p{L}\p{N}_-]*/gu)) {
    const start = m.index!;
    if (start === skipFrom && start + m[0].length === skipTo) continue;
    const w = m[0];
    if (w.length < 2 || RESERVED.has(w)) continue;
    count.set(w, (count.get(w) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

/**
 * pos の位置の補完候補。補う語の始まり（from）と候補を返す。候補が無ければ null。
 * explicit は Ctrl+Space で呼んだとき（語を打っていなくても候補を出す）
 */
export function completeAt(source: string, pos: number, explicit = false): { from: number; options: Candidate[] } | null {
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const before = source.slice(lineStart, pos);
  if (isComment(before)) return null;
  const word = /[\p{L}\p{N}_-]*$/u.exec(before)![0];
  const from = pos - word.length;
  if (!explicit && word.length === 0) return null;

  // @{ shape: の後は形の名前
  if (/@\{[^}]*\bshape:\s*[\w-]*$/.test(before)) {
    return { from, options: META_SHAPES.map((s) => ({ label: s.name, detail: s.label, type: 'enum' as const })) };
  }

  const { header } = bodyLines(source);
  // 宣言行（まだ無いか、いま打っている行）では図種を出す
  if (!header || header.from === lineStart) {
    return { from, options: DIAGRAM_TYPES.map(([label, detail]) => ({ label, detail, type: 'type' as const })) };
  }
  const kind = /^\s*([\w-]+)/.exec(header.text)?.[1] ?? '';
  const keywords = KEYWORDS[kind] ?? [];
  const names = namesIn(source, from, pos).filter((w) => !keywords.includes(w));
  return {
    from,
    options: [
      ...keywords.map((label) => ({ label, type: 'keyword' as const })),
      ...COMMON.map((label) => ({ label, type: 'keyword' as const })),
      ...names.map((label) => ({ label, type: 'variable' as const, detail: t('misc.completion.name') })),
    ],
  };
}

function source(context: CompletionContext): CompletionResult | null {
  const r = completeAt(context.state.doc.toString(), context.pos, context.explicit);
  if (!r) return null;
  return { from: r.from, options: r.options, validFor: /^[\p{L}\p{N}_-]*$/u };
}

/** エディタに入れる補完の拡張（Ctrl+Space で呼べる。打っている間は自動で出る） */
export const mermaidCompletion = autocompletion({ override: [source], icons: false });
