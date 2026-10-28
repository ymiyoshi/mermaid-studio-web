// @vitest-environment jsdom
// venn 図のプラグイン。図からの操作の結果が mermaid.parse を通ること、対象の行以外（コメント・空行）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { parseVenn, vennPlugin } from '../src/plugins/venn';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { DiagramTarget, ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const SIMPLE = all['venn'].source;
const FULL = all['venn-full'].source;

async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = ChangeSet.of(change!, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => vennPlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => vennPlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => vennPlugin.inspect!(source, ref).find((f) => f.id === id);
const set = (id: string): ElementRef => ({ kind: 'set', id });
const union = (id: string): ElementRef => ({ kind: 'union', id });
const vtext = (i: number): ElementRef => ({ kind: 'vtext', id: String(i) });

function load(id: string, svg = all[id].svg, source = all[id].source): { source: string; targets: DiagramTarget[] } {
  document.body.innerHTML = `<div>${svg}</div>`;
  return { source, targets: vennPlugin.mapTargets(document.querySelector('svg')!, source) };
}
const at = (source: string, x: DiagramTarget) => source.slice(x.range!.from, x.range!.to);

/** 変えていない行がそのまま残っているか */
function keeps(before: string, after: string, changed: string[]) {
  const rest = after.split('\n');
  for (const line of before.split('\n')) if (!changed.includes(line)) expect(rest, line).toContain(line);
}

describe('venn 図を読む', () => {
  it('set・union・字下げした text・style を読む', () => {
    const p = parseVenn(FULL);
    expect(p.subsets.map((s) => `${s.kind}:${s.key}`)).toEqual(['set:A', 'set:B', 'set:C', 'union:A,B,C']);
    expect(p.subsets[0].label!.value).toBe('一');
    expect(p.subsets[1].label).toBeNull();
    expect(p.texts.map((x) => [x.tid.value, x.key, x.owner?.key])).toEqual([['a1', 'A', 'A']]);
    expect(p.styles.map((s) => [s.key, s.entries.map((e) => `${e.key}=${e.value}`)])).toEqual([['A', ['fill=#ff6b6b']]]);
    const s = parseVenn(SIMPLE).subsets[0];
    expect(SIMPLE.slice(s.size!.range.from, s.size!.range.to)).toBe('20');
  });

  it('字下げした text は、間に他の文がはさまると直前の集合に付かない', () => {
    const src = 'venn-beta\n  set A\n  %% メモ\n\n    text t1\n  set B\n  style A fill:red\ntext A,B t2["両方"]\n';
    const p = parseVenn(src);
    expect(p.texts.map((x) => [x.tid.value, x.owner?.key ?? null, x.key])).toEqual([
      ['t1', 'A', 'A'],
      ['t2', null, 'A,B'],
    ]);
  });

  it('[…] の中の空白は除いて、中身だけを範囲にする', () => {
    const src = 'venn-beta\n  set A[ 一 ]\n  set B["二"]:3\n';
    const [a, b] = parseVenn(src).subsets;
    expect(src.slice(a.label!.range.from, a.label!.range.to)).toBe('一');
    expect(src.slice(b.label!.range.from, b.label!.range.to)).toBe('二');
  });
});

describe('SVG との対応付け', () => {
  it('集合と重なりを data-venn-sets で対応付ける', () => {
    const { source, targets } = load('venn');
    const sets = targets.filter((x) => x.ref?.kind === 'set');
    expect(sets.map((x) => x.ref!.id)).toEqual(['FE', 'BE', 'Ops']);
    expect(sets.map((x) => at(source, x))).toEqual(['フロントエンド', 'バックエンド', '運用']);
    const unions = targets.filter((x) => x.ref?.kind === 'union');
    expect(unions.map((x) => x.ref!.id)).toEqual(['BE,FE', 'BE,Ops']);
    expect(at(source, unions[0])).toBe('フルスタック');
  });

  it('ラベルの無い集合は ["…"] を差し込める。3 つの重なりで足される 2 つずつの領域は対応付けない', () => {
    const { source, targets } = load('venn-full');
    const b = targets.find((x) => x.ref?.kind === 'set' && x.ref.id === 'B')!;
    expect(b.range).toBeNull();
    expect(b.label).toBe('B');
    expect(source.slice(b.insertAt!.at - 5, b.insertAt!.at)).toBe('set B');
    expect(targets.filter((x) => x.ref?.kind === 'union').map((x) => x.ref!.id)).toEqual(['A,B,C']);
  });

  it('項目（text）を、領域の中の並びとラベルで対応付ける', () => {
    const { source, targets } = load('venn-full');
    const memo = targets.find((x) => x.ref?.kind === 'vtext')!;
    expect(memo.ref).toEqual(vtext(0));
    expect(at(source, memo)).toBe('メモ');
  });

  it('項目のラベルが合わない領域は対応付けない', () => {
    const svg = all['venn-full'].svg.replace('>メモ<', '>ちがう<');
    const { targets } = load('venn-full', svg);
    expect(targets.some((x) => x.ref?.kind === 'vtext')).toBe(false);
  });

  it('登録した図種で使われる', () => {
    expect(pluginFor('venn')).toBe(vennPlugin);
  });
});

describe('図からの操作', () => {
  it('集合を足す（最後の集合・重なりの後ろ）', async () => {
    const res = run('add-set', SIMPLE)!;
    const out = await apply(SIMPLE, res.change);
    expect(out).toContain('    union BE,Ops["SRE"]:3\n    set S1["新しい集合"]\n');
    expect(res.focus).toEqual(set('S1'));
    keeps(SIMPLE, out, []);
  });

  it('次の集合（Tab）は、選んだ集合に付いた項目の後ろに足す', async () => {
    const out = await apply(FULL, run('add-next', FULL, [set('A')])!.change);
    expect(out).toContain('  set A["一"]\n    text a1["メモ"]\n  set S1["新しい集合"]\n  set B\n');
    // 項目は A に付いたまま
    expect(parseVenn(out).texts[0].owner!.key).toBe('A');
  });

  it('2 つの集合の重なりを足す。すでにある重なりは足さない', async () => {
    const res = run('add-union', SIMPLE, [set('FE'), set('Ops')])!;
    const out = await apply(SIMPLE, res.change);
    expect(out).toContain('    union FE,Ops["重なり"]\n');
    expect(res.focus).toEqual(union('FE,Ops'));
    expect(run('add-union', SIMPLE, [set('BE'), set('FE')])).toBeNull();
    expect(run('add-union', SIMPLE, [set('BE'), set('BE')])).toBeNull();
  });

  it('項目を足す（集合に付ける・同じ領域に足す）', async () => {
    let res = run('add-text', FULL, [set('A')])!;
    let out = await apply(FULL, res.change);
    expect(out).toContain('    text a1["メモ"]\n    text t1["新しい項目"]\n  set B\n');
    expect(res.focus).toEqual(vtext(1));
    res = run('add-text', FULL, [set('B')])!;
    out = await apply(FULL, res.change);
    expect(out).toContain('  set B\n      text t1["新しい項目"]\n');
    expect(parseVenn(out).texts.find((x) => x.tid.value === 't1')!.owner!.key).toBe('B');
    // 字下げしない項目の次は、同じ領域を書いて字下げせずに足す
    const src = 'venn-beta\n  set A\n  set B\ntext A,B x1["両方"]\n';
    res = run('add-text', src, [vtext(0)])!;
    out = await apply(src, res.change);
    expect(out).toBe('venn-beta\n  set A\n  set B\ntext A,B x1["両方"]\ntext A,B t1["新しい項目"]\n');
    expect(res.focus).toEqual(vtext(1));
  });

  it('集合を消すと、それを含む重なり・付いた項目・style も消す', async () => {
    const out = await apply(FULL, run('delete', FULL, [set('A')])!.change);
    expect(out).toBe('venn-beta\n  set B\n  set C["三"]');
    const out2 = await apply(SIMPLE, run('delete', SIMPLE, [set('Ops')])!.change);
    expect(out2).not.toContain('Ops');
    expect(out2).toContain('    union FE,BE["フルスタック"]:4\n');
  });

  it('重なり・項目を消す', async () => {
    const out = await apply(FULL, run('delete', FULL, [union('A,B,C')])!.change);
    expect(out).not.toContain('union');
    keeps(FULL, out, ['  union A,B,C["全部"]']);
    const out2 = await apply(FULL, run('delete', FULL, [vtext(0)])!.change);
    expect(out2).not.toContain('text');
    keeps(FULL, out2, ['    text a1["メモ"]']);
  });

  it('英語以外の既定の文言は、すべての操作で mermaid.parse を通る', async () => {
    for (const [src, refs] of [
      [SIMPLE, [set('FE'), union('BE,FE')]],
      [FULL, [set('A'), set('B'), union('A,B,C'), vtext(0)]],
    ] as const) {
      for (const a of vennPlugin.actions!) {
        for (const r of a.arity === 0 ? [null] : refs) {
          if (r && !(a.appliesTo ?? []).includes(r.kind)) continue;
          const args = a.arity === 0 ? [] : a.arity === 2 ? [r!, refs.find((x) => x !== r && x.kind === 'set') ?? r!] : [r!];
          const res = a.run(src, args);
          if (res) await apply(src, res.change);
        }
      }
    }
  });
});

describe('プロパティ', () => {
  it('題名を変える・足す', async () => {
    expect(field(SIMPLE, null, 'title')!.value).toBe('得意な分野');
    let out = await apply(SIMPLE, prop(SIMPLE, null, 'title', 'できること'));
    expect(out).toContain('    title できること\n');
    keeps(SIMPLE, out, ['    title 得意な分野']);
    out = await apply(FULL, prop(FULL, null, 'title', '#1; 図'));
    expect(out.split('\n')[1]).toBe('  title 1  図');
  });

  it('ラベルを変える・足す・消す（値の範囲だけを変える）', async () => {
    let out = await apply(SIMPLE, prop(SIMPLE, set('FE'), 'label', 'フロント "UI"'));
    expect(out).toContain(`    set FE["フロント 'UI'"]:20\n`);
    keeps(SIMPLE, out, ['    set FE["フロントエンド"]:20']);
    out = await apply(FULL, prop(FULL, set('B'), 'label', '二'));
    expect(out).toContain('  set B["二"]\n');
    out = await apply(FULL, prop(FULL, set('A'), 'label', ''));
    expect(out).toContain('  set A\n    text a1["メモ"]\n');
    out = await apply(FULL, prop(FULL, vtext(0), 'label', 'ノート'));
    expect(out).toContain('    text a1["ノート"]\n');
    // [ ] の形で ] を書くときは ["…"] にする
    const src = 'venn-beta\n  set A[一]\n';
    expect(await apply(src, prop(src, set('A'), 'label', 'a]b'))).toBe('venn-beta\n  set A["a]b"]\n');
  });

  it('大きさを変える・足す・消す', async () => {
    expect(field(SIMPLE, set('FE'), 'size')!.value).toBe('20');
    let out = await apply(SIMPLE, prop(SIMPLE, set('FE'), 'size', '30'));
    expect(out).toContain('    set FE["フロントエンド"]:30\n');
    out = await apply(SIMPLE, prop(SIMPLE, union('BE,FE'), 'size', ''));
    expect(out).toContain('    union FE,BE["フルスタック"]\n');
    out = await apply(FULL, prop(FULL, set('B'), 'size', '5'));
    expect(out).toContain('  set B:5\n');
    expect(prop(FULL, set('B'), 'size', 'abc')).toBeNull();
    expect(prop(FULL, set('B'), 'size', '0')).toBeNull();
  });

  it('塗りの色を変える・足す・消す', async () => {
    expect(field(FULL, set('A'), 'fill')!.value).toBe('#ff6b6b');
    let out = await apply(FULL, prop(FULL, set('A'), 'fill', '#00ff00'));
    expect(out).toContain('  style A fill:#00ff00');
    out = await apply(FULL, prop(FULL, set('A'), 'fill', ''));
    expect(out).not.toContain('style');
    out = await apply(SIMPLE, prop(SIMPLE, union('BE,FE'), 'fill', 'skyblue'));
    expect(out).toContain('    union BE,Ops["SRE"]:3\n    style FE,BE fill:skyblue\n');
    expect(prop(FULL, set('B'), 'fill', 'red; x')).toBeNull();
    // 他の指定のある style からは、fill だけを外す
    const src = 'venn-beta\n  set A\n  style A fill:red, color:blue\n';
    expect(await apply(src, prop(src, set('A'), 'fill', ''))).toBe('venn-beta\n  set A\n  style A color:blue\n');
    expect(await apply(src, prop(src, set('A'), 'fill', 'green'))).toBe('venn-beta\n  set A\n  style A fill:green, color:blue\n');
    const src2 = 'venn-beta\n  set A\n  style A color:blue\n';
    expect(await apply(src2, prop(src2, set('A'), 'fill', 'green'))).toBe('venn-beta\n  set A\n  style A color:blue, fill:green\n');
  });

  it('集合の ID を変えると、union・text・style の ID も変える', async () => {
    const src = 'venn-beta\n  set A["一"]\n  set B\n  union A,B\n  style A fill:red\ntext A,B x1\n';
    const out = await apply(src, prop(src, set('A'), 'id', 'Z'));
    expect(out).toBe('venn-beta\n  set Z["一"]\n  set B\n  union Z,B\n  style Z fill:red\ntext Z,B x1\n');
    expect(prop(src, set('A'), 'id', 'B')).toBeNull();
    expect(prop(src, set('A'), 'id', '1x')).toBeNull();
  });
});
