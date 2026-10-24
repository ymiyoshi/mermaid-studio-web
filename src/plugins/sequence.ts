import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { addHitArea, matchInOrder } from './svg';

// sequenceDiagram のプラグイン。
// 参加者は SVG の data-id / name 属性で、メッセージは SVG 上の順番（= ソースのメッセージ行の順番）で対応付ける。

const NEW_PARTICIPANT = '新しい参加者';
const NEW_MESSAGE = 'メッセージ';
const DEFAULT_INDENT = '    ';

const DECLARATION = /^(\s*)(participant|actor)\s+([^\s@]+)(?:\s+as\s+(.*?))?\s*$/;
const MESSAGE =
  /^(?<indent>\s*)(?<from>[^\s:<>+-]+?)\s*(?<arrow><<-->>|<<->>|-->>|->>|-->|->|--x|-x|--\)|-\))(?<act>[+-]?)\s*(?<to>[^\s:+-]+?)\s*:(?<sp>\s?)(?<text>.*)$/d;

export const MESSAGE_ARROWS = [
  { value: '->>', label: '→ 実線の矢印' },
  { value: '-->>', label: '⇢ 点線の矢印' },
  { value: '->', label: '― 実線' },
  { value: '-->', label: '┄ 点線' },
  { value: '-x', label: '→× 実線・バツ' },
  { value: '--x', label: '⇢× 点線・バツ' },
  { value: '-)', label: '→) 非同期' },
  { value: '--)', label: '⇢) 点線・非同期' },
  { value: '<<->>', label: '↔ 双方向' },
  { value: '<<-->>', label: '⇠⇢ 点線・双方向' },
];

interface Message {
  index: number;
  line: SourceLine;
  from: string;
  to: string;
  arrow: SourceRange & { value: string };
  text: SourceRange;
}

/** 参加者の宣言行 */
function declarations(source: string) {
  return bodyLines(source)
    .body.map((line) => ({ line, m: DECLARATION.exec(line.text) }))
    .filter((x): x is { line: SourceLine; m: RegExpExecArray } => x.m !== null);
}

export function parseMessages(source: string): Message[] {
  const out: Message[] = [];
  for (const line of bodyLines(source).body) {
    const m = MESSAGE.exec(line.text);
    if (!m?.groups || !m.indices?.groups) continue;
    const a = m.indices.groups.arrow!;
    const tx = m.indices.groups.text!;
    out.push({
      index: out.length,
      line,
      from: m.groups.from,
      to: m.groups.to,
      arrow: { from: line.from + a[0], to: line.from + a[1], value: m.groups.arrow },
      text: { from: line.from + tx[0], to: line.from + tx[1] },
    });
  }
  return out;
}

/** 参加者 id の別名（as の後ろ）のソース上の範囲。別名が無ければ null（id を変えるとメッセージが壊れるため） */
export function findParticipantLabel(source: string, id: string): SourceRange | null {
  for (const { line, m } of declarations(source)) {
    if (m[3] !== id || !m[4]) continue;
    const start = line.text.lastIndexOf(m[4]);
    return { from: line.from + start, to: line.from + start + m[4].length };
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

const removeLine = (source: string, line: SourceLine): ChangeSpec =>
  line.to < source.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to };

/** 参加者を宣言する行。宣言が無ければ（暗黙の参加者なら）宣言を足す変更も返す */
function declare(source: string, id: string): { line: SourceLine; m: RegExpExecArray } | null {
  return declarations(source).find((d) => d.m[3] === id) ?? null;
}

function newDeclaration(source: string, text: string) {
  const { header, body } = bodyLines(source);
  const decls = declarations(source);
  const after = decls.at(-1)?.line ?? header;
  const indent = (decls.at(-1) && indentOf(decls.at(-1)!.line.text)) || (body[0] && indentOf(body[0].text)) || DEFAULT_INDENT;
  return insertLineAfter(source, after, indent + text);
}

/** 参加者の並び順を 1 つ動かす（宣言の行を入れ替える） */
function moveParticipant(source: string, id: string, dir: -1 | 1): ChangeSpec[] | null {
  const decls = declarations(source);
  const i = decls.findIndex((d) => d.m[3] === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= decls.length) return null;
  const a = decls[Math.min(i, j)].line;
  const b = decls[Math.max(i, j)].line;
  return [
    { from: a.from, to: a.to, insert: b.text },
    { from: b.from, to: b.to, insert: a.text },
  ];
}

export function deleteParticipant(source: string, id: string): ChangeSpec[] {
  const token = tokenRegex(id);
  const changes: ChangeSpec[] = [];
  for (const line of bodyLines(source).body) {
    const d = DECLARATION.exec(line.text);
    if (d) {
      if (d[3] === id) changes.push(removeLine(source, line));
      continue;
    }
    const m = MESSAGE.exec(line.text);
    if (m?.groups && (m.groups.from === id || m.groups.to === id)) {
      changes.push(removeLine(source, line));
      continue;
    }
    // Note over A,B / activate A / deactivate A / create participant A
    if (/^\s*(note\s+(over|left of|right of)|activate|deactivate|destroy|create)\b/i.test(line.text)) {
      const head = line.text.split(':')[0];
      if (token.test(head)) changes.push(removeLine(source, line));
    }
  }
  return changes;
}

export const sequencePlugin: DiagramPlugin = {
  type: 'sequence',
  capabilities: ['label', 'add-node', 'connect', 'delete', 'reorder', 'props'],

  mapTargets(svg, source) {
    const parts: DiagramTarget[] = participantElements(svg).map(({ el, id }, i) => {
      const labelEl = el.querySelector('text') ?? el.nextElementSibling ?? el;
      return {
        id: `participant-${i}`,
        el,
        labelEl,
        label: labelText(labelEl),
        range: findParticipantLabel(source, id),
        ref: { kind: 'participant', id },
      };
    });
    // メッセージ: 線の data-from / data-to でソースのメッセージに対応付ける。文字は線と同じ順に並ぶ
    const messages = parseMessages(source);
    const lines = [...svg.querySelectorAll('[data-et="message"]')];
    const texts = [...svg.querySelectorAll('text.messageText')];
    const msgTargets: DiagramTarget[] = [];
    const matched = matchInOrder(lines, messages, (el, m) => el.getAttribute('data-from') === m.from && el.getAttribute('data-to') === m.to);
    if (texts.length === lines.length) {
      lines.forEach((_, i) => {
        const j = matched[i];
        if (j < 0) return;
        const m = messages[j];
        msgTargets.push({
          id: `message-${i}`,
          el: lines[i],
          hits: [addHitArea(lines[i]), texts[i]],
          labelEl: texts[i],
          label: labelText(texts[i]),
          range: m.text,
          ref: { kind: 'message', id: String(j) },
        });
      });
    }
    const mapped = [...parts, ...msgTargets];
    return [...mapped, ...genericTargets(svg, source, mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]))];
  },

  renameLabel(_source, target, value) {
    if (!target.range) return null;
    return { from: target.range.from, to: target.range.to, insert: value };
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind === 'participant') {
      const d = declare(source, ref.id);
      return [
        { id: 'id', label: 'ID', type: 'text', value: ref.id, readonly: true },
        { id: 'alias', label: '表示名', type: 'text', value: d?.m[4] ?? '', placeholder: ref.id },
        {
          id: 'type',
          label: '種類',
          type: 'select',
          value: d?.m[2] ?? 'participant',
          options: [
            { value: 'participant', label: '箱（participant）' },
            { value: 'actor', label: '人（actor）' },
          ],
        },
      ];
    }
    if (ref?.kind === 'message') {
      const m = parseMessages(source)[Number(ref.id)];
      if (!m) return [];
      return [
        { id: 'ends', label: '送り手 → 受け手', type: 'text', value: `${m.from} → ${m.to}`, readonly: true },
        { id: 'text', label: '本文', type: 'text', value: source.slice(m.text.from, m.text.to) },
        { id: 'arrow', label: '矢印', type: 'select', value: m.arrow.value, options: MESSAGE_ARROWS },
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    if (ref?.kind === 'participant') {
      const d = declare(source, ref.id);
      if (field === 'type') {
        if (d) {
          const at = d.line.from + d.m[1].length;
          return { from: at, to: at + d.m[2].length, insert: value };
        }
        return newDeclaration(source, `${value} ${ref.id}`);
      }
      if (field === 'alias') {
        if (!d) return value ? newDeclaration(source, `participant ${ref.id} as ${value}`) : null;
        const head = `${d.m[1]}${d.m[2]} ${d.m[3]}`;
        return { from: d.line.from, to: d.line.to, insert: value ? `${head} as ${value}` : head };
      }
      return null;
    }
    if (ref?.kind === 'message') {
      const m = parseMessages(source)[Number(ref.id)];
      if (!m) return null;
      if (field === 'text') return { from: m.text.from, to: m.text.to, insert: value };
      if (field === 'arrow') return { from: m.arrow.from, to: m.arrow.to, insert: value };
    }
    return null;
  },

  actions: [
    {
      id: 'add-participant',
      title: '＋ 参加者',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'P');
        const change = newDeclaration(source, `participant ${id} as ${NEW_PARTICIPANT}`);
        return {
          change,
          label: `参加者 ${id} を追加`,
          selAfter: rangeInInserted(change, NEW_PARTICIPANT),
          focus: { kind: 'participant', id },
        };
      },
    },
    {
      id: 'add-message',
      title: '→ メッセージ',
      arity: 2,
      appliesTo: ['participant'],
      prompt: '送り先の参加者をクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        const { header, body } = bodyLines(source);
        const indent = (body[0] && indentOf(body[0].text)) || DEFAULT_INDENT;
        const change = insertLineAfter(source, body.at(-1) ?? header, `${indent}${from.id}->>${to.id}: ${NEW_MESSAGE}`);
        const selAfter = rangeInInserted(change, NEW_MESSAGE);
        return { change, label: `メッセージ ${from.id} → ${to.id} を追加`, selAfter, focusAt: selAfter.anchor };
      },
    },
    {
      id: 'move-left',
      title: '← 左へ',
      arity: 1,
      appliesTo: ['participant'],
      run(source, [ref]) {
        const change = moveParticipant(source, ref.id, -1);
        return change && { change, label: `参加者 ${ref.id} を左へ移動` };
      },
    },
    {
      id: 'move-right',
      title: '右へ →',
      arity: 1,
      appliesTo: ['participant'],
      run(source, [ref]) {
        const change = moveParticipant(source, ref.id, 1);
        return change && { change, label: `参加者 ${ref.id} を右へ移動` };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['participant', 'message'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'participant') {
          return { change: deleteParticipant(source, ref.id), label: `参加者 ${ref.id} を削除` };
        }
        const m = parseMessages(source)[Number(ref.id)];
        return m && { change: removeLine(source, m.line), label: `メッセージ ${m.from} → ${m.to} を削除` };
      },
    },
  ],
};
