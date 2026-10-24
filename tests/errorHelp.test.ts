// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { explainError } from '../src/render/errorHelp';
import { validate } from '../src/render/mermaid';
import { applySpec } from '../src/plugins/source';

/** エラーの説明と、直し方を当てた結果。直し方は mermaid.parse を通り、対象の行以外を変えない */
async function check(source: string) {
  const v = await validate(source);
  if (v.ok) throw new Error('エラーにならない例です');
  const help = explainError(source, v.error);
  const fixed = help.fixes.length ? applySpec(source, help.fixes[0].spec) : null;
  if (fixed !== null) {
    const r = await validate(fixed);
    expect(r.ok, `直した結果が通らない: ${fixed}`).toBe(true);
  }
  return { help, fixed };
}

/** 直した結果で、変わった行の番号（0 始まり） */
function changedLines(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  return a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
}

describe('構文エラーの説明と直し方', () => {
  it('図種の書き間違いを、近い図種に直す', async () => {
    const src = '%% メモ\nflowchrt LR\n  A --> B';
    const { help, fixed } = await check(src);
    expect(help.summary).toContain('flowchrt');
    expect(help.fixes[0].label).toBe('「flowchart」に直す');
    expect(fixed).toBe('%% メモ\nflowchart LR\n  A --> B');
  });

  it('閉じていない括弧を、矢印の手前で閉じる', async () => {
    const src = 'flowchart LR\n  %% コメント\n  A[開始 --> B\n  B --> C';
    const { help, fixed } = await check(src);
    expect(help.summary).toBe('3 行目の「[」が閉じていません。');
    expect(fixed).toBe('flowchart LR\n  %% コメント\n  A[開始] --> B\n  B --> C');
    expect(changedLines(src, fixed!)).toEqual([2]);
  });

  it('閉じていない引用符を、閉じ括弧の手前で閉じる', async () => {
    const { fixed } = await check('flowchart LR\n  A["開始] --> B');
    expect(fixed).toBe('flowchart LR\n  A["開始"] --> B');
  });

  it('閉じていない subgraph と loop に end を足す（インデントを合わせる）', async () => {
    const { help, fixed } = await check('flowchart LR\n  subgraph S\n    A --> B\n');
    expect(help.summary).toBe('2 行目の subgraph が end で閉じていません。');
    expect(fixed).toBe('flowchart LR\n  subgraph S\n    A --> B\n  end\n');
    const seq = await check('sequenceDiagram\n  A->>B: hi\n  loop 毎分\n    B->>A: yo');
    expect(seq.fixed).toBe('sequenceDiagram\n  A->>B: hi\n  loop 毎分\n    B->>A: yo\n  end');
  });

  it('余分な end の行を消す', async () => {
    const src = 'sequenceDiagram\n  A->>B: hi\n  end\n  B->>A: yo';
    const { help, fixed } = await check(src);
    expect(help.summary).toBe('3 行目の end に対応する枠（subgraph や loop など）がありません。');
    expect(fixed).toBe('sequenceDiagram\n  A->>B: hi\n  B->>A: yo');
  });

  it('end をノードの名前に使っていたら End に直す', async () => {
    const { help, fixed } = await check('flowchart LR\n  A --> end');
    expect(help.summary).toContain('予約語');
    expect(fixed).toBe('flowchart LR\n  A --> End');
  });

  it('フローチャートの -> を --> に直す', async () => {
    const { fixed } = await check('flowchart LR\n  A -> B');
    expect(fixed).toBe('flowchart LR\n  A --> B');
  });

  it('シーケンス図と円グラフで足りない : を入れる', async () => {
    expect((await check('sequenceDiagram\n  A->>B こんにちは')).fixed).toBe('sequenceDiagram\n  A->>B: こんにちは');
    expect((await check('pie\n  "犬" 10\n  "猫" : 5')).fixed).toBe('pie\n  "犬" : 10\n  "猫" : 5');
  });

  it('閉じていないクラスの { を閉じる', async () => {
    const { fixed } = await check('classDiagram\n  class A {\n    +int x\n');
    expect(fixed).toBe('classDiagram\n  class A {\n    +int x\n  }\n');
  });

  it('ER 図の }o--o{ などは、閉じていない括弧と見なさない', async () => {
    const { help } = await check('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE ::');
    expect(help.summary).not.toContain('閉じていません');
  });

  it('当てはまらないエラーは、文面を日本語にするだけで直し方は出さない', async () => {
    const { help } = await check('flowchart LR\n  A --> B --> --> C');
    expect(help.summary).toMatch(/^2 行目: /);
    expect(help.fixes).toEqual([]);
  });
});
