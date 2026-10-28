// @vitest-environment jsdom
// wardley 図のプラグイン。図からの操作の結果が mermaid.parse を通ること、対象の行以外（コメント・空行）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { formatCoord, formatName, parseWardley, wardleyPlugin } from '../src/plugins/wardley';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { DiagramTarget, ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const FULL = all['wardley-full'].source;

const applyRaw = (source: string, change: ChangeSpec) => ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = applyRaw(source, change!);
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => wardleyPlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => wardleyPlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => wardleyPlugin.inspect!(source, ref).find((f) => f.id === id);
const comp = (id: string): ElementRef => ({ kind: 'component', id });
const anchor = (id: string): ElementRef => ({ kind: 'anchor', id });
const link = (i: number): ElementRef => ({ kind: 'link', id: String(i) });

function load(id: string): { source: string; targets: DiagramTarget[] } {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  return { source: f.source, targets: wardleyPlugin.mapTargets(document.querySelector('svg')!, f.source) };
}
const refsOf = (targets: DiagramTarget[], kind: string) => targets.filter((x) => x.ref?.kind === kind).map((x) => x.ref!.id);
const sliceOf = (source: string, x: DiagramTarget) => source.slice(x.range!.from, x.range!.to);

/** 変更の後も、前のソースの行 lines がそのまま残っているか */
const keeps = (out: string, lines: string[]) => lines.forEach((l) => expect(out.split('\n')).toContain(l));

// コメントと空行を挟んだ図（対象の行以外が変わらないことを見る）
const COMMENTED = `wardley-beta
title 地図
%% 利用者
anchor User [0.95, 0.50]

component "部品 A" [0.70, 0.40] (buy)
  component Engine [0.40, 0.30] label [5, -5]
pipeline Engine {
  component Petrol [0.20]
  component Electric [0.60]
}
%% 線
User -> "部品 A"
"部品 A" -.-> Engine; 使う
Engine -> Petrol
evolve Engine 0.70
note "注意" [0.30, 0.80]
`;

const untouched = COMMENTED.split('\n').filter((l) => /^\s*(%%|$)/.test(l));

describe('wardley 図を読む', () => {
  it('部品・pipeline・線・evolve・メモを、名前と範囲つきで読む', () => {
    const p = parseWardley(FULL);
    expect(p.nodes.map((n) => `${n.kind}:${n.name.value}${n.pipeline ? `<${n.pipeline}` : ''}`)).toEqual([
      'anchor:Business',
      'component:Cup of Tea',
      'component:Kettle',
      'component:Power Supply',
      'component:Electric Kettle<Kettle',
    ]);
    const kettle = p.nodes.find((n) => n.name.value === 'Kettle')!;
    expect(kettle.strategy?.value).toBe('build');
    expect(FULL.slice(kettle.inertia!.from, kettle.inertia!.to)).toBe(' inertia');
    // 引用符で囲んだ名前は、内側を指す
    const power = p.nodes.find((n) => n.name.value === 'Power Supply')!;
    expect(FULL.slice(power.name.inner.from, power.name.inner.to)).toBe('Power Supply');
    expect(FULL.slice(power.name.outer.from, power.name.outer.to)).toBe('"Power Supply"');
    expect(p.links.map((l) => `${l.a.value} ${l.arrow.value} ${l.b.value}${l.label ? `; ${l.label.value}` : ''}`)).toEqual([
      'Business -> Cup of Tea',
      'Cup of Tea -> Kettle; boil',
      'Kettle -.-> Power Supply',
    ]);
    expect(p.pipelines.map((x) => [x.name.value, x.children.map((c) => c.name.value)])).toEqual([['Kettle', ['Electric Kettle']]]);
    expect(p.notes.map((n) => n.text.value)).toEqual(['Standard power']);
  });

  it('ポート・流れのラベル付きの矢印と、行末のコメントも読む', () => {
    const src = "wardley-beta\ncomponent A [0.5, 0.5]\ncomponent B [0.4, 0.4]\nA +> B\nA +'x y'> B; lab %% メモ\nA -> B +<\n";
    const p = parseWardley(src);
    expect(p.links.map((l) => [l.a.value, l.arrow.value, l.b.value, l.label?.value ?? null])).toEqual([
      ['A', '+>', 'B', null],
      ['A', "+'x y'>", 'B', 'lab'],
      ['A', '->', 'B', null],
    ]);
  });

  it('名前は、キーワードで始まるものや英字以外を含むものだけ引用符で囲む', () => {
    expect(formatName('Cup of Tea')).toBe('Cup of Tea');
    expect(formatName('Notes')).toBe('Notes');
    expect(formatName('notebook')).toBe('"notebook"');
    expect(formatName('market place')).toBe('"market place"');
    expect(formatName('New component 2')).toBe('"New component 2"');
    expect(formatName('お茶')).toBe('"お茶"');
  });

  it('座標は小数点を付けて書き、100 を超える値は受け付けない', () => {
    expect(formatCoord('0.5')).toBe('0.5');
    expect(formatCoord('1')).toBe('1.0');
    expect(formatCoord('55')).toBe('55.0');
    expect(formatCoord('101')).toBeNull();
    expect(formatCoord('-1')).toBeNull();
    expect(formatCoord('abc')).toBeNull();
  });
});

describe('SVG との対応付け', () => {
  it('部品は種類と名前、線は両端の位置、ラベルとメモは文字で対応付ける', () => {
    const { source, targets } = load('wardley-full');
    expect(refsOf(targets, 'anchor')).toEqual(['Business']);
    expect(refsOf(targets, 'component')).toEqual(['Cup of Tea', 'Kettle', 'Power Supply', 'Electric Kettle']);
    expect(refsOf(targets, 'pipeline')).toEqual(['Kettle']);
    expect(refsOf(targets, 'link')).toEqual(['0', '1', '2']);
    expect(refsOf(targets, 'note')).toEqual(['0']);
    for (const x of targets.filter((y) => y.ref && y.range)) expect(sliceOf(source, x).replace(/\s+/g, ' ')).toBe(x.label);
    const boil = targets.find((x) => x.ref?.kind === 'link' && x.ref.id === '1')!;
    expect(boil.label).toBe('boil');
    expect(sliceOf(source, boil)).toBe('boil');
    // ラベルの無い線は、; ラベル として差し込める
    const plain = targets.find((x) => x.ref?.kind === 'link' && x.ref.id === '2')!;
    expect(plain.range).toBeNull();
    expect(source.slice(plain.insertAt!.at - '"Power Supply"'.length, plain.insertAt!.at)).toBe('"Power Supply"');
    // 題名
    const title = targets.find((x) => x.label === 'Tea Shop')!;
    expect(sliceOf(source, title)).toBe('Tea Shop');
  });

  it('日本語の名前（引用符の中）も対応付ける', () => {
    const { source, targets } = load('wardley');
    expect(refsOf(targets, 'anchor')).toEqual(['お客さん']);
    expect(refsOf(targets, 'component')).toEqual(['一杯のお茶', '茶葉', 'お湯', 'やかん']);
    expect(refsOf(targets, 'link')).toEqual(['0', '1', '2', '3']);
    // 名前は ID でもあるので、図の上では書き換えない（線や evolve の参照が切れるため。名前の変更はプロパティパネルで行う）
    const kettle = targets.find((x) => x.ref?.id === 'やかん')!;
    expect(kettle.range).toBeNull();
    expect(wardleyPlugin.inspect!(source, kettle.ref!).find((f) => f.id === 'name')?.value).toBe('やかん');
  });

  it('描かれない線（宣言の無い名前への線）があっても、線の数が合わなければ対応付けない', () => {
    const f = all['wardley-full'];
    // ソースだけに線を足す（SVG は元のまま）と、線の数が合わない
    const source = f.source.replace('Business -> Cup of Tea', 'Business -> Cup of Tea\nBusiness -> Kettle');
    document.body.innerHTML = `<div>${f.svg}</div>`;
    const targets = wardleyPlugin.mapTargets(document.querySelector('svg')!, source);
    expect(refsOf(targets, 'link')).toEqual([]);
    // 宣言の無い名前への線は描かれないので、数えない
    const ghost = f.source.replace('Business -> Cup of Tea', 'Business -> Cup of Tea\nBusiness -> Nowhere');
    document.body.innerHTML = `<div>${f.svg}</div>`;
    const t2 = wardleyPlugin.mapTargets(document.querySelector('svg')!, ghost);
    expect(refsOf(t2, 'link')).toEqual(['0', '2', '3']);
    // pipeline の中の部品から、その親への線も描かれないので、数えない
    const toParent = f.source.replace('Business -> Cup of Tea', 'Business -> Cup of Tea\nElectric Kettle -> Kettle');
    document.body.innerHTML = `<div>${f.svg}</div>`;
    const t3 = wardleyPlugin.mapTargets(document.querySelector('svg')!, toParent);
    expect(refsOf(t3, 'link')).toEqual(['0', '2', '3']);
  });

  it('登録した図種で使われる', () => {
    expect(pluginFor('wardley')).toBe(wardleyPlugin);
  });
});

describe('図からの操作', () => {
  it('部品・利用者・メモを足す（名前はほかと重ならない）', async () => {
    let res = run('add-component', COMMENTED)!;
    let out = await apply(COMMENTED, res.change);
    // 最後のトップレベルの部品の次の行
    expect(out).toContain('  component Engine [0.40, 0.30] label [5, -5]\n  component "新しい部品" [0.50, 0.50]\npipeline Engine {');
    expect(res.select).toEqual(comp('新しい部品'));
    keeps(out, untouched);
    const again = run('add-component', out)!;
    expect(again.select).toEqual(comp('新しい部品 2'));
    out = await apply(out, again.change);
    expect(out).toContain('component "新しい部品 2" [');
    res = run('add-anchor', COMMENTED)!;
    out = await apply(COMMENTED, res.change);
    expect(res.select).toEqual(anchor('新しい利用者'));
    expect(out).toMatch(/\n {2}anchor "新しい利用者" \[0\.\d\d, 0\.\d\d\]\n/);
    out = await apply(COMMENTED, run('add-note', COMMENTED)!.change);
    expect(out).toContain('note "注意" [0.30, 0.80]\nnote "メモ" [0.20, 0.20]');
  });

  it('依存先（Tab）は、見える度合いを下げた部品を足して線でつなぐ', async () => {
    const res = run('add-next', FULL, [anchor('Business')])!;
    const out = await apply(FULL, res.change);
    // 真下（0.80, 0.63）は Cup of Tea と重なるので、ずらした位置に置く
    expect(out).toContain('anchor Business [0.95, 0.63]\ncomponent "新しい部品" [0.80, 0.53]\n');
    expect(out).toContain('Kettle -.-> "Power Supply"\nBusiness -> "新しい部品"\n');
    expect(res.select).toEqual(comp('新しい部品'));
    // 線の無い図では、宣言の次に線も足す
    const src = 'wardley-beta\ncomponent A [0.50, 0.50]\n';
    expect(await apply(src, run('add-next', src, [comp('A')])!.change)).toBe('wardley-beta\ncomponent A [0.50, 0.50]\ncomponent "新しい部品" [0.35, 0.50]\nA -> "新しい部品"\n');
    // pipeline の中の部品からも足せる（親の見える度合いを使う）
    await apply(FULL, run('add-next', FULL, [comp('Electric Kettle')])!.change);
  });

  it('pipeline の中に部品を足す', async () => {
    const res = run('add-child', FULL, [{ kind: 'pipeline', id: 'Kettle' }])!;
    const out = await apply(FULL, res.change);
    expect(out).toContain('  component Electric Kettle [0.60]\n  component "新しい部品" [0.70]\n}');
  });

  it('2 つの部品を線でつなぐ（自分自身にはつながない）', async () => {
    const out = await apply(COMMENTED, run('connect', COMMENTED, [anchor('User'), comp('Petrol')])!.change);
    expect(out).toContain('Engine -> Petrol\nUser -> Petrol\nevolve');
    keeps(out, untouched);
    expect(run('connect', COMMENTED, [comp('Engine'), comp('Engine')])).toBeNull();
    const ja = await apply(COMMENTED, run('connect', COMMENTED, [comp('部品 A'), comp('Petrol')])!.change);
    expect(ja).toContain('"部品 A" -> Petrol');
  });

  it('部品を消すと、つながる線と evolve の行も消す', async () => {
    const out = await apply(COMMENTED, run('delete', COMMENTED, [comp('部品 A')])!.change);
    expect(out).not.toContain('部品 A');
    keeps(out, untouched);
    expect(out).toContain('Engine -> Petrol');
    // 利用者（anchor）も同じ
    const a = await apply(FULL, run('delete', FULL, [anchor('Business')])!.change);
    expect(a).not.toContain('Business');
  });

  it('pipeline の親を消すと pipeline を丸ごと消し、中の部品への線も消す', async () => {
    const out = await apply(COMMENTED, run('delete', COMMENTED, [comp('Engine')])!.change);
    expect(out).not.toMatch(/Engine|Petrol|Electric|pipeline|evolve/);
    keeps(out, untouched);
    const full = await apply(FULL, run('delete', FULL, [comp('Kettle')])!.change);
    expect(full).toBe('wardley-beta\ntitle Tea Shop\nanchor Business [0.95, 0.63]\ncomponent Cup of Tea [0.79, 0.61] label [19, -4]\ncomponent "Power Supply" [0.10, 0.70]\nBusiness -> Cup of Tea\nnote "Standard power" [0.30, 0.49]');
  });

  it('pipeline の中の最後の部品を消すと、空の pipeline も消す（{ } だけは構文の誤り）', async () => {
    const out = await apply(FULL, run('delete', FULL, [comp('Electric Kettle')])!.change);
    expect(out).not.toMatch(/pipeline|Electric/);
    expect(out).toContain('component Kettle [0.43, 0.35] (build) inertia\n');
    // ほかに部品が残るなら、その行だけ消す
    const one = await apply(COMMENTED, run('delete', COMMENTED, [comp('Petrol')])!.change);
    expect(one).toContain('pipeline Engine {\n  component Electric [0.60]\n}');
    expect(one).not.toContain('Petrol');
    // pipeline の枠を消す
    const box = await apply(COMMENTED, run('delete', COMMENTED, [{ kind: 'pipeline', id: 'Engine' }])!.change);
    expect(box).not.toMatch(/pipeline|Petrol|Electric/);
    expect(box).toContain('  component Engine [0.40, 0.30] label [5, -5]\n');
  });

  it('線とメモを消す', async () => {
    const out = await apply(COMMENTED, run('delete', COMMENTED, [link(1)])!.change);
    expect(out).not.toContain('使う');
    keeps(out, untouched);
    const note = await apply(COMMENTED, run('delete', COMMENTED, [{ kind: 'note', id: '0' }])!.change);
    expect(note).not.toContain('注意');
  });

  it('すべての操作が、見本のすべての要素で構文を壊さない', async () => {
    for (const id of ['wardley', 'wardley-full']) {
      const { source, targets } = load(id);
      const refs = targets.map((x) => x.ref).filter((r): r is ElementRef => !!r);
      for (const a of wardleyPlugin.actions!) {
        const kinds = a.appliesTo ?? ['node'];
        const argsList = a.arity === 0 ? [[]] : refs.filter((r) => kinds.includes(r.kind)).map((r) => (a.arity === 2 ? [r, refs.find((x) => x !== r && kinds.includes(x.kind))!] : [r]));
        for (const args of argsList) {
          const res = a.run(source, args as ElementRef[]);
          if (res) await apply(source, res.change);
        }
      }
    }
  });
});

describe('プロパティ', () => {
  it('図全体の題名', async () => {
    expect(field(FULL, null, 'title')!.value).toBe('Tea Shop');
    const out = await apply(FULL, prop(FULL, null, 'title', '喫茶店'));
    expect(out.split('\n')[1]).toBe('title 喫茶店');
  });

  it('名前を変えると、線・evolve・pipeline の参照もそろえて変える', async () => {
    const out = await apply(COMMENTED, prop(COMMENTED, comp('Engine'), 'name', 'notebook'));
    expect(out).toContain('  component "notebook" [0.40, 0.30]');
    expect(out).toContain('pipeline "notebook" {');
    expect(out).toContain('"部品 A" -.-> "notebook"; 使う');
    expect(out).toContain('"notebook" -> Petrol');
    expect(out).toContain('evolve "notebook" 0.70');
    keeps(out, untouched);
    // 引用符の要らない名前は、引用符を外して書く
    const plain = await apply(COMMENTED, prop(COMMENTED, comp('部品 A'), 'name', 'Part A'));
    expect(plain).toContain('component Part A [0.70, 0.40] (buy)');
    expect(plain).toContain('User -> Part A\nPart A -.-> Engine; 使う');
    // ほかの部品と同じ名前・空の名前にはしない
    expect(prop(COMMENTED, comp('Engine'), 'name', 'User')).toBeNull();
    expect(prop(COMMENTED, comp('Engine'), 'name', ' "" ')).toBeNull();
  });

  it('座標・進め方・慣性・進化の行き先は、その値の範囲だけを変える', async () => {
    expect(field(FULL, comp('Kettle'), 'strategy')!.value).toBe('build');
    expect(field(FULL, comp('Kettle'), 'inertia')!.value).toBe('inertia');
    const lineOf = (s: string, name: string) => s.split('\n').find((l) => l.includes(`component ${name}`));
    let out = await apply(FULL, prop(FULL, comp('Kettle'), 'v', '0.5'));
    expect(lineOf(out, 'Kettle')).toBe('component Kettle [0.5, 0.35] (build) inertia');
    out = await apply(FULL, prop(FULL, comp('Kettle'), 'e', '1'));
    expect(lineOf(out, 'Kettle')).toBe('component Kettle [0.43, 1.0] (build) inertia');
    expect(prop(FULL, comp('Kettle'), 'e', '200')).toBeNull();
    out = await apply(FULL, prop(FULL, comp('Kettle'), 'strategy', 'buy'));
    expect(lineOf(out, 'Kettle')).toBe('component Kettle [0.43, 0.35] (buy) inertia');
    out = await apply(FULL, prop(FULL, comp('Kettle'), 'strategy', ''));
    expect(lineOf(out, 'Kettle')).toBe('component Kettle [0.43, 0.35] inertia');
    out = await apply(FULL, prop(FULL, comp('Kettle'), 'inertia', ''));
    expect(lineOf(out, 'Kettle')).toBe('component Kettle [0.43, 0.35] (build)');
    // label [..] の後ろに進め方、その後ろに慣性
    out = await apply(FULL, prop(FULL, comp('Cup of Tea'), 'strategy', 'outsource'));
    expect(lineOf(out, 'Cup of Tea')).toBe('component Cup of Tea [0.79, 0.61] label [19, -4] (outsource)');
    out = await apply(out, prop(out, comp('Cup of Tea'), 'inertia', 'inertia'));
    expect(lineOf(out, 'Cup of Tea')).toBe('component Cup of Tea [0.79, 0.61] label [19, -4] (outsource) inertia');
    // pipeline の中の部品は進化だけ
    expect(wardleyPlugin.inspect!(FULL, comp('Electric Kettle')).map((f) => f.id)).toEqual(['name', 'e', 'evolve']);
    out = await apply(FULL, prop(FULL, comp('Electric Kettle'), 'e', '0.75'));
    expect(out).toContain('  component Electric Kettle [0.75]\n');
  });

  it('進化の行き先（evolve）を足す・変える・外す', async () => {
    const ja = all.wardley.source;
    expect(field(ja, comp('やかん'), 'evolve')!.value).toBe('0.62');
    let out = await apply(ja, prop(ja, comp('やかん'), 'evolve', '0.8'));
    expect(out).toContain('evolve "やかん" 0.8\n');
    out = await apply(ja, prop(ja, comp('やかん'), 'evolve', ''));
    expect(out).not.toContain('evolve');
    out = await apply(FULL, prop(FULL, comp('Cup of Tea'), 'evolve', '0.9'));
    expect(out).toContain('Kettle -.-> "Power Supply"\nevolve Cup of Tea 0.9\nnote');
  });

  it('線の種類とラベル。ラベルを空にすると ; ごと外す', async () => {
    expect(field(FULL, link(2), 'style')!.value).toBe('-.->');
    let out = await apply(FULL, prop(FULL, link(2), 'style', '->'));
    expect(out).toContain('\nKettle -> "Power Supply"\n');
    out = await apply(FULL, prop(FULL, link(2), 'label', '電気'));
    expect(out).toContain('\nKettle -.-> "Power Supply"; 電気\n');
    out = await apply(FULL, prop(FULL, link(1), 'label', 'heat'));
    expect(out).toContain('\nCup of Tea -> Kettle; heat\n');
    out = await apply(FULL, prop(FULL, link(1), 'label', ''));
    expect(out).toContain('\nCup of Tea -> Kettle\n');
  });

  it('メモの文言と位置', async () => {
    const note = { kind: 'note', id: '0' };
    let out = await apply(COMMENTED, prop(COMMENTED, note, 'text', '気をつける "点"'));
    expect(out).toContain('note "気をつける  点 " [0.30, 0.80]');
    out = await apply(COMMENTED, prop(COMMENTED, note, 'e', '0.9'));
    expect(out).toContain('note "注意" [0.30, 0.9]');
  });
});
