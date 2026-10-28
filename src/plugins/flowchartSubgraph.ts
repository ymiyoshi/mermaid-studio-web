import type { ChangeSpec } from '@codemirror/state';
import { isInside, nodeRefs, parseFlowchart, statementText, subgraphOf, VALID_ID, type FlowDoc, type Statement, type Subgraph } from './flowchartSyntax';
import { appendTopLevel, removeLine, removeLines, topLevelEnd } from './lineOps';
import { indentOf, insertLineAfter, type SourceLine } from './source';
import { removeFromList } from './flowchartStyle';

// flowchart のサブグラフ（subgraph … end）の操作。
// ノードの所属は mermaid の規則に合わせる: 閉じた順（内側が先）に、中で言及されたノードを自分のものにする。

const DEFAULT_STEP = '    ';

/** サブグラフの中の 1 段深い字下げ（中の行に合わせる。中が空なら 4 文字深くする） */
export function innerIndent(doc: FlowDoc, sg: Subgraph): string {
  const outer = indentOf(sg.line.text);
  const child = doc.body.find((l) => isInside(sg, l) && indentOf(l.text).length > outer.length);
  return child ? indentOf(child.text) : outer + DEFAULT_STEP;
}

/** サブグラフの最後（end の前）に 1 行足す */
export function insertIntoSubgraph(doc: FlowDoc, sg: Subgraph, text: string): { from: number; insert: string } | null {
  if (!sg.end) return null;
  return { from: sg.end.from, insert: `${innerIndent(doc, sg)}${text}\n` };
}

/** 所属先の最後に 1 行足す。所属が無ければ図の最後に足す */
function insertIntoContainer(source: string, doc: FlowDoc, sg: Subgraph | null, text: string): ChangeSpec | null {
  return sg ? insertIntoSubgraph(doc, sg, text) : appendTopLevel(source, text);
}

export function findSubgraph(doc: FlowDoc, id: string): Subgraph | undefined {
  return doc.subgraphs.find((s) => s.id === id);
}

/** 新しいサブグラフの行（題名つき）。agentflow の枠は flow で書く */
function subgraphLines(doc: FlowDoc, id: string, title: string, indent: string, inner: string, body: string[]): string {
  const head = doc.container === 'flow' ? `flow ${id}["${title.replace(/"/g, '')}"]` : `subgraph ${id} [${title}]`;
  return [indent + head, ...body.map((b) => inner + b), `${indent}end`].join('\n');
}

/** 図の最後に空のサブグラフを足す */
export function addSubgraph(source: string, id: string, title: string) {
  const { after, indent } = topLevelEnd(source);
  return insertLineAfter(source, after, subgraphLines(parseFlowchart(source), id, title, indent, indent + DEFAULT_STEP, []));
}

/** ノードを新しいサブグラフにまとめる。ノードの今の所属の中に作るので、新しいサブグラフが先に閉じてノードを取る */
export function groupNode(source: string, nodeId: string, id: string, title: string): { from: number; insert: string } | null {
  const doc = parseFlowchart(source);
  const current = subgraphOf(doc, nodeId);
  if (current) {
    if (!current.end) return null;
    const indent = innerIndent(doc, current);
    const step = indent.slice(indentOf(current.line.text).length) || DEFAULT_STEP;
    return { from: current.end.from, insert: subgraphLines(doc, id, title, indent, indent + step, [nodeId]) + '\n' };
  }
  const { after, indent } = topLevelEnd(source);
  return insertLineAfter(source, after, subgraphLines(doc, id, title, indent, indent + DEFAULT_STEP, [nodeId]));
}

/** 文が、ノード 1 つだけを書いた 1 行か */
function isStandalone(st: Statement): boolean {
  if (st.links.length > 0 || st.groups[0].length !== 1) return false;
  const own = st.line.text.slice(st.from - st.line.from, st.to - st.line.from).trim();
  return statementText(st.line.text) === own;
}

/** サブグラフの中でノードを言及している文 */
function mentionsIn(doc: FlowDoc, sg: Subgraph, nodeId: string): Statement[] {
  return nodeRefs(doc, nodeId)
    .filter((r) => isInside(sg, r.statement.line))
    .map((r) => r.statement);
}

/** ノードの所属を変えられるか（今の所属の中では、ノードだけの行でしか言及されていない） */
export function canMoveNode(source: string, nodeId: string): boolean {
  const doc = parseFlowchart(source);
  const current = subgraphOf(doc, nodeId);
  return !current || mentionsIn(doc, current, nodeId).every(isStandalone);
}

/** ノードを別のサブグラフ（target が空なら外）へ移す。ノードだけの行を移し、無ければ ID の行を足す */
export function moveNodeTo(source: string, nodeId: string, target: string): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const current = subgraphOf(doc, nodeId);
  if ((current?.id ?? '') === target) return null;
  const dest = target ? findSubgraph(doc, target) : null;
  if (target && !dest) return null;
  const mentions = current ? mentionsIn(doc, current, nodeId) : [];
  if (!mentions.every(isStandalone)) return null;
  const lines = [...new Map(mentions.map((st) => [st.line.index, st.line])).values()];
  const changes: ChangeSpec[] = lines.map((l) => removeLine(source, l));
  // 定義（形やラベル）を持つ行はその文を移し、無ければ ID だけを書く
  const def = lines.map((l) => statementText(l.text)).find((t) => t !== nodeId) ?? nodeId;
  const insert = insertIntoContainer(source, doc, dest ?? null, def);
  if (!insert) return null;
  changes.push(insert);
  return changes;
}

/** サブグラフの ID を変える（subgraph の行・エッジ・style / class の行） */
export function renameSubgraph(source: string, from: string, to: string): ChangeSpec[] | null {
  if (!VALID_ID.test(to) || from === to) return null;
  const doc = parseFlowchart(source);
  const sg = findSubgraph(doc, from);
  if (!sg?.idRange) return null;
  if (findSubgraph(doc, to) || nodeRefs(doc, to).length > 0) return null;
  const changes: ChangeSpec[] = [{ from: sg.idRange.from, to: sg.idRange.to, insert: to }];
  for (const { ref } of nodeRefs(doc, from)) changes.push({ from: ref.from, to: ref.idTo, insert: to });
  for (const s of doc.styles) if (s.id.value === from) changes.push({ from: s.id.from, to: s.id.to, insert: to });
  for (const c of doc.classes) for (const x of c.ids) if (x.value === from) changes.push({ from: x.from, to: x.to, insert: to });
  return changes;
}

export function setSubgraphTitle(source: string, id: string, title: string): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const sg = findSubgraph(doc, id);
  if (!sg || /[[\]"\n]/.test(title)) return null;
  if (sg.title) {
    // ID のある書き方では、題名を空にすると [題名] ごと消す（ID が表示される）。後ろの @{ … } は残す
    if (title === '') return sg.idRange ? { from: sg.idRange.to, to: sg.headTo, insert: '' } : null;
    return { from: sg.title.from, to: sg.title.to, insert: title };
  }
  // agentflow の flow は、ID のすぐ後ろに ["題名"] と書く
  const head = doc.container === 'flow' ? `["${title}"]` : ` [${title}]`;
  return title && sg.idRange ? { from: sg.idRange.to, insert: head } : null;
}

export function setSubgraphDirection(source: string, id: string, dir: string): ChangeSpec | null {
  const doc = parseFlowchart(source);
  const sg = findSubgraph(doc, id);
  if (!sg) return null;
  if (sg.direction) {
    if (!dir) return removeLine(source, sg.direction.line);
    return { from: sg.direction.from, to: sg.direction.to, insert: dir };
  }
  return dir ? insertLineAfter(source, sg.line, `${innerIndent(doc, sg)}direction ${dir}`) : null;
}

/** 枠を外す（subgraph・direction・end の行だけを消し、中の行は残す） */
export function unwrapSubgraph(source: string, id: string): ChangeSpec[] | null {
  const sg = findSubgraph(parseFlowchart(source), id);
  if (!sg?.end) return null;
  const lines: SourceLine[] = [sg.line, ...(sg.direction ? [sg.direction.line] : []), sg.end];
  return lines.map((l) => removeLine(source, l));
}

/** サブグラフを中身ごと消す（外にある style / class の行からも外す） */
export function deleteSubgraph(source: string, id: string): ChangeSpec[] | null {
  const doc = parseFlowchart(source);
  const sg = findSubgraph(doc, id);
  if (!sg?.end) return null;
  const changes: ChangeSpec[] = [removeLines(source, sg.line, sg.end)];
  for (const s of doc.styles) if (s.id.value === id && !isInside(sg, s.line)) changes.push(removeLine(source, s.line));
  for (const c of doc.classes) {
    if (!isInside(sg, c.line) && c.ids.some((x) => x.value === id)) changes.push(removeFromList(source, c.line, c.ids, id));
  }
  return changes;
}
