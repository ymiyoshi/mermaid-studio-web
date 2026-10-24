import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { findMermaidBlocks, replaceMermaidBlock, wrapAsMarkdown } from '../src/io/markdown';
import { buildBackup, parseBackup, remapEntry, type BackupEntry } from '../src/io/backup';
import { ChangeSet, Text } from '@codemirror/state';
import { deflateSync, strToU8 } from 'fflate';
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

  it('分岐・まとめ・整理をした実際の履歴は受け付ける', () => {
    let text = Text.of(['flowchart LR']);
    const tree = HistoryTree.create('a', text.toString(), 0);
    let ts = 1;
    const add = (s: string, coalesce = false) => {
      const cs = ChangeSet.of({ from: text.length, insert: s }, text.length);
      const sel = { anchor: 0, head: 0 };
      tree.commit(cs, text, { origin: 'typing', label: s, groupKey: 'g', selBefore: sel, selAfter: sel, ts: ts++, coalesce });
      text = cs.apply(text);
    };
    for (let i = 0; i < 25; i++) add(`\n  N${i}`, i % 3 === 0);
    text = tree.undo()!.changes.apply(text);
    add('\n  X');
    text = tree.undo()!.changes.apply(text);
    add('\n  Y');
    const all = [...tree.nodes.values()];
    const json = JSON.stringify(buildBackup([{ doc: { ...entry('a', '').doc, text: text.toString(), headId: tree.headId }, history: all }]));
    expect(parseBackup(json).docs[0].history).toHaveLength(all.length);
    tree.pruneBranches();
    const pruned = JSON.stringify(buildBackup([{ doc: { ...entry('a', '').doc, headId: tree.headId }, history: [...tree.nodes.values()] }]));
    expect(() => parseBackup(pruned)).not.toThrow();
  });

  describe('壊れた・細工された履歴は拒否する', () => {
    const base = () => {
      let text = Text.of(['a']);
      const tree = HistoryTree.create('a', 'a', 0);
      for (const s of ['b', 'c']) {
        const cs = ChangeSet.of({ from: text.length, insert: s }, text.length);
        const sel = { anchor: 0, head: 0 };
        tree.commit(cs, text, { origin: 'typing', label: s, groupKey: null, selBefore: sel, selAfter: sel, ts: 1, coalesce: false });
        text = cs.apply(text);
      }
      const [root, b, c] = structuredClone(tree.takeDirty());
      return { root, b, c };
    };
    const reject = (history: unknown[]) => {
      const json = JSON.stringify(buildBackup([{ doc: entry('a', 'abc').doc, history } as BackupEntry]));
      expect(() => parseBackup(json)).toThrow();
    };

    it('親が循環している', () => {
      const { root, b, c } = base();
      b.parentId = c.id;
      c.children = [b.id];
      root.children = [];
      reject([root, b, c]);
    });
    it('子が循環している', () => {
      const { root, b, c } = base();
      c.children = [b.id];
      reject([root, b, c]);
    });
    it('ルートが 2 つ・ルートが無い', () => {
      const { root, b, c } = base();
      reject([root, b, { ...c, parentId: null }]);
      reject([b, c]);
    });
    it('id が重複している', () => {
      const { root, b, c } = base();
      reject([root, b, c, c]);
    });
    it('変更が JSON として壊れている・長さが合わない', () => {
      const { root, b, c } = base();
      reject([root, b, { ...c, forward: 'garbage' }]);
      reject([root, b, { ...c, inverse: { x: 1 } }]);
      reject([root, { ...b, forward: ChangeSet.of({ from: 0, insert: 'zz' }, 5).toJSON() }, c]);
    });
    it('選択範囲などの型が違う', () => {
      const { root, b, c } = base();
      reject([root, b, { ...c, selBefore: null }]);
      reject([root, b, { ...c, children: [1] }]);
      reject([root, b, { ...c, snapshot: 5 }]);
    });
  });

  // 保存用の内部の形（圧縮したスナップショット snapshotZ）を持ち込ませない。持ち込めると、
  // 長さの確認を通らないスナップショットが入ったり、開くときに展開に失敗したりする（§8.5）
  it('バックアップの形に無い項目は、復元するときに捨てる', () => {
    const e = entry('old', 'x');
    const snapshotZ = [...deflateSync(strToU8('y'.repeat(1000)))];
    const crafted = { ...e, history: [{ ...e.history[0], snapshotZ, extra: 1 }] } as unknown as BackupEntry;
    const json = JSON.stringify(buildBackup([crafted]));
    const r = remapEntry(parseBackup(json).docs[0], 'new');
    expect(Object.keys(r.history[0]).sort()).toEqual(Object.keys(e.history[0]).concat('docId').filter((k, i, a) => a.indexOf(k) === i).sort());
    expect(db.decodeNode(db.encodeNode(r.history[0])).snapshot).toBe('x');
  });

  it('名前付きチェックポイントの名前は残し、文字列でなければ拒否する', () => {
    const e = entry('old', 'x');
    const named = { ...e, history: [{ ...e.history[0], name: '版 1' }] };
    expect(remapEntry(parseBackup(JSON.stringify(buildBackup([named]))).docs[0], 'new').history[0].name).toBe('版 1');
    const bad = { ...e, history: [{ ...e.history[0], name: 5 }] };
    expect(() => parseBackup(JSON.stringify(buildBackup([bad as unknown as BackupEntry])))).toThrow();
  });

  // 細工したバックアップで、復元の確認だけでタブが固まらないこと（親子の確認が子の数の二乗にならない）
  it('ルートの直下に子がとても多い履歴でも、すぐに確かめ終わる', () => {
    const e = entry('a', 'x');
    const root = e.history[0];
    const empty = ChangeSet.empty(1).toJSON();
    const kids = Array.from({ length: 50_000 }, (_, i) => ({ ...root, id: `k${i}`, parentId: root.id, depth: 1, snapshot: null, forward: empty, inverse: empty }));
    const json = JSON.stringify(buildBackup([{ ...e, history: [{ ...root, children: kids.map((k) => k.id) }, ...kids] }]));
    const t0 = performance.now();
    parseBackup(json);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('タグの文字列以外は捨てる', () => {
    const e = entry('old', 'x');
    const r = remapEntry({ ...e, doc: { ...e.doc, tags: ['a', 1, null] as unknown as string[] } }, 'new');
    expect(r.doc.tags).toEqual(['a']);
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

  it('展開すると巨大になる fragment（展開爆弾）は、上限を超えた時点でやめて null', async () => {
    const { decodeShare, SHARE_MAX_BYTES, SHARE_PREFIX } = await import('../src/io/share');
    const { deflateSync, strToU8 } = await import('fflate');
    const bomb = (n: number) => {
      const bytes = deflateSync(strToU8(JSON.stringify({ t: 'x', s: 'A'.repeat(n) })), { level: 9 });
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return SHARE_PREFIX + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    expect(decodeShare(bomb(20 * 1024 * 1024))).toBeNull();
    expect(decodeShare(bomb(SHARE_MAX_BYTES))).toBeNull();
    // 上限より小さければ読める
    expect(decodeShare(bomb(SHARE_MAX_BYTES - 100))?.text).toHaveLength(SHARE_MAX_BYTES - 100);
  });

  it('途中で切れた fragment は null', async () => {
    const { decodeShare, encodeShare } = await import('../src/io/share');
    const text = 'flowchart LR\n' + Array.from({ length: 300 }, (_, i) => `  N${i} --> M${i * 7}`).join('\n');
    const hash = encodeShare({ title: 't', text });
    expect(decodeShare(hash.slice(0, hash.length - 20))).toBeNull();
  });
});
