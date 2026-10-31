import type { ChangeSpec } from '@codemirror/state';
import { linkStructure } from './structure';
import type { DiagramPlugin, DiagramTarget, PropertyField } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { blockFrom, headOf, insertIntoBlock, maskQuotes, removeLine, removeLines, topLevelEnd, VALID_NAME } from './lineOps';
import { addHitArea, edgeLabelFor, idFromSvg, matchInOrder } from './svg';
import { t } from '../i18n';

// erDiagram のプラグイン（設計書 §7.3 Phase 2）。
// エンティティは SVG の id（…-entity-<名前>-<連番>）で、リレーションは SVG 上の順番で対応付ける。

const NEW_ATTR_NAME = t('er.newAttr');
const NEW_ATTR = `string ${NEW_ATTR_NAME}`;

const REL =
  /^(?<indent>\s*)(?<a>[\p{L}\p{N}_-]+|"[^"]+")\s*(?<l>\|o|\|\||\}o|\}\|)(?<mid>--|\.\.)(?<r>o\||\|\||o\{|\|\{)\s*(?<b>[\p{L}\p{N}_-]+|"[^"]+")\s*:\s*(?<label>.*?)\s*$/du;
const BLOCK = /^\s*(?<name>[\p{L}\p{N}_-]+)\s*(?:\[[^\]]*\])?\s*\{/u;

export const LEFT_CARD = [
  { value: '||', label: t('er.card.one', { sym: '||' }) },
  { value: '|o', label: t('er.card.zeroOrOne', { sym: '|o' }) },
  { value: '}|', label: t('er.card.oneOrMore', { sym: '}|' }) },
  { value: '}o', label: t('er.card.zeroOrMore', { sym: '}o' }) },
];
export const RIGHT_CARD = [
  { value: '||', label: t('er.card.one', { sym: '||' }) },
  { value: 'o|', label: t('er.card.zeroOrOne', { sym: 'o|' }) },
  { value: '|{', label: t('er.card.oneOrMore', { sym: '|{' }) },
  { value: 'o{', label: t('er.card.zeroOrMore', { sym: 'o{' }) },
];

interface Rel {
  index: number;
  line: SourceLine;
  a: string;
  b: string;
  g: Record<string, [number, number] | undefined>;
  v: Record<string, string | undefined>;
}

/**
 * 各行の深さ（属性のブロックの中なら 1）。リレーションの多重度（|{ や }o）にも括弧が出てくるので、
 * 「NAME {」の行と「}」だけの行でブロックを数える
 */
function linesWithDepth(source: string) {
  let depth = 0;
  return bodyLines(source).body.map((line) => {
    const d = depth;
    if (BLOCK.test(line.text) && !REL.test(line.text)) depth++;
    else if (line.text.trim() === '}') depth = Math.max(0, depth - 1);
    return { line, depth: d };
  });
}

export function parseRelationships(source: string): Rel[] {
  const out: Rel[] = [];
  for (const { line, depth } of linesWithDepth(source)) {
    if (depth > 0) continue;
    const m = REL.exec(line.text);
    if (!m?.groups || !m.indices?.groups) continue;
    out.push({ index: out.length, line, a: m.groups.a, b: m.groups.b, g: m.indices.groups, v: m.groups });
  }
  return out;
}

function entityBlock(source: string, name: string): SourceLine[] | null {
  const lines = bodyLines(source).body;
  const i = lines.findIndex((l) => BLOCK.exec(l.text)?.groups?.name === name);
  return i < 0 ? null : blockFrom(lines, i);
}

/** エンティティ名に触れるトップレベルの行（リレーションと、ブロックの見出し） */
function topMentions(source: string, name: string) {
  const re = tokenRegex(name);
  return linesWithDepth(source).filter(({ line, depth }) => depth === 0 && re.test(maskQuotes(headOf(line.text))));
}

export function deleteEntity(source: string, name: string): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  const block = entityBlock(source, name);
  const inBlock = new Set(block?.map((l) => l.index));
  if (block) changes.push(removeLines(source, block[0], block.at(-1)!));
  for (const { line } of topMentions(source, name)) if (!inBlock.has(line.index)) changes.push(removeLine(source, line));
  return changes;
}

function renameEntity(source: string, from: string, to: string): ChangeSpec[] | null {
  if (!VALID_NAME.test(to) || entityBlock(source, to) || topMentions(source, to).length) return null;
  const re = tokenRegex(from, 'gu');
  const out: ChangeSpec[] = [];
  for (const { line } of topMentions(source, from)) {
    const head = maskQuotes(headOf(line.text));
    re.lastIndex = 0;
    for (let m = re.exec(head); m; m = re.exec(head)) out.push({ from: line.from + m.index, to: line.from + m.index + from.length, insert: to });
  }
  return out;
}

export const erPlugin: DiagramPlugin = {
  type: 'er',

  mapTargets(svg, source) {
    const entities: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const name = idFromSvg(g, 'entity');
      if (!name) return;
      const labelEl = g.querySelector('.label, foreignObject, text') ?? g;
      entities.push({ id: `entity-${i}`, el: g, labelEl, label: name, range: null, ref: { kind: 'entity', id: name } });
    });
    const rels = parseRelationships(source);
    const paths = [...svg.querySelectorAll('path[data-et="edge"]')];
    const relTargets: DiagramTarget[] = [];
    // リレーション: SVG の data-id に含まれる両端のエンティティで対応付ける
    const matched = matchInOrder(paths, rels, (el, r) => {
      const id = el.getAttribute('data-id') ?? '';
      const ends = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/.exec(id);
      return !!ends && ((ends[1] === r.a && ends[2] === r.b) || (ends[1] === r.b && ends[2] === r.a));
    });
    {
      paths.forEach((path, k) => {
        const i = matched[k];
        if (i < 0) return;
        const r = rels[i];
        const label = edgeLabelFor(svg, path);
        const lg = r.g.label!;
        // ラベルが引用符で囲まれていれば内側を編集する
        const quoted = r.v.label!.startsWith('"') && r.v.label!.endsWith('"');
        relTargets.push({
          id: `relationship-${i}`,
          el: path,
          hits: [addHitArea(path), ...(label ? [label] : [])],
          labelEl: label?.querySelector('foreignObject, text') ?? path,
          label: label ? labelText(label) : '',
          range: { from: r.line.from + lg[0] + (quoted ? 1 : 0), to: r.line.from + lg[1] - (quoted ? 1 : 0) },
          ref: { kind: 'relationship', id: String(i) },
        });
      });
    }
    return withGeneric(svg, source, [...entities, ...relTargets]);
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind === 'entity') {
      return [{ id: 'name', label: t('er.field.name'), type: 'text', value: ref.id, commitOnBlur: true }];
    }
    if (ref?.kind === 'relationship') {
      const r = parseRelationships(source)[Number(ref.id)];
      if (!r) return [];
      return [
        { id: 'ends', label: t('er.field.ends'), type: 'text', value: `${r.a} — ${r.b}`, readonly: true },
        { id: 'l', label: t('er.field.side', { name: r.a }), type: 'select', value: r.v.l!, options: LEFT_CARD },
        { id: 'r', label: t('er.field.side', { name: r.b }), type: 'select', value: r.v.r!, options: RIGHT_CARD },
        {
          id: 'mid',
          label: t('er.field.line'),
          type: 'select',
          value: r.v.mid!,
          options: [
            { value: '--', label: t('er.line.identifying') },
            { value: '..', label: t('er.line.nonIdentifying') },
          ],
        },
        { id: 'label', label: t('plg.label'), type: 'text', value: r.v.label!.replace(/^"(.*)"$/, '$1') },
      ];
    }
    return [];
  },

  setProperty(source, ref, field, value) {
    if (ref?.kind === 'entity' && field === 'name') return renameEntity(source, ref.id, value);
    if (ref?.kind === 'relationship') {
      const r = parseRelationships(source)[Number(ref.id)];
      const g = r?.g[field];
      if (!r || !g) return null;
      let insert = value;
      // ラベルは空にできない。空白を含むなら引用符で囲む
      if (field === 'label') {
        if (value.trim() === '') return null;
        insert = /^[\p{L}\p{N}_-]+$/u.test(value) ? value : `"${value.replace(/"/g, '')}"`;
      }
      return { from: r.line.from + g[0], to: r.line.from + g[1], insert };
    }
    return null;
  },

  actions: [
    {
      id: 'add-entity',
      title: t('er.action.addEntity'),
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'ENTITY');
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${id} {\n${indent}    string id\n${indent}}`);
        return { change, label: t('er.history.addEntity', { id }), selAfter: rangeInInserted(change, id) };
      },
    },
    {
      id: 'add-attribute',
      title: t('er.action.addAttr'),
      arity: 1,
      appliesTo: ['entity'],
      key: 'Tab',
      run(source, [ref]) {
        const block = entityBlock(source, ref.id);
        const { after, indent } = topLevelEnd(source);
        // 属性のブロックが無いエンティティには、ブロックを作って入れる
        const change = block
          ? insertIntoBlock(block, NEW_ATTR)
          : insertLineAfter(source, after, `${indent}${ref.id} {\n${indent}    ${NEW_ATTR}\n${indent}}`);
        return { change, label: t('er.history.addAttr', { id: ref.id }), selAfter: rangeInInserted(change as { from: number; insert: string }, NEW_ATTR_NAME) };
      },
    },
    {
      id: 'connect',
      title: t('er.action.connect'),
      arity: 2,
      appliesTo: ['entity'],
      prompt: t('er.prompt.connect'),
      run(source, [a, b]) {
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${a.id} ||--o{ ${b.id} : has`);
        return { change, label: t('er.history.connect', { a: a.id, b: b.id }), selAfter: rangeInInserted(change, 'has'), focusAt: rangeInInserted(change, 'has').anchor };
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['entity', 'relationship'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'entity') return { change: deleteEntity(source, ref.id), label: t('er.history.deleteEntity', { id: ref.id }) };
        const r = parseRelationships(source)[Number(ref.id)];
        return r && { change: removeLine(source, r.line), label: t('er.history.deleteRel', { a: r.a, b: r.b }) };
      },
    },
  ],

  // 構造（設計書 §17.2）: 線はリレーション
  structure: linkStructure((source) =>
    parseRelationships(source).map((x) => ({ edge: { kind: 'relationship', id: String(x.index) }, from: { kind: 'entity', id: x.a }, to: { kind: 'entity', id: x.b } })),
  ),
};
