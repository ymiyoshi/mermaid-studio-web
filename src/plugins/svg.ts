// 描画済み SVG への小さな加工。

/** 細い線でもクリックしやすいように、透明で太い線を重ねる。返り値は重ねた線 */
export function addHitArea(path: Element): Element {
  const hit = path.cloneNode(false) as SVGPathElement;
  for (const a of ['id', 'data-et', 'data-id']) hit.removeAttribute(a);
  hit.removeAttribute('marker-end');
  hit.removeAttribute('marker-start');
  hit.removeAttribute('style');
  hit.setAttribute('class', 'mmd-hit');
  path.after(hit);
  return hit;
}

/** エッジの線（data-id を持つ path）に対応するラベルの要素 */
export function edgeLabelFor(svg: SVGSVGElement, path: Element): Element | null {
  const id = path.getAttribute('data-id');
  return id ? svg.querySelector(`g.edgeLabel [data-id="${CSS.escape(id)}"]`) : null;
}

/** エッジのラベルの要素を data-id ごとに集める（エッジごとに SVG 全体を探さないため） */
export function edgeLabels(svg: SVGSVGElement): Map<string, Element> {
  const out = new Map<string, Element>();
  svg.querySelectorAll('g.edgeLabel [data-id]').forEach((el) => {
    const id = el.getAttribute('data-id')!;
    if (!out.has(id)) out.set(id, el);
  });
  return out;
}

/** "...-<prefix>-<ID>-<連番>" 形式の SVG の id から ID を取り出す */
export function idFromSvg(el: Element, prefix: string): string | null {
  const m = new RegExp(`-${prefix}-(.+)-\\d+$`).exec(el.id);
  return m ? m[1] : null;
}

/**
 * SVG の要素とソースの要素を、端点などの照合で対応付ける。
 * 要素の順に、まだ使っていない最初の一致するソースの要素を割り当てる（同じ端点のものは出てくる順）。
 * 返り値は要素ごとのソースの要素の番号（見つからなければ -1）
 */
export function matchInOrder<T>(els: Element[], items: T[], matches: (el: Element, item: T) => boolean): number[] {
  const used = new Set<number>();
  return els.map((el) => {
    const i = items.findIndex((item, k) => !used.has(k) && matches(el, item));
    if (i >= 0) used.add(i);
    return i;
  });
}
