import type { DiagramPlugin, DiagramTarget, SourceRange } from './types';

// 設計書 §7.2: どの図種でも使える汎用フォールバック。
// SVG 上のラベル文字列とソース中の文字列を突き合わせ、一意に決まるものだけを編集可能にする。

const WORD = /[\p{L}\p{N}_]/u;

function isCommentLine(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  return /^\s*%%/.test(source.slice(lineStart, at + 2));
}

/** frontmatter（先頭の --- から --- まで）の終わり。無ければ 0 */
function frontmatterEnd(source: string): number {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(source);
  return m ? m[0].length : 0;
}

/** label がソース中にちょうど 1 回だけ現れるならその範囲を返す */
export function findUniqueRange(source: string, label: string): SourceRange | null {
  if (label === '') return null;
  const bodyStart = frontmatterEnd(source);
  const checkStart = WORD.test(label[0]);
  const checkEnd = WORD.test(label[label.length - 1]);
  let found: SourceRange | null = null;
  for (let i = source.indexOf(label, bodyStart); i !== -1; i = source.indexOf(label, i + 1)) {
    const end = i + label.length;
    if (checkStart && i > 0 && WORD.test(source[i - 1])) continue;
    if (checkEnd && end < source.length && WORD.test(source[end])) continue;
    if (isCommentLine(source, i)) continue;
    if (found) return null;
    found = { from: i, to: end };
  }
  return found;
}

/** ラベルを持つ SVG 要素（HTML ラベルの foreignObject と、SVG の text） */
function labelElements(svg: SVGSVGElement): Element[] {
  const out: Element[] = [];
  svg.querySelectorAll('foreignObject, text').forEach((el) => {
    if (el.tagName.toLowerCase() === 'text' && el.closest('foreignObject')) return;
    out.push(el);
  });
  return out;
}

function labelText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** ラベル文字列の突き合わせによる対応付け。exclude の中にあるラベルは除く（図種プラグインが対応付け済みのもの） */
export function genericTargets(svg: SVGSVGElement, source: string, exclude: Element[] = []): DiagramTarget[] {
  const targets: DiagramTarget[] = [];
  // ラベルごとに除外する要素すべてと比べず、ラベルの祖先が除外する要素かだけを見る
  const excluded = new Set(exclude);
  const isExcluded = (el: Element) => {
    for (let n: Element | null = el; n && n !== svg; n = n.parentElement) if (excluded.has(n)) return true;
    return false;
  };
  labelElements(svg).forEach((el, i) => {
    if (isExcluded(el)) return;
    const label = labelText(el);
    if (label === '') return;
    targets.push({ id: `label-${i}`, el, labelEl: el, label, range: findUniqueRange(source, label) });
  });
  return targets;
}

export { labelText };

/** 図種プラグインが対応付けた要素に、残りのラベルの汎用の対応付けを足す */
export function withGeneric(svg: SVGSVGElement, source: string, mapped: DiagramTarget[]): DiagramTarget[] {
  return [...mapped, ...genericTargets(svg, source, mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]))];
}

export const genericPlugin: DiagramPlugin = {
  type: '*',

  mapTargets(svg, source) {
    return genericTargets(svg, source);
  },
};
