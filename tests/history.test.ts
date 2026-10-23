import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { HistoryTree, SNAPSHOT_INTERVAL, minimalReplace, type CommitMeta } from '../src/core/history';

const sel = (n: number) => ({ anchor: n, head: n });
const meta = (over: Partial<CommitMeta> = {}): CommitMeta => ({
  origin: 'typing',
  label: 'x',
  groupKey: null,
  selBefore: sel(0),
  selAfter: sel(0),
  ts: 0,
  coalesce: false,
  ...over,
});
const doc = (s: string) => Text.of(s.split('\n'));

/** テスト用: 文書と履歴を一緒に持つ */
class Harness {
  tree: HistoryTree;
  text: Text;
  constructor(initial: string) {
    this.tree = HistoryTree.create('d', initial, 0);
    this.text = doc(initial);
  }
  insert(at: number, s: string, m: Partial<CommitMeta> = {}) {
    const cs = ChangeSet.of({ from: at, insert: s }, this.text.length);
    this.tree.commit(cs, this.text, meta(m));
    this.text = cs.apply(this.text);
  }
  del(from: number, to: number) {
    const cs = ChangeSet.of({ from, to }, this.text.length);
    this.tree.commit(cs, this.text, meta());
    this.text = cs.apply(this.text);
  }
  undo() {
    const s = this.tree.undo();
    if (s) this.text = s.changes.apply(this.text);
    return !!s;
  }
  redo() {
    const s = this.tree.redo();
    if (s) this.text = s.changes.apply(this.text);
    return !!s;
  }
  jump(id: string) {
    const s = this.tree.jumpTo(id, this.text);
    if (s) this.text = s.changes.apply(this.text);
  }
  get s() {
    return this.text.toString();
  }
}

describe('HistoryTree', () => {
  it('undo / redo を往復できる', () => {
    const h = new Harness('flowchart TD');
    h.insert(12, '\n  A --> B');
    h.insert(22, '\n  B --> C');
    expect(h.s).toBe('flowchart TD\n  A --> B\n  B --> C');
    h.undo();
    expect(h.s).toBe('flowchart TD\n  A --> B');
    h.undo();
    expect(h.s).toBe('flowchart TD');
    expect(h.undo()).toBe(false);
    h.redo();
    h.redo();
    expect(h.s).toBe('flowchart TD\n  A --> B\n  B --> C');
    expect(h.redo()).toBe(false);
  });

  it('undo 後に別の編集をしても元の分岐は消えない', () => {
    const h = new Harness('a');
    h.insert(1, 'b');
    const branch1 = h.tree.headId;
    h.undo();
    h.insert(1, 'c');
    const branch2 = h.tree.headId;
    expect(h.s).toBe('ac');
    const root = h.tree.get(h.tree.rootId);
    expect(root.children).toEqual([branch1, branch2]);
    h.jump(branch1);
    expect(h.s).toBe('ab');
    h.jump(branch2);
    expect(h.s).toBe('ac');
  });

  it('redo は最後に訪れた分岐へ進む', () => {
    const h = new Harness('a');
    h.insert(1, 'b');
    const b = h.tree.headId;
    h.undo();
    h.insert(1, 'c');
    h.undo();
    h.redo();
    expect(h.s).toBe('ac');
    h.jump(b);
    h.undo();
    h.redo();
    expect(h.s).toBe('ab');
  });

  it('まとめた編集は 1 回の undo で戻る', () => {
    const h = new Harness('');
    h.insert(0, 'a');
    h.insert(1, 'b', { coalesce: true });
    h.insert(2, 'c', { coalesce: true });
    expect(h.tree.nodes.size).toBe(2);
    h.undo();
    expect(h.s).toBe('');
    h.redo();
    expect(h.s).toBe('abc');
  });

  it('textAt はどのノードでも正しいテキストを返す（スナップショットをまたいでも）', () => {
    const h = new Harness('x');
    const expected = new Map<string, string>([[h.tree.rootId, 'x']]);
    for (let i = 0; i < SNAPSHOT_INTERVAL * 3 + 5; i++) {
      h.insert(h.text.length, String(i % 10));
      expected.set(h.tree.headId, h.s);
    }
    for (const [id, s] of expected) expect(h.tree.textAt(id)).toBe(s);
    expect([...h.tree.nodes.values()].filter((n) => n.snapshot !== null).length).toBe(4);
  });

  it('遠いジャンプ（スナップショット経由）でも正しく移動する', () => {
    const h = new Harness('');
    for (let i = 0; i < 80; i++) h.insert(h.text.length, 'a');
    const far = h.tree.headId;
    h.jump(h.tree.rootId);
    expect(h.s).toBe('');
    h.jump(far);
    expect(h.s).toBe('a'.repeat(80));
  });

  it('ランダムな操作列の後でも、各ノードへのジャンプが記録時のテキストと一致する', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const h = new Harness('flowchart TD\n');
    const expected = new Map<string, string>([[h.tree.rootId, h.s]]);
    for (let i = 0; i < 300; i++) {
      const op = rnd(10);
      if (op < 5) h.insert(rnd(h.text.length + 1), 'xyz'.slice(0, rnd(3) + 1));
      else if (op < 6 && h.text.length > 2) {
        const from = rnd(h.text.length - 1);
        h.del(from, from + 1);
      } else if (op < 8) h.undo();
      else if (op < 9) h.redo();
      else h.jump([...expected.keys()][rnd(expected.size)]);
      expected.set(h.tree.headId, h.s);
    }
    for (const [id, s] of expected) {
      h.jump(id);
      expect(h.s).toBe(s);
    }
  });

  it('保存して読み込み直しても同じ履歴になる', () => {
    const h = new Harness('a');
    h.insert(1, 'b');
    h.undo();
    h.insert(1, 'c');
    const nodes = structuredClone(h.tree.takeDirty());
    const loaded = HistoryTree.load('d', nodes, h.tree.headId);
    const back = loaded.undo()!;
    expect(back.changes.apply(doc('ac')).toString()).toBe('a');
  });
});

describe('minimalReplace', () => {
  it('共通の先頭・末尾を残して置き換える', () => {
    const cs = minimalReplace(doc('hello world'), 'hello brave world');
    expect(cs.apply(doc('hello world')).toString()).toBe('hello brave world');
    let n = 0;
    cs.iterChanges(() => n++);
    expect(n).toBe(1);
  });
});
