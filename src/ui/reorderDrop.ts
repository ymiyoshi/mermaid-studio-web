import type { Rect } from './usePanZoom';

// ドラッグでの並べ替えの、落とし先の決め方（DOM に依存しない計算だけ）。
// 候補の要素ごとに「前に落とす」「後ろに落とす」の位置を考え、ポインタに一番近いものを選ぶ。

export interface DropCandidate<T> {
  item: T;
  /** 図ビューの座標での、要素の範囲 */
  rect: Rect;
  /** 他の候補を含む要素（枠など）か。省略すると findDrop が求める */
  container?: boolean;
}

export interface DropSpot<T> {
  item: T;
  before: boolean;
  /** 落とす位置を示す線（図ビューの座標） */
  line: Rect;
}

/** a が b を含むか（同じ範囲のオブジェクトは含まない） */
export const contains = (a: Rect, b: Rect) =>
  a !== b && a.left <= b.left && a.top <= b.top && a.left + a.width >= b.left + b.width && a.top + a.height >= b.top + b.height;

/**
 * axis の向きに、ポインタに一番近い落とし先を選ぶ。
 * 他の候補を含む要素（枠など）は、中を指しているときに選ばれないよう、端（前に落とすなら始まり、後ろなら終わり）までの距離で比べる
 */
export function findDrop<T>(axis: 'x' | 'y', pointer: { x: number; y: number }, candidates: DropCandidate<T>[]): DropSpot<T> | null {
  let best: { spot: DropSpot<T>; dist: number } | null = null;
  const consider = (item: T, before: boolean, dist: number, line: Rect) => {
    if (!best || dist < best.dist) best = { spot: { item, before, line }, dist };
  };
  for (const c of candidates) {
    const r = c.rect;
    const container = c.container ?? candidates.some((o) => contains(r, o.rect));
    const start = axis === 'y' ? r.top : r.left;
    const size = axis === 'y' ? r.height : r.width;
    const p = axis === 'y' ? pointer.y : pointer.x;
    const lineAt = (at: number): Rect =>
      axis === 'y' ? { left: r.left, top: at - 1, width: r.width, height: 2 } : { left: at - 1, top: r.top, width: 2, height: r.height };
    if (container) {
      consider(c.item, true, Math.abs(p - start), lineAt(start - 3));
      consider(c.item, false, Math.abs(p - (start + size)), lineAt(start + size + 3));
    } else {
      const center = start + size / 2;
      consider(c.item, p < center, Math.abs(p - center), lineAt(p < center ? start - 3 : start + size + 3));
    }
  }
  return best ? (best as { spot: DropSpot<T> }).spot : null;
}

/** 候補ごとに、他の候補を含むかを求めておく（ドラッグ中に毎回求めないため） */
export function markContainers<T>(candidates: DropCandidate<T>[]): DropCandidate<T>[] {
  return candidates.map((c) => ({ ...c, container: candidates.some((o) => contains(c.rect, o.rect)) }));
}
