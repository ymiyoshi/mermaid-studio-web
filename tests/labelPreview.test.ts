// @vitest-environment jsdom
// ラベルの文字だけの編集の先取り（設計書 §18.6）: 1 つのラベルの中だけの変更で、確かに同じ文字だと分かるときだけ書き換える
import { describe, expect, it } from 'vitest';
import { changedRegion, labelEditPreview, patchLabelText } from '../src/ui/labelPreview';
import type { DiagramTarget } from '../src/plugins/types';

const SOURCE = 'flowchart TD\n  A[開始] --> B[処理]\n  B -->|はい| C[終了]';

/** ソースのラベルの範囲と、図の上のラベルの要素（HTML のラベルを真似る）から要素を作る */
function target(id: string, label: string, html = `<span class="nodeLabel"><p>${label}</p></span>`): DiagramTarget {
  const from = SOURCE.indexOf(label);
  const el = document.createElement('div');
  el.innerHTML = html;
  return { id, el, labelEl: el, label: (el.textContent ?? '').replace(/\s+/g, ' ').trim(), range: { from, to: from + label.length }, ref: { kind: 'node', id } };
}

const replaceAt = (s: string, at: number, del: number, ins: string) => s.slice(0, at) + ins + s.slice(at + del);

describe('changedRegion', () => {
  it('前後の同じ部分を除いた範囲を返す', () => {
    expect(changedRegion('abcdef', 'abXYef')).toEqual({ from: 2, oldTo: 4, newTo: 4 });
    expect(changedRegion('abc', 'abc')).toBeNull();
    expect(changedRegion('ab', 'abb')).toEqual({ from: 2, oldTo: 2, newTo: 3 });
  });
});

describe('labelEditPreview と patchLabelText', () => {
  const targets = () => [target('A', '開始'), target('B', '処理'), target('C', '終了'), target('e', 'はい')];

  it('ラベルの中に打った文字を、そのラベルの要素に書き換えて見せ、元に戻せる', () => {
    const ts = targets();
    const b = ts[1];
    const text = replaceAt(SOURCE, b.range!.to, 0, 'する');
    const hit = labelEditPreview(ts, SOURCE, text)!;
    expect(hit.target).toBe(b);
    expect(hit.label).toBe('処理する');
    const revert = patchLabelText(hit.target, hit.label)!;
    expect(b.labelEl.textContent).toBe('処理する');
    expect(b.labelEl.querySelector('p')).not.toBeNull();
    revert();
    expect(b.labelEl.textContent).toBe('処理');
  });

  it('消す・置き換える・エッジのラベルでも働く', () => {
    const ts = targets();
    expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, ts[0].range!.from, 1, ''))?.label).toBe('始');
    expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, ts[2].range!.from, 2, 'おわり'))?.label).toBe('おわり');
    expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, ts[3].range!.to, 0, '!'))).toMatchObject({ target: ts[3], label: 'はい!' });
  });

  it('ラベルの外の変更・2 つのラベルにまたがる変更では書き換えない', () => {
    const ts = targets();
    expect(labelEditPreview(ts, SOURCE, `${SOURCE}\n  C --> D`)).toBeNull();
    expect(labelEditPreview(ts, SOURCE, SOURCE.replace('A[開始] --> B[処理]', 'A[開] --> B[理]'))).toBeNull();
    expect(labelEditPreview(ts, SOURCE, SOURCE)).toBeNull();
  });

  it('mermaid が文字どおりに出さないかもしれない記号を含むと書き換えない（括弧・引用符・markdown・改行・空）', () => {
    const ts = targets();
    const at = ts[1].range!.to;
    for (const ins of [']', '(', '"', '*強調*', '<br>', '&amp;', '#35;', '`x`', '\\n']) {
      expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, at, 0, ins)), ins).toBeNull();
    }
    expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, ts[1].range!.from, 2, ''))).toBeNull();
  });

  it('図に出ている文字がソースのラベルと違う（mermaid が手を加えた）なら書き換えない', () => {
    const ts = [target('B', '処理', '<span>しょり</span>')];
    expect(labelEditPreview(ts, SOURCE, replaceAt(SOURCE, ts[0].range!.to, 0, 'する'))).toBeNull();
  });

  it('文字が単語ごと・行ごとに分かれたラベルは書き換えない', () => {
    const t = target('B', '処理', '<text><tspan>処</tspan><tspan>理</tspan></text>');
    expect(patchLabelText(t, '処理する')).toBeNull();
    expect(t.labelEl.textContent).toBe('処理');
  });
});
