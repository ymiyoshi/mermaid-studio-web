import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, uniqueId, type SourceLine } from './source';
import { blockFrom, lastMention, mentions, removeLine, removeLines, renameToken, topLevelEnd, VALID_NAME } from './lineOps';
import { addHitArea, edgeLabelFor, idFromSvg } from './svg';

// stateDiagram-v2 のプラグイン（設計書 §7.3 Phase 2）。
// 状態は SVG の id（…-state-<名前>-<連番>）で、遷移は SVG 上の順番（= ソースの遷移の行の順番）で対応付ける。

const NEW_STATE = '新しい状態';

const TRANSITION = /^(?<indent>\s*)(?<a>\[\*\]|[\p{L}\p{N}_]+)\s*-->\s*(?<b>\[\*\]|[\p{L}\p{N}_]+)\s*(?::\s*(?<label>.*?))?\s*$/du;
const ALIAS = /^(?<indent>\s*)state\s+"(?<label>[^"]*)"\s+as\s+(?<name>[\p{L}\p{N}_]+)/du;
const DESC = /^(?<indent>\s*)(?<name>[\p{L}\p{N}_]+)\s*:\s*(?<label>.*?)\s*$/du;
const COMPOSITE = /^\s*state\s+(?:"[^"]*"\s+as\s+)?(?<name>[\p{L}\p{N}_]+)\s*\{/u;

interface Transition {
  index: number;
  line: SourceLine;
  a: string;
  b: string;
  label: SourceRange | null;
  bEnd: number;
}

export function parseTransitions(source: string): Transition[] {
  const out: Transition[] = [];
  for (const line of bodyLines(source).body) {
    const m = TRANSITION.exec(line.text);
    if (!m?.groups || !m.indices?.groups) continue;
    const l = m.indices.groups.label;
    out.push({
      index: out.length,
      line,
      a: m.groups.a,
      b: m.groups.b,
      label: l ? { from: line.from + l[0], to: line.from + l[1] } : null,
      bEnd: line.from + m.indices.groups.b![1],
    });
  }
  return out;
}

/** 状態の表示名の範囲（state "表示名" as X、または X : 説明） */
export function stateLabel(source: string, name: string): SourceRange | null {
  for (const line of bodyLines(source).body) {
    for (const re of [ALIAS, DESC]) {
      const m = re.exec(line.text);
      if (m?.groups?.name === name && !TRANSITION.test(line.text)) {
        const r = m.indices!.groups!.label!;
        return { from: line.from + r[0], to: line.from + r[1] };
      }
    }
  }
  return null;
}

function compositeBlock(source: string, name: string): SourceLine[] | null {
  const lines = bodyLines(source).body;
  const i = lines.findIndex((l) => COMPOSITE.exec(l.text)?.groups?.name === name);
  return i < 0 ? null : blockFrom(lines, i);
}

export function deleteState(source: string, name: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const block = compositeBlock(source, name);
  const inBlock = new Set(block?.map((l) => l.index));
  if (block) changes.push(removeLines(source, block[0], block.at(-1)!));
  for (const line of bodyLines(source).body) {
    if (inBlock.has(line.index)) continue;
    if (mentions(line, name)) changes.push(removeLine(source, line));
  }
  return changes;
}

/** 状態の宣言を足す行（遷移の後ろ）。ネストの中の状態なら、その状態の行のインデントにそろえる */
function placeAfter(source: string, name: string) {
  const line = lastMention(source, name);
  return line ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source);
}

export const statePlugin: DiagramPlugin = {
  type: 'stateDiagram',

  mapTargets(svg, source) {
    const states: DiagramTarget[] = [];
    svg.querySelectorAll('g.node, g.statediagram-cluster').forEach((g, i) => {
      const name = g.getAttribute('data-id') ?? idFromSvg(g, 'state');
      // 開始・終了の黒丸（root_start など）は対象にしない
      if (!name || /_(start|end)$/.test(name)) return;
      const labelEl = g.querySelector('.cluster-label, foreignObject, text') ?? g;
      states.push({
        id: `state-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: stateLabel(source, name),
        ref: { kind: 'state', id: name },
      });
    });
    const trs = parseTransitions(source);
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const edges: DiagramTarget[] = [];
    if (paths.length === trs.length) {
      paths.forEach((path, i) => {
        const label = edgeLabelFor(svg, path);
        edges.push({
          id: `transition-${i}`,
          el: path,
          hits: [addHitArea(path), ...(label ? [label] : [])],
          labelEl: label?.querySelector('foreignObject, text') ?? path,
          label: label ? labelText(label) : '',
          range: trs[i].label,
          ref: { kind: 'transition', id: String(i) },
        });
      });
    }
    return withGeneric(svg, source, [...states, ...edges]);
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind === 'state') {
      const r = stateLabel(source, ref.id);
      return [
        { id: 'name', label: '状態の名前（ID）', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'label', label: '表示名・説明', type: 'text', value: r ? source.slice(r.from, r.to) : '', placeholder: ref.id },
      ];
    }
    if (ref?.kind === 'transition') {
      const tr = parseTransitions(source)[Number(ref.id)];
      if (!tr) return [];
      return [
        { id: 'ends', label: '遷移', type: 'text', value: `${tr.a} → ${tr.b}`, readonly: true },
        { id: 'label', label: 'ラベル（イベント）', type: 'text', value: tr.label ? source.slice(tr.label.from, tr.label.to) : '', placeholder: '（なし）' },
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    if (ref?.kind === 'state') {
      if (field === 'name') return VALID_NAME.test(value) && !/-/.test(value) ? renameToken(source, ref.id, value) : null;
      if (field === 'label') {
        const r = stateLabel(source, ref.id);
        if (r) return { from: r.from, to: r.to, insert: value };
        if (!value) return null;
        const { after, indent } = placeAfter(source, ref.id);
        return insertLineAfter(source, after, `${indent}${ref.id} : ${value}`);
      }
    }
    if (ref?.kind === 'transition') {
      const tr = parseTransitions(source)[Number(ref.id)];
      if (!tr || field !== 'label') return null;
      if (tr.label) return value ? { from: tr.label.from, to: tr.label.to, insert: value } : { from: tr.bEnd, to: tr.line.to };
      return value ? { from: tr.line.to, insert: ` : ${value}` } : null;
    }
    return null;
  },

  actions: [
    {
      id: 'add-state',
      title: '＋ 状態',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'S');
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}state "${NEW_STATE}" as ${id}`);
        return { change, label: `状態 ${id} を追加`, selAfter: rangeInInserted(change, NEW_STATE), focus: { kind: 'state', id } };
      },
    },
    {
      id: 'add-next',
      title: '＋ 次の状態',
      arity: 1,
      appliesTo: ['state'],
      key: 'Tab',
      run(source, [from]) {
        const id = uniqueId(source, 'S');
        const { after, indent } = placeAfter(source, from.id);
        const change = insertLineAfter(source, after, `${indent}state "${NEW_STATE}" as ${id}\n${indent}${from.id} --> ${id}`);
        return { change, label: `状態 ${id} を ${from.id} の次に追加`, selAfter: rangeInInserted(change, NEW_STATE), focus: { kind: 'state', id } };
      },
    },
    {
      id: 'connect',
      title: '→ 遷移',
      arity: 2,
      appliesTo: ['state'],
      prompt: '遷移先の状態をクリックしてください（Esc で取り消し）',
      run(source, [a, b]) {
        const { after, indent } = placeAfter(source, a.id);
        const change = insertLineAfter(source, after, `${indent}${a.id} --> ${b.id}`);
        return { change, label: `${a.id} → ${b.id} の遷移を追加` };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['state', 'transition'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'state') return { change: deleteState(source, ref.id), label: `状態 ${ref.id} を削除` };
        const tr = parseTransitions(source)[Number(ref.id)];
        return tr && { change: removeLine(source, tr.line), label: `${tr.a} → ${tr.b} の遷移を削除` };
      },
    },
  ],
};
