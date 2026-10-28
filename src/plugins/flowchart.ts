import { withValue, type DiagramPlugin, type DiagramTarget, type PropertyField, type SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, lastParse, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { ARROWS, isInside, META_SHAPES, nodeDefinition, nodeRefs, parseFlowchart, SHAPE_CHOICES, subgraphOf, type FlowDoc } from './flowchartSyntax';
import {
  arrowParts,
  buildArrow,
  deleteEdge,
  deleteNode,
  edgeInfo,
  getDirection,
  insertNodeOnEdge,
  nodeWithShape,
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
import { addHitArea, edgeLabels, idFromSvg, matchInOrder } from './svg';
import { topLevelEnd } from './lineOps';
import { regexParser, type TableDef } from './table';
import { t } from '../i18n';

// flowchart / graph のプラグイン（設計書 §7.3 Phase 1）。
// ノードは SVG の id（…-flowchart-<ノード ID>-<連番>）、エッジは data-id（L_<元>_<先>_<連番>）の端点、
// サブグラフは g.cluster の id（…-<サブグラフ ID>）でソースに対応付ける。

const NEW_LABEL = t('fc.newNode');
const NEW_GROUP = t('fc.newGroup');
const DEFAULT_INDENT = '    ';

/** ノード定義の行ではない行（スタイル指定など） */
const NON_STATEMENT = /^\s*(classDef|class|style|linkStyle|click|subgraph|direction)\b/;

const DIRECTIONS = [
  { value: 'TB', label: t('fc.dir.TB') },
  { value: 'BT', label: t('fc.dir.BT') },
  { value: 'LR', label: t('fc.dir.LR') },
  { value: 'RL', label: t('fc.dir.RL') },
];

export const EDGE_ARROWS = [...ARROWS, { value: '~~~', label: t('fc.arrow.invisible') }];
const LENGTHS = [1, 2, 3, 4].map((n) => ({ value: String(n), label: n === 1 ? t('fc.length.normal') : t('fc.length.n', { n: String(n) }) }));

export const SHAPE_OPTIONS = [
  ...SHAPE_CHOICES.map((s) => ({ value: s.name, label: s.label })),
  ...META_SHAPES.map((s) => ({ value: `@${s.name}`, label: t('fc.shape.metaOption', { label: s.label, name: s.name }) })),
];

/** ノード・サブグラフの見た目（style 行のキー） */
const STYLE_FIELDS = [
  { key: 'fill', label: t('fc.style.fill') },
  { key: 'stroke', label: t('fc.style.stroke') },
  { key: 'color', label: t('fc.style.color') },
];

/** SVG のノードの id（…-<prefix>-<ID>-<連番>）からノードの ID を取り出す */
export const nodeIdFromSvg = (el: Element, prefix = 'flowchart') => idFromSvg(el, prefix);

/** ノード id のラベルのソース上の範囲。複数回定義されていれば、mermaid と同じく最後の定義を使う */
export function findNodeLabel(source: string, id: string): SourceRange | null {
  return labelRange(parseFlowchart(source), id);
}

/** 読み取り済みの文書から、ノードのラベルの範囲を求める */
function labelRange(doc: FlowDoc, id: string): SourceRange | null {
  const conn = doc.connectors.find((c) => c.id === id);
  if (conn) return conn.label;
  const def = nodeDefinition(doc, id);
  if (def?.shape) return { from: def.shape.labelFrom, to: def.shape.labelTo };
  return def?.meta?.label ?? null;
}

/** ラベルの無いノードに、ラベルを差し込める位置 */
function nodeLabelInsert(source: string, doc: FlowDoc, id: string): DiagramTarget['insertAt'] {
  // agentflow の connector は、宣言の行に題名を付ける（線の行に付けると、ふつうのノードになる）
  const conn = doc.connectors.find((c) => c.id === id);
  if (conn) return conn.label ? undefined : { at: conn.idRange.to, prefix: '["', suffix: '"]' };
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
  return [...ids].map((id) => ({ value: id, label: findSubgraph(doc, id) ? t('fc.endpoint.subgraph', { id }) : id }));
}

const styleFields = (doc: FlowDoc, id: string): PropertyField[] =>
  STYLE_FIELDS.map((f) => ({ id: f.key, label: f.label, type: 'color', value: styleProp(doc, id, f.key), placeholder: t('fc.ph.fill') }));

const CLASS_DEF_TABLE: TableDef = {
  id: 'classDef',
  title: t('fc.class'),
  secondary: true,
  schemas: [
    {
      kind: 'classDef',
      title: t('fc.class'),
      fields: [
        { name: 'name', label: t('fc.classDef.name'), type: 'text' },
        { name: 'props', label: t('fc.classDef.props'), type: 'text', width: 3 },
      ],
      parse: regexParser(/^classDef\s+(?<name>\S+)\s+(?<props>.*?)\s*;?$/d),
      format: (v) => `classDef ${v.name} ${v.props}`,
      defaults: { name: 'newClass', props: 'fill:#fff4c2,stroke:#d4a017' },
    },
  ],
};

/** フローチャートと同じ書き方の図種（agentflow）の違い */
export interface FlowVariant {
  /** mermaid.parse が返す diagramType */
  type: string;
  /** SVG のノードの id（…-<prefix>-<ID>-<連番>）の prefix */
  nodePrefix: string;
  /** 選べる形 */
  shapes: { value: string; label: string }[];
  /** 選べる矢印 */
  arrows: { value: string; label: string }[];
}

/** フローチャートのプラグイン。書き方が同じ図種（agentflow）は、形と矢印の選択肢を変えて使う */
export const flowPlugin = (v: FlowVariant): DiagramPlugin => ({
  type: v.type,

  mapTargets(svg, source) {
    const doc = parseFlowchart(source);
    const nodes: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const id = nodeIdFromSvg(g, v.nodePrefix);
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
        { id: 'direction', label: t('fc.prop.direction'), type: 'select', value: getDirection(source).replace('TD', 'TB'), options: DIRECTIONS },
        { id: 'title', label: t('fc.prop.title'), type: 'text', value: frontmatterTitle(source), placeholder: t('fc.none') },
      ];
    }
    if (ref.kind === 'node') {
      const label = labelRange(doc, ref.id);
      // agentflow の connector は、形も所属も持たない（宣言の行の ID と題名だけ）
      if (doc.connectors.some((c) => c.id === ref.id)) {
        return [
          { id: 'id', label: 'ID', type: 'text', value: ref.id, commitOnBlur: true },
          { id: 'label', label: t('fc.prop.label'), type: 'text', value: label ? source.slice(label.from, label.to) : '', placeholder: ref.id },
        ];
      }
      const shape = shapeValue(source, ref.id);
      const groups = [{ value: '', label: t('fc.none') }, ...doc.subgraphs.map((s) => ({ value: s.id, label: s.id }))];
      const classes = [{ value: '', label: t('fc.none') }, ...classNames(doc).map((c) => ({ value: c, label: c }))];
      const cls = classOf(doc, ref.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'label', label: t('fc.prop.label'), type: 'text', value: label ? source.slice(label.from, label.to) : ref.id },
        { id: 'shape', label: t('fc.prop.shape'), type: 'shape', value: shape, options: withValue(v.shapes, shape) },
        {
          id: 'subgraph',
          label: t('fc.prop.subgraph'),
          type: 'select',
          value: subgraphOf(doc, ref.id)?.id ?? '',
          options: groups,
          // サブグラフの中でエッジの一部として書かれていると、行を移せない
          readonly: !canMoveNode(source, ref.id),
        },
        { id: 'class', label: t('fc.class'), type: 'select', value: cls, options: withValue(classes, cls) },
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
        { id: 'from', label: t('fc.prop.from'), type: 'select', value: info.from, options: ends },
        { id: 'to', label: t('fc.prop.to'), type: 'select', value: info.to, options: ends },
        { id: 'label', label: t('fc.prop.label'), type: 'text', value: info.label, placeholder: t('fc.none') },
        { id: 'arrow', label: t('fc.prop.arrow'), type: 'select', value: kind, options: withValue(v.arrows, kind) },
        { id: 'length', label: t('fc.prop.length'), type: 'select', value: String(parts?.length ?? 1), options: withValue(LENGTHS, String(parts?.length ?? 1)), readonly: !parts },
        { id: 'stroke', label: t('fc.prop.stroke'), type: 'text', value: linkStyleProp(doc, info.index, 'stroke'), placeholder: t('fc.ph.stroke') },
        { id: 'stroke-width', label: t('fc.prop.strokeWidth'), type: 'text', value: linkStyleProp(doc, info.index, 'stroke-width'), placeholder: t('fc.ph.strokeWidth') },
      ];
    }
    if (ref.kind === 'subgraph') {
      const sg = findSubgraph(doc, ref.id);
      if (!sg) return [];
      return [
        { id: 'id', label: 'ID', type: 'text', value: sg.id, commitOnBlur: true, readonly: !sg.idRange },
        { id: 'title', label: t('fc.prop.title'), type: 'text', value: sg.title ? source.slice(sg.title.from, sg.title.to) : '', placeholder: sg.id },
        { id: 'direction', label: t('fc.prop.innerDirection'), type: 'select', value: sg.direction?.value ?? '', options: [{ value: '', label: t('fc.sameAsDiagram') }, ...DIRECTIONS] },
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
      // connector で変えられるのは ID と題名だけ（題名は引用符の中なので " は書けない）
      const isConnector = doc.connectors.some((c) => c.id === ref.id);
      if (isConnector && (field !== 'id' && field !== 'label' || value.includes('"'))) return null;
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
      title: t('fc.action.addNode'),
      arity: 0,
      shapes: v.shapes,
      run(source, _refs, shape = 'rect') {
        const id = uniqueId(source, 'N');
        const node = nodeWithShape(id, NEW_LABEL, shape);
        if (!node) return null;
        const { after, indent } = topLevelEnd(source, DEFAULT_INDENT);
        return { ...addLine(source, after, indent, node, id), label: t('fc.history.addNode', { id }) };
      },
    },
    {
      id: 'add-subgraph',
      title: t('fc.action.addSubgraph'),
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'G');
        const change = addSubgraph(source, id, NEW_GROUP);
        const selAfter = rangeInInserted(change, NEW_GROUP);
        return { change, label: t('fc.history.addSubgraph', { id }), selAfter, focus: { kind: 'subgraph', id } };
      },
    },
    {
      id: 'add-child',
      title: t('fc.action.addChild'),
      arity: 1,
      key: 'Tab',
      shapes: v.shapes,
      run(source, [from], shape = 'rect') {
        const id = uniqueId(source, 'N');
        const node = nodeWithShape(id, NEW_LABEL, shape);
        if (!node) return null;
        const line = lastLineOf(source, from.id);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source, DEFAULT_INDENT);
        const res = addLine(source, after, indent, `${from.id} --> ${node}`, id);
        return { ...res, change: withLinkStyles(source, res.change), label: t('fc.history.addChild', { id, from: from.id }) };
      },
    },
    {
      id: 'add-inside',
      title: t('fc.action.addInside'),
      arity: 1,
      appliesTo: ['subgraph'],
      key: 'Tab',
      shapes: v.shapes,
      run(source, [ref], shape = 'rect') {
        const doc = parseFlowchart(source);
        const sg = findSubgraph(doc, ref.id);
        const id = uniqueId(source, 'N');
        const node = nodeWithShape(id, NEW_LABEL, shape);
        const change = sg && node && insertIntoSubgraph(doc, sg, node);
        if (!change) return null;
        return { change, label: t('fc.history.addInside', { id, sg: ref.id }), selAfter: rangeInInserted(change, NEW_LABEL), focus: { kind: 'node', id } };
      },
    },
    {
      id: 'connect',
      title: t('fc.action.connect'),
      arity: 2,
      appliesTo: ['node', 'subgraph'],
      prompt: t('fc.action.connectPrompt'),
      run(source, [from, to]) {
        // サブグラフの中に書くと、接続先のノードがそのサブグラフに入ってしまうので、外の行の後ろか図の最後に書く
        const doc = parseFlowchart(source);
        const line = lastLineOf(source, from.id);
        const { after, indent } =
          line && isTopLevel(doc, line) ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source, DEFAULT_INDENT);
        const res = addLine(source, after, indent, `${from.id} --> ${to.id}`, null);
        return { ...res, change: withLinkStyles(source, res.change), label: t('fc.history.connect', { from: from.id, to: to.id }) };
      },
    },
    {
      id: 'insert-node',
      title: t('fc.action.insertNode'),
      arity: 1,
      appliesTo: ['edge'],
      shapes: v.shapes,
      run(source, [ref], shape = 'rect') {
        const id = uniqueId(source, 'N');
        const node = nodeWithShape(id, NEW_LABEL, shape);
        const change = node && insertNodeOnEdge(source, Number(ref.id), node);
        if (!change) return null;
        return {
          change: withLinkStyles(source, change),
          label: t('fc.history.insertNode', { id }),
          selAfter: rangeInInserted(change, NEW_LABEL),
          focus: { kind: 'node', id },
        };
      },
    },
    {
      id: 'reverse',
      title: t('fc.action.reverse'),
      arity: 1,
      appliesTo: ['edge'],
      menuOnly: true,
      run(source, [ref]) {
        const info = edgeInfo(source, Number(ref.id));
        const change = info && reconnectEdge(source, info.index, { from: info.to, to: info.from });
        return change && info && { change, label: t('fc.history.reverse', { from: info.from, to: info.to }) };
      },
    },
    {
      id: 'group',
      title: t('fc.action.group'),
      arity: 1,
      menuOnly: true,
      run(source, [ref]) {
        const id = uniqueId(source, 'G');
        const change = groupNode(source, ref.id, id, NEW_GROUP);
        if (!change) return null;
        return { change, label: t('fc.history.group', { node: ref.id, id }), selAfter: rangeInInserted(change, NEW_GROUP), focus: { kind: 'subgraph', id } };
      },
    },
    {
      id: 'delete',
      title: t('fc.action.delete'),
      arity: 1,
      appliesTo: ['node', 'edge'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'node') {
          const change = deleteNode(source, ref.id);
          return change && { change: withLinkStyles(source, change), label: t('fc.history.deleteNode', { id: ref.id }) };
        }
        const info = edgeInfo(source, Number(ref.id));
        const change = deleteEdge(source, Number(ref.id));
        return change && info && { change: withLinkStyles(source, change), label: t('fc.history.deleteEdge', { from: info.from, to: info.to }) };
      },
    },
    {
      id: 'unwrap',
      title: t('fc.action.unwrap'),
      arity: 1,
      appliesTo: ['subgraph'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const change = unwrapSubgraph(source, ref.id);
        return change && { change, label: t('fc.history.unwrap', { id: ref.id }) };
      },
    },
    {
      id: 'delete-subgraph',
      title: t('fc.action.deleteSubgraph'),
      arity: 1,
      appliesTo: ['subgraph'],
      danger: true,
      menuOnly: true,
      run(source, [ref]) {
        const change = deleteSubgraph(source, ref.id);
        return change && { change: withLinkStyles(source, change), label: t('fc.history.deleteSubgraph', { id: ref.id }) };
      },
    },
  ],

  // ドラッグ: ノードをサブグラフ（swimlane のレーン・agentflow の flow）の中へ、または外へ移す。
  // 位置は自動レイアウトのままなので、前後の並べ替えはしない（設計書 §6.3）
  reorder: {
    axis: (source, ref) =>
      ref.kind === 'node' && !parseFlowchart(source).connectors.some((c) => c.id === ref.id) && canMoveNode(source, ref.id) ? 'xy' : null,
    // 図の一番外へは、サブグラフの中にあるノードだけ（外にあるノードは、外へ動かしても変わらない）
    acceptsInto: (source, ref, container) =>
      ref.kind === 'node' && (container === null ? !!subgraphOf(parseFlowchartOnce(source), ref.id) : container.kind === 'subgraph'),
    into(source, ref, container) {
      const change = moveNodeTo(source, ref.id, container?.id ?? '');
      if (!change) return null;
      const label = container ? t('fc.history.moveInto', { node: ref.id, id: container.id }) : t('fc.history.moveOut', { node: ref.id });
      return { change, label, select: ref };
    },
  },
});

const parseFlowchartOnce = lastParse(parseFlowchart);

export const flowchartPlugin = flowPlugin({ type: 'flowchart-v2', nodePrefix: 'flowchart', shapes: SHAPE_OPTIONS, arrows: EDGE_ARROWS });
