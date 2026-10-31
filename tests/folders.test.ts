// @vitest-environment jsdom
// 設計書 §17.9: フォルダを開く。テスト用の偽のハンドルは IndexedDB に保存するとメソッドを失うので、
// フォルダとファイルの結び付きはメモリに持たせる（tests/filesReopen.test.ts と同じ対処）。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/db')>();
  type Db = typeof import('../src/storage/db');
  const files = new Map<string, import('../src/storage/db').FileBinding>();
  const folders = new Map<string, import('../src/storage/db').FolderRecord>();
  return {
    ...real,
    putFileBinding: async (b: Parameters<Db['putFileBinding']>[0]) => {
      files.set(b.docId, b);
      await real.putFileBinding({ ...b, handle: null });
    },
    listFileBindings: async () => [...files.values()],
    getFileBinding: async (docId: string) => files.get(docId),
    putFolder: async (f: Parameters<Db['putFolder']>[0]) => void folders.set(f.id, f),
    listFolders: async () => [...folders.values()],
    deleteFolder: async (id: string) => void folders.delete(id),
  };
});

import { useSession } from '../src/core/session';
import { saveFile } from '../src/io/files';
import { closeFolder, loadFolders, openFolder, openFolderFile, rescanFolder, scanDirectory, useFolders } from '../src/io/folders';
import * as db from '../src/storage/db';
import { FakeDirHandle, FakeHandle, installDirectoryPicker, installPickers } from './helpers/fakeFs';

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

const asDir = (d: FakeDirHandle) => d as unknown as FileSystemDirectoryHandle;

function repo() {
  const flow = new FakeHandle('flow.mmd', 'flowchart TD\n  A --> B\n');
  const readme = new FakeHandle('README.md', '# 説明\n\n```mermaid\nsequenceDiagram\n  A->>B: やあ\n```\n');
  const plain = new FakeHandle('notes.md', '# 図の無いメモ\n');
  const other = new FakeHandle('logo.svg', '<svg/>');
  const nested = new FakeHandle('state.mermaid', 'stateDiagram-v2\n  [*] --> A\n');
  const root = new FakeDirHandle('docs', [
    flow,
    readme,
    plain,
    other,
    new FakeDirHandle('sub', [nested]),
    new FakeDirHandle('node_modules', [new FakeHandle('x.mmd', 'graph TD\n  X\n')]),
    new FakeDirHandle('.git', [new FakeHandle('y.mmd', 'graph TD\n  Y\n')]),
  ]);
  return { root, flow, readme, nested };
}

describe('フォルダの中の図を集める', () => {
  it('.mmd・.mermaid と mermaid のブロックがある .md だけを、パスの順に集める（node_modules と . で始まるフォルダは読まない）', async () => {
    const { root } = repo();
    const r = await scanDirectory(asDir(root));
    expect(r.files.map((f) => f.path)).toEqual(['flow.mmd', 'README.md', 'sub/state.mermaid']);
    expect(r.truncated).toBe(false);
  });
});

describe('フォルダを開く', () => {
  it('開いたフォルダのファイルを開くと結び付きができ、上書き保存は元のファイルに書く', async () => {
    const { root, flow } = repo();
    installDirectoryPicker(root);
    installPickers(flow);
    await openFolder();
    const f = useFolders.getState().folders[0];
    expect(f.status).toBe('ready');
    expect(f.files).toHaveLength(3);

    await openFolderFile(f.files[0]);
    const cur = useSession.getState().current!;
    expect(cur.title).toBe('flow');
    expect(cur.file?.name).toBe('flow.mmd');
    // もう一度開いても、図を増やさない
    const count = useSession.getState().docs.length;
    await openFolderFile(f.files[0]);
    expect(useSession.getState().docs.length).toBe(count);

    useSession.getState().current && (await saveFile());
    expect(flow.writes).toBe(1);
  });

  it('同じフォルダをもう一度選んでも増やさない。許可が無ければ「許可」の状態にし、尋ねてから読む', async () => {
    const before = useFolders.getState().folders.length;
    await openFolder();
    expect(useFolders.getState().folders.length).toBe(before);

    const f = useFolders.getState().folders[0];
    const dir = f.handle as unknown as FakeDirHandle;
    dir.permission = 'prompt';
    await loadFolders();
    expect(useFolders.getState().folders[0].status).toBe('permission');
    await rescanFolder(f.id, true);
    expect(useFolders.getState().folders[0].status).toBe('ready');

    await closeFolder(f.id);
    expect(useFolders.getState().folders).toHaveLength(before - 1);
    expect(await db.listFolders()).toHaveLength(before - 1);
  });
});
