import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { HistoryTree } from '../src/core/history';
import { FOLD_MIN, layoutHistory } from '../src/ui/historyLayout';

function build() {
  let text = Text.of(['']);
  const tree = HistoryTree.create('d', '', 0);
  let ts = 1;
  const add = (s: string) => {
    const cs = ChangeSet.of({ from: text.length, insert: s }, text.length);
    tree.commit(cs, text, {
      origin: 'typing',
      label: s,
      groupKey: null,
      selBefore: { anchor: 0, head: 0 },
      selAfter: { anchor: 0, head: 0 },
      ts: ts++,
      coalesce: false,
    });
    text = cs.apply(text);
  };
  const undo = () => {
    text = tree.undo()!.changes.apply(text);
  };
  return { tree, add, undo };
}

describe('layoutHistory', () => {
  it('分岐は別のレーンに置く', () => {
    const { tree, add, undo } = build();
    add('a');
    add('b');
    undo();
    add('c');
    const l = layoutHistory(tree.nodes, tree.rootId, tree.headId, new Set());
    const labels = l.rows.map((r) => (r.kind === 'node' ? `${r.node.label}@${r.lane}` : 'fold'));
    expect(labels).toEqual(['作成@0', 'a@0', 'b@0', 'c@1']);
    expect(l.edges).toContainEqual({ fromRow: 1, fromLane: 0, toRow: 3, toLane: 1 });
  });

  it('長い一本道を折りたたみ、展開もできる', () => {
    const { tree, add } = build();
    for (let i = 0; i < FOLD_MIN + 4; i++) add(String(i));
    const folded = layoutHistory(tree.nodes, tree.rootId, tree.headId, new Set());
    const fold = folded.rows.find((r) => r.kind === 'fold');
    expect(fold).toBeDefined();
    expect(folded.rows.some((r) => r.kind === 'node' && r.node.id === tree.headId)).toBe(true);
    const expanded = layoutHistory(tree.nodes, tree.rootId, tree.headId, new Set([fold!.kind === 'fold' ? fold!.key : '']));
    expect(expanded.rows).toHaveLength(tree.nodes.size);
  });

  it('子が循環した壊れた履歴でも終わる', () => {
    const { tree, add } = build();
    add('a');
    add('b');
    // b の子に a を足して循環させる
    tree.nodes.get(tree.headId)!.children.push(tree.head.parentId!);
    const l = layoutHistory(tree.nodes, tree.rootId, tree.headId, new Set());
    expect(l.rows.filter((r) => r.kind === 'node')).toHaveLength(3);
  });
});
