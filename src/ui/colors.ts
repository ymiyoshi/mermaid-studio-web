// 色の入力欄で使う色。パレットに並べる色と、入力された色の読み取り。

/**
 * パレットの色。1 段目は塗り向けの淡い色、2 段目は枠線・文字向けの濃い色で、
 * 同じ列が同じ色相（白黒・灰・赤・橙・黄・緑・青・紫・桃）になるように並べる
 */
export const PALETTE = [
  ['#ffffff', '#f3f4f6', '#fee2e2', '#ffedd5', '#fef9c3', '#dcfce7', '#dbeafe', '#ede9fe', '#fce7f3'],
  ['#000000', '#6b7280', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed', '#db2777'],
];

/** 色の入力欄に渡せる #rrggbb にする（#abc は #aabbcc に。読めない色は null） */
export function toHex(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  return null;
}

/** 見本に塗れる色か（red や rgb(...) も含む。読めなければ見本は空のまま） */
export function isCssColor(v: string): boolean {
  const s = v.trim();
  if (!s) return false;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') return CSS.supports('color', s);
  return toHex(s) !== null;
}
