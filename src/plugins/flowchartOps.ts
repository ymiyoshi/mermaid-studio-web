import type { ChangeSpec } from '@codemirror/state';
import {
  nodeDefinition,
  nodeRefs,
  parseFlowchart,
  SHAPE_CHOICES,
  type FlowDoc,
  type Link,
  type NodeRef,
  type Statement,
} from './flowchartSyntax';
import { indentOf, tokenRegex, bodyLines } from './source';

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
    const keep = part.groups[0].filter((r) => r.shape || !referencedElsewhere(doc, r.id, st));
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
  const wholeLine = st.line.text.trim().replace(/;$/, '').trim() === source.slice(st.from, st.to).trim();
  if (texts.length === 0 && wholeLine) {
    if (st.line.to < source.length) return { from: st.line.from, to: st.line.to + 1 };
    return { from: Math.max(0, st.line.from - 1), to: st.line.to };
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
    const remove = () =>
      out.push(line.to < source.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to });
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
  if (statements.size === 0) return null;
  // 読めなかった行にも出てくるなら、中途半端に消さない
  if (doc.unknown.some((l) => tokenRegex(id).test(l.text))) return null;
  const changes: ChangeSpec[] = [];
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
  const seen = new Set<string>();
  const nodeText = (r: NodeRef) => {
    if (seen.has(r.id)) return r.id;
    seen.add(r.id);
    return source.slice(r.from, r.to);
  };
  const texts: string[] = [];
  const own = doc.edges.filter((e) => e.statement === st);
  for (const e of own) {
    if (e.index === index) continue;
    const a = st.groups[e.link].find((r) => r.id === e.from)!;
    const b = st.groups[e.link + 1].find((r) => r.id === e.to)!;
    const l = st.links[e.link];
    texts.push(`${nodeText(a)} ${source.slice(l.from, l.to)} ${nodeText(b)}`);
  }
  // どのエッジにも残らなかったノードの定義は残す
  for (const g of st.groups) for (const r of g) if (!seen.has(r.id) && (r.shape || !referencedElsewhere(doc, r.id, st))) texts.push(nodeText(r));
  return replaceStatement(source, st, texts);
}

export function setShape(source: string, id: string, shape: string): ChangeSpec[] | null {
  const choice = SHAPE_CHOICES.find((s) => s.name === shape);
  if (!choice) return null;
  const doc = parseFlowchart(source);
  const def = nodeDefinition(doc, id);
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

const HEADER = /^(\s*(?:flowchart|graph))(?:([ \t]+)(TB|TD|BT|RL|LR))?/;

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

const VALID_ID = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.]|-(?=[\p{L}\p{N}_]))*$/u;

/** ノードの ID を変える。文の中の参照と、class / style / click の行をすべて書き換える */
export function renameNode(source: string, from: string, to: string): ChangeSpec[] | null {
  if (!VALID_ID.test(to) || from === to) return null;
  const doc = parseFlowchart(source);
  if (nodeRefs(doc, to).length > 0) return null; // 既にある ID にはまとめない
  const refs = nodeRefs(doc, from);
  if (refs.length === 0) return null;
  const changes: ChangeSpec[] = refs.map(({ ref }) => ({ from: ref.from, to: ref.idTo, insert: to }));
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
