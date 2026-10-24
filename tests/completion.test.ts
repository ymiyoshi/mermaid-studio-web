import { describe, expect, it } from 'vitest';
import { completeAt } from '../src/render/completion';

const labels = (r: ReturnType<typeof completeAt>) => r?.options.map((o) => o.label) ?? [];

describe('入力補完', () => {
  it('宣言行では図種を出す', () => {
    const r = completeAt('seq', 3);
    expect(r?.from).toBe(0);
    expect(labels(r)).toContain('sequenceDiagram');
  });

  it('図種に合った書き方と、文書の中にある名前を出す', () => {
    const src = 'sequenceDiagram\n  participant Alice\n  Alice->>Bob: こんにちは\n  Al';
    const r = completeAt(src, src.length);
    expect(r?.from).toBe(src.length - 2);
    expect(labels(r)).toContain('participant');
    expect(labels(r)).toContain('Alice');
    expect(labels(r)).toContain('Bob');
    // フローチャートの書き方は出さない
    expect(labels(r)).not.toContain('subgraph');
  });

  it('いま打っている語そのものは名前の候補にしない', () => {
    const src = 'flowchart LR\n  A --> Bx';
    expect(labels(completeAt(src, src.length))).not.toContain('Bx');
  });

  it('@{ shape: の後は形の名前を出す', () => {
    const src = 'flowchart LR\n  A@{ shape: do';
    const r = completeAt(src, src.length);
    expect(labels(r)).toContain('doc');
    expect(r?.options.find((o) => o.label === 'doc')?.detail).toBe('書類');
  });

  it('コメントの中と、何も打っていないときは出さない（Ctrl+Space なら出す）', () => {
    expect(completeAt('flowchart LR\n  %% su', 21)).toBeNull();
    const src = 'flowchart LR\n  ';
    expect(completeAt(src, src.length)).toBeNull();
    expect(labels(completeAt(src, src.length, true))).toContain('subgraph');
  });
});
