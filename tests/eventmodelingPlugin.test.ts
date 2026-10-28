// @vitest-environment jsdom
// eventmodeling 図のプラグイン。図からの操作の結果が mermaid.parse を通ること、対象の行以外（コメント・空行）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { eventmodelingPlugin, nextFrameId, parseFrames } from '../src/plugins/eventmodeling';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import { isPositional, type DiagramTarget, type ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const BASIC = all.eventmodeling.source;

async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = ChangeSet.of(change!, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => eventmodelingPlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => eventmodelingPlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => eventmodelingPlugin.inspect!(source, ref).find((f) => f.id === id);
const frame = (id: string): ElementRef => ({ kind: 'frame', id: `f${id}` });

function load(source = BASIC): DiagramTarget[] {
  document.body.innerHTML = `<div>${all.eventmodeling.svg}</div>`;
  return eventmodelingPlugin.mapTargets(document.querySelector('svg')!, source);
}
const refsOf = (targets: DiagramTarget[], kind: string) => targets.filter((x) => x.ref?.kind === kind).map((x) => x.ref!.id);

// コメント・data のブロックを挟んだ図
const COMMENTED = `eventmodeling
%% 画面
tf 01 ui Shop.CartScreen

// コマンド
tf 02 cmd AddItem ->> 01 [[Item]]
data Item {
  tf 99 ui Fake
}
/* 複数行の
   tf 98 ui Fake2 */
  rf 03 event ItemAdded ->> 02
tf 04 rmo CartItems ->> 03 ->> 02
`;
const untouched = COMMENTED.split('\n').filter((l) => !/^\s*(tf|rf)\s/.test(l));
const keeps = (out: string) => untouched.forEach((l) => expect(out.split('\n')).toContain(l));

describe('eventmodeling 図を読む', () => {
  it('枠の行を、番号・種類・名前・->> の先と範囲つきで読む（data のブロックとコメントの中は読まない）', () => {
    const fs = parseFrames(COMMENTED);
    expect(fs.map((f) => `${f.kw.value} ${f.id} ${f.type.canonical} ${f.entity.value} <${f.sources.map((s) => s.id).join(',')}>`)).toEqual([
      'tf 01 ui Shop.CartScreen <>',
      'tf 02 cmd AddItem <01>',
      'rf 03 evt ItemAdded <02>',
      'tf 04 rmo CartItems <03,02>',
    ]);
    const last = fs[3];
    expect(COMMENTED.slice(last.sources[1].clause.from, last.sources[1].clause.to)).toBe(' ->> 02');
    expect(COMMENTED.slice(fs[1].sourcesEnd - 6, fs[1].sourcesEnd)).toBe('->> 01');
  });

  it('新しい枠の番号は、いちばん大きい番号の次で、桁数をそろえる', () => {
    expect(nextFrameId(parseFrames(BASIC))).toBe('05');
    expect(nextFrameId(parseFrames('eventmodeling\ntf 7 ui A\n'))).toBe('08');
    expect(nextFrameId(parseFrames('eventmodeling\ntf 120 ui A\n'))).toBe('121');
    expect(nextFrameId(parseFrames('eventmodeling\ntf 01 ui A\ntf 999 ui B\n'))).toBe('002');
  });
});

describe('SVG との対応付け', () => {
  it('枠は行の順に、太字の名前を確かめて対応付ける。矢印は両端の枠で対応付ける', () => {
    const targets = load();
    expect(refsOf(targets, 'frame')).toEqual(['f01', 'f02', 'f03', 'f04']);
    for (const x of targets.filter((y) => y.ref?.kind === 'frame')) expect(BASIC.slice(x.range!.from, x.range!.to)).toBe(x.label);
    expect(refsOf(targets, 'relation')).toEqual(['1:0', '2:0', '3:0']);
    // 枠は番号で指す（並べ替えても同じ枠を指す）。矢印は位置で指す
    expect(isPositional(frame('01'))).toBe(false);
    expect(isPositional({ kind: 'relation', id: '1:0' })).toBe(true);
  });

  it('名前が合わない枠は対応付けない。名前空間.名前 は名前の部分を指す', () => {
    const changed = BASIC.replace('AddItem', 'Other');
    expect(refsOf(load(changed), 'frame')).toEqual(['f01', 'f03', 'f04']);
    const ns = BASIC.replace('ui CartScreen', 'ui Shop.CartScreen');
    const t = load(ns).find((x) => x.ref?.id === 'f01')!;
    expect(ns.slice(t.range!.from, t.range!.to)).toBe('CartScreen');
  });

  it('枠の数が合わなければ対応付けない', () => {
    expect(refsOf(load(`${BASIC}tf 05 ui Extra\n`), 'frame')).toEqual([]);
  });

  it('登録した図種で使われる', () => {
    expect(pluginFor('eventmodeling')).toBe(eventmodelingPlugin);
  });
});

describe('図からの操作', () => {
  it('枠を足す（最後の枠の後ろ）', async () => {
    const res = run('add-frame', COMMENTED)!;
    const out = await apply(COMMENTED, res.change);
    expect(out).toBe(`${COMMENTED}tf 05 ui Screen1\n`);
    expect(res.focus).toEqual(frame('05'));
  });

  it('次の枠（Tab）は、選んだ枠の次の行に、次の種類の枠を ->> 付きで足す', async () => {
    let res = run('add-next', COMMENTED, [frame('01')])!;
    let out = await apply(COMMENTED, res.change);
    expect(out).toContain('tf 01 ui Shop.CartScreen\ntf 05 cmd Command1 ->> 01\n');
    keeps(out);
    expect(res.focus).toEqual(frame('05'));
    res = run('add-next', COMMENTED, [frame('03')])!;
    out = await apply(COMMENTED, res.change);
    expect(out).toContain('  rf 03 event ItemAdded ->> 02\n  tf 05 rmo ReadModel1 ->> 03\n');
  });

  it('2 つの枠をつなぐと、後に続く枠の行に ->> を足す', async () => {
    const res = run('connect', COMMENTED, [frame('01'), frame('03')])!;
    const out = await apply(COMMENTED, res.change);
    expect(out).toContain('  rf 03 event ItemAdded ->> 02 ->> 01\n');
    keeps(out);
    // data の参照（[[…]]）の前に足す
    const d = await apply(COMMENTED, run('connect', COMMENTED, [frame('04'), frame('02')])!.change);
    expect(d).toContain('tf 02 cmd AddItem ->> 01 ->> 04 [[Item]]\n');
    // すでにつながっているもの・自分自身はつながない
    expect(run('connect', COMMENTED, [frame('01'), frame('02')])).toBeNull();
    expect(run('connect', COMMENTED, [frame('01'), frame('01')])).toBeNull();
  });

  it('枠を消すと、ほかの枠からその枠への ->> も外す', async () => {
    const out = await apply(COMMENTED, run('delete', COMMENTED, [frame('02')])!.change);
    expect(out).not.toContain('AddItem');
    expect(out).toContain('  rf 03 event ItemAdded\n');
    expect(out).toContain('tf 04 rmo CartItems ->> 03\n');
    keeps(out);
    // 数として同じ番号（->> 2）も外す
    const src = 'eventmodeling\ntf 01 ui A\ntf 02 cmd B ->> 1\n';
    expect(await apply(src, run('delete', src, [frame('01')])!.change)).toBe('eventmodeling\ntf 02 cmd B\n');
  });

  it('矢印を消すと、その ->> だけを外す', async () => {
    const out = await apply(COMMENTED, run('delete', COMMENTED, [{ kind: 'relation', id: '3:1' }])!.change);
    expect(out).toContain('tf 04 rmo CartItems ->> 03\n');
    keeps(out);
  });

  it('枠を前後に動かす（行を入れ替えるだけで、間の行には触れない）', async () => {
    let out = await apply(COMMENTED, run('move-up', COMMENTED, [frame('03')])!.change);
    expect(parseFrames(out).map((f) => f.id)).toEqual(['01', '03', '02', '04']);
    keeps(out);
    out = await apply(COMMENTED, run('move-down', COMMENTED, [frame('01')])!.change);
    expect(parseFrames(out).map((f) => f.id)).toEqual(['02', '01', '03', '04']);
    expect(run('move-up', COMMENTED, [frame('01')])).toBeNull();
    expect(run('move-down', COMMENTED, [frame('04')])).toBeNull();
  });

  it('ドラッグで並べ替える', async () => {
    const r = eventmodelingPlugin.reorder!;
    expect(r.axis(BASIC, frame('01'))).toBe('x');
    let out = await apply(BASIC, r.move!(BASIC, frame('04'), frame('01'), true)!.change);
    expect(parseFrames(out).map((f) => f.id)).toEqual(['04', '01', '02', '03']);
    out = await apply(BASIC, r.move!(BASIC, frame('01'), frame('04'), false)!.change);
    expect(parseFrames(out).map((f) => f.id)).toEqual(['02', '03', '04', '01']);
    expect(r.move!(BASIC, frame('01'), frame('02'), true)).toBeNull();
  });

  it('すべての操作が、見本のすべての要素で構文を壊さない', async () => {
    const refs = load()
      .map((x) => x.ref)
      .filter((r): r is ElementRef => !!r);
    for (const a of eventmodelingPlugin.actions!) {
      const kinds = a.appliesTo ?? ['node'];
      const argsList = a.arity === 0 ? [[]] : refs.filter((r) => kinds.includes(r.kind)).map((r) => (a.arity === 2 ? [r, refs.find((x) => x !== r && kinds.includes(x.kind))!] : [r]));
      for (const args of argsList) {
        const res = a.run(BASIC, args as ElementRef[]);
        if (res) await apply(BASIC, res.change);
      }
    }
  });
});

describe('プロパティ', () => {
  it('枠の名前・種類・枠の種類・->> の先は、その範囲だけを変える', async () => {
    const f2 = frame('02');
    expect(field(COMMENTED, f2, 'type')!.value).toBe('cmd');
    expect(field(COMMENTED, frame('03'), 'kind')!.value).toBe('rf');
    expect(field(COMMENTED, frame('04'), 'sources')!.value).toBe('03 02');
    let out = await apply(COMMENTED, prop(COMMENTED, f2, 'name', 'Cart.AddProduct'));
    expect(out).toContain('tf 02 cmd Cart.AddProduct ->> 01 [[Item]]\n');
    keeps(out);
    out = await apply(COMMENTED, prop(COMMENTED, f2, 'type', 'pcr'));
    expect(out).toContain('tf 02 pcr AddItem ->> 01 [[Item]]\n');
    out = await apply(COMMENTED, prop(COMMENTED, frame('03'), 'kind', 'tf'));
    expect(out).toContain('  tf 03 event ItemAdded ->> 02\n');
    out = await apply(COMMENTED, prop(COMMENTED, frame('04'), 'sources', '01, 03'));
    expect(out).toContain('tf 04 rmo CartItems ->> 01 ->> 03\n');
    out = await apply(COMMENTED, prop(COMMENTED, frame('04'), 'sources', ''));
    expect(out).toContain('tf 04 rmo CartItems\n');
    out = await apply(COMMENTED, prop(COMMENTED, frame('01'), 'sources', '04'));
    expect(out).toContain('tf 01 ui Shop.CartScreen ->> 04\n');
  });

  it('書けない名前・番号は受け付けない', () => {
    expect(prop(COMMENTED, frame('02'), 'name', '買い物')).toBeNull();
    expect(prop(COMMENTED, frame('02'), 'name', 'data')).toBeNull();
    expect(prop(COMMENTED, frame('02'), 'name', '1abc')).toBeNull();
    expect(prop(COMMENTED, frame('02'), 'sources', '1000')).toBeNull();
    expect(prop(COMMENTED, frame('02'), 'type', 'xyz')).toBeNull();
  });
});
