import { withValue, type DiagramPlugin, type DiagramTarget, type PropertyField, type SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { ARROWS, isInside, META_SHAPES, nodeDefinition, nodeRefs, parseFlowchart, SHAPE_CHOICES, subgraphOf, type FlowDoc } from './flowchartSyntax';
import {
  arrowParts,
  buildArrow,
  deleteEdge,
  deleteNode,
  edgeInfo,
  getDirection,
  insertNodeOnEdge,
  reconnectEdge,
  renameNode,
  setArrow,
  setDirection,
  setEdgeLabel,
  setShape,
  shapeValue,
  withLinkStyles,
} from './flowchartOps';
import {
  addSubgraph,
  canMoveNode,
  deleteSubgraph,
  findSubgraph,
  groupNode,
  insertIntoSubgraph,
  moveNodeTo,
  renameSubgraph,
  setSubgraphDirection,
  setSubgraphTitle,
  unwrapSubgraph,
} from './flowchartSubgraph';
import { classNames, classOf, frontmatterTitle, linkStyleProp, setClass, setFrontmatterTitle, setLinkStyleProp, setStyleProp, styleProp } from './flowchartStyle';
import { addHitArea, edgeLabels, matchInOrder } from './svg';
import { topLevelEnd } from './lineOps';
import { regexParser, type TableDef } from './table';

// flowchart / graph のプラグイン（設計書 §7.3 Phase 1）。
// ノードは SVG の id（…-flowchart-<ノード ID>-<連番>）、エッジは data-id（L_<元>_<先>_<連番>）の端点、
// サブグラフは g.cluster の id（…-<サブグラフ ID>）でソースに対応付ける。

const NEW_LABEL = '新しいノード';
const NEW_GROUP = '新しいグループ';
const DEFAULT_INDENT = '    ';

/** ノード定義の行ではない行（スタイル指定など） */
const NON_STATEMENT = /^\s*(classDef|class|style|linkStyle|click|subgraph|direction)\b/;

const DIRECTIONS = [
  { value: 'TB', label: '上から下 (TB)' },
  { value: 'BT', label: '下から上 (BT)' },
  { value: 'LR', label: '左から右 (LR)' },
  { value: 'RL', label: '右から左 (RL)' },
];

const EDGE_ARROWS = [...ARROWS, { value: '~~~', label: '　 見えない線（配置だけ）' }];
const LENGTHS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: n === 1 ? '標準' : `${n} 段` }));

const SHAPE_OPTIONS = [
  ...SHAPE_CHOICES.map((s) => ({ value: s.name, label: s.label })),
  ...META_SHAPES.map((s) => ({ value: `@${s.name}`, label: `${s.label}（@{ shape: ${s.name} }）` })),
];

/** ノード・サブグラフの見た目（style 行のキー） */
const STYLE_FIELDS = [
  { key: 'fill', label: '塗りの色' },
  { key: 'stroke', label: '枠線の色' },
  { key: 'color', label: '文字の色' },
];

export function nodeIdFromSvg(el: Element): string | null {
  const m = /-flowchart-(.+)-\d+$/.exec(el.id);
  return m ? m[1] : null;
}

/** ノード id のラベルのソース上の範囲。複数回定義されていれば、mermaid と同じく最後の定義を使う */
export function findNodeLabel(source: string, id: string): SourceRange | null {
  return labelRange(parseFlowchart(source), id);
}

/** 読み取り済みの文書から、ノードのラベルの範囲を求める */
function labelRange(doc: FlowDoc, id: string): SourceRange | null {
  const def = nodeDefinition(doc, id);
  if (def?.shape) return { from: def.shape.labelFrom, to: def.shape.labelTo };
  return def?.meta?.label ?? null;
}

/** ラベルの無いノードに、ラベルを差し込める位置 */
function nodeLabelInsert(source: string, doc: FlowDoc, id: string): DiagramTarget['insertAt'] {
  const def = nodeDefinition(doc, id);
  if (def?.meta) {
    if (def.meta.label) return undefined;
    let at = def.meta.to - 1;
    while (at > def.meta.from + 2 && /\s/.test(source[at - 1])) at--;
    return { at, prefix: ', label: "', suffix: '"' };
  }
  if (def?.shape) return undefined;
  const first = nodeRefs(doc, id)[0];
  return first ? { at: first.ref.idTo, prefix: '[', suffix: ']' } : undefined;
}

/** 文が（入れ子も含めて）どのサブグラフにも入っていない行か */
const isTopLevel = (doc: FlowDoc, line: SourceLine) => !doc.subgraphs.some((sg) => isInside(sg, line));

/** ノード id が最後に現れる文の行 */
function lastLineOf(source: string, id: string): SourceLine | null {
  const { body } = bodyLines(source);
  const re = tokenRegex(id);
  for (let i = body.length - 1; i >= 0; i--) {
    if (!NON_STATEMENT.test(body[i].text) && re.test(body[i].text)) return body[i];
  }
  return null;
}

/** 新しいノードを含む 1 行を差し込む */
function addLine(source: string, after: SourceLine | null, indent: string, stmt: string, newId: string | null) {
  const change = insertLineAfter(source, after, indent + stmt);
  return {
    change,
    selAfter: newId ? rangeInInserted(change, NEW_LABEL) : rangeInInserted(change, stmt),
    focus: newId ? { kind: 'node', id: newId } : undefined,
  };
}

/** ノードとサブグラフの ID（エッジの端点の選択肢） */
function endpointOptions(doc: FlowDoc) {
  const ids = new Set<string>();
  for (const st of doc.statements) for (const g of st.groups) for (const r of g) ids.add(r.id);
  for (const sg of doc.subgraphs) ids.add(sg.id);
  return [...ids].map((id) => ({ value: id, label: findSubgraph(doc, id) ? `${id}（サブグラフ）` : id }));
}

const styleFields = (doc: FlowDoc, id: string): PropertyField[] =>
  STYLE_FIELDS.map((f) => ({ id: f.key, label: f.label, type: 'text', value: styleProp(doc, id, f.key), placeholder: '例: #ffcc00' }));

const CLASS_DEF_TABLE: TableDef = {
  id: 'classDef',
  title: 'クラス',
  secondary: true,
  schemas: [
    {
      kind: 'classDef',
      title: 'クラス',
      fields: [
        { name: 'name', label: '名前', type: 'text' },
        { name: 'props', label: 'スタイル', type: 'text', width: 3 },
      ],
      parse: regexParser(/^classDef\s+(?<name>\S+)\s+(?<props>.*?)\s*;?$/d),
      format: (v) => `classDef ${v.name} ${v.props}`,
      defaults: { name: 'newClass', props: 'fill:#fff4c2,stroke:#d4a017' },
    },
  ],
};

export const flowchartPlugin: DiagramPlugin = {
  type: 'flowchart-v2',

  mapTargets(svg, source) {
    const doc = parseFlowchart(source);
    const nodes: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const id = nodeIdFromSvg(g);
      if (!id) return;
      const labelEl = g.querySelector('foreignObject, text') ?? g;
      const range = labelRange(doc, id);
      nodes.push({
        id: `node-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range,
        insertAt: range ? undefined : nodeLabelInsert(source, doc, id),
        ref: { kind: 'node', id },
      });
    });

    // エッジ: SVG の data-id（L_<元>_<先>_<連番>）の端点で、ソースのエッジに対応付ける。
    // 同じ端点のエッジは出てくる順に割り当てる。端点が合わないものは編集の対象にしない
    const edges: DiagramTarget[] = [];
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const matched = matchInOrder(paths, doc.edges, (el, e) => (el.getAttribute('data-id') ?? '').startsWith(`L_${e.from}_${e.to}_`));
    const labels = edgeLabels(svg);
    paths.forEach((path, k) => {
      const i = matched[k];
      if (i < 0) return;
      const label = labels.get(path.getAttribute('data-id') ?? '') ?? null;
      const labelEl = label?.querySelector('foreignObject, text') ?? label ?? path;
      const info = doc.edges[i];
      const l = info.statement.links[info.link];
      edges.push({
        id: `edge-${i}`,
        el: path,
        hits: [addHitArea(path), ...(label ? [label] : [])],
        labelEl,
        label: label ? labelText(labelEl) : '',
        range: l.label ? { from: l.label.from, to: l.label.to } : null,
        insertAt: l.label || l.arrow.startsWith('~') ? undefined : { at: l.arrowTo, prefix: '|', suffix: '|' },
        ref: { kind: 'edge', id: String(i) },
      });
    });

    // サブグラフ: g.cluster の id は「SVG の id-サブグラフ ID」
    const clusters: DiagramTarget[] = [];
    const prefix = `${svg.id}-`;
    svg.querySelectorAll('g.cluster').forEach((g, i) => {
      if (!g.id.startsWith(prefix)) return;
      const sg = findSubgraph(doc, g.id.slice(prefix.length));
      if (!sg) return;
      const labelEl = g.querySelector('.cluster-label foreignObject, .cluster-label text') ?? g;
      clusters.push({
        id: `subgraph-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: sg.title,
        insertAt: sg.title || !sg.idRange ? undefined : { at: sg.idRange.to, prefix: ' [', suffix: ']' },
        ref: { kind: 'subgraph', id: sg.id },
      });
    });

    const mapped = [...nodes, ...edges, ...clusters];
    return [...mapped, ...genericTargets(svg, source, mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]))];
  },

  inspect(source, ref): PropertyField[] {
    const doc = parseFlowchart(source);
    if (!ref) {
      return [
        { id: 'direction', label: '向き', type: 'select', value: getDirection(source).replace('TD', 'TB'), options: DIRECTIONS },
        { id: 'title', label: '題名', type: 'text', value: frontmatterTitle(source), placeholder: '（なし）' },
      ];
    }
    if (ref.kind === 'node') {
      const label = labelRange(doc, ref.id);
      const shape = shapeValue(source, ref.id);
      const groups = [{ value: '', label: '（なし）' }, ...doc.subgraphs.map((s) => ({ value: s.id, label: s.id }))];
      const classes = [{ value: '', label: '（なし）' }, ...classNames(doc).map((c) => ({ value: c, label: c }))];
      const cls = classOf(doc, ref.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'label', label: 'ラベル', type: 'text', value: label ? source.slice(label.from, label.to) : ref.id },
        { id: 'shape', label: '形', type: 'select', value: shape, options: withValue(SHAPE_OPTIONS, shape) },
        {
          id: 'subgraph',
          label: 'サブグラフ',
          type: 'select',
          value: subgraphOf(doc, ref.id)?.id ?? '',
          options: groups,
          // サブグラフの中でエッジの一部として書かれていると、行を移せない
          readonly: !canMoveNode(source, ref.id),
        },
        { id: 'class', label: 'クラス', type: 'select', value: cls, options: withValue(classes, cls) },
        ...styleFields(doc, ref.id),
      ];
    }
    if (ref.kind === 'edge') {
      const info = edgeInfo(source, Number(ref.id));
      if (!info) return [];
      const parts = arrowParts(info.arrow);
      const kind = parts?.kind ?? info.arrow;
      const ends = endpointOptions(doc);
      return [
        { id: 'from', label: '元', type: 'select', value: info.from, options: ends },
        { id: 'to', label: '先', type: 'select', value: info.to, options: ends },
        { id: 'label', label: 'ラベル', type: 'text', value: info.label, placeholder: '（なし）' },
        { id: 'arrow', label: '線の種類', type: 'select', value: kind, options: withValue(EDGE_ARROWS, kind) },
        { id: 'length', label: '長さ', type: 'select', value: String(parts?.length ?? 1), options: withValue(LENGTHS, String(parts?.length ?? 1)), readonly: !parts },
        { id: 'stroke', label: '線の色', type: 'text', value: linkStyleProp(doc, info.index, 'stroke'), placeholder: '例: #ff0000' },
        { id: 'stroke-width', label: '線の太さ', type: 'text', value: linkStyleProp(doc, info.index, 'stroke-width'), placeholder: '例: 3px' },
      ];
    }
    if (ref.kind === 'subgraph') {
      const sg = findSubgraph(doc, ref.id);
      if (!sg) return [];
      return [
        { id: 'id', label: 'ID', type: 'text', value: sg.id, commitOnBlur: true, readonly: !sg.idRange },
        { id: 'title', label: '題名', type: 'text', value: sg.title ? source.slice(sg.title.from, sg.title.to) : '', placeholder: sg.id },
        { id: 'direction', label: '中の向き', type: 'select', value: sg.direction?.value ?? '', options: [{ value: '', label: '（図と同じ）' }, ...DIRECTIONS] },
        ...styleFields(doc, sg.id),
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    const doc = parseFlowchart(source);
    if (!ref) {
      if (field === 'direction') return setDirection(source, value);
      if (field === 'title') return setFrontmatterTitle(source, value);
      return null;
    }
    if (ref.kind === 'node') {
      if (field === 'shape') return setShape(source, ref.id, value);
      if (field === 'id') return findSubgraph(doc, value) ? null : renameNode(source, ref.id, value);
      if (field === 'subgraph') return moveNodeTo(source, ref.id, value);
      if (field === 'class') return setClass(source, doc, ref.id, value);
      if (STYLE_FIELDS.some((f) => f.key === field)) return setStyleProp(source, doc, ref.id, field, value);
      if (field === 'label') {
        const r = labelRange(doc, ref.id);
        if (r) return { from: r.from, to: r.to, insert: value };
        const at = nodeLabelInsert(source, doc, ref.id);
        if (!at || value === '' || (at.prefix.includes('"') && value.includes('"'))) return null;
        return { from: at.at, insert: at.prefix + value + at.suffix };
      }
      return null;
    }
    if (ref.kind === 'edge') {
      const index = Number(ref.id);
      const info = edgeInfo(source, index);
      if (!info) return null;
      const parts = arrowParts(info.arrow);
      if (field === 'arrow') return setArrow(source, index, buildArrow(value, parts?.length ?? 1));
      if (field === 'length') return parts ? setArrow(source, index, buildArrow(parts.kind, Number(value))) : null;
      if (field === 'label') return setEdgeLabel(source, index, value);
      if (field === 'from') return reconnectEdge(source, index, { from: value, to: info.to });
      if (field === 'to') return reconnectEdge(source, index, { from: info.from, to: value });
      if (field === 'stroke' || field === 'stroke-width') return setLinkStyleProp(source, doc, index, field, value);
      return null;
    }
    if (ref.kind === 'subgraph') {
      if (field === 'id') return renameSubgraph(source, ref.id, value);
      if (field === 'title') return setSubgraphTitle(source, ref.id, value);
      if (field === 'direction') return setSubgraphDirection(source, ref.id, value);
      if (STYLE_FIELDS.some((f) => f.key === field)) return setStyleProp(source, doc, ref.id, field, value);
    }
    return null;
  },

  tables: [CLASS_DEF_TABLE],

  actions: [
    {
      id: 'add-node',
      title: '＋ ノード',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'N');
        const { after, indent } = topLevelEnd(source, DEFAULT_INDENT);
        return { ...addLine(source, after, indent, `${id}[${NEW_LABEL}]`, id), label: `ノード ${id} を追加` };
      },
    },
    {
      id: 'add-subgraph',
      title: '＋ サブグラフ',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'G');
        const change = addSubgraph(source, id, NEW_GROUP);
        const selAfter = rangeInInserted(change, NEW_GROUP);
        return { change, label: `サブグラフ ${id} を追加`, selAfter, focus: { kind: 'subgraph', id } };
      },
    },
    {
      id: 'add-child',
      title: '＋ 次のノード',
      arity: 1,
      key: 'Tab',
      run(source, [from]) {
        const id = uniqueId(source, 'N');
        const line = lastLineOf(source, from.id);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source, DEFAULT_INDENT);
        const res = addLine(source, after, indent, `${from.id} --> ${id}[${NEW_LABEL}]`, id);
        return { ...res, change: withLinkStyles(source, res.change), label: `ノード ${id} を ${from.id} の次に追加` };
      },
    },
    {
      id: 'add-inside',
      title: '＋ 中にノード',
      arity: 1,
      appliesTo: ['subgraph'],
      key: 'Tab',
      run(source, [ref]) {
        const doc = parseFlowchart(source);
        const sg = findSubgraph(doc, ref.id);
        const id = uniqueId(source, 'N');
        const change = sg && insertIntoSubgraph(doc, sg, `${id}[${NEW_LABEL}]`);
        if (!change) return null;
        return { change, label: `ノード ${id} を ${ref.id} に追加`, selAfter: rangeInInserted(change, NEW_LABEL), focus: { kind: 'node', id } };
      },
    },
    {
      id: 'connect',
      title: '→ 接続',
      arity: 2,
      appliesTo: ['node', 'subgraph'],
      prompt: '接続先のノード（またはサブグラフ）をクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        // サブグラフの中に書くと、接続先のノードがそのサブグラフに入ってしまうので、外の行の後ろか図の最後に書く
        const doc = parseFlowchart(source);
        const line = lastLineOf(source, from.id);
        const { after, indent } =
          line && isTopLevel(doc, line) ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source, DEFAULT_INDENT);
        const res = addLine(source, after, indent, `${from.id} --> ${to.id}`, null);
        return { ...res, change: withLinkStyles(source, res.change), label: `${from.id} → ${to.id} を接続` };
      },
    },
    {
      id: 'insert-node',
      title: '＋ 間にノード',
      arity: 1,
      appliesTo: ['edge'],
      run(source, [ref]) {
        const id = uniqueId(source, 'N');
        const node = `${id}[${NEW_LABEL}]`;
        const change = insertNodeOnEdge(source, Number(ref.id), node);
        if (!change) return null;
        return {
          change: withLinkStyles(source, change),
          label: `エッジの間にノード ${id} を追加`,
          selAfter: rangeInInserted(change, NEW_LABEL),
          focus: { kind: 'node', id },
        };
      },
    },
    {
      id: 'reverse',
      title: '⇄ 向きを反転',
      arity: 1,
      appliesTo: ['edge'],
      menuOnly: true,
      run(source, [ref]) {
        const info = edgeInfo(source, Number(ref.id));
        const change = info && reconnectEdge(source, info.index, { from: info.to, to: info.from });
        return change && info && { change, label: `${info.from} → ${info.to} の向きを反転` };
      },
    },
    {
      id: 'group',
      title: 'サブグラフにまとめる',
      arity: 1,
      menuOnly: true,
      run(source, [ref]) {
        const id = uniqueId(source, 'G');
        const change = groupNode(source, ref.id, id, NEW_GROUP);
        if (!change) return null;
        return { change, label: `ノード ${ref.id} をサブグラフ ${id} にまとめる`, selAfter: rangeInInserted(change, NEW_GROUP), focus: { kind: 'subgraph', id } };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['node', 'edge'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'node') {
          const change = deleteNode(source, ref.id);
          return change && { change: withLinkStyles(source, change), label: `ノード ${ref.id} を削除` };
        }
        const info = edgeInfo(source, Number(ref.id));
        const change = deleteEdge(source, Number(ref.id));
        return change && info && { change: withLinkStyles(source, change), label: `${info.from} → ${info.to} のエッジを削除` };
      },
    },
    {
      id: 'unwrap',
      title: '枠を外す',
      arity: 1,
      appliesTo: ['subgraph'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const change = unwrapSubgraph(source, ref.id);
        return change && { change, label: `サブグラフ ${ref.id} の枠を外す` };
      },
    },
    {
      id: 'delete-subgraph',
      title: '中身ごと削除',
      arity: 1,
      appliesTo: ['subgraph'],
      danger: true,
      menuOnly: true,
      run(source, [ref]) {
        const change = deleteSubgraph(source, ref.id);
        return change && { change: withLinkStyles(source, change), label: `サブグラフ ${ref.id} を中身ごと削除` };
      },
    },
  ],
};
