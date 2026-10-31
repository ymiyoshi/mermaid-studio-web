import { describe, expect, it } from 'vitest';
import { keyName, nearestInDirection, parseKeys, parseTravel } from '../src/ui/viKeys';

// vi のキーバインド（設計書 §16）の、DOM に依存しない部分。

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  keyName({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('keyName', () => {
  it('文字はそのまま、特別なキーは vim の書き方にする', () => {
    expect(key('j')).toBe('j');
    expect(key('G')).toBe('G');
    expect(key('?')).toBe('?');
    expect(key(' ')).toBe('<Space>');
    expect(key('Enter')).toBe('<CR>');
    expect(key('Escape')).toBe('<Esc>');
    expect(key('r', { ctrlKey: true })).toBe('<C-r>');
  });

  it('修飾キーだけ・Alt / Meta つき・扱わないキーは null', () => {
    expect(key('Shift')).toBeNull();
    expect(key('Tab')).toBeNull();
    expect(key('ArrowUp')).toBeNull();
    expect(key('j', { altKey: true })).toBeNull();
    expect(key('s', { metaKey: true })).toBeNull();
  });
});

describe('parseKeys', () => {
  const table = ['j', 'g g', 'g t', 'd d', '<Space> e', ':'];

  it('1 つのキーのコマンドと、続けて打つコマンドを読む', () => {
    expect(parseKeys(['j'], table)).toEqual({ kind: 'run', cmd: 'j', count: 1 });
    expect(parseKeys(['g'], table)).toEqual({ kind: 'pending' });
    expect(parseKeys(['g', 'g'], table)).toEqual({ kind: 'run', cmd: 'g g', count: 1 });
    expect(parseKeys(['<Space>', 'e'], table)).toEqual({ kind: 'run', cmd: '<Space> e', count: 1 });
  });

  it('先頭の数字は回数（0 からは始まらない）', () => {
    expect(parseKeys(['3', 'j'], table)).toEqual({ kind: 'run', cmd: 'j', count: 3 });
    expect(parseKeys(['1', '2', 'j'], table)).toEqual({ kind: 'run', cmd: 'j', count: 12 });
    expect(parseKeys(['2'], table)).toEqual({ kind: 'pending' });
    expect(parseKeys(['0'], table)).toEqual({ kind: 'none' });
  });

  it('どのコマンドにも合わなければ none（標準のキー操作に任せる）', () => {
    expect(parseKeys(['q'], table)).toEqual({ kind: 'none' });
    expect(parseKeys(['g', 'x'], table)).toEqual({ kind: 'none' });
    expect(parseKeys(['d', 'j'], table)).toEqual({ kind: 'none' });
  });
});

describe('nearestInDirection', () => {
  const box = (left: number, top: number) => ({ left, top, width: 20, height: 20 });
  const from = box(100, 100);

  it('その向きに進んでいる要素のうち、向きから外れていないものを選ぶ', () => {
    const cands = [box(100, 200), box(140, 130), box(300, 100), box(100, 0)];
    // 下: 斜め下（30 下・40 右）より、真下（100 下）を選ぶ
    expect(nearestInDirection(from, cands, 'j')).toBe(0);
    expect(nearestInDirection(from, cands, 'k')).toBe(3);
    expect(nearestInDirection(from, cands, 'l')).toBe(1);
    expect(nearestInDirection(from, cands, 'h')).toBe(-1);
  });

  it('同じだけ進む要素なら、真っすぐ先にある要素を選ぶ', () => {
    const cands = [box(180, 160), box(100, 160)];
    expect(nearestInDirection(from, cands, 'j')).toBe(1);
  });
});

describe('parseTravel', () => {
  it('数だけなら回数、単位が付けば時間（ミリ秒）', () => {
    expect(parseTravel('')).toEqual({ steps: 1 });
    expect(parseTravel('5')).toEqual({ steps: 5 });
    expect(parseTravel('30s')).toEqual({ ms: 30_000 });
    expect(parseTravel('10m')).toEqual({ ms: 600_000 });
    expect(parseTravel('2h')).toEqual({ ms: 7_200_000 });
    expect(parseTravel('abc')).toBeNull();
  });
});
