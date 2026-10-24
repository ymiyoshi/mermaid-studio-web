import type { ChangeSpec } from '@codemirror/state';
import { splitLines, type SourceLine } from './source';

// 図の先頭の設定（frontmatter）の読み書き。テーマの編集に使う。
//   ---
//   config:
//     theme: base
//     themeVariables:
//       primaryColor: "#ffcc00"
//   ---
// YAML の全部は読まない。「キー: 値」の入れ子（インデント）だけを読み、書き換えるのは対象の行だけにする。

interface YamlEntry {
  key: string;
  indent: number;
  line: SourceLine;
  /** 値の範囲（引用符の中）。値が無い（子を持つ）なら null */
  value: { from: number; to: number; text: string } | null;
  children: YamlEntry[];
}

export interface Frontmatter {
  open: SourceLine;
  close: SourceLine;
  entries: YamlEntry[];
}

const ENTRY = /^(?<indent> *)(?<key>[\w-]+):(?<rest>.*)$/;

/** 先頭の --- から --- まで。無ければ null */
export function parseFrontmatter(source: string): Frontmatter | null {
  const lines = splitLines(source);
  if (!/^---\s*$/.test(lines[0]?.text ?? '')) return null;
  const end = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l.text));
  if (end < 0) return null;
  const root: YamlEntry[] = [];
  const stack: YamlEntry[] = [];
  for (const line of lines.slice(1, end)) {
    const m = ENTRY.exec(line.text);
    if (!m?.groups) continue;
    const indent = m.groups.indent.length;
    const rest = m.groups.rest;
    const raw = rest.trim();
    let value: YamlEntry['value'] = null;
    if (raw !== '' && !raw.startsWith('#')) {
      const start = line.from + indent + m.groups.key.length + 1 + (rest.length - rest.trimStart().length);
      // 引用符の中だけを値にする（"#fff" の # をコメントと読まないため）
      const q = /^(["'])(.*)\1/.exec(raw);
      const text = q ? q[2] : raw.replace(/\s+#.*$/, '');
      value = { from: q ? start + 1 : start, to: (q ? start + 1 : start) + text.length, text };
    }
    const entry: YamlEntry = { key: m.groups.key, indent, line, value, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].children : root).push(entry);
    stack.push(entry);
  }
  return { open: lines[0], close: lines[end], entries: root };
}

function find(entries: YamlEntry[], path: string[]): YamlEntry | null {
  let list = entries;
  let found: YamlEntry | null = null;
  for (const k of path) {
    found = list.find((e) => e.key === k) ?? null;
    if (!found) return null;
    list = found.children;
  }
  return found;
}

/** path（['config', 'theme'] など）の値。無ければ '' */
export function getFrontmatterValue(source: string, path: string[]): string {
  const fm = parseFrontmatter(source);
  return (fm && find(fm.entries, path)?.value?.text) ?? '';
}

/** YAML の値として書く（# や : を含むなら引用符で囲む） */
const yamlValue = (v: string) => (/^[\w.-]+$/.test(v) ? v : `"${v.replace(/["\\]/g, '')}"`);

/** 行とその改行を消す範囲 */
const lineSpan = (l: SourceLine) => ({ from: l.from, to: l.to + 1 });

/**
 * path の値を value にする変更。value が空なら、その行を消す（子が無くなった親の行も消す）。
 * frontmatter や途中のキーが無ければ足す。変えなくてよければ null
 */
export function setFrontmatterValue(source: string, path: string[], value: string): ChangeSpec | null {
  const v = value.trim();
  const fm = parseFrontmatter(source);
  const nest = (keys: string[], depth: number) =>
    keys.map((k, i) => `${'  '.repeat(depth + i)}${k}:${i === keys.length - 1 ? ` ${yamlValue(v)}` : ''}`).join('\n');

  if (!fm) {
    if (v === '') return null;
    return { from: 0, insert: `---\n${nest(path, 0)}\n---\n` };
  }

  // いちばん深くまである祖先を探す
  let list = fm.entries;
  let parent: YamlEntry | null = null;
  let depth = 0;
  for (; depth < path.length; depth++) {
    const e = list.find((x) => x.key === path[depth]);
    if (!e) break;
    parent = e;
    list = e.children;
  }

  if (depth === path.length) {
    const target = parent!;
    if (v === '') {
      // 消した後に子が無くなる祖先も一緒に消す
      const chain: YamlEntry[] = [];
      let l = fm.entries;
      for (const k of path) {
        const e = l.find((x) => x.key === k)!;
        chain.push(e);
        l = e.children;
      }
      let top = chain.length - 1;
      while (top > 0 && chain[top - 1].children.length === 1 && chain[top - 1].value === null) top--;
      const first = chain[top].line;
      // 消す範囲は、その祖先の行から最後の子孫の行まで
      let last = target.line;
      const walk = (e: YamlEntry) => e.children.forEach((c) => ((last = c.line.index > last.index ? c.line : last), walk(c)));
      walk(chain[top]);
      // frontmatter が空になるなら、--- ごと消す
      const remaining = fm.entries.length - (top === 0 ? 1 : 0);
      if (remaining === 0) return { from: 0, to: Math.min(fm.close.to + 1, source.length) };
      return { from: first.from, to: lineSpan(last).to };
    }
    if (target.value) {
      if (target.value.text === v) return null;
      const quoted = source[target.value.from - 1] === '"' || source[target.value.from - 1] === "'";
      return quoted ? { from: target.value.from, to: target.value.to, insert: v.replace(/["\\]/g, '') } : { from: target.value.from, to: target.value.to, insert: yamlValue(v) };
    }
    return null;
  }
  if (v === '') return null;
  // 足りないキーを、見つかった祖先の子の最後（無ければ祖先の直後、祖先も無ければ閉じる --- の前）に足す
  const indent = parent ? (parent.children[0]?.indent ?? parent.indent + 2) : 0;
  const text = path
    .slice(depth)
    .map((k, i, rest) => `${' '.repeat(indent + i * 2)}${k}:${i === rest.length - 1 ? ` ${yamlValue(v)}` : ''}`)
    .join('\n');
  if (!parent) return { from: fm.close.from, insert: `${text}\n` };
  let last = parent.line;
  const walk = (e: YamlEntry) => e.children.forEach((c) => ((last = c.line.index > last.index ? c.line : last), walk(c)));
  walk(parent);
  return { from: last.to, insert: `\n${text}` };
}

/** テーマの編集で出す色（themeVariables の名前と表示名） */
export const THEME_COLORS: { key: string; label: string }[] = [
  { key: 'primaryColor', label: '基本の塗り' },
  { key: 'primaryTextColor', label: '基本の文字' },
  { key: 'primaryBorderColor', label: '基本の枠線' },
  { key: 'lineColor', label: '線' },
  { key: 'secondaryColor', label: '2 番目の塗り' },
  { key: 'tertiaryColor', label: '3 番目の塗り' },
  { key: 'background', label: '背景' },
];

export const DIAGRAM_THEMES = ['default', 'base', 'neutral', 'forest', 'dark'];
