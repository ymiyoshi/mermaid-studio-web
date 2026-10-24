import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, uniqueId, type SourceLine } from './source';
import { blockFrom, insertIntoBlock, lastMention, mentions, removeLine, removeLines, renameToken, topLevelEnd, VALID_NAME } from './lineOps';
import { addHitArea, idFromSvg, matchInOrder } from './svg';

// classDiagram のプラグイン（設計書 §7.3 Phase 2）。
// クラスは SVG の id（…-classId-<名前>-<連番>）で、関係は SVG 上の順番（= ソースの関係の行の順番）で対応付ける。

const NEW_CLASS = '新しいクラス';
const NEW_MEMBER = '+新しいメンバー';

const DECL = /^(?<indent>\s*)class\s+(?<name>[\p{L}\p{N}_`~]+)(?:\["(?<label>[^"]*)"\])?/du;
const REL =
  /^(?<indent>\s*)(?<a>[\p{L}\p{N}_`~.]+)\s*(?:"(?<ca>[^"]*)"\s*)?(?<rel>(?:<\||\*|o|<|\(\))?(?:--|\.\.)(?:\|>|\*|o|>|\(\))?)\s*(?:"(?<cb>[^"]*)"\s*)?(?<b>[\p{L}\p{N}_`~.]+)\s*(?::\s*(?<label>.*?))?\s*$/du;
const ANNOTATION = /^\s*<<(?<ann>[^>]+)>>\s*(?<name>[\p{L}\p{N}_`~]*)\s*$/du;

export const RELATIONS = [
  { value: '<|--', label: '継承（<|--）' },
  { value: '*--', label: '合成（*--）' },
  { value: 'o--', label: '集約（o--）' },
  { value: '-->', label: '関連（-->）' },
  { value: '--', label: 'リンク（--）' },
  { value: '..>', label: '依存（..>）' },
  { value: '..|>', label: '実現（..|>）' },
  { value: '..', label: '点線のリンク（..）' },
];

const ANNOTATIONS = ['', 'interface', 'abstract', 'service', 'enumeration'];

interface Relation {
  index: number;
  line: SourceLine;
  a: string;
  b: string;
  groups: Record<string, [number, number] | undefined>;
  values: Record<string, string | undefined>;
}

/**
 * 各行のブロック（{ }）の深さ。class 図では { } はクラスの本体にしか出てこないので、文字単位で数える
 * （ER 図は多重度の記号 |{ }o にも括弧が出てくるため、erDiagram.ts では別の数え方をしている）
 */
function topLevelLines(source: string): { line: SourceLine; depth: number }[] {
  let depth = 0;
  return bodyLines(source).body.map((line) => {
    const d = depth;
    for (const c of line.text.replace(/"[^"]*"/g, '')) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    return { line, depth: d };
  });
}

export function parseRelations(source: string): Relation[] {
  const out: Relation[] = [];
  for (const { line, depth } of topLevelLines(source)) {
    if (depth > 0) continue;
    const m = REL.exec(line.text);
    if (!m?.groups || !m.indices?.groups) continue;
    out.push({ index: out.length, line, a: m.groups.a, b: m.groups.b, groups: m.indices.groups, values: m.groups });
  }
  return out;
}

function declaration(source: string, name: string) {
  const lines = bodyLines(source).body;
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i].text);
    if (m?.groups?.name === name) return { index: i, line: lines[i], m, lines };
  }
  return null;
}

function classLabel(source: string, name: string): SourceRange | null {
  const d = declaration(source, name);
  const r = d?.m.indices?.groups?.label;
  return d && r ? { from: d.line.from + r[0], to: d.line.from + r[1] } : null;
}

function ownBlock(source: string, name: string): SourceLine[] | null {
  const d = declaration(source, name);
  if (!d || !d.line.text.includes('{')) return null;
  return blockFrom(d.lines, d.index);
}

export function deleteClass(source: string, name: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const block = ownBlock(source, name);
  const inBlock = new Set(block?.map((l) => l.index));
  if (block) changes.push(removeLines(source, block[0], block.at(-1)!));
  for (const { line, depth } of topLevelLines(source)) {
    if (depth > 0 || inBlock.has(line.index)) continue;
    // 宣言・メンバー・関係・注釈・note for など、このクラスに触れる行
    if (mentions(line, name)) changes.push(removeLine(source, line));
  }
  return changes;
}

function annotationOf(source: string, name: string): { line: SourceLine; value: string } | null {
  const block = ownBlock(source, name);
  for (const line of block?.slice(1) ?? []) {
    const m = ANNOTATION.exec(line.text);
    if (m?.groups && !m.groups.name) return { line, value: m.groups.ann };
  }
  for (const line of bodyLines(source).body) {
    const m = ANNOTATION.exec(line.text);
    if (m?.groups?.name === name) return { line, value: m.groups.ann };
  }
  return null;
}

function setAnnotation(source: string, name: string, value: string): ChangeSpec | null {
  const cur = annotationOf(source, name);
  if (cur) {
    if (!value) return removeLine(source, cur.line);
    const at = cur.line.from + cur.line.text.indexOf('<<') + 2;
    return { from: at, to: at + cur.value.length, insert: value };
  }
  if (!value) return null;
  const { after, indent } = topLevelEnd(source);
  return insertLineAfter(source, after, `${indent}<<${value}>> ${name}`);
}

export const classPlugin: DiagramPlugin = {
  type: 'classDiagram',

  mapTargets(svg, source) {
    const classes: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const name = idFromSvg(g, 'classId');
      if (!name) return;
      const labelEl = g.querySelector('.label-group') ?? g;
      classes.push({
        id: `class-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: classLabel(source, name),
        ref: { kind: 'class', id: name },
      });
    });
    const rels = parseRelations(source);
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const relTargets: DiagramTarget[] = [];
    // 関係: SVG の data-id（id_<A>_<B>_<連番>）の端点で対応付ける
    const matched = matchInOrder(paths, rels, (el, r) => {
      const id = el.getAttribute('data-id') ?? '';
      return id.startsWith(`id_${r.a}_${r.b}_`) || id.startsWith(`id_${r.b}_${r.a}_`);
    });
    {
      paths.forEach((path, k) => {
        const i = matched[k];
        if (i < 0) return;
        const r = rels[i];
        const lr = r.groups.label;
        relTargets.push({
          id: `relation-${i}`,
          el: path,
          hits: [addHitArea(path)],
          labelEl: path,
          label: r.values.label ?? '',
          range: lr ? { from: r.line.from + lr[0], to: r.line.from + lr[1] } : null,
          ref: { kind: 'relation', id: String(i) },
        });
      });
    }
    return withGeneric(svg, source, [...classes, ...relTargets]);
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind === 'class') {
      const label = classLabel(source, ref.id);
      return [
        { id: 'name', label: 'クラス名', type: 'text', value: ref.id, commitOnBlur: true },
        { id: 'label', label: '表示名', type: 'text', value: label ? source.slice(label.from, label.to) : '', placeholder: ref.id },
        {
          id: 'annotation',
          label: '種類',
          type: 'select',
          value: annotationOf(source, ref.id)?.value ?? '',
          options: ANNOTATIONS.map((a) => ({ value: a, label: a ? `<<${a}>>` : '（なし）' })),
        },
      ];
    }
    if (ref?.kind === 'relation') {
      const r = parseRelations(source)[Number(ref.id)];
      if (!r) return [];
      const rel = r.values.rel!;
      return [
        { id: 'ends', label: 'クラス', type: 'text', value: `${r.a} — ${r.b}`, readonly: true },
        {
          id: 'rel',
          label: '関係の種類',
          type: 'select',
          value: rel,
          options: RELATIONS.some((x) => x.value === rel) ? RELATIONS : [{ value: rel, label: rel }, ...RELATIONS],
        },
        { id: 'label', label: 'ラベル', type: 'text', value: r.values.label ?? '', placeholder: '（なし）' },
        { id: 'ca', label: `${r.a} 側の多重度`, type: 'text', value: r.values.ca ?? '', placeholder: '例: 1' },
        { id: 'cb', label: `${r.b} 側の多重度`, type: 'text', value: r.values.cb ?? '', placeholder: '例: 0..*' },
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    if (ref?.kind === 'class') {
      if (field === 'name') return VALID_NAME.test(value) && !declaration(source, value) ? renameToken(source, ref.id, value) : null;
      if (field === 'annotation') return setAnnotation(source, ref.id, value);
      if (field === 'label') {
        const d = declaration(source, ref.id);
        const r = classLabel(source, ref.id);
        if (r) return value ? { from: r.from, to: r.to, insert: value } : { from: r.from - 2, to: r.to + 2 };
        if (!value) return null;
        if (d) {
          const at = d.line.from + d.m.indices!.groups!.name![1];
          return { from: at, insert: `["${value}"]` };
        }
        const { after, indent } = topLevelEnd(source);
        return insertLineAfter(source, after, `${indent}class ${ref.id}["${value}"]`);
      }
      return null;
    }
    if (ref?.kind === 'relation') {
      const r = parseRelations(source)[Number(ref.id)];
      if (!r) return null;
      const at = (g: string) => r.groups[g] && { from: r.line.from + r.groups[g]![0], to: r.line.from + r.groups[g]![1] };
      if (field === 'rel') return { ...at('rel')!, insert: value };
      if (field === 'label') {
        const g = at('label');
        if (g) return value ? { ...g, insert: value } : { from: r.line.from + r.groups.b![1], to: r.line.to };
        return value ? { from: r.line.to, insert: ` : ${value}` } : null;
      }
      if (field === 'ca' || field === 'cb') {
        const g = at(field);
        if (g && value) return { ...g, insert: value };
        // 多重度を消す: クラス名と矢印のあいだを空白 1 つにする
        if (g) {
          const [from, to] = field === 'ca' ? [r.groups.a![1], r.groups.rel![0]] : [r.groups.rel![1], r.groups.b![0]];
          return { from: r.line.from + from, to: r.line.from + to, insert: ' ' };
        }
        if (!value) return null;
        return field === 'ca' ? { from: r.line.from + r.groups.a![1], insert: ` "${value}"` } : { from: r.line.from + r.groups.b![0], insert: `"${value}" ` };
      }
    }
    return null;
  },

  actions: [
    {
      id: 'add-class',
      title: '＋ クラス',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'Class');
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}class ${id}["${NEW_CLASS}"]`);
        return { change, label: `クラス ${id} を追加`, selAfter: rangeInInserted(change, NEW_CLASS), focus: { kind: 'class', id } };
      },
    },
    {
      id: 'add-member',
      title: '＋ メンバー',
      arity: 1,
      appliesTo: ['class'],
      key: 'Tab',
      run(source, [ref]) {
        const block = ownBlock(source, ref.id);
        if (block) {
          const change = insertIntoBlock(block, NEW_MEMBER);
          return { change, label: `${ref.id} にメンバーを追加`, selAfter: rangeInInserted(change as { from: number; insert: string }, NEW_MEMBER) };
        }
        const line = lastMention(source, ref.id);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${ref.id} : ${NEW_MEMBER}`);
        return { change, label: `${ref.id} にメンバーを追加`, selAfter: rangeInInserted(change, NEW_MEMBER) };
      },
    },
    {
      id: 'connect',
      title: '→ 関係',
      arity: 2,
      appliesTo: ['class'],
      prompt: '関係の相手のクラスをクリックしてください（Esc で取り消し）',
      run(source, [a, b]) {
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${a.id} --> ${b.id}`);
        return { change, label: `${a.id} → ${b.id} の関係を追加` };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['class', 'relation'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'class') return { change: deleteClass(source, ref.id), label: `クラス ${ref.id} を削除` };
        const r = parseRelations(source)[Number(ref.id)];
        return r && { change: removeLine(source, r.line), label: `${r.a} — ${r.b} の関係を削除` };
      },
    },
  ],
};
