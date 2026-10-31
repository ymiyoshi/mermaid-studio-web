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

describe('スナップショットの圧縮', () => {
  it('長いスナップショットは圧縮して保存し、読むときに戻す', async () => {
    const big = 'flowchart LR\n' + '  A --> B\n'.repeat(500);
    const tree = HistoryTree.create('big', big, 0);
    const nodes = tree.takeDirty();
    const stored = db.encodeNode(nodes[0]) as ReturnType<typeof db.encodeNode> & { snapshotZ?: Uint8Array };
    expect(stored.snapshot).toBeNull();
    expect(stored.snapshotZ!.length).toBeLessThan(big.length / 10);
    await db.saveDocAndNodes(record(tree, big), nodes);
    const loaded = await db.loadHistory('big');
    expect(loaded[0].snapshot).toBe(big);
    expect('snapshotZ' in loaded[0]).toBe(false);
  });

  it('短いスナップショットはそのまま', () => {
    const tree = HistoryTree.create('s', 'graph TD', 0);
    const n = tree.takeDirty()[0];
    expect(db.encodeNode(n)).toBe(n);
  });
});

describe('保存形式の版を上げる', () => {
  it('版 3 のデータベースを版 4 で開くと、文書はそのまま読め、フォルダの入れ物が増える（§17.9）', async () => {
    await db.resetDbConnection();
    await new Promise((r) => (indexedDB.deleteDatabase('mermaid-studio').onsuccess = r));
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('mermaid-studio', 3);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('history', { keyPath: ['docId', 'id'] }).createIndex('byDoc', 'docId');
        d.createObjectStore('settings', { keyPath: 'key' });
        d.createObjectStore('files', { keyPath: 'docId' });
        d.createObjectStore('thumbs', { keyPath: 'docId' });
        req.transaction!.objectStore('documents').put({ id: 'old', title: '古い図', text: 'graph TD\n  A', headId: 'h', createdAt: 0, updatedAt: 0, deletedAt: null, tags: [] });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    expect((await db.getDoc('old'))?.title).toBe('古い図');
    expect(await db.listFolders()).toEqual([]);
    expect((await db.db()).version).toBe(4);
  });
});
