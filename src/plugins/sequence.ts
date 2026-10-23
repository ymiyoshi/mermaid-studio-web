import type { DiagramPlugin, DiagramTarget, SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, uniqueId } from './source';

// sequenceDiagram のプラグイン（設計書 §7.3 Phase 2 の先行実装）。
// 参加者は SVG の data-id / name 属性でソースに対応付ける。

const NEW_PARTICIPANT = '新しい参加者';
const NEW_MESSAGE = 'メッセージ';
const DEFAULT_INDENT = '    ';

const DECLARATION = /^(\s*)(participant|actor)\s+([^\s@]+)(?:\s+as\s+(.*?))?\s*$/;

/** 参加者の宣言行 */
function declarations(source: string) {
  return bodyLines(source)
    .body.map((line) => ({ line, m: DECLARATION.exec(line.text) }))
    .filter((x) => x.m !== null);
}

/** 参加者 id の別名（as の後ろ）のソース上の範囲。別名が無ければ null（id を変えるとメッセージが壊れるため） */
export function findParticipantLabel(source: string, id: string): SourceRange | null {
  for (const { line, m } of declarations(source)) {
    if (m![3] !== id || !m![4]) continue;
    const start = line.text.lastIndexOf(m![4]);
    return { from: line.from + start, to: line.from + start + m![4].length };
  }
  return null;
}

function participantElements(svg: SVGSVGElement): { el: Element; id: string }[] {
  const out: { el: Element; id: string }[] = [];
  svg.querySelectorAll('g[data-et="participant"][data-id]').forEach((g) => {
    out.push({ el: g, id: g.getAttribute('data-id')! });
  });
  // 下側の参加者の箱
  svg.querySelectorAll('rect.actor-bottom[name]').forEach((rect) => {
    const parent = rect.parentElement;
    const el = parent && parent.tagName.toLowerCase() === 'g' && parent.querySelectorAll('rect.actor').length === 1 ? parent : rect;
    if (!out.some((x) => x.el === el || x.el.contains(el))) out.push({ el, id: rect.getAttribute('name')! });
  });
  return out;
}

export const sequencePlugin: DiagramPlugin = {
  type: 'sequence',
  capabilities: ['label', 'add-node', 'connect'],

  mapTargets(svg, source) {
    const parts: DiagramTarget[] = participantElements(svg).map(({ el, id }, i) => {
      const labelEl = el.querySelector('text') ?? el.nextElementSibling ?? el;
      return {
        id: `participant-${i}`,
        el,
        labelEl,
        label: labelText(labelEl),
        range: findParticipantLabel(source, id),
        elementId: id,
      };
    });
    return [...parts, ...genericTargets(svg, source, parts.map((p) => p.el))];
  },

  renameLabel(_source, target, value) {
    if (!target.range) return null;
    return { from: target.range.from, to: target.range.to, insert: value };
  },

  actions: [
    {
      id: 'add-participant',
      title: '＋ 参加者',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'P');
        const { header, body } = bodyLines(source);
        const decls = declarations(source);
        const after = decls.at(-1)?.line ?? header;
        const indent = (decls.at(-1) && indentOf(decls.at(-1)!.line.text)) || (body[0] && indentOf(body[0].text)) || DEFAULT_INDENT;
        const change = insertLineAfter(source, after, `${indent}participant ${id} as ${NEW_PARTICIPANT}`);
        return { change, label: `参加者 ${id} を追加`, selAfter: rangeInInserted(change, NEW_PARTICIPANT), focus: id };
      },
    },
    {
      id: 'add-message',
      title: '→ メッセージ',
      arity: 2,
      prompt: '送り先の参加者をクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        const { header, body } = bodyLines(source);
        const indent = (body[0] && indentOf(body[0].text)) || DEFAULT_INDENT;
        const change = insertLineAfter(source, body.at(-1) ?? header, `${indent}${from}->>${to}: ${NEW_MESSAGE}`);
        const selAfter = rangeInInserted(change, NEW_MESSAGE);
        return { change, label: `メッセージ ${from} → ${to} を追加`, selAfter, focusAt: selAfter.anchor };
      },
    },
  ],
};
