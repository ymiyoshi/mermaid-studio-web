// vi のキーバインド（設計書 §16）のうち、DOM に依存しない部分。キーの名前・キー列の読み取り・向きでの移動先の選び方。

/** 複数キーの途中でこれ以上止まったら、打ちかけのキーを捨てる（vim の timeoutlen） */
export const VI_TIMEOUT_MS = 1000;

/** キーの名前（vim の書き方: 'a'・'G'・'<C-r>'・'<Space>'・'<CR>'・'<Esc>'）。修飾キーだけ・扱わないキーは null */
export function keyName(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): string | null {
  if (e.altKey || e.metaKey) return null;
  const special: Record<string, string> = { ' ': '<Space>', Enter: '<CR>', Escape: '<Esc>', F2: '<F2>' };
  const base = special[e.key] ?? (e.key.length === 1 ? e.key : null);
  if (base === null) return null;
  if (e.ctrlKey) return e.key.length === 1 ? `<C-${e.key.toLowerCase()}>` : null;
  return base;
}

export type ViParse = { kind: 'run'; cmd: string; count: number } | { kind: 'pending' } | { kind: 'none' };

/**
 * 打ったキーの列を、コマンドの表と照らし合わせる。コマンドはキーを空白でつないだもの（'g g'・'<Space> e'）。
 * 先頭の数字は回数（0 からは始まらない）。表のどれかの途中なら pending、どれにも合わなければ none。
 */
export function parseKeys(keys: readonly string[], table: readonly string[]): ViParse {
  let i = 0;
  while (i < keys.length && /^[0-9]$/.test(keys[i]) && !(i === 0 && keys[i] === '0')) i++;
  const count = i > 0 ? Number(keys.slice(0, i).join('')) : 1;
  const rest = keys.slice(i);
  if (rest.length === 0) return { kind: i > 0 ? 'pending' : 'none' };
  const cmd = rest.join(' ');
  if (table.includes(cmd)) return { kind: 'run', cmd, count };
  if (table.some((c) => c.startsWith(cmd + ' '))) return { kind: 'pending' };
  return { kind: 'none' };
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Dir = 'h' | 'j' | 'k' | 'l';

/**
 * from から dir の向き（h: 左、j: 下、k: 上、l: 右）で一番近い候補の番号。無ければ -1。
 * 中心どうしで測り、向きに沿った距離に、向きから外れた距離を重く足す（真横・真下の要素を優先する）。
 */
export function nearestInDirection(from: Box, candidates: readonly Box[], dir: Dir): number {
  const cx = (b: Box) => b.left + b.width / 2;
  const cy = (b: Box) => b.top + b.height / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((b, i) => {
    const dx = cx(b) - cx(from);
    const dy = cy(b) - cy(from);
    const along = dir === 'l' ? dx : dir === 'h' ? -dx : dir === 'j' ? dy : -dy;
    const across = dir === 'l' || dir === 'h' ? Math.abs(dy) : Math.abs(dx);
    // 向きに進んでいない要素（同じ高さ・同じ列で重なるものを含む）は選ばない
    if (along <= 0.5) return;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** :earlier / :later の引数。'5' は回数、'10m'・'30s'・'2h' は時間（ミリ秒）。読めなければ null */
export function parseTravel(arg: string): { steps: number } | { ms: number } | null {
  const m = /^\s*(\d*)\s*([smhd]?)\s*$/.exec(arg);
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  if (m[2] === '') return { steps: n };
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return { ms: n * unit };
}
