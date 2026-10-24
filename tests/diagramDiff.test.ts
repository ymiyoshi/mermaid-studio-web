// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/rendered-svg.json';
import { pluginFor } from '../src/plugins/registry';
import { diffDiagrams, diffItems } from '../src/render/diagramDiff';

const fx = (fixtures as Record<string, { source: string; svg: string }>).flowchart;

/** 見本の SVG を読み、フローチャートのプラグインで要素に対応付ける。edit で SVG とソースを書き換えられる */
function load(edit?: (svg: SVGSVGElement) => void, source = fx.source) {
  const host = document.createElement('div');
  host.innerHTML = fx.svg;
  const svg = host.querySelector('svg')!;
  edit?.(svg);
  return diffItems(pluginFor('flowchart-v2').mapTargets(svg, source), source);
}

const nodeEl = (svg: SVGSVGElement, id: string) => svg.querySelector(`g.node[id*="-flowchart-${id}-"]`)!;

/** ノードのラベルの文字を書き換える（ソースを書き換えたときに mermaid が描くもの） */
const relabel = (svg: SVGSVGElement, id: string, text: string) => {
  const el = [...nodeEl(svg, id).querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim())!;
  el.textContent = text;
};

describe('図で見る差分', () => {
  it('同じ図どうしでは差分が無い', () => {
    const d = diffDiagrams(load(), load());
    expect([d.added, d.removed, d.changed]).toEqual([0, 0, 0]);
  });

  it('ノードは ID で、エッジは data-id（端点）で突き合わせる', () => {
    const keys = load().map((x) => x.key);
    expect(keys).toContain('e:node:A');
    expect(keys.some((k) => /^d:edge:L_A_B_0$/.test(k))).toBe(true);
  });

  it('消したノードは前の版に、足したノードは後の版に付く', () => {
    const before = load();
    const after = load((svg) => nodeEl(svg, 'D').remove());
    const d = diffDiagrams(before, after);
    expect(d.left.get('e:node:D')).toBe('removed');
    expect(diffDiagrams(after, before).right.get('e:node:D')).toBe('added');
  });

  it('ラベル・形（括弧）・色が変われば changed、位置だけの違いは差分にしない', () => {
    const before = load();
    // ラベル
    const relabeled = fx.source.replace('C[処理を実行]', 'C[処理を実行する]');
    expect(diffDiagrams(before, load((svg) => relabel(svg, 'C', '処理を実行する'), relabeled)).right.get('e:node:C')).toBe('changed');
    // 形
    const reshaped = fx.source.replace('C[処理を実行]', 'C([処理を実行])');
    expect(diffDiagrams(before, load(undefined, reshaped)).right.get('e:node:C')).toBe('changed');
    // 色
    const recolored = load((svg) => nodeEl(svg, 'C').querySelector('rect, path, polygon')!.setAttribute('style', 'fill:#f00'));
    expect(diffDiagrams(before, recolored).right.get('e:node:C')).toBe('changed');
    // 位置だけ
    const moved = load((svg) => nodeEl(svg, 'C').setAttribute('transform', 'translate(999, 999)'));
    expect(diffDiagrams(before, moved).changed).toBe(0);
  });

  it('画面の選択の強調（mmd- のクラス）は差分にしない', () => {
    const selected = load((svg) => nodeEl(svg, 'A').classList.add('mmd-selected'));
    expect(diffDiagrams(load(), selected).changed).toBe(0);
  });
});
