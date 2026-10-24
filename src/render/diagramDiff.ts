import { refKey, type DiagramTarget } from '../plugins/types';

// 図で見る差分。2 つの版をそれぞれ描き、図の要素（プラグインの対応付け）どうしを比べる。
// 要素は、mermaid が付ける data-id（ノード ID・エッジの端点）、無ければ意味上の参照、それも無ければラベルで突き合わせる。
// 位置は描くたびに変わるので比べず、ラベル・括弧の形・色などの見た目の属性だけを比べる。

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffItem {
  key: string;
  sig: string;
  /** 一覧に出す名前 */
  name: string;
}

/** 比べない属性（位置と大きさ。描くたびに変わる） */
const GEOMETRY = new Set(['d', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points', 'transform', 'viewBox', 'id', 'marker-start', 'marker-end', 'data-points']);

/** 要素の見た目の特徴（子孫のタグ・クラス・色など） */
function visualSignature(el: Element): string {
  const parts: string[] = [];
  const walk = (e: Element) => {
    const attrs = [...e.attributes]
      .filter((a) => !GEOMETRY.has(a.name) && !a.name.startsWith('data-') && !/^(style)$/.test(a.name))
      // 画面で付ける強調のクラス（mmd-…）は見ない
      .map((a) => `${a.name}=${a.name === 'class' ? [...new Set(a.value.split(/\s+/).filter((c) => c && !c.startsWith('mmd-')))].sort().join(' ') : a.value}`)
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

/** 図の要素を、比べられる形にする。source はその版のテキスト（ラベルの前後の括弧を形として見る） */
export function diffItems(targets: DiagramTarget[], source: string): DiffItem[] {
  const seen = new Map<string, number>();
  return targets.map((x) => {
    const dataId = x.el.getAttribute('data-id');
    const base = dataId ? `d:${x.ref?.kind ?? x.el.tagName}:${dataId}` : x.ref ? `e:${refKey(x.ref)}` : `l:${x.label}`;
    // 同じキーが複数あれば、出てきた順に番号を付ける
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = n ? `${base}#${n}` : base;
    // 形は、ラベルにすぐ接している括弧だけで見る（A[( と )] など。エッジの範囲の前後にある隣のノードの文字は見ない）
    const shape = x.range
      ? `${/[[\](){}<>/\\|"]*$/.exec(source.slice(Math.max(0, x.range.from - 3), x.range.from))![0]}|${/^[[\](){}<>/\\|"]*/.exec(source.slice(x.range.to, x.range.to + 3))![0]}`
      : '';
    return { key, sig: `${x.label}\u0000${shape}\u0000${visualSignature(x.el)}`, name: x.label || x.ref?.id || dataId || '' };
  });
}

/** before → after の差分。before 側には removed / changed、after 側には added / changed が付く */
export function diffDiagrams(before: DiffItem[], after: DiffItem[]) {
  const a = new Map(before.map((x) => [x.key, x]));
  const b = new Map(after.map((x) => [x.key, x]));
  const left = new Map<string, DiffKind>();
  const right = new Map<string, DiffKind>();
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) left.set(k, 'removed');
    else if (y.sig !== x.sig) {
      left.set(k, 'changed');
      right.set(k, 'changed');
    }
  }
  for (const k of b.keys()) if (!a.has(k)) right.set(k, 'added');
  const count = (m: Map<string, DiffKind>, kind: DiffKind) => [...m.values()].filter((v) => v === kind).length;
  return { left, right, added: count(right, 'added'), removed: count(left, 'removed'), changed: count(right, 'changed') };
}
