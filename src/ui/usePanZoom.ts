import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

// 図ビューのパン（ドラッグで移動）とズーム（ホイール・ボタン・全体表示）。

export interface ViewBox {
  scale: number;
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** これより小さい動きはドラッグではなくクリックとみなす */
export const DRAG_THRESHOLD_PX = 4;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 2 つの範囲を合わせた範囲 */
export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
}

/** container の左上からの el の位置と大きさ */
export function rectIn(el: Element, container: HTMLElement): Rect {
  const a = el.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  return { left: a.left - c.left, top: a.top - c.top, width: a.width, height: a.height };
}

/** mermaid の SVG は幅 100% で出力されるので、拡大縮小のために本来の大きさに固定する */
export function fixSvgSize(svg: SVGSVGElement) {
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0) {
    svg.setAttribute('width', String(vb.width));
    svg.setAttribute('height', String(vb.height));
  }
  svg.style.maxWidth = 'none';
}

/** (px, py) を中心に scale を変えた表示 */
function zoomAround(v: ViewBox, scale: number, px: number, py: number): ViewBox {
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export function usePanZoom(viewport: RefObject<HTMLDivElement | null>, canvas: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState<ViewBox>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // ホイールで、カーソルの位置を中心に拡大縮小する（ページのスクロールを止めるため passive: false）
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      setView((v) => zoomAround(v, clampScale(v.scale * Math.exp(-e.deltaY * 0.0015)), e.clientX - rect.left, e.clientY - rect.top));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [viewport]);

  /** 図全体が収まるように表示する */
  const fit = useCallback(() => {
    const vp = viewport.current;
    const svgEl = canvas.current?.querySelector('svg');
    if (!vp || !svgEl) return;
    const w = Number(svgEl.getAttribute('width')) || svgEl.getBBox().width;
    const h = Number(svgEl.getAttribute('height')) || svgEl.getBBox().height;
    const pad = 32;
    const scale = Math.min(2, clampScale(Math.min((vp.clientWidth - pad * 2) / w, (vp.clientHeight - pad * 2) / h)));
    setView({ scale, x: (vp.clientWidth - w * scale) / 2, y: (vp.clientHeight - h * scale) / 2 });
  }, [viewport, canvas]);

  /** 表示の中心を基準に拡大縮小する */
  const zoomBy = (factor: number) => {
    const vp = viewport.current;
    if (!vp) return;
    setView((v) => zoomAround(v, clampScale(v.scale * factor), vp.clientWidth / 2, vp.clientHeight / 2));
  };

  /** 要素が表示範囲の外にあれば、見えるところまで動かす */
  const scrollIntoView = (el: Element) => {
    const vp = viewport.current;
    if (!vp) return;
    const r = rectIn(el, vp);
    const margin = 48;
    const dx =
      r.left < margin ? margin - r.left : r.left + r.width > vp.clientWidth - margin ? vp.clientWidth - margin - r.left - r.width : 0;
    const dy =
      r.top < margin ? margin - r.top : r.top + r.height > vp.clientHeight - margin ? vp.clientHeight - margin - r.top - r.height : 0;
    if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const beginDrag = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ペンや合成イベントなどで捕捉できないときは、捕捉なしで続ける
    }
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };

  /** ドラッグを終える。ドラッグしていなければ null、動かさずに離したなら moved: false（＝クリック） */
  const endDrag = (): { moved: boolean } | null => {
    const d = drag.current;
    drag.current = null;
    return d && { moved: d.moved };
  };

  return { view, fit, zoomBy, scrollIntoView, beginDrag, moveDrag, endDrag };
}
