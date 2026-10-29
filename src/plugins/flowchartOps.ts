import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import {
  nodeDefinition,
  nodeRefs,
  parseFlowchart,
  SHAPE_CHOICES,
  CLASSIC_TO_META,
  META_SHAPES,
  metaShapeValue,
  shapeName,
  type FlowDoc,
  type Link,
  type NodeRef,
  type Statement,
  type FlowEdge,
  isDefinition,
  statementText,
  VALID_ID,
} from './flowchartSyntax';
import { applySpec, indentOf, tokenRegex, bodyLines } from './source';
import { removeLine } from './lineOps';

// flowchart の削除・形・矢印・方向の変更。変わるのは対象の文だけで、他の行には触れない（§6.2）。

interface Part {
  groups: NodeRef[][];
  links: Link[];
}

function groupText(source: string, g: NodeRef[], original: NodeRef[]): string {
  if (g.length === original.length) return source.slice(g[0].from, g[g.length - 1].to);
  return g.map((r) => source.slice(r.from, r.to)).join(' & ');
}

/** 文の外でもノードが参照されているか */
function referencedElsewhere(doc: FlowDoc, id: string, st: Statement): boolean {
  return nodeRefs(doc, id).some((x) => x.statement !== st);
}

/** 部分（リンクでつながったノードの並び）を文の文字列にする。残す必要が無ければ null */
function partText(source: string, doc: FlowDoc, st: Statement, part: Part, originals: NodeRef[][]): string | null {
  if (part.links.length === 0) {
    // ノードだけが残った: 形の定義があるか、他に出てこないノードだけを残す
    const keep = part.groups[0].filter((r) => isDefinition(r) || !referencedElsewhere(doc, r.id, st));
    if (keep.length === 0) return null;
    return keep.map((r) => source.slice(r.from, r.to)).join(' & ');
  }
  let out = groupText(source, part.groups[0], originals[0]);
  part.links.forEach((l, i) => {
    out += ' ' + source.slice(l.from, l.to) + ' ' + groupText(source, part.groups[i + 1], originals[i + 1]);
  });
  return out;
}

/** 文を書き換える変更。parts が空なら文を（行ごと）消す */
function replaceStatement(source: string, st: Statement, texts: string[]): ChangeSpec {
  const wholeLine = statementText(st.line.text) === source.slice(st.from, st.to).trim();
  if (texts.length === 0 && wholeLine) return removeLine(source, st.line);
  if (texts.length === 0) {
    // ; で区切った文の 1 つを消すときは、区切りも一緒に消す（残すと「; C --> D」や「;;」になる）。
    // 後ろに区切りがあれば後ろの区切りまで、最後の文なら前の区切りから
    const after = /^\s*;[ \t]*/.exec(source.slice(st.to, st.line.to));
    if (after) return { from: st.from, to: st.to + after[0].length };
    const before = /;\s*$/.exec(source.slice(st.line.from, st.from));
    if (before) return { from: st.line.from + before.index, to: st.to };
  }
  const sep = wholeLine ? '\n' + indentOf(st.line.text) : '; ';
  return { from: st.from, to: st.to, insert: texts.join(sep) };
}

/** groups/links のうち、keepGroup が false のグループと、それにつながるリンクを取り除いて部分に分ける */
function split(st: Statement, groups: NodeRef[][], keepLink: (i: number) => boolean): Part[] {
  const parts: Part[] = [];
  let cur: Part | null = null;
  groups.forEach((g, i) => {
    if (g.length === 0) {
      if (cur) parts.push(cur);
      cur = null;
      return;
    }
    if (cur && i > 0 && keepLink(i - 1)) {
      cur.links.push(st.links[i - 1]);
      cur.groups.push(g);
    } else {
      if (cur) parts.push(cur);
      cur = { groups: [g], links: [] };
    }
  });
  if (cur) parts.push(cur);
  return parts;
}

/** スタイル指定の行（class / style / click）から id を取り除く */
function styleLineChanges(source: string, id: string): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  const token = tokenRegex(id);
  for (const line of bodyLines(source).body) {
    const remove = () => out.push(removeLine(source, line));
    const style = /^\s*(style|click)\s+(\S+)/.exec(line.text);
    if (style && style[2] === id) {
      remove();
      continue;
    }
    const cls = /^(\s*class\s+)([^\s]+)(\s+.*)$/.exec(line.text);
    if (cls && token.test(cls[2])) {
      const ids = cls[2].split(',').filter((x) => x !== id);
      if (ids.length === 0) remove();
      else out.push({ from: line.from + cls[1].length, to: line.from + cls[1].length + cls[2].length, insert: ids.join(',') });
    }
  }
  return out;
}

export function deleteNode(source: string, id: string): ChangeSpec[] | null {
  const doc = parseFlowchart(source);
  const statements = new Set(nodeRefs(doc, id).map((x) => x.statement));
  // agentflow の connector は、宣言の行も消す
  const conn = doc.connectors.find((c) => c.id === id);
  if (statements.size === 0 && !conn) return null;
  // 読めなかった行にも出てくるなら、中途半端に消さない
  if (doc.unknown.some((l) => tokenRegex(id).test(l.text))) return null;
  const changes: ChangeSpec[] = conn ? [removeLine(source, conn.line)] : [];
  for (const st of statements) {
    const groups = st.groups.map((g) => g.filter((r) => r.id !== id));
    const parts = split(st, groups, () => true);
    const texts = parts.map((p) => partText(source, doc, st, p, st.groups)).filter((x): x is string => x !== null);
    changes.push(replaceStatement(source, st, texts));
  }
  changes.push(...styleLineChanges(source, id));
  return changes;
}

export function deleteEdge(source: string, index: number): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge) return null;
  const st = edge.statement;
  const i = edge.link;
  if (st.groups[i].length === 1 && st.groups[i + 1].length === 1) {
    // 単純なリンク: そこで文を 2 つに分ける
    const parts = split(st, st.groups, (k) => k !== i);
    const texts = parts.map((p) => partText(source, doc, st, p, st.groups)).filter((x): x is string => x !== null);
    return replaceStatement(source, st, texts);
  }
  // & でまとめたリンク: その文のエッジを 1 本ずつの文に書き直す
  return rewriteEdges(source, doc, st, (e) => (e.index === index ? null : e));
}

/**
 * 文のエッジを 1 本ずつの文に書き直す。map が null を返したエッジは消し、端点を返したらその端点でつなぐ。
 * エッジの順番は変えないので、他のエッジの番号（linkStyle が指すもの）はずれない
 */
function rewriteEdges(source: string, doc: FlowDoc, st: Statement, map: (e: FlowEdge) => { from: string; to: string } | null): ChangeSpec {
  const seen = new Set<string>();
  // ノードの定義（形やラベル）は最初に出てくるところに 1 度だけ書く
  const nodeText = (e: FlowEdge, id: string) => {
    const r = st.groups[e.link].find((x) => x.id === id) ?? st.groups[e.link + 1].find((x) => x.id === id);
    if (!r || seen.has(id)) return id;
    seen.add(id);
    return source.slice(r.from, r.to);
  };
  const texts: string[] = [];
  for (const e of doc.edges.filter((x) => x.statement === st)) {
    const ends = map(e);
    if (!ends) continue;
    const l = st.links[e.link];
    texts.push(`${nodeText(e, ends.from)} ${source.slice(l.from, l.to)} ${nodeText(e, ends.to)}`);
  }
  // どのエッジにも残らなかったノードの定義は残す
  for (const g of st.groups) for (const r of g) if (!seen.has(r.id) && (isDefinition(r) || !referencedElsewhere(doc, r.id, st))) texts.push(source.slice(r.from, r.to));
  return replaceStatement(source, st, texts);
}

/** エッジの端点を変える（from / to のどちらか、または両方を入れ替える）。エッジの番号は変わらない */
export function reconnectEdge(source: string, index: number, ends: { from: string; to: string }): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge || !VALID_ID.test(ends.from) || !VALID_ID.test(ends.to)) return null;
  if (ends.from === edge.from && ends.to === edge.to) return null;
  const st = edge.statement;
  const i = edge.link;
  const a = st.groups[i];
  const b = st.groups[i + 1];
  const single = a.length === 1 && b.length === 1;
  // 向きを入れ替えるだけの 1 本の文（A --> B）: 両端の参照をそのまま入れ替える
  if (single && st.links.length === 1 && ends.from === edge.to && ends.to === edge.from) {
    return [
      { from: a[0].from, to: a[0].to, insert: source.slice(b[0].from, b[0].to) },
      { from: b[0].from, to: b[0].to, insert: source.slice(a[0].from, a[0].to) },
    ];
  }
  // 端の参照（形の定義が無く、他のリンクと共有していない）なら ID だけを書き換える
  const plainEnd = (g: NodeRef[], k: number) => g.length === 1 && !isDefinition(g[0]) && (k === 0 || k === st.groups.length - 1);
  if (single && (ends.from === edge.from || plainEnd(a, i)) && (ends.to === edge.to || plainEnd(b, i + 1))) {
    const out: ChangeSpec[] = [];
    if (ends.from !== edge.from) out.push({ from: a[0].from, to: a[0].idTo, insert: ends.from });
    if (ends.to !== edge.to) out.push({ from: b[0].from, to: b[0].idTo, insert: ends.to });
    return out;
  }
  return rewriteEdges(source, doc, st, (e) => (e.index === index ? ends : e));
}

/** エッジの間にノードを挟む（A --> B を A --> N[ラベル] --> B に） */
export function insertNodeOnEdge(source: string, index: number, node: string): { from: number; insert: string } | null {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge) return null;
  const l = edge.statement.links[edge.link];
  return { from: l.to, insert: ` ${node} ${l.arrow}` };
}

/**
 * ノードの形を変える。shape は括弧の形の名前か「@名前」（新しい書き方でしか書けない形）。
 * 新しい書き方（@{ … }）のノードは shape: の値だけを変え、括弧の形のノードは括弧だけを変える。
 * 括弧で書けない形を選んだときだけ、@{ shape: …, label: "…" } に書き直す
 */
/** 形を付けた新しいノードの書き方（形は setShape と同じ名前。読めない形なら null） */
export function nodeWithShape(id: string, label: string, shape: string): string | null {
  const choice = SHAPE_CHOICES.find((s) => s.name === shape);
  if (choice) return `${id}${choice.open}${label}${choice.close}`;
  const metaName = shape.startsWith('@') ? shape.slice(1) : null;
  if (!metaName || !META_SHAPES.some((m) => m.name === metaName)) return null;
  return `${id}@{ shape: ${metaName}, label: "${label.replace(/"/g, '#quot;')}" }`;
}

export function setShape(source: string, id: string, shape: string): ChangeSpec[] | null {
  const metaName = shape.startsWith('@') ? shape.slice(1) : CLASSIC_TO_META[shape];
  const choice = SHAPE_CHOICES.find((s) => s.name === shape);
  if (!metaName || (!choice && !META_SHAPES.some((m) => m.name === metaName))) return null;
  const doc = parseFlowchart(source);
  const def = nodeDefinition(doc, id);
  if (def?.meta) {
    const m = def.meta;
    if (m.shape) return [{ from: m.shape.from, to: m.shape.to, insert: metaName }];
    return [{ from: m.from + 2, insert: ` shape: ${metaName},` }];
  }
  if (!choice) {
    // 括弧の形から新しい書き方へ
    const label = def?.shape ? source.slice(def.shape.labelFrom, def.shape.labelTo) : id;
    const meta = `@{ shape: ${metaName}, label: "${label.replace(/"/g, '#quot;')}" }`;
    if (def?.shape) return [{ from: def.shape.from, to: def.shape.to, insert: meta }];
    const first = nodeRefs(doc, id)[0];
    return first ? [{ from: first.ref.idTo, insert: meta }] : null;
  }
  if (def?.shape) {
    const s = def.shape;
    return [
      { from: s.from, to: s.from + s.open.length, insert: choice.open },
      { from: s.to - s.close.length, to: s.to, insert: choice.close },
    ];
  }
  const first = nodeRefs(doc, id)[0];
  if (!first) return null;
  return [{ from: first.ref.idTo, insert: `${choice.open}${id}${choice.close}` }];
}

/** ノードの形の選択肢の値 */
export function shapeValue(source: string, id: string): string {
  const def = nodeDefinition(parseFlowchart(source), id);
  if (def?.meta) return def.meta.shape ? metaShapeValue(def.meta.shape.value) : 'rect';
  return def?.shape ? shapeName(def.shape) : 'rect';
}

// ---- 線の種類と長さ ----

const ARROW_PARTS = /^([<ox]?)(-+|=+|-\.+-|~+)([>ox]?)$/;

/** 矢印を、種類（長さ 1 のときの書き方）と長さに分ける。読めなければ null */
export function arrowParts(arrow: string): { kind: string; length: number } | null {
  const m = ARROW_PARTS.exec(arrow);
  if (!m) return null;
  const [, left, body, right] = m;
  const head = right !== '';
  let length: number;
  let base: string;
  if (body.startsWith('-.')) {
    length = body.length - 2;
    base = '-.-';
  } else if (body[0] === '~') {
    length = body.length - 2;
    base = '~~~';
  } else {
    length = body.length - (head ? 1 : 2);
    base = body[0].repeat(head ? 2 : 3);
  }
  if (length < 1) return null;
  return { kind: left + base + right, length };
}

/** 種類（長さ 1 の書き方）と長さから矢印を作る */
export function buildArrow(kind: string, length: number): string {
  const m = ARROW_PARTS.exec(kind);
  if (!m || length < 1) return kind;
  const [, left, body, right] = m;
  const extra = length - 1;
  if (body.startsWith('-.')) return `${left}-${'.'.repeat(1 + extra)}-${right}`;
  return `${left}${body}${body[0].repeat(extra)}${right}`;
}

export function setArrow(source: string, index: number, arrow: string): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge) return null;
  const l = edge.statement.links[edge.link];
  if (l.label?.style === 'inline') {
    return { from: l.from, to: l.to, insert: `${arrow}|${source.slice(l.label.from, l.label.to)}|` };
  }
  return { from: l.arrowFrom, to: l.arrowTo, insert: arrow };
}

export function setEdgeLabel(source: string, index: number, text: string): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge) return null;
  const l = edge.statement.links[edge.link];
  if (!l.label) return text === '' ? null : { from: l.arrowTo, insert: `|${text}|` };
  if (text === '') {
    return l.label.style === 'pipe' ? { from: l.arrowTo, to: l.to } : { from: l.from, to: l.to, insert: l.arrow };
  }
  return { from: l.label.from, to: l.label.to, insert: text };
}

export function edgeInfo(source: string, index: number) {
  const doc = parseFlowchart(source);
  const edge = doc.edges[index];
  if (!edge) return null;
  const l = edge.statement.links[edge.link];
  return { ...edge, arrow: l.arrow, label: l.label ? source.slice(l.label.from, l.label.to) : '', labelRange: l.label };
}

/**
 * エッジを足す・消す変更に、linkStyle の番号の付け直しを加える。
 * linkStyle はエッジを出てくる順の番号で指すので、途中に足したり消したりすると別のエッジを指してしまう
 * （範囲外の番号は構文エラーになる）。変更の前後のエッジを突き合わせて番号を直す。
 * 変更が触れていないエッジは矢印の位置で突き合わせる（同じ端点のエッジが並んでいても取り違えない）。
 * 書き換えた文の中のエッジは、端点で出てくる順に突き合わせる
 */
export function withLinkStyles(source: string, change: ChangeSpec): ChangeSpec {
  const doc = parseFlowchart(source);
  if (doc.linkStyles.length === 0) return change;
  const changes = ChangeSet.of(change, source.length);
  const next = parseFlowchart(applySpec(source, change)).edges;
  const arrowOf = (e: FlowEdge) => e.statement.links[e.link];
  // A & B --> C は 1 つの矢印に複数のエッジがあるので、端点も合わせて引く
  const key = (at: number, e: FlowEdge) => `${at} ${e.from} ${e.to}`;
  const byArrow = new Map(next.map((e) => [key(arrowOf(e).arrowFrom, e), e.index]));
  const map = new Map<number, number>();
  const used = new Set<number>();
  const touched: FlowEdge[] = [];
  for (const e of doc.edges) {
    const l = arrowOf(e);
    const k = changes.touchesRange(l.arrowFrom, l.arrowTo) ? undefined : byArrow.get(key(changes.mapPos(l.arrowFrom, 1), e));
    if (k === undefined) touched.push(e);
    else {
      map.set(e.index, k);
      used.add(k);
    }
  }
  let j = 0;
  for (const e of touched) {
    let k = j;
    while (k < next.length && (used.has(k) || !(next[k].from === e.from && next[k].to === e.to))) k++;
    if (k < next.length) {
      map.set(e.index, k);
      used.add(k);
      j = k + 1;
    }
  }
  const extra: ChangeSpec[] = [];
  for (const ls of doc.linkStyles) {
    if (ls.indices.value === 'default') continue;
    const old = ls.indices.value.split(',');
    const renumbered = old.flatMap((x) => {
      const k = map.get(Number(x));
      return /^\d+$/.test(x) && k !== undefined ? [String(k)] : [];
    });
    if (renumbered.join(',') === old.join(',')) continue;
    extra.push(renumbered.length === 0 ? removeLine(source, ls.line) : { from: ls.indices.from, to: ls.indices.to, insert: renumbered.join(',') });
  }
  return extra.length ? [change, ...extra] : change;
}

// swimlane・agentflow は、フローチャートと同じ書き方の図種
const HEADER = /^(\s*(?:flowchart-elk|flowchart|graph|swimlane-beta|agentflow-beta))(?:([ \t]+)(TB|TD|BT|RL|LR))?/;

export function getDirection(source: string): string {
  const h = bodyLines(source).header;
  return (h && HEADER.exec(h.text)?.[3]) ?? 'TB';
}

export function setDirection(source: string, dir: string): ChangeSpec | null {
  const h = bodyLines(source).header;
  const m = h && HEADER.exec(h.text);
  if (!h || !m) return null;
  if (m[3]) {
    const at = h.from + m[1].length + m[2].length;
    return { from: at, to: at + m[3].length, insert: dir };
  }
  return { from: h.from + m[1].length, insert: ' ' + dir };
}


/** ノードの ID を変える。文の中の参照と、class / style / click の行をすべて書き換える */
export function renameNode(source: string, from: string, to: string): ChangeSpec[] | null {
  if (!VALID_ID.test(to) || from === to) return null;
  const doc = parseFlowchart(source);
  // 既にある ID にはまとめない
  if (nodeRefs(doc, to).length > 0 || doc.connectors.some((c) => c.id === to)) return null;
  const refs = nodeRefs(doc, from);
  // agentflow の connector は、宣言の行の ID も変える
  const conn = doc.connectors.find((c) => c.id === from);
  if (refs.length === 0 && !conn) return null;
  const changes: ChangeSpec[] = refs.map(({ ref }) => ({ from: ref.from, to: ref.idTo, insert: to }));
  if (conn) changes.push({ from: conn.idRange.from, to: conn.idRange.to, insert: to });
  const token = tokenRegex(from, 'gu');
  for (const line of bodyLines(source).body) {
    if (!/^\s*(class|style|click)\s/.test(line.text)) continue;
    const head = /^\s*(?:class\s+[^\s]+|style\s+\S+|click\s+\S+)/.exec(line.text)![0];
    token.lastIndex = 0;
    for (let m = token.exec(head); m; m = token.exec(head)) {
      changes.push({ from: line.from + m.index, to: line.from + m.index + from.length, insert: to });
    }
  }
  return changes;
}
