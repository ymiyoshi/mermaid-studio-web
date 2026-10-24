import { describe, expect, it } from 'vitest';
import { Text, ChangeSet } from '@codemirror/state';
import { HistoryTree } from '../src/core/history';
import { pathToHead, sampleFrames } from '../src/ui/timelapse';

describe('タイムラプスの版の並び', () => {
  it('根から head までの道のりだけをたどる（別の分岐は通らない）', () => {
    const tree = HistoryTree.create('d', 'a', 0);
    const meta = (ts: number) => ({ origin: 'typing' as const, label: String(ts), groupKey: null, selBefore: { anchor: 0, head: 0 }, selAfter: { anchor: 0, head: 0 }, ts, coalesce: false });
    let doc = Text.of(['a']);
    const step = (insert: string, ts: number) => {
      const ch = ChangeSet.of({ from: doc.length, insert }, doc.length);
      const n = tree.commit(ch, doc, meta(ts));
      doc = ch.apply(doc);
      return n.id;
    };
    const b = step('b', 1);
    step('x', 2);
    tree.undo();
    doc = Text.of(['ab']);
    const c = step('c', 3);
    const path = pathToHead(tree);
    expect(path).toEqual([tree.rootId, b, c]);
    expect(path.map((id) => tree.textAt(id))).toEqual(['a', 'ab', 'abc']);
  });

  it('長い道のりは最初と最後を含めて間引く', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const s = sampleFrames(items, 10);
    expect(s).toHaveLength(10);
    expect(s[0]).toBe(0);
    expect(s[9]).toBe(999);
    expect(sampleFrames([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});
