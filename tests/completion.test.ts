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
  it('本文（: の後・括弧や引用符の中）と日本語の語では自動で出さない（Ctrl+Space なら出す）', () => {
    const msg = 'sequenceDiagram\n  U->>S: リクエスト\n  S->>U: Re';
    expect(completeAt(msg, msg.length)).toBeNull();
    const ja = 'sequenceDiagram\n  participant 利用者\n  利';
    expect(completeAt(ja, ja.length)).toBeNull();
    expect(labels(completeAt(ja, ja.length, true))).toContain('利用者');
    const label = 'flowchart LR\n  Kensaku --> B[Ken';
    expect(completeAt(label, label.length)).toBeNull();
    const edge = 'flowchart LR\n  Kensaku -->|Ke';
    expect(completeAt(edge, edge.length)).toBeNull();
    // 閉じた括弧の後は本文の外
    const after = 'flowchart LR\n  Kensaku[検索] --> Ke';
    expect(labels(completeAt(after, after.length))).toContain('Kensaku');
  });
});