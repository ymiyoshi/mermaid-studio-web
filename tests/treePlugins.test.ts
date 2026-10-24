// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { mindNodes, mindmapPlugin } from '../src/plugins/mindmap';
import { kanbanItems, kanbanPlugin } from '../src/plugins/kanban';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

const apply = (source: string, spec: ChangeSpec | null | undefined) => {
  expect(spec).toBeTruthy();
  return ChangeSet.of(spec!, source.length).apply(Text.of(source.split('\n'))).toString();
};
const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
const act = (p: DiagramPlugin, id: string, source: string, refs: ElementRef[] = []) => {
  const res = p.actions!.find((a) => a.id === id)!.run(source, refs);
  expect(res).toBeTruthy();
  return { out: apply(source, res!.change), res: res! };
};

const MM = `mindmap
  root((Studio))
    表示
      ::icon(fa fa-eye)
      全図種
    編集
      テキスト
      図
`;

describe('mindmap', () => {
  it('ノードとラベルを読む（アイコンの行はノードに数えない）', () => {
    const nodes = mindNodes(MM);
    expect(nodes.map((n) => MM.slice(n.label.from, n.label.to))).toEqual(['Studio', '表示', '全図種', '編集', 'テキスト', '図']);
    expect(nodes[0].shape?.name).toBe('circle');
    expect(nodes[2].node.parent?.index).toBe(1);
  });

  it('子・兄弟を追加すると、部分木の後ろに正しいインデントで入る', async () => {
    let { out, res } = act(mindmapPlugin, 'add-child', MM, [{ kind: 'topic', id: '1' }]);
    expect(out).toContain('      全図種\n      新しいトピック\n    編集');
    expect(res.focus).toEqual({ kind: 'topic', id: '3' });
    await valid(out);
    ({ out } = act(mindmapPlugin, 'add-sibling', MM, [{ kind: 'topic', id: '1' }]));
    expect(out).toContain('      全図種\n    新しいトピック\n    編集');
    await valid(out);
    ({ out } = act(mindmapPlugin, 'add-child', MM, [{ kind: 'topic', id: '5' }]));
    expect(out).toBe(MM.replace('      図\n', '      図\n        新しいトピック\n'));
    await valid(out);
  });

  it('部分木ごと削除・移動する', async () => {
    let { out } = act(mindmapPlugin, 'delete', MM, [{ kind: 'topic', id: '1' }]);
    expect(out).toBe('mindmap\n  root((Studio))\n    編集\n      テキスト\n      図\n');
    await valid(out);
    ({ out } = act(mindmapPlugin, 'move-up', MM, [{ kind: 'topic', id: '3' }]));
    expect(out).toBe('mindmap\n  root((Studio))\n    編集\n      テキスト\n      図\n    表示\n      ::icon(fa fa-eye)\n      全図種\n');
    await valid(out);
    expect(mindmapPlugin.actions!.find((a) => a.id === 'delete')!.run(MM, [{ kind: 'topic', id: '0' }])).toBeNull();
  });

  it('形を変える（形の無いノードには ID を付ける）', async () => {
    let out = apply(MM, mindmapPlugin.setProperty!(MM, { kind: 'topic', id: '1' }, 'shape', 'square'));
    expect(out).toContain('    n1[表示]\n');
    await valid(out);
    out = apply(MM, mindmapPlugin.setProperty!(MM, { kind: 'topic', id: '0' }, 'shape', 'hexagon'));
    expect(out).toContain('  root{{Studio}}\n');
    await valid(out);
  });
});

const KB = `kanban
  todo[やること]
    t1[設計]
    t2[実装]
  done[完了]
    t3[調査]
`;

describe('kanban', () => {
  it('列とカードを読む', () => {
    expect(kanbanItems(KB).map((i) => `${i.kind}:${i.id}`)).toEqual(['column:todo', 'card:t1', 'card:t2', 'column:done', 'card:t3']);
  });

  it('列・カードを追加し、列ごと移動・削除する', async () => {
    let { out } = act(kanbanPlugin, 'add-column', KB);
    expect(out).toContain('    t3[調査]\n  col1[新しい列]');
    await valid(out);
    ({ out } = act(kanbanPlugin, 'add-card', KB, [{ kind: 'card', id: 't1' }]));
    expect(out).toContain('    t2[実装]\n    card1[新しいカード]\n  done');
    await valid(out);
    ({ out } = act(kanbanPlugin, 'move-down', KB, [{ kind: 'column', id: 'todo' }]));
    expect(out).toBe('kanban\n  done[完了]\n    t3[調査]\n  todo[やること]\n    t1[設計]\n    t2[実装]\n');
    await valid(out);
    ({ out } = act(kanbanPlugin, 'delete', KB, [{ kind: 'column', id: 'todo' }]));
    expect(out).toBe('kanban\n  done[完了]\n    t3[調査]\n');
    await valid(out);
  });
});
