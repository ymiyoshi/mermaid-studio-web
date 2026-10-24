import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, uniqueId } from './source';
import { addChild, deleteSubtree, moveSibling, parseOutline, type OutlineNode } from './outline';
import { t } from '../i18n';

// kanban のプラグイン（設計書 §7.3 Phase 4）。
// 1 段目が列、2 段目がカード。SVG の g の id（…-<ID>）でソースに対応付ける。

const NEW_COLUMN = t('kb.newColumn');
const NEW_CARD = t('kb.newCard');

const ITEM = /^(?<id>[\p{L}\p{N}_-]+)\[(?<label>[^\]]*)\]/du;

interface Item {
  node: OutlineNode;
  id: string;
  label: SourceRange;
  kind: 'column' | 'card';
}

export function kanbanItems(source: string): Item[] {
  const out: Item[] = [];
  for (const node of parseOutline(source)) {
    const start = indentOf(node.line.text).length;
    const m = ITEM.exec(node.line.text.slice(start));
    if (!m?.groups || !m.indices?.groups) continue;
    const r = m.indices.groups.label!;
    out.push({
      node,
      id: m.groups.id,
      label: { from: node.line.from + start + r[0], to: node.line.from + start + r[1] },
      kind: node.depth === 0 ? 'column' : 'card',
    });
  }
  return out;
}

const svgId = (el: Element) => el.id.replace(/^mmd-render-\d+-/, '');

export const kanbanPlugin: DiagramPlugin = {
  type: 'kanban',

  mapTargets(svg, source) {
    const items = kanbanItems(source);
    const mapped: DiagramTarget[] = [];
    svg.querySelectorAll('g.cluster, g.node').forEach((g, i) => {
      const item = items.find((x) => x.id === svgId(g));
      if (!item) return;
      const labelEl = g.querySelector('.cluster-label, .label, foreignObject, text') ?? g;
      mapped.push({ id: `kanban-${i}`, el: g, labelEl, label: labelText(labelEl), range: item.label, ref: { kind: item.kind, id: item.id } });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    const item = kanbanItems(source).find((x) => x.id === ref?.id);
    if (!item) return [];
    return [
      { id: 'id', label: 'ID', type: 'text', value: item.id, readonly: true },
      { id: 'label', label: item.kind === 'column' ? t('kb.field.columnName') : t('kb.field.cardText'), type: 'text', value: source.slice(item.label.from, item.label.to) },
    ];
  },

  setProperty(source, ref, field, value) {
    const item = kanbanItems(source).find((x) => x.id === ref?.id);
    return item && field === 'label' ? { from: item.label.from, to: item.label.to, insert: value.replace(/[[\]]/g, '') } : null;
  },

  actions: [
    {
      id: 'add-column',
      title: t('kb.action.addColumn'),
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'col');
        const { header, body } = bodyLines(source);
        const columns = kanbanItems(source).filter((x) => x.kind === 'column');
        const indent = columns[0] ? indentOf(columns[0].node.line.text) : '  ';
        const after = body.at(-1) ?? header;
        const change = insertLineAfter(source, after, `${indent}${id}[${NEW_COLUMN}]`);
        return { change, label: t('kb.history.addColumn', { id }), focus: { kind: 'column', id } };
      },
    },
    {
      id: 'add-card',
      title: t('kb.action.addCard'),
      arity: 1,
      appliesTo: ['column', 'card'],
      key: 'Tab',
      run(source, [ref]) {
        const items = kanbanItems(source);
        const item = items.find((x) => x.id === ref.id);
        if (!item) return null;
        const column = item.kind === 'column' ? item.node : item.node.parent!;
        const id = uniqueId(source, 'card');
        return { change: addChild(column, `${id}[${NEW_CARD}]`), label: t('kb.history.addCard', { id }), focus: { kind: 'card', id } };
      },
    },
    {
      id: 'move-up',
      title: t('kb.action.moveBack'),
      arity: 1,
      appliesTo: ['column', 'card'],
      run(source, [ref]) {
        const item = kanbanItems(source).find((x) => x.id === ref.id);
        const change = item && moveSibling(source, item.node, -1);
        return change ? { change, label: t('kb.history.moveBack', { id: ref.id }) } : null;
      },
    },
    {
      id: 'move-down',
      title: t('kb.action.moveForward'),
      arity: 1,
      appliesTo: ['column', 'card'],
      run(source, [ref]) {
        const item = kanbanItems(source).find((x) => x.id === ref.id);
        const change = item && moveSibling(source, item.node, 1);
        return change ? { change, label: t('kb.history.moveForward', { id: ref.id }) } : null;
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['column', 'card'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const item = kanbanItems(source).find((x) => x.id === ref.id);
        return item ? { change: deleteSubtree(source, item.node), label: t('kb.history.delete', { id: ref.id }) } : null;
      },
    },
  ],
};
