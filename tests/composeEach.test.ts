import { describe, expect, it } from 'vitest';
import { composeEach, applySpec } from '../src/plugins/source';

describe('まとめて編集の変更', () => {
  it('前の変更を当てた後のソースで次の変更を作り、1 つの変更にまとめる', () => {
    const src = 'a b c';
    // それぞれの文字を、いまのソースでの位置を探して大文字にする（前の変更で長さが変わっても合う）
    const cs = composeEach(src, ['a', 'c'], (s, x) => ({ from: s.indexOf(x), to: s.indexOf(x) + 1, insert: x.toUpperCase().repeat(3) }));
    expect(applySpec(src, cs!)).toBe('AAA b CCC');
  });

  it('作れない要素は飛ばし、1 つも作れなければ null', () => {
    expect(composeEach('a', ['x'], () => null)).toBeNull();
    const cs = composeEach('a b', ['a', 'z'], (s, x) => (s.includes(x) ? { from: s.indexOf(x), to: s.indexOf(x) + 1 } : null));
    expect(applySpec('a b', cs!)).toBe(' b');
  });
});
