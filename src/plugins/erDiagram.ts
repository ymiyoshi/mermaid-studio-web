import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';
import { blockFrom, headOf, insertIntoBlock, maskQuotes, removeLine, removeLines, topLevelEnd, VALID_NAME } from './lineOps';
import { addHitArea, idFromSvg, matchInOrder } from './svg';

// erDiagram のプラグイン（設計書 §7.3 Phase 2）。
// エンティティは SVG の id（…-entity-<名前>-<連番>）で、リレーションは SVG 上の順番で対応付ける。

const NEW_ATTR = 'string 新しい属性';

const REL =
  /^(?<indent>\s*)(?<a>[\p{L}\p{N}_-]+|"[^"]+")\s*(?<l>\|o|\|\||\}o|\}\|)(?<mid>--|\.\.)(?<r>o\||\|\||o\{|\|\{)\s*(?<b>[\p{L}\p{N}_-]+|"[^"]+")\s*:\s*(?<label>.*?)\s*$/du;
const BLOCK = /^\s*(?<name>[\p{L}\p{N}_-]+)\s*(?:\[[^\]]*\])?\s*\{/u;

export const LEFT_CARD = [
  { value: '||', label: 'ちょうど 1（||）' },
  { value: '|o', label: '0 か 1（|o）' },
  { value: '}|', label: '1 以上（}|）' },
  { value: '}o', label: '0 以上（}o）' },
];
export const RIGHT_CARD = [
  { value: '||', label: 'ちょうど 1（||）' },
  { value: 'o|', label: '0 か 1（o|）' },
  { value: '|{', label: '1 以上（|{）' },
  { value: 'o{', label: '0 以上（o{）' },
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
  capabilities: ['label', 'add-node', 'connect', 'delete', 'props'],

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
        const dataId = path.getAttribute('data-id') ?? '';
        const label = dataId ? svg.querySelector(`g.edgeLabel [data-id="${CSS.escape(dataId)}"]`) : null;
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
    const mapped = [...entities, ...relTargets];
    return [...mapped, ...genericTargets(svg, source, mapped.flatMap((x) => [x.el, ...(x.hits ?? [])]))];
  },

  renameLabel(_source, target, value) {
    return target.range ? { from: target.range.from, to: target.range.to, insert: value } : null;
  },

  inspect(source, ref): PropertyField[] {
    if (ref?.kind === 'entity') {
      return [{ id: 'name', label: 'エンティティ名', type: 'text', value: ref.id, commitOnBlur: true }];
    }
    if (ref?.kind === 'relationship') {
      const r = parseRelationships(source)[Number(ref.id)];
      if (!r) return [];
      return [
        { id: 'ends', label: 'エンティティ', type: 'text', value: `${r.a} — ${r.b}`, readonly: true },
        { id: 'l', label: `${r.a} 側`, type: 'select', value: r.v.l!, options: LEFT_CARD },
        { id: 'r', label: `${r.b} 側`, type: 'select', value: r.v.r!, options: RIGHT_CARD },
        {
          id: 'mid',
          label: '線',
          type: 'select',
          value: r.v.mid!,
          options: [
            { value: '--', label: '実線（識別）' },
            { value: '..', label: '点線（非識別）' },
          ],
        },
        { id: 'label', label: 'ラベル', type: 'text', value: r.v.label!.replace(/^"(.*)"$/, '$1') },
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
      title: '＋ エンティティ',
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'ENTITY');
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${id} {\n${indent}    string id\n${indent}}`);
        return { change, label: `エンティティ ${id} を追加`, selAfter: rangeInInserted(change, id) };
      },
    },
    {
      id: 'add-attribute',
      title: '＋ 属性',
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
        return { change, label: `${ref.id} に属性を追加`, selAfter: rangeInInserted(change as { from: number; insert: string }, '新しい属性') };
      },
    },
    {
      id: 'connect',
      title: '→ リレーション',
      arity: 2,
      appliesTo: ['entity'],
      prompt: '相手のエンティティをクリックしてください（Esc で取り消し）',
      run(source, [a, b]) {
        const { after, indent } = topLevelEnd(source);
        const change = insertLineAfter(source, after, `${indent}${a.id} ||--o{ ${b.id} : has`);
        return { change, label: `${a.id} — ${b.id} のリレーションを追加`, selAfter: rangeInInserted(change, 'has'), focusAt: rangeInInserted(change, 'has').anchor };
      },
    },
    {
      id: 'delete',
      title: '削除',
      arity: 1,
      appliesTo: ['entity', 'relationship'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'entity') return { change: deleteEntity(source, ref.id), label: `エンティティ ${ref.id} を削除` };
        const r = parseRelationships(source)[Number(ref.id)];
        return r && { change: removeLine(source, r.line), label: `${r.a} — ${r.b} のリレーションを削除` };
      },
    },
  ],
};
