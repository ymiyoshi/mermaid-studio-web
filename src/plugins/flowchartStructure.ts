import { isInside, nodeDefinition, nodeRefs, parseFlowchart, subgraphOf, type FlowDoc, type Subgraph } from './flowchartSyntax';
import { innerIndent } from './flowchartSubgraph';
import { withLinkStyles } from './flowchartOps';
import { topLevelEnd } from './lineOps';
import { insertLineAfter, lastParse, tokenRegex } from './source';
import type { ActionResult, DuplicateSpec, ElementRef, StructureSpec } from './types';
import { t } from '../i18n';

// フローチャート（swimlane・agentflow・flowchart-elk も）の構造（設計書 §17.2）。
// 親はノードが所属するサブグラフ（mermaid と同じく、内側のサブグラフが先に取る）、線はエッジ。

/** サブグラフを囲む、一番内側のサブグラフ */
export function enclosingSubgraph(doc: FlowDoc, sg: Subgraph): Subgraph | null {
  let best: Subgraph | null = null;
  for (const o of doc.subgraphs) if (o !== sg && isInside(o, sg.line) && (!best || o.line.index > best.line.index)) best = o;
  return best;
}

/** 文書に出てくるノードの ID（出てくる順。サブグラフの ID は除く） */
export function nodeIds(doc: FlowDoc): string[] {
  const sgs = new Set(doc.subgraphs.map((s) => s.id));
  const seen = new Set<string>();
  for (const c of doc.connectors) seen.add(c.id);
  for (const st of doc.statements) for (const g of st.groups) for (const r of g) if (!sgs.has(r.id)) seen.add(r.id);
  return [...seen];
}

/** エッジの端（サブグラフへのエッジもある） */
const endRef = (doc: FlowDoc, id: string): ElementRef => ({ kind: doc.subgraphs.some((s) => s.id === id) ? 'subgraph' : 'node', id });

// 一覧は要素ごとに parent を呼ぶので、同じソースを読み直さない（読んだ結果は書き換えない）
const parseOnce = lastParse(parseFlowchart);

export const flowStructure: StructureSpec = {
  parent(source, ref) {
    const doc = parseOnce(source);
    if (ref.kind === 'node') {
      const sg = subgraphOf(doc, ref.id);
      return sg ? { kind: 'subgraph', id: sg.id } : null;
    }
    if (ref.kind === 'subgraph') {
      const sg = doc.subgraphs.find((s) => s.id === ref.id);
      const outer = sg && enclosingSubgraph(doc, sg);
      return outer ? { kind: 'subgraph', id: outer.id } : null;
    }
    return null;
  },
  children(source, ref) {
    if (ref.kind !== 'subgraph') return [];
    const doc = parseOnce(source);
    const sg = doc.subgraphs.find((s) => s.id === ref.id);
    if (!sg) return [];
    // ソースの順（ノードは最初に出てくる行、サブグラフは subgraph の行）に並べる
    const subs = doc.subgraphs.filter((s) => enclosingSubgraph(doc, s) === sg).map((s) => ({ at: s.line.index, ref: { kind: 'subgraph', id: s.id } }));
    const nodes = nodeIds(doc)
      .filter((id) => subgraphOf(doc, id) === sg)
      .map((id) => ({ at: nodeRefs(doc, id)[0]?.statement.line.index ?? Infinity, ref: { kind: 'node', id } }));
    return [...nodes, ...subs].sort((a, b) => a.at - b.at).map((x) => x.ref);
  },
  links(source) {
    const doc = parseOnce(source);
    return doc.edges.map((e) => ({ edge: { kind: 'edge', id: String(e.index) }, from: endRef(doc, e.from), to: endRef(doc, e.to) }));
  },
};

// ---- 複製（設計書 §17.3） ----

const STEP = '    ';

/** ID の末尾の数字を外した名前に、まだ使っていない連番を付ける（A → A1、N3 → N4 など） */
function freshId(base: string, taken: Set<string>, source: string): string {
  const stem = base.replace(/\d+$/, '') || base;
  for (let k = 1; ; k++) {
    const id = `${stem}${k}`;
    if (!taken.has(id) && !tokenRegex(id).test(source)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * ノードとサブグラフ（中身ごと）を複製する。ID は振り直し、複製するものどうしをつなぐエッジ・style・class の指定も複製する。
 * 複製は、選んだ要素がみな同じサブグラフにあればその最後、そうでなければ図の最後に足す
 */
export function duplicateFlow(source: string, refs: ElementRef[]): ActionResult | null {
  const doc = parseFlowchart(source);
  const connectors = new Set(doc.connectors.map((c) => c.id));
  const pickedSgs = refs.flatMap((r) => (r.kind === 'subgraph' ? (doc.subgraphs.find((s) => s.id === r.id) ?? []) : []));
  const pickedNodes = new Set(refs.filter((r) => r.kind === 'node' && !connectors.has(r.id)).map((r) => r.id));
  // 選んだサブグラフの中の（入れ子も含む）サブグラフも複製する
  const sgs = new Set<Subgraph>();
  const addSg = (sg: Subgraph) => {
    if (sgs.has(sg) || !sg.end) return;
    sgs.add(sg);
    doc.subgraphs.filter((s) => enclosingSubgraph(doc, s) === sg).forEach(addSg);
  };
  pickedSgs.forEach(addSg);
  const ids = nodeIds(doc).filter((id) => !connectors.has(id) && (pickedNodes.has(id) || (subgraphOf(doc, id) && sgs.has(subgraphOf(doc, id)!))));
  if (ids.length === 0 && sgs.size === 0) return null;

  const taken = new Set<string>();
  const rename = new Map<string, string>();
  for (const id of ids) rename.set(id, freshId(id, taken, source));
  for (const sg of sgs) rename.set(sg.id, sg.idRange ? freshId(sg.id, taken, source) : freshId('G', taken, source));
  const nodeLine = (id: string) => {
    const def = nodeDefinition(doc, id);
    const to = rename.get(id)!;
    return def ? to + source.slice(def.idTo, def.to) : `${to}["${id}"]`;
  };
  const sgHead = (sg: Subgraph) => {
    const id = rename.get(sg.id)!;
    const title = sg.title ? source.slice(sg.title.from, sg.title.to) : null;
    if (doc.container === 'flow') return `flow ${id}${title !== null ? `["${title.replace(/"/g, '')}"]` : ''}`;
    return `subgraph ${id}${title !== null ? ` [${title}]` : ''}`;
  };
  // 枠の外側から順に、中のノード・枠を字下げして書く
  const emit = (sg: Subgraph | null, indent: string): string[] => {
    const inner = sg ? ids.filter((id) => subgraphOf(doc, id) === sg) : ids.filter((id) => !sgs.has(subgraphOf(doc, id)!));
    const subs = sg ? doc.subgraphs.filter((s) => sgs.has(s) && enclosingSubgraph(doc, s) === sg) : [...sgs].filter((s) => !sgs.has(enclosingSubgraph(doc, s)!));
    const out = inner.map((id) => indent + nodeLine(id));
    for (const s of subs) {
      out.push(indent + sgHead(s));
      if (s.direction) out.push(`${indent}${STEP}direction ${s.direction.value}`);
      out.push(...emit(s, indent + STEP), `${indent}end`);
    }
    return out;
  };
  const rn = (id: string) => rename.get(id);
  const edges = doc.edges
    .filter((e) => rn(e.from) && rn(e.to))
    .map((e) => {
      const l = e.statement.links[e.link];
      return `${rn(e.from)} ${source.slice(l.from, l.to).trim()} ${rn(e.to)}`;
    });
  const styles = doc.styles.filter((s) => rn(s.id.value)).map((s) => `style ${rn(s.id.value)} ${s.props.value}`);
  const classes = doc.classes.flatMap((c) => {
    const picked = c.ids.flatMap((x) => rn(x.value.trim()) ?? []);
    return picked.length ? [`class ${picked.join(',')} ${c.name.value}`] : [];
  });

  // 足す場所: 選んだ要素の親がみな同じサブグラフなら、その中
  const parents = refs.map((r) => flowStructure.parent(source, r)?.id ?? null);
  const home = parents.every((p) => p === parents[0]) && parents[0] !== null ? (doc.subgraphs.find((s) => s.id === parents[0]) ?? null) : null;
  let change: { from: number; insert: string };
  if (home?.end) {
    const indent = innerIndent(doc, home);
    const lines = [...emit(null, indent), ...[...edges, ...styles, ...classes].map((l) => indent + l)];
    change = { from: home.end.from, insert: lines.join('\n') + '\n' };
  } else {
    const { after, indent } = topLevelEnd(source, STEP);
    const lines = [...emit(null, indent), ...[...edges, ...styles, ...classes].map((l) => indent + l)];
    change = insertLineAfter(source, after, lines.join('\n'));
  }
  const first = ids[0] !== undefined && !sgs.has(subgraphOf(doc, ids[0])!) ? { kind: 'node', id: rn(ids[0])! } : null;
  const firstSg = [...sgs].find((s) => !sgs.has(enclosingSubgraph(doc, s)!));
  const select = first ?? (firstSg ? { kind: 'subgraph', id: rn(firstSg.id)! } : undefined);
  return { change: withLinkStyles(source, change), label: t('dup.history', { n: String(refs.length) }), select };
}

export const flowDuplicate: DuplicateSpec = {
  accepts: (ref) => ref.kind === 'node' || ref.kind === 'subgraph',
  run: duplicateFlow,
};
