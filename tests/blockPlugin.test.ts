// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/rendered-svg.json';
import { blockPlugin, parseBlock } from '../src/plugins/block';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import { applySpec } from '../src/plugins/source';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import type { ElementRef } from '../src/plugins/types';

const fx = (fixtures as Record<string, { source: string; svg: string }>).block;
const SRC = fx.source;

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec) {
  const out = ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const action = (id: string) => blockPlugin.actions!.find((a) => a.id === id)!;
const run = (id: string, source: string, refs: ElementRef[] = []) => action(id).run(source, refs);
const block = (id: string): ElementRef => ({ kind: 'block-item', id });

/** 変わった行（コメント行が残ることを確かめる） */
const keeps = (before: string, after: string, line: string) => {
  expect(before).toContain(line);
  expect(after).toContain(line);
};

describe('block 図', () => {
  it('mermaid は block として読み、プラグインが登録されている', async () => {
    const r = await validate(SRC);
    expect(r.ok && r.diagramType).toBe('block');
    expect(pluginFor('block')).toBe(blockPlugin);
  });

  it('ブロック・入れ子・列の数・矢印を読む', () => {
    const p = parseBlock(SRC);
    expect(p.items.map((x) => [x.id, x.parent, x.width?.value ?? null])).toEqual([
      ['front', null, null],
      ['api', null, 2],
      ['db', 'back', null],
      ['cache', 'back', null],
      ['queue', 'back', null],
    ]);
    expect(p.groups.map((g) => [g.id, g.width?.value])).toEqual([['back', 3]]);
    expect(p.columns.map((c) => c.value)).toEqual(['3']);
    expect(p.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['front>api', 'api>db']);
    const db = p.items.find((x) => x.id === 'db')!;
    expect(SRC.slice(db.label!.from, db.label!.to)).toBe('データベース');
    expect(db.shape).toMatchObject({ open: '[(', close: ')]' });
    const queue = p.items.find((x) => x.id === 'queue')!;
    expect(queue.shape).toMatchObject({ open: '>', close: ']' });
  });

  it('描いた SVG のブロックと矢印をソースに対応付ける', () => {
    document.body.innerHTML = `<div>${fx.svg}</div>`;
    const svg = document.querySelector('svg')!;
    const targets = blockPlugin.mapTargets(svg, SRC);
    const refs = targets.filter((x) => x.ref).map((x) => `${x.ref!.kind}:${x.ref!.id}`);
    expect(refs).toEqual(expect.arrayContaining(['block-item:front', 'block-item:api', 'block-item:back', 'block-item:db', 'block-item:cache', 'block-item:queue', 'edge:0', 'edge:1']));
    const api = targets.find((x) => x.ref?.id === 'api')!;
    expect(api.label).toBe('API');
    expect(SRC.slice(api.range!.from, api.range!.to)).toBe('API');
  });

  it('ブロックを足す（トップレベルの最後・同じ行の次・入れ子の中）', async () => {
    const top = await apply(SRC, run('add-block', SRC)!.change);
    expect(top).toContain('    end\n    b1["新しいブロック"]\n    front --> api');
    keeps(SRC, top, '%% 画面とサーバーの構成');
    const next = await apply(SRC, run('add-next', SRC, [block('front')])!.change);
    expect(next).toContain('front["フロント"] b1["新しいブロック"] api["API"]:2');
    const inside = await apply(SRC, run('add-inside', SRC, [block('back')])!.change);
    expect(inside).toContain('queue>"キュー"]\n        b1["新しいブロック"]\n    end');
  });

  it('形を選んでブロックを足せる（どの形も mermaid.parse を通る）', async () => {
    for (const { value } of action('add-block').shapes!) {
      const out = await apply(SRC, action('add-block').run(SRC, [], value)!.change);
      keeps(SRC, out, '%% 画面とサーバーの構成');
      expect(parseBlock(out).items.find((x) => x.id === 'b1')?.label).toBeTruthy();
    }
    expect(await apply(SRC, action('add-block').run(SRC, [], 'cylinder')!.change)).toContain('    b1[("新しいブロック")]\n');
    expect(action('add-block').run(SRC, [], 'no-such-shape')).toBeNull();
  });

  it('矢印を足し、ブロックを消すと矢印も消える', async () => {
    const connected = await apply(SRC, run('connect', SRC, [block('cache'), block('queue')])!.change);
    expect(connected).toMatch(/api --> db\n {4}cache --> queue\n$/);
    const removed = await apply(SRC, run('delete', SRC, [block('api')])!.change);
    expect(removed).toContain('front["フロント"]\n');
    expect(removed).not.toContain('api');
    keeps(SRC, removed, '%% 画面とサーバーの構成');
    const group = await apply(SRC, run('delete', SRC, [block('back')])!.change);
    expect(group).not.toMatch(/block:|end|db/);
    const edge = await apply(SRC, run('delete', SRC, [{ kind: 'edge', id: '0' }])!.change);
    expect(edge).not.toContain('front --> api');
    expect(edge).toContain('api --> db');
  });

  it('ラベル・形・幅・列の数を変える（対象の範囲だけを書き換える）', async () => {
    const set = (ref: ElementRef | null, field: string, value: string) => blockPlugin.setProperty!(SRC, ref, field, value)!;
    expect(await apply(SRC, set(block('api'), 'label', 'API サーバー'))).toContain('api["API サーバー"]:2');
    expect(await apply(SRC, set(block('front'), 'shape', 'round'))).toContain('front("フロント")');
    expect(await apply(SRC, set(block('front'), 'width', '2'))).toContain('front["フロント"]:2 api');
    expect(await apply(SRC, set(block('api'), 'width', '1'))).toContain('api["API"]\n');
    expect(await apply(SRC, set(null, 'columns', '4'))).toContain('columns 4');
    expect(await apply(SRC, set(block('back'), 'columns', '2'))).toContain('block:back:3\n        columns 2\n');
    expect(await apply(SRC, set(block('back'), 'width', '2'))).toContain('block:back:2');
    // ラベルの無いブロックには括弧ごと付ける
    const bare = 'block-beta\n  a b\n';
    expect(await apply(bare, blockPlugin.setProperty!(bare, block('a'), 'label', 'エー')!)).toBe('block-beta\n  a["エー"] b\n');
    expect(applySpec(bare, blockPlugin.setProperty!(bare, block('b'), 'shape', 'circle')!)).toBe('block-beta\n  a b(("b"))\n');
  });

  it('同じ行に矢印などの読めない書き方がある行のブロックは消さない（他のブロックを巻き込まないように）', () => {
    const src = 'block-beta\n  columns 2\n  a["A"] --> b["B"]\n  c["C"]\n';
    expect(run('delete', src, [block('a')])).toBeNull();
    expect(applySpec(src, run('delete', src, [block('c')])!.change)).toBe('block-beta\n  columns 2\n  a["A"] --> b["B"]\n');
  });
});