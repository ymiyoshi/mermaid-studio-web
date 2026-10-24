// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { addRow, deleteRow, moveRow, setCell, tableRows } from '../src/plugins/table';
import {
  c4Plugin,
  ganttPlugin,
  gitGraphPlugin,
  parseGanttTask,
  piePlugin,
  quadrantPlugin,
  sankeyPlugin,
  xyPlugin,
} from '../src/plugins/dataPlugins';
import type { DiagramPlugin } from '../src/plugins/types';

const apply = (source: string, spec: ChangeSpec | ChangeSpec[] | null) => {
  expect(spec).toBeTruthy();
  return ChangeSet.of(spec!, source.length).apply(Text.of(source.split('\n'))).toString();
};
const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
const rows = (p: DiagramPlugin, s: string) => tableRows(s, p.tables![0]);

describe('pie', () => {
  const SRC = 'pie title 利用ブラウザ\n    "Chrome" : 62\n    %% コメント\n    "Safari" : 20\n';

  it('スライスを読み、値・ラベルを書き換える', async () => {
    const r = rows(piePlugin, SRC);
    expect(r.map((x) => x.values)).toEqual([
      { label: 'Chrome', value: '62' },
      { label: 'Safari', value: '20' },
    ]);
    let out = apply(SRC, setCell(r[1], 'value', '35'));
    expect(out).toContain('    "Safari" : 35\n');
    out = apply(SRC, setCell(r[0], 'label', 'Google "Chrome"'));
    expect(out).toContain('"Google #quot;Chrome#quot;" : 62');
    await valid(out);
  });

  it('行の追加・削除・並べ替え（コメントは残る）', async () => {
    const r = rows(piePlugin, SRC);
    let out = apply(SRC, addRow(SRC, r, piePlugin.tables![0].schemas[0], r[0]));
    expect(out).toContain('    "Chrome" : 62\n    "新しい項目" : 10\n    %% コメント');
    await valid(out);
    out = apply(SRC, deleteRow(SRC, r[0]));
    expect(out).toBe('pie title 利用ブラウザ\n    %% コメント\n    "Safari" : 20\n');
    out = apply(SRC, moveRow(r, 1, -1));
    expect(out).toBe('pie title 利用ブラウザ\n    "Safari" : 20\n    %% コメント\n    "Chrome" : 62\n');
    await valid(out);
  });

  it('タイトルは宣言行のものも編集できる', () => {
    expect(piePlugin.inspect!(SRC, null)[0].value).toBe('利用ブラウザ');
    const out = apply(SRC, piePlugin.setProperty!(SRC, null, 'title', '内訳'));
    expect(out.startsWith('pie title 内訳\n')).toBe(true);
  });
});

describe('gantt', () => {
  const SRC = `gantt
    title 開発計画
    dateFormat YYYY-MM-DD
    section 設計
    要件定義 :done, a1, 2026-11-01, 7d
    基本設計 :after a1, 10d
    レビュー :crit, 2d
`;

  it('タスクの書き方を読み分ける', () => {
    expect(parseGanttTask('要件定義 :done, a1, 2026-11-01, 7d')!.values).toEqual({ name: '要件定義', status: 'done', id: 'a1', start: '2026-11-01', end: '7d' });
    expect(parseGanttTask('基本設計 :after a1, 10d')!.values).toMatchObject({ id: '', start: 'after a1', end: '10d' });
    expect(parseGanttTask('dateFormat YYYY-MM-DD')).toBeNull();
    const r = rows(ganttPlugin, SRC);
    expect(r.map((x) => x.schema.kind)).toEqual(['section', 'task', 'task', 'task']);
  });

  it('値を変える（無かった ID を足す・状態を外す）', async () => {
    const r = rows(ganttPlugin, SRC);
    let out = apply(SRC, setCell(r[2], 'end', '5d'));
    expect(out).toContain('基本設計 :after a1, 5d');
    out = apply(SRC, setCell(r[2], 'id', 'b1'));
    expect(out).toContain('    基本設計 :b1, after a1, 10d\n');
    out = apply(SRC, setCell(r[1], 'status', ''));
    expect(out).toContain('    要件定義 :a1, 2026-11-01, 7d\n');
    await valid(out);
    out = apply(SRC, addRow(SRC, r, ganttPlugin.tables![0].schemas[1], null));
    expect(out).toContain('    レビュー :crit, 2d\n    新しいタスク :3d\n');
    await valid(out);
    expect(ganttPlugin.inspect!(SRC, null).find((f) => f.id === 'dateFormat')!.value).toBe('YYYY-MM-DD');
  });
});

describe('gitGraph', () => {
  const SRC = 'gitGraph\n    commit\n    branch dev\n    commit id: "a1" tag: "v1"\n    checkout main\n    merge dev\n';
  it('コマンドを読み、属性を足す・変える', async () => {
    const r = rows(gitGraphPlugin, SRC);
    expect(r.map((x) => x.schema.kind)).toEqual(['commit', 'branch', 'commit', 'checkout', 'merge']);
    expect(r[2].values).toMatchObject({ id: 'a1', tag: 'v1', type: 'NORMAL' });
    let out = apply(SRC, setCell(r[0], 'type', 'HIGHLIGHT'));
    expect(out).toContain('    commit type: HIGHLIGHT\n');
    out = apply(SRC, setCell(r[2], 'tag', 'v2'));
    expect(out).toContain('commit id: "a1" tag: "v2"');
    await valid(out);
  });
});

describe('quadrant / xychart / sankey / C4', () => {
  it('quadrant の点と軸', async () => {
    const src = 'quadrantChart\n    x-axis 低 --> 高\n    A: [0.3, 0.8]\n';
    const r = rows(quadrantPlugin, src);
    const out = apply(src, setCell(r[0], 'x', '0.9'));
    expect(out).toContain('A: [0.9, 0.8]');
    expect(quadrantPlugin.inspect!(src, null).find((f) => f.id === 'x')!.value).toBe('低 --> 高');
    await valid(out);
  });

  it('xychart の系列（名前は引用符つきで足す）', async () => {
    const src = 'xychart\n    title "売上"\n    x-axis [a, b]\n    bar [1, 2]\n';
    const r = rows(xyPlugin, src);
    const out = apply(src, setCell(r[0], 'name', '今年'));
    expect(out).toContain('bar "今年" [1, 2]');
    expect(xyPlugin.inspect!(src, null)[0].value).toBe('売上');
    await valid(out);
  });

  it('sankey の行', async () => {
    const src = 'sankey\nA,B,10\nB,C,5\n';
    const r = rows(sankeyPlugin, src);
    expect(r).toHaveLength(2);
    const out = apply(src, setCell(r[1], 'value', '7'));
    expect(out).toBe('sankey\nA,B,10\nB,C,7\n');
    await valid(out);
  });

  it('C4 の要素と関係', async () => {
    const src = 'C4Context\n    Person(user, "利用者")\n    System(sys, "システム", "説明")\n    Rel(user, sys, "使う")\n';
    const r = rows(c4Plugin, src);
    expect(r.map((x) => x.schema.kind)).toEqual(['element', 'element', 'rel']);
    let out = apply(src, setCell(r[0], 'fn', 'Person_Ext'));
    expect(out).toContain('Person_Ext(user, "利用者")');
    out = apply(src, setCell(r[0], 'descr', '外部の人'));
    expect(out).toContain('Person(user, "利用者", "外部の人")');
    await valid(out);
  });
});
