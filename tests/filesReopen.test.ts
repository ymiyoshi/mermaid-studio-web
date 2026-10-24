// @vitest-environment jsdom
// 同じファイルをもう一度開いたときに、新しい図を作らず既存の図を開くこと（§9.3）。
// 本物の FileSystemFileHandle は IndexedDB に保存できるが、テスト用の偽物は保存すると isSameEntry を失うので、
// ファイルとの結び付きだけはメモリに持たせる。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/db')>();
  const live = new Map<string, import('../src/storage/db').FileBinding>();
  return {
    ...real,
    putFileBinding: async (b: import('../src/storage/db').FileBinding) => {
      live.set(b.docId, b);
      await real.putFileBinding({ ...b, handle: null });
    },
    listFileBindings: async () => [...live.values()],
    getFileBinding: async (docId: string) => live.get(docId),
  };
});

import { useSession } from '../src/core/session';
import { importFromHandle } from '../src/io/files';
import * as db from '../src/storage/db';
import { FakeHandle, installPickers } from './helpers/fakeFs';

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

describe('同じファイルを開き直す', () => {
  it('既存の図を開き、外部での変更があれば読み込み直す', async () => {
    const h = new FakeHandle('same.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFromHandle(h as unknown as FileSystemFileHandle);
    const firstId = useSession.getState().current!.id;
    const count = useSession.getState().docs.length;

    const other = new FakeHandle('other.mmd', 'graph TD\n  O\n');
    await importFromHandle(other as unknown as FileSystemFileHandle);
    expect(useSession.getState().current!.id).not.toBe(firstId);

    h.touch('graph TD\n  A --> B\n');
    await importFromHandle(h as unknown as FileSystemFileHandle);
    expect(useSession.getState().current!.id).toBe(firstId);
    expect(useSession.getState().docs.length).toBe(count + 1);
    expect(useSession.getState().current!.text.toString()).toBe('graph TD\n  A --> B\n');
  });
});
