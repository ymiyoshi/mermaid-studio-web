// @vitest-environment jsdom
// PWA のファイルの関連付け: OS から渡された .mmd / .mermaid を開く（launchQueue）。
// テスト用の偽のハンドルは IndexedDB に保存すると isSameEntry を失うので、ファイルとの結び付きだけはメモリに持たせる
// （tests/filesReopen.test.ts と同じ対処）。
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { openDoc, useSession } from '../src/core/session';
import { openLaunchedFiles, saveFile, watchLaunchFiles } from '../src/io/files';
import * as db from '../src/storage/db';
import { FakeHandle, installPickers } from './helpers/fakeFs';

type Consumer = (params: { files: unknown[] }) => void;

/** window.launchQueue の代わり。setConsumer で受け取った関数を返す */
function installLaunchQueue() {
  const box: { consumer: Consumer | null } = { consumer: null };
  (window as unknown as { launchQueue: unknown }).launchQueue = { setConsumer: (c: Consumer) => (box.consumer = c) };
  return box;
}

const cur = () => useSession.getState().current!;
const liveDocs = () => useSession.getState().docs.filter((d) => d.deletedAt === null);
const toast = () => useSession.getState().toast?.message ?? null;
const asHandles = (...hs: unknown[]) => hs as FileSystemHandle[];

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

beforeEach(() => {
  // 読み込みの失敗は通知に出るので、通知が無いことも確かめる（失敗が通知に隠れて、テストが素通りしないように）
  useSession.setState({ toast: null });
});

afterEach(() => {
  delete (window as unknown as { launchQueue?: unknown }).launchQueue;
  installPickers(null);
});

describe('OS から渡されたファイルを開く', () => {
  it('launchQueue が無いブラウザでは、ファイルは渡されない', async () => {
    await expect(watchLaunchFiles(Promise.resolve())).resolves.toBe(false);
  });

  it('起動処理が終わってから、渡された .mmd を新しい図として開き、上書き保存できるように結び付ける', async () => {
    const box = installLaunchQueue();
    let markReady!: () => void;
    const launched = watchLaunchFiles(new Promise<void>((r) => (markReady = r)));
    const handle = new FakeHandle('構成.mmd', 'flowchart LR\n  A --> B\n');
    box.consumer!({ files: [handle] });
    // 起動処理には「ファイルを渡された」と伝わる（最初の図を開かない）
    await expect(launched).resolves.toBe(true);
    // 起動処理が終わるまでは開かない
    await new Promise((r) => setTimeout(r, 20));
    expect(liveDocs().some((d) => d.title === '構成')).toBe(false);
    markReady();
    await vi.waitFor(() => expect(cur().title).toBe('構成'));
    expect(cur().text.toString()).toBe('flowchart LR\n  A --> B\n');
    expect(cur().file).toMatchObject({ name: '構成.mmd', kind: 'mermaid' });
    // 上書き保存すると、渡されたファイルに書く
    installPickers(handle);
    await saveFile();
    expect(handle.writes).toBe(1);
    expect(toast()).toBe('「構成.mmd」に保存しました');
  });

  it('同じファイルをもう一度渡されたら、新しく作らずに前の図を開き、渡されたハンドルに置き換える', async () => {
    const first = new FakeHandle('再.mermaid', 'pie\n  "a" : 1\n');
    await openLaunchedFiles(asHandles(first));
    const id = cur().id;
    const count = liveDocs().length;
    await openLaunchedFiles(asHandles(new FakeHandle('別.mmd', 'flowchart LR\n  X\n')));
    expect(cur().id).not.toBe(id);

    // OS から同じファイルを指す別のハンドルが渡される
    const again = new FakeHandle('再.mermaid', 'pie\n  "a" : 1\n');
    first.isSameEntry = async (other: unknown) => other === first || other === again;
    await openLaunchedFiles(asHandles(again));
    expect(cur().id).toBe(id);
    expect(liveDocs()).toHaveLength(count + 1);
    expect(cur().file?.handle).toBe(again);
    expect(toast()).toBeNull();
  });

  it('同じ新しいファイルを続けて渡されても（同時に）、図は 1 つだけ作る', async () => {
    const count = liveDocs().length;
    const handle = new FakeHandle('続けて.mmd', 'flowchart LR\n  C\n');
    await Promise.all([openLaunchedFiles(asHandles(handle)), openLaunchedFiles(asHandles(handle))]);
    expect(liveDocs()).toHaveLength(count + 1);
    expect(liveDocs().filter((d) => d.title === '続けて')).toHaveLength(1);
    expect(toast()).toBeNull();
  });

  it('ファイルでないもの（フォルダ）は無視する', async () => {
    const count = liveDocs().length;
    await openLaunchedFiles(asHandles({ kind: 'directory', name: 'folder' }));
    expect(liveDocs()).toHaveLength(count);
    expect(toast()).toBeNull();
  });

  it('今開いている図を開き直しても、読み込み直さない（書き込み権を手放さない）', async () => {
    const before = cur();
    await openDoc(before.id);
    expect(cur()).toBe(before);
    expect(cur().readOnly).toBe(false);
  });
});
