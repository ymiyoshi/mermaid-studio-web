import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as db from '../src/storage/db';
import { addSnippet, diagramKind, normalizeSnippet, snippetInsertion, useSnippets } from '../src/ui/snippets';

beforeEach(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

const apply = (src: string, r: { from: number; to: number; insert: string }) => src.slice(0, r.from) + r.insert + src.slice(r.to);

describe('部品集', () => {
  it('図種は宣言行の最初の語（frontmatter とコメントは飛ばす）', () => {
    expect(diagramKind('---\ntitle: x\n---\n%% メモ\nflowchart LR\n  A')).toBe('flowchart');
    expect(diagramKind('')).toBe('');
  });

  it('部品は共通のインデントと前後の空行を外してそろえる', () => {
    expect(normalizeSnippet('\n    A --> B\n      B --> C\n\n')).toBe('A --> B\n  B --> C');
  });

  it('カーソルのある行の下に、その行のインデントで差し込み、差し込んだ範囲を選ぶ', () => {
    const src = 'flowchart LR\n  A --> B\n  %% 残す\n';
    const r = snippetInsertion(src, { anchor: 15, head: 15 }, 'X --> Y\nY --> Z');
    expect(apply(src, r)).toBe('flowchart LR\n  A --> B\n  X --> Y\n  Y --> Z\n  %% 残す\n');
    const out = apply(src, r);
    expect(out.slice(r.selection.anchor, r.selection.head)).toBe('  X --> Y\n  Y --> Z');
  });

  it('宣言行の上なら本文のインデントにし、空の行ならその行を置き換える', () => {
    expect(apply('flowchart LR', snippetInsertion('flowchart LR', { anchor: 3, head: 3 }, 'A'))).toBe('flowchart LR\n    A');
    const src = 'flowchart LR\n  A\n\n';
    expect(apply(src, snippetInsertion(src, { anchor: 17, head: 17 }, 'B'))).toBe('flowchart LR\n  A\nB\n');
  });

  it('カーソルが宣言行より上（先頭のコメント・frontmatter）なら、宣言行の下に本文のインデントで差し込む', () => {
    const commented = '%% メモ\nflowchart LR\n  A --> B';
    expect(apply(commented, snippetInsertion(commented, { anchor: 0, head: 0 }, 'C --> D'))).toBe('%% メモ\nflowchart LR\n  C --> D\n  A --> B');
    const fm = '---\nconfig:\n  theme: dark\n---\nflowchart LR\n  A';
    expect(apply(fm, snippetInsertion(fm, { anchor: 5, head: 5 }, 'C'))).toBe('---\nconfig:\n  theme: dark\n---\nflowchart LR\n  C\n  A');
  });

  it('先頭が改行の文書で、カーソルが先頭にあっても範囲が逆にならない', () => {
    const src = '\nflowchart LR\n  A';
    const r = snippetInsertion(src, { anchor: 0, head: 0 }, 'B');
    expect(r.from).toBeLessThanOrEqual(r.to);
    expect(apply(src, r)).toBe('\nflowchart LR\n  B\n  A');
  });

  it('保存してある部品を読み終える前に登録しても、保存済みの部品を消さない', async () => {
    await db.putSetting('snippets', [{ id: 'old', name: '前からある', text: 'A', kind: 'flowchart', createdAt: 0 }]);
    useSnippets.setState({ loaded: false, items: [] });
    await addSnippet('新しい', 'B', 'flowchart');
    expect(useSnippets.getState().items.map((x) => x.name)).toEqual(['前からある', '新しい']);
    expect(((await db.getSetting<{ name: string }[]>('snippets')) ?? []).map((x) => x.name)).toEqual(['前からある', '新しい']);
  });
});