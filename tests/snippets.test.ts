import { describe, expect, it } from 'vitest';
import { diagramKind, normalizeSnippet, snippetInsertion } from '../src/ui/snippets';

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
    expect(apply(src, snippetInsertion(src, { anchor: 17, head: 17 }, 'B'))).toBe('flowchart LR\n  A\n    B\n');
  });
});
