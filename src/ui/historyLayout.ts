import type { HistoryNode } from '../core/history';

// 履歴ツリーを git graph 風の行と列（レーン）に並べる（設計書 §8.4）。
// 行は深さ優先の順（ルートが一番上）。最初の子は親と同じレーン、それ以外の子は新しいレーンを使う。
// 分岐も head も無い長い一本道は折りたたむ。

export type HistoryRow =
  | { kind: 'node'; node: HistoryNode; lane: number }
  | { kind: 'fold'; key: string; lane: number; ids: string[] };

export interface HistoryEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

export interface HistoryLayout {
  rows: HistoryRow[];
  edges: HistoryEdge[];
  lanes: number;
}

/** これより長い一本道を折りたたむ */
export const FOLD_MIN = 6;

export function layoutHistory(
  nodes: Map<string, HistoryNode>,
  rootId: string,
  headId: string,
  expanded: ReadonlySet<string>,
): HistoryLayout {
  const order: { node: HistoryNode; lane: number }[] = [];
  let nextLane = 1;
  // 再帰だと深い履歴でスタックがあふれるので、明示的なスタックで深さ優先にたどる
  const stack: { id: string; lane: number }[] = [{ id: rootId, lane: 0 }];
  while (stack.length) {
    const { id, lane } = stack.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    order.push({ node, lane });
    const kids = [...node.children].sort((a, b) => (nodes.get(a)?.ts ?? 0) - (nodes.get(b)?.ts ?? 0));
    const lanes = kids.map((_, i) => (i === 0 ? lane : nextLane++));
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], lane: lanes[i] });
  }

  const foldable = (n: HistoryNode) => {
    if (n.parentId === null || n.id === headId || n.children.length !== 1 || n.name) return false;
    return nodes.get(n.parentId)?.children.length === 1;
  };

  const rows: HistoryRow[] = [];
  const rowOf = new Map<string, number>();
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && foldable(order[j].node)) j++;
    const run = order.slice(i, j);
    const key = run[0]?.node.id;
    if (run.length >= FOLD_MIN && !expanded.has(key)) {
      const row = rows.length;
      rows.push({ kind: 'fold', key, lane: run[0].lane, ids: run.map((r) => r.node.id) });
      run.forEach((r) => rowOf.set(r.node.id, row));
      i = j;
      continue;
    }
    if (run.length > 0) {
      for (const r of run) {
        rowOf.set(r.node.id, rows.length);
        rows.push({ kind: 'node', node: r.node, lane: r.lane });
      }
      i = j;
      continue;
    }
    rowOf.set(order[i].node.id, rows.length);
    rows.push({ kind: 'node', node: order[i].node, lane: order[i].lane });
    i++;
  }

  const laneOf = new Map(order.map((o) => [o.node.id, o.lane]));
  const edges: HistoryEdge[] = [];
  const seen = new Set<string>();
  for (const { node } of order) {
    if (node.parentId === null) continue;
    const fromRow = rowOf.get(node.parentId)!;
    const toRow = rowOf.get(node.id)!;
    if (fromRow === toRow) continue; // 折りたたんだ行の内部
    const k = `${fromRow}:${toRow}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ fromRow, fromLane: laneOf.get(node.parentId)!, toRow, toLane: laneOf.get(node.id)! });
  }

  return { rows, edges, lanes: nextLane };
}
