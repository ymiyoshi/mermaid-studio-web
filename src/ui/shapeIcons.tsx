import type { ReactNode } from 'react';

// ノードの形の選択肢に出す小さな図形（viewBox 0 0 32 20、線は文字の色）。
// 図種ごとに名前の付け方が違うので、同じ形の別名は ALIAS でそろえる。
// 「@名前」はフローチャートの新しい書き方（@{ shape: … }）の形

const R = { x: 3, y: 3, w: 26, h: 14 };

const ICONS: Record<string, ReactNode> = {
  rect: <rect x={R.x} y={R.y} width={R.w} height={R.h} />,
  round: <rect x={R.x} y={R.y} width={R.w} height={R.h} rx={4} />,
  stadium: <rect x={R.x} y={R.y} width={R.w} height={R.h} rx={7} />,
  subroutine: (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} />
      <path d="M6 3v14M26 3v14" />
    </>
  ),
  cylinder: <path d="M6 5a10 2.5 0 0 0 20 0a10 2.5 0 0 0-20 0v10a10 2.5 0 0 0 20 0V5" />,
  circle: <circle cx={16} cy={10} r={7.5} />,
  'double-circle': (
    <>
      <circle cx={16} cy={10} r={8} />
      <circle cx={16} cy={10} r={5.5} />
    </>
  ),
  rhombus: <path d="M16 2L29 10L16 18L3 10Z" />,
  hexagon: <path d="M3 10L8 3H24L29 10L24 17H8Z" />,
  lean: <path d="M8 3H29L24 17H3Z" />,
  'lean-l': <path d="M3 3H24L29 17H8Z" />,
  trapezoid: <path d="M8 3H24L29 17H3Z" />,
  'trapezoid-alt': <path d="M3 3H29L24 17H8Z" />,
  asymmetric: <path d="M3 3H29V17H3L8 10Z" />,
  // マインドマップの「標準」は下線だけ
  default: <path d="M3 15H29" />,
  cloud: <path d="M9 17a4 4 0 0 1-1-7.8a5 5 0 0 1 9.4-3a4.5 4.5 0 0 1 7.6 3.2a4 4 0 0 1-1 7.6Z" />,
  bang: <path d="M16 2l2.5 4.5L24 4l-1 5L29 10l-5.5 2L25 17l-5-2.5L16 18l-2.5-3.5L8 17l1.5-5L3 10l6-1L8 4l5.5 2.5Z" />,

  // ---- 新しい書き方でしか書けない形 ----
  '@doc': <path d="M3 3H29V15Q22.5 11 16 15T3 15Z" />,
  '@docs': (
    <>
      <path d="M7 3H29V13" />
      <path d="M5 5H27V15" />
      <path d="M3 7H25V17Q19 13.5 14 17T3 17Z" />
    </>
  ),
  '@lin-doc': (
    <>
      <path d="M3 3H29V15Q22.5 11 16 15T3 15Z" />
      <path d="M7 3V14" />
    </>
  ),
  '@tag-doc': (
    <>
      <path d="M3 3H29V15Q22.5 11 16 15T3 15Z" />
      <path d="M23 13L29 7" />
    </>
  ),
  '@notch-rect': <path d="M8 3H29V17H3V8Z" />,
  '@lin-rect': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} />
      <path d="M6 3v14" />
    </>
  ),
  '@div-rect': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} />
      <path d="M3 7H29" />
    </>
  ),
  '@st-rect': (
    <>
      <path d="M7 3H29V13" />
      <path d="M5 5H27V15" />
      <rect x={3} y={7} width={22} height={10} />
    </>
  ),
  '@tag-rect': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} />
      <path d="M23 17L29 11" />
    </>
  ),
  '@sl-rect': <path d="M3 7L29 3V17H3Z" />,
  '@bow-rect': <path d="M7 3H29Q25 10 29 17H7Q3 10 7 3Z" />,
  '@win-pane': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} />
      <path d="M3 7H29M8 3V17" />
    </>
  ),
  '@h-cyl': <path d="M6 3H26a3 7 0 0 1 0 14H6a3 7 0 0 1 0-14ZM26 3a3 7 0 0 0 0 14" />,
  '@lin-cyl': (
    <>
      <path d="M6 5a10 2.5 0 0 0 20 0a10 2.5 0 0 0-20 0v10a10 2.5 0 0 0 20 0V5" />
      <path d="M6 8a10 2.5 0 0 0 20 0" />
    </>
  ),
  '@datastore': (
    <>
      <path d="M3 3H29M3 17H29" />
      <path d="M8 3a3 7 0 0 0 0 14" />
    </>
  ),
  '@delay': <path d="M3 3H20a7 7 0 0 1 0 14H3Z" />,
  '@curv-trap': <path d="M8 3H22a7 7 0 0 1 0 14H8L3 10Z" />,
  '@notch-pent': <path d="M8 3H24L29 8V17H3V8Z" />,
  '@tri': <path d="M16 2L29 18H3Z" />,
  '@flip-tri': <path d="M3 2H29L16 18Z" />,
  '@hourglass': <path d="M7 2H25L7 18H25Z" />,
  '@flag': <path d="M3 5Q9.5 1 16 5T29 5V15Q22.5 19 16 15T3 15Z" />,
  '@bolt': <path d="M19 2L9 11H16L12 18L23 8H16Z" />,
  '@sm-circ': <circle cx={16} cy={10} r={4} />,
  '@fr-circ': (
    <>
      <circle cx={16} cy={10} r={6} />
      <circle cx={16} cy={10} r={3.5} fill="currentColor" />
    </>
  ),
  '@f-circ': <circle cx={16} cy={10} r={4} fill="currentColor" />,
  '@cross-circ': (
    <>
      <circle cx={16} cy={10} r={7.5} />
      <path d="M10.7 4.7L21.3 15.3M21.3 4.7L10.7 15.3" />
    </>
  ),
  '@fork': <rect x={3} y={8} width={26} height={4} fill="currentColor" />,
  '@brace': <path d="M12 3Q8 3 8 6.5T5 10Q8 10 8 13.5T12 17" />,
  '@brace-r': <path d="M20 3Q24 3 24 6.5T27 10Q24 10 24 13.5T20 17" />,
  '@braces': <path d="M10 3Q6 3 6 6.5T3 10Q6 10 6 13.5T10 17M22 3Q26 3 26 6.5T29 10Q26 10 26 13.5T22 17" />,
  '@text': <path d="M10 5H22M16 5V16" />,
  '@folder': <path d="M3 4H12L14 6H29V17H3Z" />,
  '@bucket': <path d="M4 3L8 17H24L28 3" />,
  '@console': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} rx={1.5} />
      <path d="M7 7L10 10L7 13M12 13H17" />
    </>
  ),
  '@browser': (
    <>
      <rect x={R.x} y={R.y} width={R.w} height={R.h} rx={1.5} />
      <path d="M3 7H29" />
    </>
  ),
  '@person': (
    <>
      <circle cx={16} cy={6} r={3.5} />
      <path d="M9 18a7 7 0 0 1 14 0" />
    </>
  ),
};

const ALIAS: Record<string, string> = {
  square: 'rect',
  rounded: 'round',
  parallelogram: 'lean',
  '@cloud': 'cloud',
  '@bang': 'bang',
};

/** 形の名前に対応する図形。知らない形なら null（文字で出す） */
export function shapeIcon(name: string): ReactNode | null {
  const icon = ICONS[ALIAS[name] ?? name];
  if (!icon) return null;
  return (
    <svg className="shape-icon" viewBox="0 0 32 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round">
      {icon}
    </svg>
  );
}
