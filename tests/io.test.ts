import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { findMermaidBlocks, replaceMermaidBlock, wrapAsMarkdown } from '../src/io/markdown';
import { buildBackup, parseBackup, remapEntry, type BackupEntry } from '../src/io/backup';
import { HistoryTree } from '../src/core/history';
import * as db from '../src/storage/db';
import { markdownWithDiagram } from '../src/io/files';

const MD = `# 設計メモ

説明の文章。

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

\`\`\`js
console.log('mermaid ではない');
\`\`\`

~~~mermaid
sequenceDiagram
  A->>B: hi
~~~
`;

describe('Markdown の mermaid ブロック', () => {
  it('mermaid のブロックだけを取り出す（``` と ~~~ の両方）', () => {
    const blocks = findMermaidBlocks(MD);
    expect(blocks.map((b) => b.text)).toEqual(['flowchart LR\n  A --> B\n', 'sequenceDiagram\n  A->>B: hi\n']);
  });

  it('指定したブロックの中身だけを差し替え、他の部分は変えない', () => {
    const out = replaceMermaidBlock(MD, 1, 'sequenceDiagram\n  B->>A: bye')!;
    expect(out).toBe(MD.replace('  A->>B: hi\n', '  B->>A: bye\n'));
    expect(findMermaidBlocks(out)[0].text).toBe('flowchart LR\n  A --> B\n');
  });

  it('CRLF の Markdown では改行をそろえる', () => {
    const crlf = MD.replace(/\n/g, '\r\n');
    const out = replaceMermaidBlock(crlf, 0, 'flowchart TD\n  X --> Y\n')!;
    expect(out).toContain('```mermaid\r\nflowchart TD\r\n  X --> Y\r\n```');
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('無いブロックは null', () => {
    expect(replaceMermaidBlock(MD, 5, 'x')).toBeNull();
  });

  it('閉じられていないブロックは数えない', () => {
    expect(findMermaidBlocks('```mermaid\nflowchart LR\n')).toHaveLength(0);
  });

  it('新しい .md はフェンスで囲む', () => {
    expect(wrapAsMarkdown('flowchart LR\n  A')).toBe('```mermaid\nflowchart LR\n  A\n```\n');
  });
});

function entry(id: string, text: string): BackupEntry {
  const tree = HistoryTree.create(id, text, 0);
  return {
    doc: { id, title: 't', text, headId: tree.headId, createdAt: 0, updatedAt: 0, deletedAt: null, tags: [] },
    history: tree.takeDirty(),
  };
}

describe('バックアップ', () => {
  it('書き出した JSON を読み戻せる', () => {
    const json = JSON.stringify(buildBackup([entry('a', 'flowchart LR')], 123));
    const back = parseBackup(json);
    expect(back.docs[0].doc.text).toBe('flowchart LR');
    expect(back.exportedAt).toBe(123);
  });

  it('形式の違う JSON は拒否する', () => {
    expect(() => parseBackup('{"hello":1}')).toThrow();
    expect(() => parseBackup('not json')).toThrow();
    expect(() => parseBackup(JSON.stringify({ ...buildBackup([]), version: 99 }))).toThrow();
  });

  it('復元するときは新しい docId を振り、履歴も付け替える', () => {
    const e = entry('old', 'x');
    const r = remapEntry({ ...e, doc: { ...e.doc, deletedAt: 5 } }, 'new');
    expect(r.doc.id).toBe('new');
    expect(r.doc.deletedAt).toBeNull();
    expect(r.history.every((n) => n.docId === 'new')).toBe(true);
    expect(r.history.map((n) => n.id)).toEqual(e.history.map((n) => n.id));
  });

  it('head が履歴に無ければルートに戻す', () => {
    const e = entry('old', 'x');
    const r = remapEntry({ ...e, doc: { ...e.doc, headId: 'missing' } }, 'new');
    expect(r.doc.headId).toBe(e.history[0].id);
  });
});

describe('IndexedDB の版上げ', () => {
  beforeEach(async () => {
    await db.resetDbConnection();
    indexedDB.deleteDatabase('mermaid-studio');
  });

  it('版 1 のデータを残したまま files ストアを追加する', async () => {
    const v1 = await openDB('mermaid-studio', 1, {
      upgrade(d) {
        d.createObjectStore('documents', { keyPath: 'id' });
        d.createObjectStore('history', { keyPath: ['docId', 'id'] }).createIndex('byDoc', 'docId');
        d.createObjectStore('settings', { keyPath: 'key' });
      },
    });
    await v1.put('documents', { id: 'd1', title: 'old', text: 'graph TD', headId: 'h', createdAt: 0, updatedAt: 0, deletedAt: null, tags: [] });
    v1.close();

    expect((await db.getDoc('d1'))?.title).toBe('old');
    await db.putFileBinding({
      docId: 'd1',
      name: 'a.mmd',
      kind: 'mermaid',
      blockIndex: 0,
      handle: null,
      lastModified: 1,
      savedText: 'graph TD',
      markdown: null,
    });
    expect((await db.getFileBinding('d1'))?.name).toBe('a.mmd');
    await db.purgeDoc('d1');
    expect(await db.getFileBinding('d1')).toBeUndefined();
  });
});

describe('既存の .md に保存', () => {
  it('読み込んだときと同じ番号のブロックを差し替える', () => {
    const r = markdownWithDiagram(MD, 'sequenceDiagram\n  Z->>Z: new', 1);
    expect(r.blockIndex).toBe(1);
    expect(findMermaidBlocks(r.content)[1].text).toBe('sequenceDiagram\n  Z->>Z: new\n');
    expect(findMermaidBlocks(r.content)[0].text).toBe('flowchart LR\n  A --> B\n');
  });

  it('mermaid ブロックの無い .md には末尾に足し、本文は残す', () => {
    const r = markdownWithDiagram('# 見出し\n本文\n', 'flowchart LR', 0);
    expect(r.content).toBe('# 見出し\n本文\n\n```mermaid\nflowchart LR\n```\n');
  });
});

describe('URL 共有', () => {
  it('図を fragment に入れて戻せる（日本語・長い図も）', async () => {
    const { encodeShare, decodeShare, shareUrl } = await import('../src/io/share');
    const text = 'flowchart LR\n' + Array.from({ length: 200 }, (_, i) => `  N${i}[ノード${i}] --> N${i + 1}`).join('\n');
    const hash = encodeShare({ title: '共有テスト', text });
    expect(hash.startsWith('#v1/')).toBe(true);
    expect(hash).toMatch(/^#v1\/[A-Za-z0-9_-]+$/);
    expect(decodeShare(hash)).toEqual({ title: '共有テスト', text });
    expect(shareUrl({ title: 'x', text: 'graph TD' }, 'https://example.com/app/#old')).toMatch(/^https:\/\/example\.com\/app\/#v1\//);
  });

  it('壊れた fragment は null', async () => {
    const { decodeShare } = await import('../src/io/share');
    expect(decodeShare('#v1/!!!')).toBeNull();
    expect(decodeShare('#other')).toBeNull();
  });
});
