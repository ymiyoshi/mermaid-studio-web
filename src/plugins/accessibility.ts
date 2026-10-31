import type { ChangeSpec } from '@codemirror/state';
import { bodyLines, indentOf, type SourceLine } from './source';
import { removeLine, removeLines } from './lineOps';

// 読み上げ用の題名と説明（accTitle / accDescr。設計書 §17.6）。mermaid はこれを SVG の <title> と <desc> にする。
// 図種によらず同じ書き方なので、プロパティパネルの「図」の欄として共通に扱う。
// 書き換えるのはその行だけ。無ければ図種の宣言行のすぐ後ろに足す。

export type AccKey = 'accTitle' | 'accDescr';

/**
 * accTitle / accDescr が書けない図種。mermaid.parse が通らない（mindmap・sankey・block・venn・eventmodeling）か、
 * 通っても字下げの木の項目として読まれるおそれがある（kanban・ishikawa）。mermaid 12.2 のテンプレートに足して確かめた
 */
export const NO_ACC_TYPES = new Set(['mindmap', 'sankey', 'block', 'venn', 'eventmodeling', 'kanban', 'ishikawa', 'zenuml', 'info']);

interface AccLine {
  first: SourceLine;
  last: SourceLine;
  /** 値の範囲（1 行の書き方のとき） */
  value: { from: number; to: number } | null;
  text: string;
}

const LINE = (key: AccKey) => new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'd');
const BLOCK = /^\s*accDescr\s*\{/;

export function readAcc(source: string, key: AccKey): AccLine | null {
  const { body } = bodyLines(source);
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const m = LINE(key).exec(line.text);
    if (m) {
      const [a, b] = m.indices![1]!;
      return { first: line, last: line, value: { from: line.from + a, to: line.from + b }, text: m[1] };
    }
    // accDescr { … }（複数行）
    if (key === 'accDescr' && BLOCK.test(line.text)) {
      const inline = /\{([^}]*)\}/.exec(line.text);
      if (inline) return { first: line, last: line, value: null, text: inline[1].trim() };
      const end = body.findIndex((l, j) => j > i && l.text.includes('}'));
      const last = end < 0 ? line : body[end];
      const all = source.slice(line.from, last.to);
      const text = all.slice(all.indexOf('{') + 1, all.lastIndexOf('}') < 0 ? undefined : all.lastIndexOf('}'));
      return { first: line, last, value: null, text: text.split('\n').map((s) => s.trim()).filter(Boolean).join(' ') };
    }
  }
  return null;
}

/** 値を変える変更。空にすると行を消す。複数行の accDescr は 1 行の書き方に置き換える */
export function setAcc(source: string, key: AccKey, raw: string): ChangeSpec | null {
  const value = raw.replace(/[\r\n]+/g, ' ').trim();
  const cur = readAcc(source, key);
  if (cur) {
    if (value === '') return cur.first === cur.last ? removeLine(source, cur.first) : removeLines(source, cur.first, cur.last);
    if (cur.value) return { from: cur.value.from, to: cur.value.to, insert: value };
    return { from: cur.first.from, to: cur.last.to, insert: `${indentOf(cur.first.text)}${key}: ${value}` };
  }
  if (value === '') return null;
  const { header, body } = bodyLines(source);
  if (!header) return null;
  // accDescr は accTitle の後ろに置く（読みやすさのため。順番は mermaid の解釈に関係しない）
  const title = key === 'accDescr' ? readAcc(source, 'accTitle') : null;
  const after = title?.last ?? header;
  const indent = body[0] ? indentOf(body[0].text) || '    ' : '    ';
  return { from: after.to, insert: `\n${indent}${key}: ${value}` };
}
