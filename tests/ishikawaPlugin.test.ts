// @vitest-environment jsdom
// ishikawa（特性要因図）の図からの編集。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { ishikawaPlugin, parseIshikawa } from '../src/plugins/ishikawa';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { ElementRef } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec) {
  const out = ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

function load(id: string) {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  return { source: f.source, targets: ishikawaPlugin.mapTargets(document.querySelector('svg')!, f.source) };
}

const run = (id: string, source: string, ref: ElementRef) => ishikawaPlugin.actions!.find((a) => a.id === id)!.run(source, [ref]);
const cause = (i: number): ElementRef => ({ kind: 'cause', id: String(i) });
const labels = (source: string) => parseIshikawa(source).map((n) => `${n.level}:${source.slice(n.label.from, n.label.to)}`);

describe('ishikawa', () => {
  it('mermaid は ishikawa として読み、プラグインが登録されている', async () => {
    const r = await validate(all.ishikawa.source);
    expect(r.ok && r.diagramType).toBe('ishikawa');
    expect(pluginFor('ishikawa')).toBe(ishikawaPlugin);
  });

  it('頭と要因の階層を、最初の要因からのインデントで読む', () => {
    expect(labels(all['ishikawa-full'].source)).toEqual([
      '0:遅配',
      '1:車両',
      '2:古いトラック',
      '3:故障が多い',
      '2:GPS が古い',
      '1:方法',
      '2:手作業の配車',
      '1:人',
      '2:夜勤の<br>教育不足',
      '1:天候',
    ]);
    // 頭を宣言行に続けて書いてもよく、要因のインデントの深さは問わない
    expect(labels('ishikawa 結果\n  A\n      B\n  C')).toEqual(['0:結果', '1:A', '2:B', '1:C']);
  });

  it('図の要素を、描く順番（上側は子を逆順）とラベルで対応付ける', () => {
    for (const id of ['ishikawa', 'ishikawa-full']) {
      const { source, targets } = load(id);
      const mapped = targets.filter((x) => x.ref);
      expect(mapped.length).toBe(parseIshikawa(source).length);
      for (const x of mapped) {
        const n = parseIshikawa(source)[Number(x.ref!.id)];
        expect(x.range).toEqual(n.label);
        expect(x.ref!.kind).toBe(n.level === 0 ? 'effect' : 'cause');
      }
      // 選んだ g の中に、そのラベルの文字が描かれている
      const gps = mapped.find((x) => x.label === 'GPS が古い');
      if (gps) expect(gps.el.textContent).toBe('GPS が古い');
    }
  });

  it('ソースと図が合わなければ、要素としては対応付けない', () => {
    const { targets } = load('ishikawa');
    document.body.innerHTML = `<div>${all.ishikawa.svg}</div>`;
    const other = ishikawaPlugin.mapTargets(document.querySelector('svg')!, all.ishikawa.source.replace('点検不足', '点検の不足'));
    expect(targets.some((x) => x.ref)).toBe(true);
    expect(other.some((x) => x.ref)).toBe(false);
  });

  it('文言を変える（範囲だけを書き換え、空や改行は書かない）', async () => {
    const src = all.ishikawa.source;
    const out = await apply(src, ishikawaPlugin.setProperty!(src, cause(2), 'label', '老朽化した設備')!);
    expect(out).toBe(src.replace('古い設備', '老朽化した設備'));
    expect(ishikawaPlugin.setProperty!(src, cause(2), 'label', '  ')).toBeNull();
    expect(ishikawaPlugin.setProperty!(src, cause(2), 'label', '%% x')).toBeNull();
    expect(ishikawaPlugin.inspect!(src, cause(2)).map((f) => [f.id, f.value])).toEqual([
      ['label', '古い設備'],
      ['level', '2'],
    ]);
  });

  it('子・兄弟を足し、足した要素の番号を返す', async () => {
    const src = all.ishikawa.source;
    let res = run('add-child', src, cause(1))!; // 機械の中
    let out = await apply(src, res.change);
    expect(labels(out).slice(1, 5)).toEqual(['1:機械', '2:古い設備', '2:点検不足', '2:新しい要因']);
    expect(res.focus).toEqual(cause(4));
    res = run('add-sibling', src, cause(1))!; // 機械の次
    out = await apply(src, res.change);
    expect(labels(out)[4]).toBe('1:新しい要因');
    expect(res.focus).toEqual(cause(4));
    // 頭に足すと大骨になる
    res = run('add-child', src, { kind: 'effect', id: '0' })!;
    out = await apply(src, res.change);
    expect(labels(out).at(-1)).toBe('1:新しい要因');
    // 要因の無い頭にも足せる
    out = await apply('ishikawa-beta\n結果', run('add-child', 'ishikawa-beta\n結果', { kind: 'effect', id: '0' })!.change);
    expect(labels(out)).toEqual(['0:結果', '1:新しい要因']);
  });

  it('兄弟のあいだで動かし、部分木ごと消す（頭は消さない）', async () => {
    const src = all.ishikawa.source;
    let out = await apply(src, run('move-down', src, cause(1))!.change);
    expect(labels(out).slice(1, 6)).toEqual(['1:方法', '2:手順書が無い', '1:機械', '2:古い設備', '2:点検不足']);
    out = await apply(src, run('delete', src, cause(1))!.change);
    expect(out).not.toContain('機械');
    expect(out).not.toContain('古い設備');
    expect(out).toContain('方法');
    expect(run('delete', src, { kind: 'effect', id: '0' })).toBeNull();
    expect(run('move-up', src, cause(1))).toBeNull();
  });

  it('動かした後も、動かした要因を選び続ける（番号で指すので、新しい番号を返す）', async () => {
    const src = all.ishikawa.source;
    // 機械（1、子 2 つ）を下へ: 方法（子 1 つ）の後ろに入るので 1 + 2 = 3 番
    let res = run('move-down', src, cause(1))!;
    let out = await apply(src, res.change);
    expect(res.select).toEqual(cause(3));
    expect(labels(out)[3]).toBe('1:機械');
    // 方法（4）を上へ: 機械の位置（1）
    res = run('move-up', src, cause(4))!;
    out = await apply(src, res.change);
    expect(res.select).toEqual(cause(1));
    expect(labels(out)[1]).toBe('1:方法');
  });
});
