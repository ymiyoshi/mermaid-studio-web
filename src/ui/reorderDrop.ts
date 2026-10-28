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

/** p から start〜start+size の範囲までの距離（範囲の中なら 0） */
const gap = (p: number, start: number, size: number) => Math.max(0, start - p, p - (start + size));

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
      // 向きと直交する方向に離れている要素（mindmap の根の反対側・timeline の別の列）は、その分だけ遠いとみなす
      const center = start + size / 2;
      const across = axis === 'y' ? gap(pointer.x, r.left, r.width) : gap(pointer.y, r.top, r.height);
      consider(c.item, p < center, Math.hypot(p - center, across), lineAt(p < center ? start - 3 : start + size + 3));
    }
  }
  return best ? (best as { spot: DropSpot<T> }).spot : null;
}

/** 候補ごとに、他の候補を含むかを求めておく（ドラッグ中に毎回求めないため） */
export function markContainers<C extends DropCandidate<unknown>>(candidates: C[]): C[] {
  return candidates.map((c) => ({ ...c, container: candidates.some((o) => contains(c.rect, o.rect)) }));
}

// ---- 中へ落とす（サブグラフ・グループ・列・子にする）ことのできる図種の落とし先 ----

export interface DragCandidate<T> {
  item: T;
  rect: Rect;
  /** 前後に落とせるか */
  sibling: boolean;
  /** 中に落とせるか */
  into: boolean;
  /** 他の候補を含む要素か（markContainers で求める） */
  container?: boolean;
}

export type DropResult<T> =
  | { kind: 'move'; item: T; before: boolean; line: Rect }
  /** item が null なら図の一番外（どの枠にも入れない）。box は示す枠 */
  | { kind: 'into'; item: T | null; box: Rect | null };

const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height;
const area = (r: Rect) => r.width * r.height;

/** 点を含む候補のうち、一番内側の枠 */
function innermost<T>(list: DragCandidate<T>[], at: (r: Rect) => boolean): DragCandidate<T> | null {
  let best: DragCandidate<T> | null = null;
  for (const c of list) if (at(c.rect) && (!best || area(c.rect) < area(best.rect))) best = c;
  return best;
}

/** 左右と上下を合わせた並び（ブロック図の格子など）: 一番近い要素の、中心より左なら前・右なら後ろ */
function findDropXY<T>(pointer: { x: number; y: number }, candidates: DropCandidate<T>[]): DropSpot<T> | null {
  let best: { spot: DropSpot<T>; dist: number } | null = null;
  for (const c of candidates) {
    const r = c.rect;
    const cy = r.top + r.height / 2;
    const before = pointer.x < r.left + r.width / 2;
    const edge = before ? r.left : r.left + r.width;
    // 枠は端までの距離で比べる（中を指しているときに枠そのものを選ばないため）
    const dist = c.container
      ? Math.hypot(pointer.x - edge, pointer.y - cy)
      : Math.hypot(pointer.x - (r.left + r.width / 2), pointer.y - cy);
    const line = { left: before ? r.left - 4 : r.left + r.width + 2, top: r.top, width: 2, height: r.height };
    if (!best || dist < best.dist) best = { spot: { item: c.item, before, line }, dist };
  }
  return best ? (best as { spot: DropSpot<T> }).spot : null;
}

/**
 * 落とし先を決める。
 * 1. 中に落とせる要素（枠でないもの）の真ん中を指していれば、その中（子にする）
 * 2. 指している一番内側の枠と同じ枠にある要素のうち、一番近いものの前後
 * 3. 前後に落とせる要素が無ければ、指している枠の中。どの枠も指していなければ、root のとき図の一番外
 * 中に落とせる候補が 1 つも無ければ、findDrop と同じ（前後だけ）
 */
export function resolveDrop<T>(
  axis: 'x' | 'y' | 'xy',
  pointer: { x: number; y: number },
  candidates: DragCandidate<T>[],
  root: boolean,
): DropResult<T> | null {
  const intos = candidates.filter((c) => c.into);
  const frames = intos.filter((c) => c.container);
  // 1. 枠でない要素の真ん中（前後にも落とせる要素は、並びの向きの真ん中の半分だけ。xy なら左右・上下とも）。
  //    重なっているときは、指している一番内側（小さい）もの
  const mid = (start: number, size: number, p: number) => p >= start + size / 4 && p <= start + (size * 3) / 4;
  const central = (c: DragCandidate<T>) =>
    !c.sibling ||
    ((axis === 'y' || mid(c.rect.left, c.rect.width, pointer.x)) && (axis === 'x' || mid(c.rect.top, c.rect.height, pointer.y)));
  const leaf = innermost(
    intos.filter((c) => !c.container),
    (r) => inside(r, pointer),
  );
  if (leaf && central(leaf)) return { kind: 'into', item: leaf.item, box: leaf.rect };
  // 2. 同じ枠の中にある要素の前後
  const frame = innermost(frames, (r) => inside(r, pointer));
  const siblings = candidates.filter(
    (c) => c.sibling && (frames.length === 0 || innermost(frames, (r) => contains(r, c.rect)) === frame),
  );
  const spot = axis === 'xy' ? findDropXY(pointer, siblings) : findDrop(axis, pointer, siblings);
  if (spot) return { kind: 'move', ...spot };
  // 3. 枠の中・図の一番外
  if (frame) return { kind: 'into', item: frame.item, box: frame.rect };
  return root ? { kind: 'into', item: null, box: null } : null;
}
