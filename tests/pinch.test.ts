import { describe, expect, it } from 'vitest';
import { pinchView } from '../src/ui/usePanZoom';

describe('ピンチでの拡大縮小', () => {
  const start = { scale: 1, x: 10, y: 20 };

  it('指の間が 2 倍に開けば 2 倍に拡大し、中点の下の図の位置は動かない', () => {
    const v = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(v.scale).toBeCloseTo(2);
    // 中点 (150, 100) の下にあった図の位置 (140, 80) が、拡大後も中点に来る
    expect(v.x + 140 * v.scale).toBeCloseTo(150);
    expect(v.y + 80 * v.scale).toBeCloseTo(100);
  });

  it('2 本の指をそろえて動かせばパンになる', () => {
    const v = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 140 }, { x: 230, y: 140 });
    expect(v).toEqual({ scale: 1, x: 40, y: 60 });
  });

  it('倍率は上限と下限に収める', () => {
    expect(pinchView(start, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }).scale).toBe(8);
    expect(pinchView(start, { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }).scale).toBe(0.1);
  });
});
