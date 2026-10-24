import { describe, expect, it } from 'vitest';
import { composeEach, applySpec } from '../src/plugins/source';

describe('まとめて編集の変更', () => {
  it('前の変更を当てた後のソースで次の変更を作り、1 つの変更にまとめる', () => {
    const src = 'a b c';
    // それぞれの文字を、いまのソースでの位置を探して大文字にする（前の変更で長さが変わっても合う）
    const cs = composeEach(src, ['a', 'c'], (s, x) => ({ from: s.indexOf(x), to: s.indexOf(x) + 1, insert: x.toUpperCase().repeat(3) }));
    expect(applySpec(src, cs!)).toBe('AAA b CCC');
  });

  it('番号で指す要素でも、すべて元のソースで作るので、先の変更で番号がずれない', () => {
    const src = 'l0\nl1\nl2\nl3\n';
    // 行番号で消す（先に 1 行目を消しても、3 行目は元の 3 行目のまま）
    const line = (s: string, k: number) => {
      const from = s.split('\n').slice(0, k).join('\n').length + (k ? 1 : 0);
      return { from, to: from + 3 };
    };
    expect(applySpec(src, composeEach(src, [1, 3], line, () => true)!)).toBe('l0\nl2\n');
    // 先に消した範囲の中を消す変更は、何もしない（ノードを消すとその行のエッジも消える、のような重なり）
    expect(applySpec('abcdef', composeEach('abcdef', [{ from: 1, to: 5 }, { from: 2, to: 3 }], (_, x) => x, () => true)!)).toBe('af');
  });

  it('ID で指す要素は、前の変更を当てた後のソースで順に作る（番号で指す要素の後に）', () => {
    // 前の変更で書き戻した文字も、後の変更が見て消せる
    const src = 'C --> E\nD --> E\n';
    const cs = composeEach(src, ['C', 'E'], (s, id) => (id === 'C' ? { from: 0, to: 6 } : { from: s.indexOf('E'), to: s.length }))!;
    expect(applySpec(src, cs)).toBe('');
  });

  it('作れない要素は飛ばし、1 つも作れなければ null', () => {
    expect(composeEach('a', ['x'], () => null)).toBeNull();
    const cs = composeEach('a b', ['a', 'z'], (s, x) => (s.includes(x) ? { from: s.indexOf(x), to: s.indexOf(x) + 1 } : null));
    expect(applySpec('a b', cs!)).toBe(' b');
  });
});
