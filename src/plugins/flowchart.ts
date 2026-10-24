import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { ARROWS, nodeDefinition, parseFlowchart, SHAPE_CHOICES, shapeName } from './flowchartSyntax';
import { deleteEdge, deleteNode, edgeInfo, getDirection, renameNode, setArrow, setDirection, setEdgeLabel, setShape } from './flowchartOps';
import { addHitArea, matchInOrder } from './svg';

// flowchart / graph のプラグイン（設計書 §7.3 Phase 1）。
// ノードは SVG の id（…-flowchart-<ノード ID>-<連番>）で、エッジは SVG 上の順番（= mermaid が数える順）でソースに対応付ける。

const NEW_LABEL = '新しいノード';
const DEFAULT_INDENT = '    ';

/** ノード定義の行ではない行（スタイル指定など） */
const NON_STATEMENT = /^\s*(classDef|class|style|linkStyle|click|subgraph|direction)\b/;

export function nodeIdFromSvg(el: Element): string | null {
  const m = /-flowchart-(.+)-\d+$/.exec(el.id);
  return m ? m[1] : null;
}

/** ノード id のラベルのソース上の範囲。複数回定義されていれば、mermaid と同じく最後の定義を使う */
export function findNodeLabel(source: string, id: string): SourceRange | null {
  const def = nodeDefinition(parseFlowchart(source), id);
  return def?.shape ? { from: def.shape.labelFrom, to: def.shape.labelTo } : null;
}

/** ノード id が最後に現れる文の行 */
function lastLineOf(source: string, id: string): SourceLine | null {
  const { body } = bodyLines(source);
  const re = tokenRegex(id);
  for (let i = body.length - 1; i >= 0; i--) {
    if (!NON_STATEMENT.test(body[i].text) && re.test(body[i].text)) return body[i];
  }
  return null;
}

function topLevel(source: string) {
  const { header, body } = bodyLines(source);
  return { after: body.at(-1) ?? header, indent: body[0] ? indentOf(body[0].text) || DEFAULT_INDENT : DEFAULT_INDENT };
}

/** 新しいノードを含む 1 行を差し込む */
function addLine(source: string, after: SourceLine | null, indent: string, stmt: string, newId: string | null) {
  const change = insertLineAfter(source, after, indent + stmt);
  return {
    change,
    selAfter: newId ? rangeInInserted(change, NEW_LABEL) : rangeInInserted(change, stmt),
    focus: newId ? { kind: 'node', id: newId } : undefined,
  };
}

export const flowchartPlugin: DiagramPlugin = {
  type: 'flowchart-v2',
  capabilities: ['label', 'add-node', 'connect', 'delete', 'props'],

  mapTargets(svg, source) {
    const doc = parseFlowchart(source);
    const nodes: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const id = nodeIdFromSvg(g);
      if (!id) return;
      const labelEl = g.querySelector('foreignObject, text') ?? g;
      const def = nodeDefinition(doc, id);
      nodes.push({
        id: `node-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: def?.shape ? { from: def.shape.labelFrom, to: def.shape.labelTo } : null,
        ref: { kind: 'node', id },
      });
    });

    // エッジ: SVG の data-id（L_<元>_<先>_<連番>）の端点で、ソースのエッジに対応付ける。
    // 同じ端点のエッジは出てくる順に割り当てる。端点が合わないものは編集の対象にしない
    const edges: DiagramTarget[] = [];
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const matched = matchInOrder(paths, doc.edges, (el, e) => (el.getAttribute('data-id') ?? '').startsWith(`L_${e.from}_${e.to}_`));
    {
      paths.forEach((path, k) => {
        const i = matched[k];
        if (i < 0) return;
        const dataId = path.getAttribute('data-id') ?? '';
        const label = dataId ? svg.querySelector(`g.edgeLabel [data-id="${CSS.escape(dataId)}"]`) : null;
        const labelEl = label?.querySelector('foreignObject, text') ?? label ?? path;
        const info = doc.edges[i];
        const l = info.statement.links[info.link];
        edges.push({
          id: `edge-${i}`,
          el: path,
          hits: [addHitArea(path), ...(label ? [label] : [])],
          labelEl,
          label: label ? labelText(labelEl) : '',
          range: l.label ? { from: l.label.from, to: l.label.to } : null,
          ref: { kind: 'edge', id: String(i) },
        });
      });
    }
    const mapped = [...nodes, ...edges];
    return [...mapped, ...genericTargets(svg, source, mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]))];
  },

  renameLabel(_source, target, value) {
    if (!target.range) return null;
    return { from: target.range.from, to: target.range.to, insert: value };
  },

  inspect(source, ref): PropertyField[] {
    if (!ref) {
      return [
        {
          id: 'direction',
          label: '向き',
          type: 'select',
          value: getDirection(source) === 'TD' ? 'TB' : getDirection(source),
          options: [
            { value: 'TB', label: '上から下 (TB)' },
            { value: 'BT', label: '下から上 (BT)' },
            { value: 'LR', label: '左から右 (LR)' },
            { value: 'RL', label: '右から左 (RL)' },
          ],
        },
      ];
    }
    if (ref.kind === 'node') {
      const def = nodeDefinition(parseFlowchart(source), ref.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'label', label: 'ラベル', type: 'text', value: def?.shape ? source.slice(def.shape.labelFrom, def.shape.labelTo) : ref.id },
        {
          id: 'shape',
          label: '形',
          type: 'select',
          value: def?.shape ? shapeName(def.shape) : 'rect',
          options: SHAPE_CHOICES.map((s) => ({ value: s.name, label: s.label })),
        },
      ];
    }
    if (ref.kind === 'edge') {
      const info = edgeInfo(source, Number(ref.id));
      if (!info) return [];
      const known = ARROWS.some((a) => a.value === info.arrow);
      return [
        { id: 'ends', label: 'つなぐノード', type: 'text', value: `${info.from} → ${info.to}`, readonly: true },
        { id: 'label', label: 'ラベル', type: 'text', value: info.label, placeholder: '（なし）' },
        {
          id: 'arrow',
          label: '線の種類',
          type: 'select',
          value: info.arrow,
          options: known ? ARROWS : [{ value: info.arrow, label: info.arrow }, ...ARROWS],
        },
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    if (!ref) return field === 'direction' ? setDirection(source, value) : null;
    if (ref.kind === 'node') {
      if (field === 'shape') return setShape(source, ref.id, value);
      if (field === 'id') return renameNode(source, ref.id, value);
      if (field === 'label') {
        const r = findNodeLabel(source, ref.id);
        if (r) return { from: r.from, to: r.to, insert: value };
        // ラベルの無いノードには [ラベル] を付ける
        const first = parseFlowchart(source).statements.flatMap((s) => s.groups.flat()).find((n) => n.id === ref.id);
        return first && value !== '' ? { from: first.idTo, insert: `[${value}]` } : null;
      }
      return null;
    }
    if (ref.kind === 'edge') {
      if (field === 'arrow') return setArrow(source, Number(ref.id), value);
      if (field === 'label') return setEdgeLabel(source, Number(ref.id), value);
    }
    return null;
  },

  actions: [
    {
      id: 'add-node',
      title: '＋ ノード',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'N');
        const { after, indent } = topLevel(source);
        return { ...addLine(source, after, indent, `${id}[${NEW_LABEL}]`, id), label: `ノード ${id} を追加` };
      },
    },
    {
      id: 'add-child',
      title: '＋ 次のノード',
      arity: 1,
      key: 'Tab',
      run(source, [from]) {
        const id = uniqueId(source, 'N');
        const line = lastLineOf(source, from.id);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevel(source);
        return {
          ...addLine(source, after, indent, `${from.id} --> ${id}[${NEW_LABEL}]`, id),
          label: `ノード ${id} を ${from.id} の次に追加`,
        };
      },
    },
    {
      id: 'connect',
      title: '→ 接続',
      arity: 2,
      prompt: '接続先のノードをクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        const line = lastLineOf(source, from.id);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevel(source);
        return { ...addLine(source, after, indent, `${from.id} --> ${to.id}`, null), label: `${from.id} → ${to.id} を接続` };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['node', 'edge'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'node') {
          const change = deleteNode(source, ref.id);
          return change && { change, label: `ノード ${ref.id} を削除` };
        }
        const info = edgeInfo(source, Number(ref.id));
        const change = deleteEdge(source, Number(ref.id));
        return change && info && { change, label: `${info.from} → ${info.to} のエッジを削除` };
      },
    },
  ],
};
