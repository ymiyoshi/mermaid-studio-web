// @vitest-environment jsdom
// cynefin 図のプラグイン。図からの操作の結果が mermaid.parse を通ること、対象の行以外（コメント・空行）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { cynefinPlugin, parseCynefin, quoteString } from '../src/plugins/cynefin';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { DiagramTarget, ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const SRC = all['cynefin'].source;

async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = ChangeSet.of(change!, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => cynefinPlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => cynefinPlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => cynefinPlugin.inspect!(source, ref).find((f) => f.id === id);
const item = (i: number): ElementRef => ({ kind: 'item', id: String(i) });
const domain = (id: string): ElementRef => ({ kind: 'domain', id });
const transition = (i: number): ElementRef => ({ kind: 'transition', id: String(i) });

function load(svg: string, source: string): DiagramTarget[] {
  document.body.innerHTML = `<div>${svg}</div>`;
  return cynefinPlugin.mapTargets(document.querySelector('svg')!, source);
}
const at = (source: string, x: DiagramTarget) => source.slice(x.range!.from, x.range!.to);
const of = (targets: DiagramTarget[], kind: string) => targets.filter((x) => x.ref?.kind === kind);

/** mermaid の描く形を真似た SVG（項目は描く順に、遷移は線とラベルを並べる） */
function fakeSvg(items: string[], arrows: (string | null)[], overflow = 0): string {
  const g = items.map((x) => `<g><rect class="cynefinItem"></rect><text class="cynefinItemText">${x}</text></g>`).join('');
  const more = overflow ? `<g><rect class="cynefinItemOverflow"></rect><text class="cynefinItemText">+${overflow} more</text></g>` : '';
  const a = arrows.map((l) => `<path class="cynefinArrowLine"></path>${l === null ? '' : `<text class="cynefinArrowLabel">${l}</text>`}`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg"><g class="cynefin-labels"><text class="cynefinDomainLabel" x="400" y="290">Confusion</text></g><path class="cynefinConfusion"></path><g class="cynefin-items">${g}${more}</g><g class="cynefin-arrows">${a}</g></svg>`;
}

describe('cynefin 図を読む', () => {
  it('領域・項目・遷移を、範囲つきで読む', () => {
    const p = parseCynefin(SRC);
    expect(p.blocks.map((b) => `${b.domain}:${b.items.map((x) => x.value).join('/')}`)).toEqual([
      'complex:新しい市場',
      'complicated:性能の改善/監査',
      'clear:パスワードの再発行',
      'chaotic:障害対応',
    ]);
    expect(p.transitions.map((x) => `${x.from.value}>${x.to.value}:${x.label?.value}`)).toEqual(['chaotic>complex:落ち着かせる', 'complex>complicated:収束させる']);
    const audit = p.items[2];
    expect(SRC.slice(audit.range.from, audit.range.to)).toBe('監査');
  });

  it('領域の行に続けて書いた項目、\\ の書き方、コメントを読む', () => {
    const src = "cynefin-beta\n  complex \"a\" 'b\\'c' %% メモ\n  \"d\"\n  complex --> clear\n  \"x\"\n";
    const p = parseCynefin(src);
    expect(p.items.map((x) => x.value)).toEqual(['a', "b'c", 'd']);
    expect(p.items[1].escaped).toBe(true);
    expect(p.transitions[0].label).toBeNull();
  });

  it('値は \\ と引用符を \\ で書く', () => {
    expect(quoteString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteString("it's", "'")).toBe("'it\\'s'");
  });
});

describe('SVG との対応付け', () => {
  it('領域・項目・遷移を対応付ける（項目は complex・complicated・chaotic・clear の順に描かれる）', () => {
    const targets = load(all['cynefin'].svg, SRC);
    expect(of(targets, 'domain').map((x) => x.ref!.id)).toEqual(['complex', 'complicated', 'chaotic', 'clear', 'confusion']);
    const items = of(targets, 'item');
    expect(items.map((x) => x.ref!.id)).toEqual(['0', '1', '2', '4', '3']);
    expect(items.map((x) => at(SRC, x))).toEqual(['新しい市場', '性能の改善', '監査', '障害対応', 'パスワードの再発行']);
    const trs = of(targets, 'transition');
    expect(trs.map((x) => at(SRC, x))).toEqual(['落ち着かせる', '収束させる']);
    // 領域の名前は、背景と説明文もクリックの当たり判定にする（汎用の対応付けで項目と取り違えない）
    const complex = targets.find((x) => x.ref?.id === 'complex')!;
    expect(complex.hits!.map((h) => h.getAttribute('class'))).toEqual(['cynefinDomain', 'cynefinSubtitle', 'cynefinSubtitle']);
  });

  it('同じ領域を 2 度書くと後のものだけを、confusion は 3 つまでを対応付ける', () => {
    const src = 'cynefin-beta\nconfusion\n  "古い"\nconfusion\n  "a" "b" "c" "d"\nclear --> clear\nclear --> chaotic\n';
    const targets = load(fakeSvg(['a', 'b', 'c'], [null], 1), src);
    expect(of(targets, 'item').map((x) => x.ref!.id)).toEqual(['1', '2', '3']);
    // 自分自身への遷移は描かれない。ラベルの無い遷移は : "…" を差し込める
    const tr = of(targets, 'transition');
    expect(tr.map((x) => x.ref!.id)).toEqual(['1']);
    expect(tr[0].range).toBeNull();
    expect(src.slice(tr[0].insertAt!.at - 'chaotic'.length, tr[0].insertAt!.at)).toBe('chaotic');
    // 「+N more」は confusion の領域を選ぶ
    expect(targets.find((x) => x.ref?.id === 'confusion')!.hits!.some((h) => h.querySelector('.cynefinItemOverflow'))).toBe(true);
  });

  it('文言が合わなければ項目を対応付けない', () => {
    const src = 'cynefin-beta\nconfusion\n  "a"\n';
    expect(of(load(fakeSvg(['b'], []), src), 'item')).toEqual([]);
  });

  it('\\ を含む項目は、図から直接編集しない', () => {
    const src = 'cynefin-beta\nconfusion\n  "a\\"b"\n';
    const x = of(load(fakeSvg(['a"b'], []), src), 'item')[0];
    expect(x.ref).toEqual(item(0));
    expect(x.range).toBeNull();
  });

  it('登録した図種で使われる', () => {
    expect(pluginFor('cynefin')).toBe(cynefinPlugin);
  });
});

describe('図からの操作', () => {
  it('領域に項目を足す（Tab）', async () => {
    let res = run('add-item', SRC, [domain('complicated')])!;
    let out = await apply(SRC, res.change);
    expect(out).toContain('complicated\n    "性能の改善" "監査"\n    "新しい項目"\nclear\n');
    expect(res.focus).toEqual(item(3));
    // 項目の無い領域は、領域の行ごと足す
    res = run('add-item', SRC, [domain('confusion')])!;
    out = await apply(SRC, res.change);
    expect(out).toContain('    "障害対応"\nconfusion\n    "新しい項目"\nchaotic --> complex');
    expect(res.focus).toEqual(item(5));
  });

  it('項目の次に項目を足す（同じ行の途中なら、すぐ後ろに）', async () => {
    let res = run('add-item', SRC, [item(1)])!;
    let out = await apply(SRC, res.change);
    expect(out).toContain('    "性能の改善" "新しい項目" "監査"\n');
    expect(res.focus).toEqual(item(2));
    res = run('add-item', SRC, [item(0)])!;
    out = await apply(SRC, res.change);
    expect(out).toContain('complex\n    "新しい市場"\n    "新しい項目"\ncomplicated');
    expect(res.focus).toEqual(item(1));
  });

  it('遷移を足す。同じ領域への遷移は足さない', async () => {
    const res = run('connect', SRC, [domain('clear'), domain('chaotic')])!;
    const out = await apply(SRC, res.change);
    expect(out).toContain('complex --> complicated : "収束させる"\nclear --> chaotic : "移る"\n');
    expect(res.focus).toEqual(transition(2));
    expect(run('connect', SRC, [domain('clear'), domain('clear')])).toBeNull();
  });

  it('同じ領域の中で並べ替える', async () => {
    const res = run('move-down', SRC, [item(1)])!;
    const out = await apply(SRC, res.change);
    expect(out).toContain('    "監査" "性能の改善"\n');
    expect(res.select).toEqual(item(2));
    expect(run('move-up', SRC, [item(1)])).toBeNull();
    expect(run('move-down', SRC, [item(0)])).toBeNull();
  });

  it('項目・遷移・領域を消す', async () => {
    let out = await apply(SRC, run('delete', SRC, [item(0)])!.change);
    expect(out).toContain('complex\ncomplicated\n');
    out = await apply(SRC, run('delete', SRC, [item(1)])!.change);
    expect(out).toContain('complicated\n    "監査"\n');
    out = await apply(SRC, run('delete', SRC, [item(2)])!.change);
    expect(out).toContain('complicated\n    "性能の改善"\nclear');
    out = await apply(SRC, run('delete', SRC, [transition(0)])!.change);
    expect(out).not.toContain('落ち着かせる');
    expect(out).toContain('complex --> complicated : "収束させる"');
    expect(run('delete', SRC, [domain('complicated')])).toBeNull();
    out = await apply(SRC, run('delete-domain', SRC, [domain('complicated')])!.change);
    expect(out).toContain('    "新しい市場"\nclear\n');
    // 領域の行に続けて書いた項目
    const src = 'cynefin-beta\ncomplex "a" "b"\n';
    expect(await apply(src, run('delete', src, [item(0)])!.change)).toBe('cynefin-beta\ncomplex "b"\n');
    expect(await apply(src, run('delete', src, [item(1)])!.change)).toBe('cynefin-beta\ncomplex "a"\n');
  });
});

describe('プロパティ', () => {
  it('題名を変える', async () => {
    expect(field(SRC, null, 'title')!.value).toBe('仕事の分類');
    const out = await apply(SRC, prop(SRC, null, 'title', '分類'));
    expect(out).toContain('\ntitle 分類\n');
  });

  it('項目の文言を変える（引用符は \\ で書く）', async () => {
    let out = await apply(SRC, prop(SRC, item(2), 'label', '監査 "外部"'));
    expect(out).toContain('    "性能の改善" "監査 \\"外部\\""\n');
    expect(parseCynefin(out).items[2].value).toBe('監査 "外部"');
    expect(prop(SRC, item(2), 'label', ' ')).toBeNull();
    out = await apply(SRC, prop(SRC, item(0), 'label', '市場'));
    expect(out.split('\n').filter((l) => !l.includes('市場'))).toEqual(SRC.split('\n').filter((l) => !l.includes('市場')));
  });

  it('項目を別の領域へ移す', async () => {
    expect(field(SRC, item(2), 'domain')!.value).toBe('complicated');
    let out = await apply(SRC, prop(SRC, item(2), 'domain', 'clear'));
    expect(out).toContain('complicated\n    "性能の改善"\nclear\n    "パスワードの再発行"\n    "監査"\nchaotic');
    // 項目の無い領域へ移すと、領域の行ごと足す
    out = await apply(SRC, prop(SRC, item(4), 'domain', 'confusion'));
    expect(out).toContain('chaotic\nconfusion\n    "障害対応"\nchaotic --> complex');
    // 最後の行の項目を、その前の領域へ
    const src = 'cynefin-beta\ncomplex\n  "a"\nclear\n  "b"';
    out = await apply(src, prop(src, item(1), 'domain', 'complex'));
    expect(out).toBe('cynefin-beta\ncomplex\n  "a"\n  "b"\nclear');
    expect(prop(SRC, item(2), 'domain', 'complicated')).toBeNull();
  });

  it('遷移の両端とラベルを変える', async () => {
    let out = await apply(SRC, prop(SRC, transition(0), 'from', 'clear'));
    expect(out).toContain('\nclear --> complex : "落ち着かせる"\n');
    expect(prop(SRC, transition(0), 'to', 'chaotic')).toBeNull();
    out = await apply(SRC, prop(SRC, transition(1), 'label', '分析'));
    expect(out).toContain('complex --> complicated : "分析"');
    out = await apply(SRC, prop(SRC, transition(1), 'label', ''));
    expect(out).toContain('complex --> complicated\n');
    const src = 'cynefin-beta\ncomplex --> clear\n';
    expect(await apply(src, prop(src, transition(0), 'label', 'a'))).toBe('cynefin-beta\ncomplex --> clear : "a"\n');
  });
});
