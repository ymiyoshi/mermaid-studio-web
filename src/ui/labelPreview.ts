import type { DiagramTarget } from '../plugins/types';

// 設計書 §18.6: ラベルの文字だけを変えた編集は、描き直しを待たずに、いま出ている SVG の文字を書き換えて見せる。
// 表示だけの先取りで、テキストや履歴には触れない（正しい図は、描き直しが終わったら差し替わる）。
// 書き換えるのは、確かに同じ文字だと分かるときだけにする（そうでなければ何もしないで描き直しを待つ）。

/**
 * mermaid が文字どおりに出すと言える文字だけ。括弧・引用符・< & などの記号、markdown の記号（* _ ` ~ #）、
 * エスケープ（\ と #…;）、改行（<br> や \n）、%（コメントや指令）、; を含むラベルは書き換えない
 */
const PLAIN = /^[^\[\](){}<>|"'`&#*_~\\\n\r;%]*$/;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 2 つの文字列で違う部分（前後の同じ部分を除いた範囲）。old の [from, oldTo) が new の [from, newTo) になった */
export function changedRegion(old: string, now: string): { from: number; oldTo: number; newTo: number } | null {
  if (old === now) return null;
  const max = Math.min(old.length, now.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === now.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && old.charCodeAt(old.length - 1 - s) === now.charCodeAt(now.length - 1 - s)) s++;
  return { from: p, oldTo: old.length - s, newTo: now.length - s };
}

/**
 * svgSource（いま出ている図のテキスト）から text への変更が、1 つの要素のラベルの中だけで、
 * 書き換えても見た目がそのラベルを打ったとおりになると言えるなら、その要素と新しいラベルを返す
 */
export function labelEditPreview(targets: DiagramTarget[], svgSource: string, text: string): { target: DiagramTarget; label: string } | null {
  const region = changedRegion(svgSource, text);
  if (!region) return null;
  let best: DiagramTarget | null = null;
  for (const x of targets) {
    const r = x.range;
    if (!r || region.from < r.from || region.oldTo > r.to) continue;
    if (!best || r.to - r.from < best.range!.to - best.range!.from) best = x;
  }
  if (!best) return null;
  const r = best.range!;
  const oldLabel = svgSource.slice(r.from, r.to);
  const newLabel = text.slice(r.from, r.to + (text.length - svgSource.length));
  if (!PLAIN.test(oldLabel) || !PLAIN.test(newLabel) || norm(newLabel) === '') return null;
  // ソースのラベルが、図に出ている文字と同じであること（mermaid が手を加えていない）
  if (norm(oldLabel) !== norm(best.label)) return null;
  return { target: best, label: norm(newLabel) };
}

/**
 * ラベルの要素の文字を書き換え、元に戻す関数を返す。文字を持つ部分が 1 つだけで、その中身が今のラベルと同じときだけ書き換える
 * （単語ごと・行ごとに分かれたラベルは、分け方が分からないので書き換えない）
 */
export function patchLabelText(target: DiagramTarget, label: string): (() => void) | null {
  const nodes: Text[] = [];
  const walk = document.createTreeWalker(target.labelEl, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if ((n.nodeValue ?? '').trim() !== '') nodes.push(n as Text);
  if (nodes.length !== 1) return null;
  const node = nodes[0];
  const original = node.data;
  if (norm(original) !== norm(target.label)) return null;
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  node.data = `${lead}${label}${trail}`;
  // 描き直しで差し替わった後の要素に戻しても害は無い
  return () => void (node.data = original);
}
