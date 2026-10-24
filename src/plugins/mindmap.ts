import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { indentOf, uniqueId } from './source';
import { addChild, addSibling, deleteSubtree, moveSibling, parseOutline, type OutlineNode } from './outline';
import { t } from '../i18n';

// mindmap のプラグイン（設計書 §7.3 Phase 3）。
// ノードはインデントで親子を表す。SVG のノード（node_<番号>）は、ソースのノードの行と同じ順番に並ぶ。

const NEW_TOPIC = t('mm.newTopic');

/** 形の括弧。長いものから順に試す */
export const MINDMAP_SHAPES = [
  { name: 'circle', label: t('mm.shape.circle'), open: '((', close: '))' },
  { name: 'bang', label: t('mm.shape.bang'), open: '))', close: '((' },
  { name: 'hexagon', label: t('mm.shape.hexagon'), open: '{{', close: '}}' },
  { name: 'cloud', label: t('mm.shape.cloud'), open: ')', close: '(' },
  { name: 'rounded', label: t('mm.shape.rounded'), open: '(', close: ')' },
  { name: 'square', label: t('mm.shape.square'), open: '[', close: ']' },
];

/** ノードに付く行（アイコンとクラス） */
const isAttached = (text: string) => text.startsWith('::icon(') || text.startsWith(':::');

interface MindNode {
  node: OutlineNode;
  id: string | null;
  shape: (typeof MINDMAP_SHAPES)[number] | null;
  label: SourceRange;
  /** 形の括弧を含む範囲（形が無ければラベルと同じ） */
  body: SourceRange;
}

export function parseMindNode(node: OutlineNode): MindNode {
  const line = node.line;
  const start = indentOf(line.text).length;
  const text = line.text.slice(start).trimEnd();
  for (const s of MINDMAP_SHAPES) {
    const at = text.indexOf(s.open);
    if (at < 0 || !text.endsWith(s.close) || text.length < at + s.open.length + s.close.length) continue;
    const id = text.slice(0, at);
    if (/\s/.test(id) || /[()[\]{}]/.test(id)) continue;
    let lf = at + s.open.length;
    let lt = text.length - s.close.length;
    if (text[lf] === '"' && text[lt - 1] === '"' && lt - lf >= 2) {
      lf++;
      lt--;
    }
    return {
      node,
      id: id || null,
      shape: s,
      label: { from: line.from + start + lf, to: line.from + start + lt },
      body: { from: line.from + start + at, to: line.from + start + text.length },
    };
  }
  const r = { from: line.from + start, to: line.from + start + text.length };
  return { node, id: null, shape: null, label: r, body: r };
}

export function mindNodes(source: string): MindNode[] {
  return parseOutline(source, isAttached).map(parseMindNode);
}

function setShape(source: string, m: MindNode, shape: string): ChangeSpec | null {
  const label = source.slice(m.label.from, m.label.to);
  if (shape === 'default') {
    // 形を外す: ID は残せないので、ラベルだけにする
    return m.shape ? { from: m.body.from - (m.id?.length ?? 0), to: m.body.to, insert: label } : null;
  }
  const s = MINDMAP_SHAPES.find((x) => x.name === shape);
  if (!s) return null;
  const quoted = /[()[\]{}]/.test(label) ? `"${label}"` : label;
  const id = m.id ?? uniqueId(source, 'n');
  return { from: m.body.from - (m.id?.length ?? 0), to: m.body.to, insert: `${id}${s.open}${quoted}${s.close}` };
}

export const mindmapPlugin: DiagramPlugin = {
  type: 'mindmap',

  mapTargets(svg, source) {
    const nodes = mindNodes(source);
    const els = [...svg.querySelectorAll('g.mindmap-node')];
    const mapped: DiagramTarget[] = [];
    if (els.length === nodes.length) {
      els.forEach((g, i) => {
        const labelEl = g.querySelector('foreignObject, text') ?? g;
        mapped.push({ id: `topic-${i}`, el: g, labelEl, label: labelText(labelEl), range: nodes[i].label, ref: { kind: 'topic', id: String(i) } });
      });
    }
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind !== 'topic') return [];
    const m = mindNodes(source)[Number(ref.id)];
    if (!m) return [];
    return [
      { id: 'label', label: t('mm.field.text'), type: 'text', value: source.slice(m.label.from, m.label.to) },
      {
        id: 'shape',
        label: t('mm.field.shape'),
        type: 'select',
        value: m.shape?.name ?? 'default',
        options: [{ value: 'default', label: t('mm.shape.default') }, ...MINDMAP_SHAPES.map((s) => ({ value: s.name, label: s.label }))],
      },
      { id: 'depth', label: t('mm.field.depth'), type: 'text', value: String(m.node.depth), readonly: true },
    ];
  },

  setProperty(source, ref, field, value) {
    const m = ref?.kind === 'topic' ? mindNodes(source)[Number(ref.id)] : undefined;
    if (!m) return null;
    if (field === 'label') return value ? { from: m.label.from, to: m.label.to, insert: value } : null;
    if (field === 'shape') return setShape(source, m, value);
    return null;
  },

  actions: [
    {
      id: 'add-child',
      title: t('mm.action.addChild'),
      arity: 1,
      appliesTo: ['topic'],
      key: 'Tab',
      run(source, [ref]) {
        const nodes = mindNodes(source);
        const m = nodes[Number(ref.id)];
        if (!m) return null;
        const change = addChild(m.node, NEW_TOPIC);
        // 新しいノードは、親の部分木の最後の次の番号になる
        const newIndex = lastIndexIn(m.node) + 1;
        return { change, label: t('mm.history.add'), focus: { kind: 'topic', id: String(newIndex) } };
      },
    },
    {
      id: 'add-sibling',
      title: t('mm.action.addSibling'),
      arity: 1,
      appliesTo: ['topic'],
      run(source, [ref]) {
        const m = mindNodes(source)[Number(ref.id)];
        if (!m || !m.node.parent) return null;
        const change = addSibling(m.node, NEW_TOPIC);
        return { change, label: t('mm.history.add'), focus: { kind: 'topic', id: String(lastIndexIn(m.node) + 1) } };
      },
    },
    {
      id: 'move-up',
      title: '↑',
      arity: 1,
      appliesTo: ['topic'],
      run(source, [ref]) {
        const m = mindNodes(source)[Number(ref.id)];
        const change = m && moveSibling(source, m.node, -1);
        return change ? { change, label: t('mm.history.moveUp') } : null;
      },
    },
    {
      id: 'move-down',
      title: '↓',
      arity: 1,
      appliesTo: ['topic'],
      run(source, [ref]) {
        const m = mindNodes(source)[Number(ref.id)];
        const change = m && moveSibling(source, m.node, 1);
        return change ? { change, label: t('mm.history.moveDown') } : null;
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['topic'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const m = mindNodes(source)[Number(ref.id)];
        // 根は消さない（mindmap には根が 1 つ必要）
        if (!m || !m.node.parent) return null;
        return { change: deleteSubtree(source, m.node), label: t('mm.history.delete') };
      },
    },
  ],
};

/** 部分木の中で最後のノードの番号 */
function lastIndexIn(node: OutlineNode): number {
  let n = node;
  while (n.children.length) n = n.children[n.children.length - 1];
  return n.index;
}
