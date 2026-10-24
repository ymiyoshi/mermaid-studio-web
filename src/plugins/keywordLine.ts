import type { ChangeSpec } from '@codemirror/state';
import { bodyLines, escapeRe, indentOf, insertLineAfter, type SourceLine } from './source';
import { removeLine } from './lineOps';

// 「title 売上」「dateFormat YYYY-MM-DD」のような、キーワードと値の 1 行の設定。

export interface KeywordSpec {
  id: string;
  label: string;
  keyword: string;
  type?: 'text' | 'select';
  options?: { value: string; label: string }[];
  /** 値を "..." で囲んで書く（xychart の title など）。読むときは引用符を外す */
  quoted?: boolean;
  placeholder?: string;
  /** 図種の宣言行に書かれることもある（pie title ...）。値を取り出す正規表現 */
  headerPattern?: RegExp;
}

interface Found {
  line: SourceLine;
  from: number;
  to: number;
  value: string;
}

export function findKeyword(source: string, spec: KeywordSpec): Found | null {
  const { header, body } = bodyLines(source);
  if (spec.headerPattern && header) {
    const m = spec.headerPattern.exec(header.text);
    if (m?.indices?.[1]) {
      const [a, b] = m.indices[1];
      return { line: header, from: header.from + a, to: header.from + b, value: m[1] };
    }
  }
  const re = new RegExp(`^(\\s*${escapeRe(spec.keyword)}\\s+)(.*?)\\s*$`);
  for (const line of body) {
    const m = re.exec(line.text);
    if (!m) continue;
    let from = line.from + m[1].length;
    let to = from + m[2].length;
    let value = m[2];
    if (spec.quoted && /^".*"$/.test(value)) {
      from++;
      to--;
      value = value.slice(1, -1);
    }
    return { line, from, to, value };
  }
  return null;
}

export function setKeyword(source: string, spec: KeywordSpec, value: string): ChangeSpec | null {
  const cur = findKeyword(source, spec);
  if (cur) {
    if (value === '' && cur.line !== bodyLines(source).header) return removeLine(source, cur.line);
    return { from: cur.from, to: cur.to, insert: value };
  }
  if (value === '') return null;
  const { header, body } = bodyLines(source);
  const indent = body[0] ? indentOf(body[0].text) : '    ';
  const v = spec.quoted ? `"${value.replace(/"/g, '')}"` : value;
  return insertLineAfter(source, header, `${indent}${spec.keyword} ${v}`);
}

export function keywordFields(source: string, specs: KeywordSpec[]) {
  return specs.map((s) => ({
    id: s.id,
    label: s.label,
    type: s.type ?? ('text' as const),
    options: s.options,
    placeholder: s.placeholder,
    value: findKeyword(source, s)?.value ?? '',
  }));
}
