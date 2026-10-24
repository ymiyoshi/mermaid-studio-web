// @vitest-environment jsdom
// PWA のファイルの関連付け: OS から渡された .mmd / .mermaid を開く（launchQueue）。
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSession } from '../src/core/session';
import { saveFile, watchLaunchFiles } from '../src/io/files';
import * as db from '../src/storage/db';
import { FakeHandle, installPickers } from './helpers/fakeFs';

type Consumer = (params: { files: unknown[] }) => void;

/** window.launchQueue の代わり。setConsumer で受け取った関数で、ファイルを渡す */
function installLaunchQueue() {
  let consumer: Consumer | null = null;
  (window as unknown as { launchQueue: unknown }).launchQueue = { setConsumer: (c: Consumer) => (consumer = c) };
  return async (...files: unknown[]) => {
    consumer!({ files });
    // 読み込みは非同期なので、終わるまで待つ
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  };
}

const cur = () => useSession.getState().current!;
const liveDocs = () => useSession.getState().docs.filter((d) => d.deletedAt === null);

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

afterEach(() => {
  delete (window as unknown as { launchQueue?: unknown }).launchQueue;
});

describe('OS から渡されたファイルを開く', () => {
  it('launchQueue が無いブラウザでは何もしない', () => {
    expect(() => watchLaunchFiles()).not.toThrow();
  });

  it('渡された .mmd を新しい図として開き、上書き保存できるように結び付ける', async () => {
    const launch = installLaunchQueue();
    watchLaunchFiles();
    const handle = new FakeHandle('構成.mmd', 'flowchart LR\n  A --> B\n');
    await launch(handle);
    expect(cur().title).toBe('構成');
    expect(cur().text.toString()).toBe('flowchart LR\n  A --> B\n');
    expect(cur().file).toMatchObject({ name: '構成.mmd', kind: 'mermaid' });
    // 上書き保存すると、渡されたファイルに書く
    installPickers(handle);
    await saveFile();
    expect(handle.writes).toBe(1);
  });

  it('同じファイルをもう一度渡されたら、新しく作らずに前の図を開く', async () => {
    const launch = installLaunchQueue();
    watchLaunchFiles();
    const handle = new FakeHandle('再.mermaid', 'pie\n  "a" : 1\n');
    await launch(handle);
    const id = cur().id;
    const count = liveDocs().length;
    await launch(handle);
    expect(cur().id).toBe(id);
    expect(liveDocs()).toHaveLength(count);
  });

  it('ファイルでないもの（フォルダ）は無視する', async () => {
    const launch = installLaunchQueue();
    watchLaunchFiles();
    const count = liveDocs().length;
    await launch({ kind: 'directory', name: 'folder' });
    expect(liveDocs()).toHaveLength(count);
  });
});
