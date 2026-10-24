// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/rendered-svg.json';
import { pluginFor } from '../src/plugins/registry';
import { diffDiagrams, diffItems, stableDataId } from '../src/render/diagramDiff';

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

  it('描くたびに変わる ID（mmd-render-N）に左右されない（block 図の矢印など）', () => {
    const all = fixtures as Record<string, { source: string; svg: string }>;
    for (const [id, type] of [['block', 'block'], ['sequence-full', 'sequence'], ['state', 'stateDiagram'], ['mindmap', 'mindmap']] as const) {
      const f = all[id];
      const items = (svgText: string) => {
        const host = document.createElement('div');
        host.innerHTML = svgText;
        return diffItems(pluginFor(type).mapTargets(host.querySelector('svg')!, f.source), f.source);
      };
      // 別の描画（id の番号が違う）として読む
      const d = diffDiagrams(items(f.svg), items(f.svg.replace(/mmd-render-(\d+)/g, (_, n) => `mmd-render-${Number(n) + 40}`)));
      expect([d.added, d.removed, d.changed], id).toEqual([0, 0, 0]);
    }
    expect(stableDataId('mmd-render-2-1-front-api')).toBe('front-api');
    expect(stableDataId('L_A_B_0')).toBe('L_A_B_0');
    for (const positional of ['i0', 'edge3', 'edge_0_1', '12']) expect(stableDataId(positional)).toBeNull();
  });

  it('番号で指す要素は並び順で突き合わせ、途中に 1 つ足しても後ろを「変えた」にしない', () => {
    const msg = (label: string, i: number) => ({ key: `p:message#${i}`, group: 'message', sig: label, name: label });
    const before = ['a', 'b', 'c'].map(msg);
    const inserted = diffDiagrams(before, ['x', 'a', 'b', 'c'].map(msg));
    expect([inserted.added, inserted.removed, inserted.changed]).toEqual([1, 0, 0]);
    expect(inserted.right.get('p:message#0')).toBe('added');
    // 1 つだけ書き換えたら「変えた」1
    const edited = diffDiagrams(before, ['a', 'B', 'c'].map(msg));
    expect([edited.added, edited.removed, edited.changed]).toEqual([0, 0, 1]);
    expect(edited.left.get('p:message#1')).toBe('changed');
    const removed = diffDiagrams(before, ['a', 'c'].map(msg));
    expect([removed.added, removed.removed, removed.changed]).toEqual([0, 1, 0]);
  });
});