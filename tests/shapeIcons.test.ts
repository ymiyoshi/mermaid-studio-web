// 形の欄は選択肢を図形で並べる。どの図種の形の選択肢にも図形があること（文字だけで出るものが無いこと）を確かめる
import { describe, expect, it } from 'vitest';
import { shapeIcon } from '../src/ui/shapeIcons';
import { flowchartPlugin } from '../src/plugins/flowchart';
import { mindmapPlugin } from '../src/plugins/mindmap';
import { blockPlugin } from '../src/plugins/block';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

function shapeField(plugin: DiagramPlugin, source: string, ref: ElementRef) {
  return plugin.inspect!(source, ref).find((f) => f.id === 'shape')!;
}

describe('形の図形', () => {
  it.each([
    ['flowchart', flowchartPlugin, 'flowchart TD\n  A[開始] --> B', { kind: 'node', id: 'A' }],
    ['mindmap', mindmapPlugin, 'mindmap\n  root((中心))\n    子', { kind: 'topic', id: '1' }],
    ['block', blockPlugin, 'block-beta\n  columns 2\n  a["A"] b', { kind: 'block-item', id: 'a' }],
  ] as const)('%s: 形の欄は図形の一覧で、すべての選択肢に図形がある', (_, plugin, source, ref) => {
    const f = shapeField(plugin, source, ref);
    expect(f.type).toBe('shape');
    expect(f.options!.length).toBeGreaterThan(5);
    const missing = f.options!.filter((o) => shapeIcon(o.value) === null).map((o) => o.value);
    expect(missing).toEqual([]);
  });

  it('知らない形は null（文字で出す）', () => {
    expect(shapeIcon('no-such-shape')).toBeNull();
  });
});
