import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { HistoryTree } from '../src/core/history';
import * as db from '../src/storage/db';

const doc = (s: string) => Text.of(s.split('\n'));

function record(tree: HistoryTree, text: string, over: Partial<db.DocRecord> = {}): db.DocRecord {
  return {
    id: tree.docId,
    title: 't',
    text,
    headId: tree.headId,
    createdAt: 0,
    updatedAt: 1,
    deletedAt: null,
    tags: [],
    ...over,
  };
}

beforeEach(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

describe('IndexedDB への保存', () => {
  it('文書と履歴を保存し、読み込み直して undo できる', async () => {
    const tree = HistoryTree.create('doc1', 'a', 0);
    const cs = ChangeSet.of({ from: 1, insert: 'b' }, 1);
    tree.commit(cs, doc('a'), {
      origin: 'typing',
      label: '入力',
      groupKey: null,
      selBefore: { anchor: 1, head: 1 },
      selAfter: { anchor: 2, head: 2 },
      ts: 1,
      coalesce: false,
    });
    await db.saveDocAndNodes(record(tree, 'ab'), tree.takeDirty());

    const rec = (await db.getDoc('doc1'))!;
    const nodes = await db.loadHistory('doc1');
    expect(rec.text).toBe('ab');
    expect(nodes).toHaveLength(2);

    const loaded = HistoryTree.load('doc1', nodes, rec.headId);
    const step = loaded.undo()!;
    expect(step.changes.apply(doc(rec.text)).toString()).toBe('a');
  });

  it('ゴミ箱の保持期間を過ぎた図だけを完全に削除する', async () => {
    const now = Date.now();
    const old = HistoryTree.create('old', 'x', 0);
    const recent = HistoryTree.create('recent', 'y', 0);
    await db.saveDocAndNodes(record(old, 'x', { deletedAt: now - db.TRASH_RETENTION_MS - 1 }), old.takeDirty());
    await db.saveDocAndNodes(record(recent, 'y', { deletedAt: now - 1000 }), recent.takeDirty());

    expect(await db.purgeExpiredTrash(now)).toBe(1);
    expect(await db.getDoc('old')).toBeUndefined();
    expect(await db.loadHistory('old')).toHaveLength(0);
    expect(await db.getDoc('recent')).toBeDefined();
  });
});
