// @vitest-environment jsdom
// treeView（ファイルの木）の図からの編集。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { parseTreeView, treeViewPlugin } from '../src/plugins/treeView';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { ElementRef } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;
const SRC = all.treeview.source;
const FULL = all['treeview-full'].source;

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
  return treeViewPlugin.mapTargets(document.querySelector('svg')!, f.source);
}

const entry = (i: number): ElementRef => ({ kind: 'entry', id: String(i) });
const run = (id: string, source: string, ref: ElementRef) => treeViewPlugin.actions!.find((a) => a.id === id)!.run(source, [ref]);
const set = (source: string, i: number, field: string, value: string) => treeViewPlugin.setProperty!(source, entry(i), field, value);
const names = (source: string) => parseTreeView(source).entries.map((e) => `${e.depth}:${source.slice(e.name.from, e.name.to)}${e.slash !== null ? '/' : ''}`);
const lines = (s: string) => s.split('\n');

describe('treeView', () => {
  it('mermaid は treeView として読み、プラグインが登録されている', async () => {
    const r = await validate(SRC);
    expect(r.ok && r.diagramType).toBe('treeView');
    expect(pluginFor('treeView')).toBe(treeViewPlugin);
  });

  it('項目の名前・フォルダ・注記を読む（title の行は項目にしない）', () => {
    expect(names(FULL)).toEqual(['0:my project/', '1:src/', '2:index.ts', '2:utils file.ts', '1:README.md']);
    const [, src, index] = parseTreeView(FULL).entries;
    expect(FULL.slice(src.cls!.value.from, src.cls!.value.to)).toBe('highlight');
    expect(FULL.slice(index.icon!.value.from, index.icon!.value.to)).toBe('mdi:language-typescript');
    expect(FULL.slice(index.desc!.value.from, index.desc!.value.to)).toBe('入口');
  });

  it('図の項目（仮の根の後ろ）を、ソースの行の順と名前で対応付ける', () => {
    for (const id of ['treeview', 'treeview-full']) {
      const targets = load(id).filter((x) => x.ref);
      expect(targets.length).toBe(parseTreeView(all[id].source).entries.length);
      targets.forEach((x, i) => expect(x.ref).toEqual(entry(i)));
    }
  });

  it('名前を変える。区切りになる文字を含む名前は引用符で囲む', async () => {
    let out = await apply(SRC, set(SRC, 3, 'name', 'plugin')!);
    expect(lines(out)[4]).toBe('            plugin/ :::highlight');
    out = await apply(SRC, set(SRC, 2, 'name', 'a ## b')!);
    expect(lines(out)[3]).toBe('            "a ## b" ## 入口');
    // 引用符の中の名前は、引用符を残して中だけ変える
    out = await apply(FULL, set(FULL, 3, 'name', 'util.ts')!);
    expect(lines(out)[5]).toBe("            'util.ts'");
    expect(set(SRC, 2, 'name', '')).toBeNull();
  });

  it('ファイルとフォルダを切り替える', async () => {
    let out = await apply(SRC, set(SRC, 4, 'kind', 'dir')!);
    expect(lines(out)[5]).toBe('        package.json/');
    out = await apply(FULL, set(FULL, 0, 'kind', 'file')!);
    expect(lines(out)[2]).toBe('    "my project"');
    expect(set(SRC, 4, 'kind', 'file')).toBeNull();
  });

  it('説明・アイコン・クラスを足す・変える・外す', async () => {
    let out = await apply(SRC, set(SRC, 4, 'desc', '依存')!);
    expect(lines(out)[5]).toBe('        package.json ## 依存');
    out = await apply(SRC, set(SRC, 2, 'desc', '')!);
    expect(lines(out)[3]).toBe('            main.tsx');
    // 説明の付いた行では、他の注記は説明の前に足す
    out = await apply(SRC, set(SRC, 2, 'icon', 'mdi:react')!);
    expect(lines(out)[3]).toBe('            main.tsx icon(mdi:react) ## 入口');
    out = await apply(SRC, set(SRC, 3, 'class', '')!);
    expect(lines(out)[4]).toBe('            plugins/');
    expect(set(SRC, 3, 'class', 'a b')).toBeNull();
  });

  it('中・次に足し、ファイルの中に足すとフォルダにする', async () => {
    let res = run('add-child', SRC, entry(4))!;
    let out = await apply(SRC, res.change);
    expect(names(out).slice(4, 6)).toEqual(['1:package.json/', '2:新しいファイル']);
    expect(res.focus).toEqual(entry(5));
    res = run('add-sibling', SRC, entry(1))!;
    out = await apply(SRC, res.change);
    expect(names(out)[4]).toBe('1:新しいファイル');
    expect(res.focus).toEqual(entry(4));
  });

  it('兄弟のあいだで動かし、部分木ごと消す', async () => {
    let out = await apply(SRC, run('move-down', SRC, entry(1))!.change);
    expect(names(out)).toEqual(['0:mermaid-studio/', '1:package.json', '1:src/', '2:main.tsx', '2:plugins/', '1:README.md']);
    out = await apply(SRC, run('delete', SRC, entry(1))!.change);
    expect(names(out)).toEqual(['0:mermaid-studio/', '1:package.json', '1:README.md']);
    expect(run('delete', 'treeView-beta\n    a', entry(0))).toBeNull();
    // ただ 1 つの最上位の項目は、子があっても消さない（中身ごと消えて空の木になる）
    expect(run('delete', SRC, entry(0))).toBeNull();
    // 動かした後も、動かした項目を選び続ける
    expect(run('move-down', SRC, entry(1))!.select).toEqual(entry(2));
    expect(run('move-up', SRC, entry(4))!.select).toEqual(entry(1));
  });

  it('罫線で書いた木は、名前は変えられるが、足す・消す・動かすはしない', async () => {
    const boxed = 'treeView-beta\nroot/\n├── src/\n│   └── index.ts\n└── package.json';
    expect(names(boxed)).toEqual(['0:root/', '1:src/', '2:index.ts', '1:package.json']);
    const out = await apply(boxed, set(boxed, 2, 'name', 'main.ts')!);
    expect(out).toContain('│   └── main.ts');
    for (const a of ['add-child', 'add-sibling', 'move-down', 'delete']) expect(run(a, boxed, entry(2))).toBeNull();
  });

  it('図全体のタイトル', async () => {
    const out = await apply(FULL, treeViewPlugin.setProperty!(FULL, null, 'title', '新しい構成')!);
    expect(lines(out)[1]).toBe('    title 新しい構成');
  });
});
