import { isPositional, refKey, type DiagramTarget } from '../plugins/types';

// 図で見る差分。2 つの版をそれぞれ描き、図の要素（プラグインの対応付け）どうしを比べる。
// 要素は、mermaid が付ける data-id（ノード ID・エッジの端点）、無ければ意味上の参照、それも無ければラベルで突き合わせる。
// 位置は描くたびに変わるので比べず、ラベル・括弧の形・色などの見た目の属性だけを比べる。

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffItem {
  key: string;
  sig: string;
  /** 一覧に出す名前 */
  name: string;
  /** 番号で指す要素の種類（キーではなく、並び順で突き合わせる）。キーで突き合わせる要素は undefined */
  group?: string;
}

/** 比べない属性（位置と大きさ。描くたびに変わる） */
const GEOMETRY = new Set(['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'transform', 'viewBox', 'id', 'marker-start', 'marker-end', 'data-points']);

/** 要素の見た目の特徴（子孫のタグ・クラス・色など） */
function visualSignature(el: Element): string {
  const parts: string[] = [];
  const walk = (e: Element) => {
    const attrs = [...e.attributes]
      .filter((a) => !GEOMETRY.has(a.name) && !a.name.startsWith('data-') && !/^(style)$/.test(a.name))
      // 画面で付ける強調のクラス（mmd-…）は見ない。描くたびに変わる ID（mmd-render-N。url(#…) の参照など）も見ない
      .map((a) => `${a.name}=${a.name === 'class' ? [...new Set(a.value.split(/\s+/).filter((c) => c && !c.startsWith('mmd-')))].sort().join(' ') : a.value.replace(/mmd-render-\d+/g, 'R')}`)
      .sort();
    // style は色と線の太さだけを見る（stroke-dasharray は線の長さで値が変わるので見ない。点線などはクラスでわかる）
    const style = (e.getAttribute('style') ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^(fill|stroke|stroke-width|color|font-weight)\s*:/.test(s))
      .join(';');
    parts.push(`${e.tagName}[${attrs.join(',')}${style ? `;${style}` : ''}]`);
    for (const c of e.children) walk(c);
  };
  walk(el);
  return parts.join('');
}

/**
 * mermaid の data-id から、描くたびに変わる部分を除く。番号でしか決まらない ID（シーケンス図の i0、状態遷移図の edge0、
 * マインドマップの edge_0_1 など）は、要素を足したり消したりすると別の要素を指すので null にする
 */
export function stableDataId(dataId: string | null): string | null {
  if (!dataId) return null;
  // block 図の矢印は「mmd-render-N-<連番>-<始点>-<終点>」
  const id = dataId.replace(/^mmd-render-\d+-/, '').replace(/^\d+-(?=\D)/, '');
  return /^[A-Za-z]{0,4}[_-]?[\d_]+$/.test(id) ? null : id;
}

/** 図の要素を、比べられる形にする。source はその版のテキスト（ラベルの前後の括弧を形として見る） */
export function diffItems(targets: DiagramTarget[], source: string): DiffItem[] {
  const seen = new Map<string, number>();
  return targets.map((x) => {
    const dataId = stableDataId(x.el.getAttribute('data-id'));
    const kind = x.ref?.kind ?? x.el.tagName;
    // 番号で指す要素は、キーで突き合わせず、並び順で突き合わせる（diffDiagrams）
    const group = !dataId && x.ref && isPositional(x.ref) ? kind : undefined;
    const base = group ? `p:${group}` : dataId ? `d:${kind}:${dataId}` : x.ref ? `e:${refKey(x.ref)}` : `l:${x.label}`;
    // 同じキーが複数あれば、出てきた順に番号を付ける
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = n || group ? `${base}#${n}` : base;
    // 形は、ラベルにすぐ接している括弧だけで見る（A[( と )] など。エッジの範囲の前後にある隣のノードの文字は見ない）
    const shape = x.range
      ? `${/[[\](){}<>/\\|"]*$/.exec(source.slice(Math.max(0, x.range.from - 3), x.range.from))![0]}|${/^[[\](){}<>/\\|"]*/.exec(source.slice(x.range.to, x.range.to + 3))![0]}`
      : '';
    return { key, group, sig: `${x.label}\u0000${shape}\u0000${visualSignature(x.el)}`, name: x.label || x.ref?.id || dataId || '' };
  });
}

/** 2 つの並びの最長共通部分（同じ sig どうし）の組 [前の番号, 後の番号] */
function lcsPairs(a: DiffItem[], b: DiffItem[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) len[i][j] = a[i].sig === b[j].sig ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i].sig === b[j].sig) out.push([i++, j++]);
    else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** before → after の差分。before 側には removed / changed、after 側には added / changed が付く */
export function diffDiagrams(before: DiffItem[], after: DiffItem[]) {
  const left = new Map<string, DiffKind>();
  const right = new Map<string, DiffKind>();
  // キーで突き合わせる要素（ノード ID・端点など）
  const a = new Map(before.filter((x) => !x.group).map((x) => [x.key, x]));
  const b = new Map(after.filter((x) => !x.group).map((x) => [x.key, x]));
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) left.set(k, 'removed');
    else if (y.sig !== x.sig) {
      left.set(k, 'changed');
      right.set(k, 'changed');
    }
  }
  for (const k of b.keys()) if (!a.has(k)) right.set(k, 'added');
  // 番号で指す要素（メッセージ・遷移など）: 種類ごとに並び順の最長共通部分で突き合わせ、
  // 間に挟まった要素は、前後で数が合う分を「変えた」、残りを「消した」「足した」にする
  for (const group of new Set([...before, ...after].map((x) => x.group).filter((g): g is string => !!g))) {
    const xs = before.filter((x) => x.group === group);
    const ys = after.filter((x) => x.group === group);
    let i = 0;
    let j = 0;
    for (const [pi, pj] of [...lcsPairs(xs, ys), [xs.length, ys.length] as [number, number]]) {
      const gapA = xs.slice(i, pi);
      const gapB = ys.slice(j, pj);
      gapA.forEach((x, k) => left.set(x.key, k < gapB.length ? 'changed' : 'removed'));
      gapB.forEach((y, k) => right.set(y.key, k < gapA.length ? 'changed' : 'added'));
      i = pi + 1;
      j = pj + 1;
    }
  }
  const count = (m: Map<string, DiffKind>, kind: DiffKind) => [...m.values()].filter((v) => v === kind).length;
  return { left, right, added: count(right, 'added'), removed: count(left, 'removed'), changed: count(right, 'changed') };
}