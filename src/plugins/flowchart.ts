import type { DiagramPlugin, DiagramTarget, SourceRange } from './types';
import { genericTargets, labelText } from './generic';
import { bodyLines, indentOf, insertLineAfter, rangeInInserted, tokenRegex, uniqueId, type SourceLine } from './source';

// flowchart / graph のプラグイン（設計書 §7.3 Phase 1）。
// ノードは SVG の id（…-flowchart-<ノード ID>-<連番>）でソースに対応付ける。

const NEW_LABEL = '新しいノード';
const DEFAULT_INDENT = '    ';

/** 形の開き括弧と閉じ括弧。長いものから順に試す */
const SHAPES: [string, string[]][] = [
  ['(((', [')))']],
  ['([', ['])']],
  ['[[', [']]']],
  ['[(', [')]']],
  ['((', ['))']],
  ['{{', ['}}']],
  ['[/', ['/]', '\\]']],
  ['[\\', ['\\]', '/]']],
  ['[', [']']],
  ['(', [')']],
  ['{', ['}']],
  ['>', [']']],
];

/** ノード定義の行ではない行（スタイル指定など） */
const NON_STATEMENT = /^\s*(classDef|class|style|linkStyle|click|subgraph|direction)\b/;

export function nodeIdFromSvg(el: Element): string | null {
  const m = /-flowchart-(.+)-\d+$/.exec(el.id);
  return m ? m[1] : null;
}

/** ノード id のラベルのソース上の範囲。複数回定義されていれば、mermaid と同じく最後の定義を使う */
export function findNodeLabel(source: string, id: string): SourceRange | null {
  const { body } = bodyLines(source);
  const re = tokenRegex(id, 'gu');
  let found: SourceRange | null = null;
  for (const line of body) {
    re.lastIndex = 0;
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      let i = m.index + id.length;
      while (line.text[i] === ' ') i++;
      const shape = SHAPES.find(([open]) => line.text.startsWith(open, i));
      if (!shape) continue;
      const start = i + shape[0].length;
      if (line.text[start] === '"') {
        const end = line.text.indexOf('"', start + 1);
        if (end > start) found = { from: line.from + start + 1, to: line.from + end };
        continue;
      }
      const ends = shape[1].map((c) => line.text.indexOf(c, start)).filter((x) => x >= start);
      if (ends.length) found = { from: line.from + start, to: line.from + Math.min(...ends) };
    }
  }
  return found;
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
    focus: newId ?? undefined,
  };
}

export const flowchartPlugin: DiagramPlugin = {
  type: 'flowchart-v2',
  capabilities: ['label', 'add-node', 'connect'],

  mapTargets(svg, source) {
    const nodes: DiagramTarget[] = [];
    svg.querySelectorAll('g.node').forEach((g, i) => {
      const elementId = nodeIdFromSvg(g);
      if (!elementId) return;
      const labelEl = g.querySelector('foreignObject, text') ?? g;
      nodes.push({
        id: `node-${i}`,
        el: g,
        labelEl,
        label: labelText(labelEl),
        range: findNodeLabel(source, elementId),
        elementId,
      });
    });
    return [...nodes, ...genericTargets(svg, source, nodes.map((n) => n.el))];
  },

  renameLabel(_source, target, value) {
    if (!target.range) return null;
    return { from: target.range.from, to: target.range.to, insert: value };
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
      run(source, [from]) {
        const id = uniqueId(source, 'N');
        const line = lastLineOf(source, from);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevel(source);
        return {
          ...addLine(source, after, indent, `${from} --> ${id}[${NEW_LABEL}]`, id),
          label: `ノード ${id} を ${from} の次に追加`,
        };
      },
    },
    {
      id: 'connect',
      title: '→ 接続',
      arity: 2,
      prompt: '接続先のノードをクリックしてください（Esc で取り消し）',
      run(source, [from, to]) {
        const line = lastLineOf(source, from);
        const { after, indent } = line ? { after: line, indent: indentOf(line.text) } : topLevel(source);
        return { ...addLine(source, after, indent, `${from} --> ${to}`, null), label: `${from} → ${to} を接続` };
      },
    },
  ],
};
