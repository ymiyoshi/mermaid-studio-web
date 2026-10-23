import { describe, expect, it } from 'vitest';
import { findUniqueRange } from '../src/plugins/generic';
import { toSourceLine } from '../src/render/mermaid';

describe('findUniqueRange', () => {
  const src = `flowchart TD
    %% 開始 はコメント中にもある
    A[開始] --> B{条件を満たす?}
    B -->|はい| C[処理]
`;

  it('一意なラベルの範囲を返す', () => {
    const r = findUniqueRange(src, '条件を満たす?')!;
    expect(src.slice(r.from, r.to)).toBe('条件を満たす?');
  });

  it('コメント中の出現は数えない', () => {
    const r = findUniqueRange(src, '開始')!;
    expect(src.slice(r.from - 2, r.to + 1)).toBe('A[開始]');
  });

  it('単語の一部としての出現は数えない', () => {
    expect(findUniqueRange('graph TD\n  A --> AB', 'A')).toEqual({ from: 11, to: 12 });
  });

  it('複数回現れるラベルは特定できない', () => {
    expect(findUniqueRange('graph TD\n  A[x] --> B[x]', 'x')).toBeNull();
  });

  it('frontmatter の中は対象外', () => {
    const s = '---\ntitle: 開始\n---\nflowchart TD\n  A[開始]';
    const r = findUniqueRange(s, '開始')!;
    expect(s.slice(r.from - 2, r.from)).toBe('A[');
  });
});

describe('toSourceLine', () => {
  it('mermaid が取り除くコメント行と frontmatter を数えずに行番号を戻す', () => {
    const src = '---\ntitle: x\n---\nflowchart TD\n  %% c\n  A --> B\n  B --> (';
    // 取り除いた後: 1=flowchart TD, 2=A --> B, 3=B --> (
    expect(toSourceLine(src, 3)).toBe(7);
    expect(toSourceLine(src, 1)).toBe(4);
  });
});
