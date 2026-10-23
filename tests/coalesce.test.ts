import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { HistoryTree } from '../src/core/history';
import { describeTyping, editKind, shouldCoalesce, typingGroupKey } from '../src/core/coalesce';

const doc = (s: string) => Text.of(s.split('\n'));

function treeWithTyping(text: string, at: number, insert: string, ts = 1000) {
  const tree = HistoryTree.create('d', text, 0);
  const cs = ChangeSet.of({ from: at, insert }, text.length);
  tree.commit(cs, doc(text), {
    origin: 'typing',
    label: '',
    groupKey: typingGroupKey(cs),
    selBefore: { anchor: at, head: at },
    selAfter: { anchor: at + insert.length, head: at + insert.length },
    ts,
    coalesce: false,
  });
  return { tree, text: text.slice(0, at) + insert + text.slice(at) };
}

function next(text: string, at: number, insert: string, ts: number, cursor = at) {
  const changes = ChangeSet.of({ from: at, insert }, text.length);
  return {
    origin: 'typing' as const,
    groupKey: typingGroupKey(changes),
    changes,
    docBefore: doc(text),
    selBefore: { anchor: cursor, head: cursor },
    ts,
  };
}

describe('editKind', () => {
  it('挿入・削除・改行・置換を区別する', () => {
    expect(editKind(ChangeSet.of({ from: 0, insert: 'a' }, 0))).toBe('insert');
    expect(editKind(ChangeSet.of({ from: 0, to: 1 }, 1))).toBe('delete');
    expect(editKind(ChangeSet.of({ from: 0, insert: '\n' }, 0))).toBe('newline');
    expect(editKind(ChangeSet.of({ from: 0, to: 1, insert: 'b' }, 1))).toBe('replace');
  });
});

describe('shouldCoalesce', () => {
  it('続けて打った文字はまとめる', () => {
    const { tree, text } = treeWithTyping('', 0, 'a');
    expect(shouldCoalesce(tree.head, next(text, 1, 'b', 1200))).toBe(true);
  });

  it('1 秒以上止まったら区切る', () => {
    const { tree, text } = treeWithTyping('', 0, 'a');
    expect(shouldCoalesce(tree.head, next(text, 1, 'b', 2500))).toBe(false);
  });

  it('カーソルが離れていたら区切る', () => {
    const { tree, text } = treeWithTyping('xyz', 0, 'a');
    expect(shouldCoalesce(tree.head, next(text, 3, 'b', 1100, 3))).toBe(false);
  });

  it('単語の後に空白を打ったら区切る', () => {
    const { tree, text } = treeWithTyping('', 0, 'abc');
    expect(shouldCoalesce(tree.head, next(text, 3, ' ', 1100))).toBe(false);
  });

  it('改行は常に独立したステップ', () => {
    const { tree, text } = treeWithTyping('', 0, 'abc');
    expect(shouldCoalesce(tree.head, next(text, 3, '\n', 1100))).toBe(false);
  });

  it('挿入から削除に変わったら区切る', () => {
    const { tree, text } = treeWithTyping('', 0, 'abc');
    const changes = ChangeSet.of({ from: 2, to: 3 }, 3);
    expect(
      shouldCoalesce(tree.head, {
        origin: 'typing',
        groupKey: typingGroupKey(changes),
        changes,
        docBefore: doc(text),
        selBefore: { anchor: 3, head: 3 },
        ts: 1100,
      }),
    ).toBe(false);
  });

  it('ラベル編集のセッションは時間に関係なくまとめる', () => {
    const tree = HistoryTree.create('d', 'A[x]', 0);
    const cs = ChangeSet.of({ from: 2, to: 3, insert: 'y' }, 4);
    tree.commit(cs, doc('A[x]'), {
      origin: 'diagram-op',
      label: '',
      groupKey: 'label:s1',
      selBefore: { anchor: 0, head: 0 },
      selAfter: { anchor: 3, head: 3 },
      ts: 0,
      coalesce: false,
    });
    const cs2 = ChangeSet.of({ from: 2, to: 3, insert: 'yy' }, 4);
    const base = { changes: cs2, docBefore: doc('A[y]'), selBefore: { anchor: 9, head: 9 }, ts: 99999 };
    expect(shouldCoalesce(tree.head, { ...base, origin: 'diagram-op', groupKey: 'label:s1' })).toBe(true);
    expect(shouldCoalesce(tree.head, { ...base, origin: 'diagram-op', groupKey: 'label:s2' })).toBe(false);
  });
});

describe('describeTyping', () => {
  it('入力した文字列をラベルにする', () => {
    expect(describeTyping(ChangeSet.of({ from: 0, insert: 'A --> B' }, 0))).toBe('入力「A --> B」');
    expect(describeTyping(ChangeSet.of({ from: 0, to: 3 }, 5))).toBe('削除（3 文字）');
  });
});
