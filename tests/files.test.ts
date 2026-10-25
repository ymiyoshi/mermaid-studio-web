// @vitest-environment jsdom
// ローカルファイルの読み書き（設計書 §9.3）・バックアップ・URL 共有の結合テスト。
import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { applyChanges, useSession } from '../src/core/session';
import { checkExternalChange, ignoreExternalChange, importFile, reloadFromFile, saveFile } from '../src/io/files';
import { exportBackup, importBackupFile } from '../src/io/backup';
import { copyShareLink, importFromLocationHash } from '../src/io/shareActions';
import { encodeShare } from '../src/io/share';
import { useIo } from '../src/io/ioStore';
import { findMermaidBlocks } from '../src/io/markdown';
import * as db from '../src/storage/db';
import { captureDownloads, FakeHandle, installPickers } from './helpers/fakeFs';

const MD = '# メモ\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n本文\n\n```mermaid\nsequenceDiagram\n  X->>Y: hi\n```\n';

const cur = () => useSession.getState().current!;
const text = () => cur().text.toString();
const toast = () => useSession.getState().toast?.message ?? '';
const historyLabels = () => [...cur().tree.nodes.values()].sort((a, b) => a.depth - b.depth).map((n) => n.label);

/** エディタで末尾に文字を足したことにする */
function typeAtEnd(s: string) {
  const len = cur().text.length;
  applyChanges(ChangeSet.of({ from: len, insert: s }, len), { origin: 'typing', fromEditor: true });
}

/** Markdown の図を選ぶダイアログが出たら、index 番目を選ぶ */
function chooseBlockWhenAsked(index: number) {
  const off = useIo.subscribe((s) => {
    if (s.blockPicker) {
      off();
      s.blockPicker.resolve(index);
    }
  });
}

/** hold() してから release() するまで getFile を待たせるハンドル（権限の確認などで待つ間を作る） */
class GatedHandle extends FakeHandle {
  private gate: Promise<void> | null = null;
  hold() {
    let release!: () => void;
    this.gate = new Promise((r) => (release = r));
    return () => {
      this.gate = null;
      release();
    };
  }
  async getFile() {
    if (this.gate) await this.gate;
    return super.getFile();
  }
}

let downloads: ReturnType<typeof captureDownloads>;

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

beforeEach(() => {
  downloads = captureDownloads();
  useIo.setState({ blockPicker: null, conflict: null, exportOpen: false });
});

describe('読み込み', () => {
  it('.mmd を読むと新しい図になり、ファイルと結び付く', async () => {
    installPickers(null);
    await importFile(new File(['graph TD\r\n  A --> B\r\n'], 'a.mmd', { lastModified: 5 }), null);
    expect(cur().title).toBe('a');
    expect(text()).toBe('graph TD\n  A --> B\n');
    expect(cur().file).toMatchObject({ name: 'a.mmd', kind: 'mermaid', lastModified: 5, savedText: 'graph TD\n  A --> B\n' });
    expect(historyLabels()).toEqual(['ファイルから読み込み']);
  });

  it('mermaid ブロックが複数ある .md では、どれを開くか選ぶ', async () => {
    chooseBlockWhenAsked(1);
    await importFile(new File([MD], 'memo.md'), null);
    expect(cur().title).toBe('memo #2');
    expect(text()).toBe('sequenceDiagram\n  X->>Y: hi\n');
    expect(cur().file).toMatchObject({ kind: 'markdown', blockIndex: 1, markdown: MD });
  });

  it('選ぶダイアログを閉じたら何も作らない', async () => {
    const before = useSession.getState().docs.length;
    const off = useIo.subscribe((s) => s.blockPicker?.resolve(null));
    await importFile(new File([MD], 'memo.md'), null);
    off();
    expect(useSession.getState().docs.length).toBe(before);
  });

  it('mermaid ブロックの無い .md は知らせるだけ', async () => {
    const before = useSession.getState().docs.length;
    await importFile(new File(['# 見出しだけ'], 'empty.md'), null);
    expect(useSession.getState().docs.length).toBe(before);
    expect(toast()).toContain('mermaid のコードブロックがありません');
  });
});

describe('保存（File System Access API）', () => {
  it('結び付いた .md の該当ブロックだけを上書きする', async () => {
    const h = new FakeHandle('memo.md', MD);
    installPickers(h);
    chooseBlockWhenAsked(1);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    typeAtEnd('  Y-->>X: yo\n');
    await saveFile();
    expect(h.writes).toBe(1);
    expect(findMermaidBlocks(h.content).map((b) => b.text)).toEqual(['flowchart LR\n  A --> B\n', 'sequenceDiagram\n  X->>Y: hi\n  Y-->>X: yo\n']);
    expect(h.content.startsWith('# メモ\n\n')).toBe(true);
    expect(cur().file!.savedText).toBe(text());
    expect(toast()).toContain('memo.md');
  });

  it('外部で変更されていたら上書きせずに確認し、force で上書きする', async () => {
    const h = new FakeHandle('c.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    h.touch('graph TD\n  Z\n');
    typeAtEnd('  B\n');
    await saveFile();
    expect(h.writes).toBe(0);
    expect(useIo.getState().conflict).toMatchObject({ name: 'c.mmd', localChanges: true });
    await saveFile({ force: true });
    expect(h.content).toBe('graph TD\n  A\n  B\n');
    expect(useIo.getState().conflict).toBeNull();
  });

  it('保存先が無ければ選んでもらい、既存の .md にブロックが無ければ末尾に足す', async () => {
    installPickers(null);
    await importFile(new File(['graph LR\n  P --> Q\n'], 'new.mmd'), null);
    const target = new FakeHandle('notes.md', '# ノート\n本文\n');
    installPickers(target, target);
    await saveFile({ saveAs: true });
    expect(target.content).toBe('# ノート\n本文\n\n```mermaid\ngraph LR\n  P --> Q\n```\n');
    expect(cur().file).toMatchObject({ name: 'notes.md', kind: 'markdown', blockIndex: 0 });
  });
});

describe('外部での変更', () => {
  it('未保存の変更が無ければ黙って読み込み直す（履歴は 1 ステップ）', async () => {
    const h = new FakeHandle('e.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    h.touch('graph TD\n  A --> B\n');
    await checkExternalChange();
    expect(text()).toBe('graph TD\n  A --> B\n');
    expect(historyLabels()).toEqual(['ファイルから読み込み', '「e.mmd」から再読み込み']);
    expect(cur().file!.lastModified).toBe(h.mtime);
  });

  it('未保存の変更があれば確認のバナーを出し、無視すると次からは聞かない', async () => {
    const h = new FakeHandle('f.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    typeAtEnd('  B\n');
    h.touch('graph TD\n  X\n');
    await checkExternalChange();
    expect(useIo.getState().conflict).toMatchObject({ localChanges: true });
    expect(text()).toBe('graph TD\n  A\n  B\n');
    await ignoreExternalChange();
    expect(useIo.getState().conflict).toBeNull();
    await checkExternalChange();
    expect(useIo.getState().conflict).toBeNull();
  });

  it('ファイルを待つ間に入力したら、黙って読み込み直さずに確認のバナーを出す', async () => {
    const h = new GatedHandle('g.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    h.touch('graph TD\n  X\n');
    const release = h.hold();
    const checking = checkExternalChange();
    await Promise.resolve();
    typeAtEnd('  B\n');
    release();
    await checking;
    expect(text()).toBe('graph TD\n  A\n  B\n');
    expect(useIo.getState().conflict).toMatchObject({ localChanges: true });
  });

  it('再読み込みでファイルを待つ間に入力しても、ファイルの内容に置き換わる', async () => {
    const h = new GatedHandle('h.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    h.touch('graph TD\n  X --> Y\n');
    const release = h.hold();
    const reloading = reloadFromFile();
    await Promise.resolve();
    typeAtEnd('  B\n');
    release();
    await reloading;
    expect(text()).toBe('graph TD\n  X --> Y\n');
    expect(cur().file).toMatchObject({ savedText: 'graph TD\n  X --> Y\n', lastModified: h.mtime });
  });

  it('再読み込みでファイルを待つ間に別の図へ切り替えたら、切り替え後の図には触れない', async () => {
    const h = new GatedHandle('i.mmd', 'graph TD\n  A\n');
    installPickers(h);
    await importFile(await h.getFile(), h as unknown as FileSystemFileHandle);
    h.touch('graph TD\n  X --> Y\n');
    const release = h.hold();
    const reloading = reloadFromFile();
    await Promise.resolve();
    installPickers(null);
    await importFile(new File(['graph LR\n  P\n'], 'other.mmd', { lastModified: 5 }), null);
    release();
    await reloading;
    expect(cur().title).toBe('other');
    expect(text()).toBe('graph LR\n  P\n');
    expect(historyLabels()).toEqual(['ファイルから読み込み']);
  });
});

describe('保存（API の無いブラウザ）', () => {
  it('ダウンロードで保存し、.md は元の Markdown の該当ブロックを差し替える', async () => {
    installPickers(null);
    chooseBlockWhenAsked(0);
    await importFile(new File([MD], 'memo.md'), null);
    typeAtEnd('  B --> C\n');
    await saveFile();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('memo.md');
    const content = await downloads[0].blob.text();
    expect(findMermaidBlocks(content)[0].text).toBe('flowchart LR\n  A --> B\n  B --> C\n');
    expect(findMermaidBlocks(content)[1].text).toBe('sequenceDiagram\n  X->>Y: hi\n');
  });
});

describe('バックアップ', () => {
  it('書き出した JSON を読み込むと、同じ数の図が新しく増える（履歴つき）', async () => {
    await exportBackup();
    expect(downloads).toHaveLength(1);
    const json = await downloads[0].blob.text();
    const exported = JSON.parse(json).docs.length;
    const before = useSession.getState().docs.length;
    await importBackupFile(new File([json], 'backup.json'));
    expect(useSession.getState().docs.length).toBe(before + exported);
    expect(toast()).toContain(`${exported} 件の図を復元しました`);
  });

  it('.json をファイルとして読み込むと、バックアップの復元になる', async () => {
    const before = useSession.getState().docs.length;
    await importFile(new File(['{"bad":true}'], 'x.json'), null);
    expect(useSession.getState().docs.length).toBe(before);
    expect(toast()).toContain('バックアップファイルではありません');
  });
});

describe('URL 共有', () => {
  it('共有リンクをコピーし、そのリンクを開くと新しい図として取り込む', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => void (copied = s) }, configurable: true });
    await copyShareLink();
    expect(copied).toContain('#v1/');
    expect(toast()).toContain('共有リンクをコピーしました');

    const sharedText = 'flowchart LR\n  S[共有] --> T\n';
    location.hash = encodeShare({ title: '共有された図', text: sharedText });
    await importFromLocationHash();
    expect(location.hash).toBe('');
    expect(cur().title).toBe('共有された図');
    expect(text()).toBe(sharedText);
    expect(historyLabels()).toEqual(['共有リンクから読み込み']);
  });

  it('壊れたリンクは取り込まない', async () => {
    const before = useSession.getState().docs.length;
    location.hash = '#v1/!!!';
    await importFromLocationHash();
    expect(useSession.getState().docs.length).toBe(before);
    expect(toast()).toContain('読み取れませんでした');
  });
});
