// @vitest-environment jsdom
// 表で編集する図種（pie・gantt など）で、図のラベルから表の行を選び、プロパティと図の上のボタンで編集できること。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { pluginFor } from '../src/plugins/registry';
import { ROW } from '../src/plugins/dataPlugins';
import { validate } from '../src/render/mermaid';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec) {
  const out = ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

function targetsOf(id: string, type: string) {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  const plugin = pluginFor(type);
  return { plugin, source: f.source, targets: plugin.mapTargets(document.querySelector('svg')!, f.source) };
}

const run = (plugin: DiagramPlugin, id: string, source: string, ref: ElementRef) => plugin.actions!.find((a) => a.id === id)!.run(source, [ref]);
const row = (line: number): ElementRef => ({ kind: ROW, id: String(line) });
const lines = (s: string) => s.split('\n');

describe('表の行を図から編集する', () => {
  it('pie: スライスのラベルが、その行（行番号）を指す', () => {
    const { targets } = targetsOf('pie', 'pie');
    const chrome = targets.find((x) => x.label === 'Chrome')!;
    expect(chrome.ref).toEqual(row(2));
    expect(targets.find((x) => x.label === 'その他')!.ref).toEqual(row(5));
  });

  it('pie: プロパティに行の値が出て、変えると値の範囲だけを書き換える', async () => {
    const { plugin, source } = targetsOf('pie', 'pie');
    const fields = plugin.inspect!(source, row(3));
    expect(fields.map((f) => [f.id, f.value])).toEqual([
      ['#kind', 'スライス'],
      ['label', 'Safari'],
      ['value', '20'],
    ]);
    const out = await apply(source, plugin.setProperty!(source, row(3), 'value', '25')!);
    expect(lines(out)[2]).toBe('    "Safari" : 25');
    expect(lines(out).filter((_, i) => i !== 2)).toEqual(lines(source).filter((_, i) => i !== 2));
    // 種類は表示だけ
    expect(plugin.setProperty!(source, row(3), '#kind', 'x')).toBeNull();
  });

  it('pie: 後ろに同じ種類の行を足し、足した行を選ぶ', async () => {
    const { plugin, source } = targetsOf('pie', 'pie');
    const res = run(plugin, 'add-row', source, row(2))!;
    const out = await apply(source, res.change);
    expect(lines(out)[2]).toMatch(/^ {4}"[^"]+" : 10$/);
    expect(res.select).toEqual(row(3));
    expect(plugin.inspect!(out, res.select!)[1].value).toBe(lines(out)[2].match(/"(.*)"/)![1]);
  });

  it('pie: 前後と入れ替え、動かした行を選び続ける', async () => {
    const { plugin, source } = targetsOf('pie', 'pie');
    const res = run(plugin, 'move-down', source, row(2))!;
    const out = await apply(source, res.change);
    expect(lines(out).slice(1, 3)).toEqual(['    "Safari" : 20', '    "Chrome" : 62']);
    expect(res.select).toEqual(row(3));
    // 先頭の行は上へ動かせない
    expect(run(plugin, 'move-up', source, row(2))).toBeNull();
  });

  it('pie: 行を消す（他の行は残る）', async () => {
    const { plugin, source } = targetsOf('pie', 'pie');
    const out = await apply(source, run(plugin, 'delete', source, row(4))!.change);
    expect(out).not.toContain('Firefox');
    expect(lines(out)).toEqual(lines(source).filter((l) => !l.includes('Firefox')));
  });

  it('gantt: タスクの行を選び、省略された値（開始）を足せる', async () => {
    const { plugin, source, targets } = targetsOf('gantt', 'gantt');
    const ref = targets.find((x) => x.label === '基本設計')!.ref!;
    expect(ref).toEqual(row(6));
    const out = await apply(source, plugin.setProperty!(source, ref, 'id', 'a2')!);
    expect(lines(out)[5]).toContain('a2');
  });

  it('ラベルの無い要素も、意味のある値で行に対応付ける（流れ・系列・コミット・要求・利用者）', () => {
    const refsBy = (id: string, type: string, sel: string) =>
      targetsOf(id, type)
        .targets.filter((x) => x.ref && x.el.matches(sel))
        .map((x) => x.ref!.id);
    // サンキー図の流れは、元と先のノードの色で行を決める
    expect(refsBy('sankey', 'sankey', 'g.link')).toEqual(['2', '3', '4', '5']);
    // XY チャートの系列は bar-plot-<番号> / line-plot-<番号>
    expect(refsBy('xychart', 'xychart', 'g.plot > g')).toEqual(['5', '6']);
    // Git グラフのコミットの点は commit・merge の行の順（merge の点は 2 つ描かれるが 1 つ目だけ）
    expect(refsBy('gitgraph', 'gitGraph', 'circle.commit')).toEqual(['2', '5', '6', '8', '9']);
    // 要求図の要求・要素は g.node の id、関係は線の data-id の端点
    expect(refsBy('requirement', 'requirement', 'g.node, path')).toEqual(['2', '8', '11']);
    // ユースケース図の利用者は data-usecase-id
    expect(refsBy('usecase', 'usecase', 'g[data-usecase-kind="actor"]')).toEqual(['2', '3']);
  });

  it('Git グラフ: ID を書いたコミットは ID が合うことを確かめ、合わなければ対応付けない', () => {
    const f = all.gitgraph;
    document.body.innerHTML = `<div>${f.svg}</div>`;
    const plugin = pluginFor('gitGraph');
    const other = f.source.replace('    commit\n    branch', '    commit id: "x"\n    branch');
    expect(plugin.mapTargets(document.querySelector('svg')!, other).some((x) => x.el.matches('circle.commit') && x.ref)).toBe(false);
  });

  it('Git グラフ: ただのコミットの行は消せる（後ろの行が頼っていない）', async () => {
    const { plugin, source } = targetsOf('gitgraph', 'gitGraph');
    const out = await apply(source, run(plugin, 'delete', source, row(9))!.change);
    expect(lines(out)).toEqual(lines(source).filter((_, i) => i !== 8));
  });

  it('要求図: 要求・要素は { から } までのまとまりで、足す・消す・動かす', async () => {
    const { plugin, source } = targetsOf('requirement', 'requirement');
    // 要求の後ろに足すと、} の後ろに入る
    const res = run(plugin, 'add-row', source, row(2))!;
    let out = await apply(source, res.change);
    expect(lines(out).slice(6, 9)).toEqual(['    }', '    requirement req1 {', '    id: req1']);
    expect(res.select).toEqual(row(8));
    // 消すと、まとまりごと消える
    out = await apply(source, run(plugin, 'delete', source, row(8))!.change);
    expect(out).not.toContain('element history_tree');
    expect(out).not.toContain('type: module');
    // 動かすと、まとまりごと入れ替わる
    out = await apply(source, run(plugin, 'move-down', source, row(2))!.change);
    expect(lines(out).slice(1, 4)).toEqual(['    element history_tree {', '    type: module', '    }']);
  });

  it('パケット図: 欄は最後にだけ足し、次のビットから始める。途中の欄は消さない・動かさない', async () => {
    const { plugin, source, targets } = targetsOf('packet', 'packet');
    const first = targets.find((x) => x.label === '送信元ポート')!.ref!;
    const out = await apply(source, run(plugin, 'add-row', source, first)!.change);
    expect(lines(out).at(-1)).toMatch(/^64-71: "[^"]+"$/);
    expect(run(plugin, 'delete', source, first)).toBeNull();
    expect(run(plugin, 'move-down', source, first)).toBeNull();
    const last = targets.find((x) => x.label === 'シーケンス番号')!.ref!;
    expect(await apply(source, run(plugin, 'delete', source, last)!.change)).not.toContain('シーケンス番号');
  });

  it('次の行は、選んだ行に属する行（section の中・期間の続き・treemap の子）の後ろに足す', async () => {
    // gantt: section の次の section は、その section のタスクの後ろ（間に入れると、タスクを新しい section が取る）
    let { plugin, source } = targetsOf('gantt', 'gantt');
    let res = run(plugin, 'add-row', source, row(4))!;
    let out = await apply(source, res.change);
    expect(lines(out).slice(3, 8)).toEqual(['    section 設計', '    要件定義 :a1, 2026-11-01, 7d', '    基本設計 :after a1, 10d', '    section 新しいセクション', '    section 実装']);
    expect(res.select).toEqual(row(7));
    // timeline: 期間の次の期間は、「: 出来事」の続きの後ろ
    const tl = 'timeline\n    2020 : A\n         : B\n    2021 : C';
    out = await apply(tl, run(pluginFor('timeline'), 'add-row', tl, row(2))!.change);
    expect(lines(out)[3]).toMatch(/^ {4}\S.* : /);
    expect(lines(out)[2]).toBe('         : B');
    // treemap: 親の次の項目は、子の後ろに同じ深さで
    ({ plugin, source } = targetsOf('treemap', 'treemap'));
    res = run(plugin, 'add-row', source, row(2))!;
    out = await apply(source, res.change);
    expect(lines(out).slice(1, 5)).toEqual(['"製品"', '    "アプリ": 30', '    "サーバー": 20', '"新しい項目": 10']);
  });

  it('treemap: 名前のラベルを先に行へ割り当てる（親の合計の数が、子の値と一致しても取らない）', () => {
    const { targets } = targetsOf('treemap', 'treemap');
    expect(targets.find((x) => x.label === '保守')!.ref).toEqual(row(6));
    expect(targets.filter((x) => x.label === '15').every((x) => !x.ref)).toBe(true);
  });

  it('XY チャート: 表で読めない系列（引用符の無い名前）があれば、系列を対応付けない（番号がずれるため）', () => {
    const f = all.xychart;
    document.body.innerHTML = `<div>${f.svg}</div>`;
    const other = f.source.replace('    bar [10, 22, 31, 45]', '    bar Sales [10, 22, 31, 45]');
    const targets = pluginFor('xychart').mapTargets(document.querySelector('svg')!, other);
    expect(targets.some((x) => x.ref && x.el.matches('g.plot > g'))).toBe(false);
  });

  it('要求図・ユースケース図: 要素の中のラベルは要素にまとめる（選んでも何もできないラベルを残さない）', () => {
    let { targets } = targetsOf('requirement', 'requirement');
    const node = targets.find((x) => x.el.matches('g.node') && x.ref)!;
    // 要求の名前は関係の行からも参照されるので、図の上では書き換えない（宣言だけ変えると関係が切れる）
    expect(node.label).toBe('undo_history');
    expect(node.range).toBeNull();
    // 要素の中に、選んでも何もできないラベルが残らない
    expect(targets.filter((x) => !x.ref && node.el.contains(x.el))).toEqual([]);
    ({ targets } = targetsOf('usecase', 'usecase'));
    const actor = targets.find((x) => x.ref?.id === '2')!;
    expect(actor.label).toBe('User');
    expect(targets.filter((x) => !x.ref && actor.el.contains(x.el))).toEqual([]);
  });

  it('要求図: 複数行のまとまりを動かしても、動かした行を選び続ける', async () => {
    const { plugin, source } = targetsOf('requirement', 'requirement');
    const res = run(plugin, 'move-down', source, row(2))!;
    const out = await apply(source, res.change);
    expect(res.select).toEqual(row(5));
    expect(plugin.inspect!(out, res.select!).find((f) => f.id === 'name')!.value).toBe('undo_history');
  });

  it('Git グラフ: 後ろの行が頼っている行（branch・checkout・最初の branch の前のただ 1 つのコミット）は消さない', () => {
    const { plugin, source } = targetsOf('gitgraph', 'gitGraph');
    for (const line of [2, 3, 4, 7]) expect(run(plugin, 'delete', source, row(line)), `${line} 行目`).toBeNull();
    expect(run(plugin, 'delete', source, row(5))).not.toBeNull();
  });

  it('Git グラフ: commit1 のような ID のコミットも対応付ける', () => {
    const f = all.gitgraph;
    // 点の class は「commit <ID> commit<ブランチの番号>」。ID を書き換えた SVG とソースで確かめる
    const svg = f.svg.replace(/class="commit 0-\w+ commit0"/, 'class="commit commit1 commit0"');
    document.body.innerHTML = `<div>${svg}</div>`;
    const source = f.source.replace('gitGraph\n    commit\n', 'gitGraph\n    commit id: "commit1"\n');
    const targets = pluginFor('gitGraph').mapTargets(document.querySelector('svg')!, source);
    expect(targets.filter((x) => x.el.matches('circle.commit')).map((x) => x.ref!.id)).toEqual(['2', '5', '6', '8', '9']);
  });

  it('行でない要素や、別の行番号は何も返さない', () => {
    const { plugin, source } = targetsOf('pie', 'pie');
    expect(plugin.inspect!(source, row(1))).toEqual([]);
    expect(plugin.inspect!(source, { kind: 'node', id: '2' })).toEqual([]);
    expect(run(plugin, 'delete', source, row(99))).toBeNull();
  });
});
