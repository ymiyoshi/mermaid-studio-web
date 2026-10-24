import type { ChangeSpec } from '@codemirror/state';
import { splitList, type FlowDoc } from './flowchartSyntax';
import { appendTopLevel as appendLine, removeLine } from './lineOps';
import type { SourceLine } from './source';

// flowchart の見た目の指定（style / class / classDef / linkStyle）と、frontmatter の題名の読み書き。
// 書き換えるのは対象の行の値の部分だけ。行が無ければ図の最後に 1 行足し、値が無くなった行は消す。

/** "fill:#f96,stroke:#333" を [キー, 値] の並びにする */
function parseProps(text: string): [string, string][] {
  return text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(':');
      return i < 0 ? [p, ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
}

const formatProps = (props: [string, string][]) => props.map(([k, v]) => `${k}:${v}`).join(',');

/** スタイルの値に使えない文字（区切りの , ; と改行） */
const INVALID_VALUE = /[,;\n]/;

function withProp(text: string, key: string, value: string): string {
  const props = parseProps(text).filter(([k]) => k !== key);
  if (value) props.push([key, value]);
  return formatProps(props);
}

/** ノード（またはサブグラフ）id の style の値。複数の行があれば後のものが勝つ */
export function styleProp(doc: FlowDoc, id: string, key: string): string {
  let value = '';
  for (const s of doc.styles) if (s.id.value === id) for (const [k, v] of parseProps(s.props.value)) if (k === key) value = v;
  return value;
}

export function setStyleProp(source: string, doc: FlowDoc, id: string, key: string, value: string): ChangeSpec | null {
  value = value.trim();
  if (INVALID_VALUE.test(value)) return null;
  // 同じキーを持つ最後の行、なければ最後の style 行を書き換える
  const lines = doc.styles.filter((s) => s.id.value === id);
  const line = [...lines].reverse().find((s) => parseProps(s.props.value).some(([k]) => k === key)) ?? lines.at(-1);
  if (!line) return value ? appendLine(source, `style ${id} ${key}:${value}`) : null;
  const props = withProp(line.props.value, key, value);
  if (props === '') return removeLine(source, line.line);
  return { from: line.props.from, to: line.props.to, insert: props };
}

/** classDef で定義されたクラスの名前 */
export function classNames(doc: FlowDoc): string[] {
  return [...new Set(doc.classDefs.flatMap((d) => d.names.value.split(',')).filter(Boolean))];
}

/** ノードに付いたクラス（:::name か class 行。後のものが勝つ） */
export function classOf(doc: FlowDoc, id: string): string {
  const hits: { at: number; name: string }[] = [];
  for (const st of doc.statements) for (const g of st.groups) for (const r of g) if (r.id === id && r.cls) hits.push({ at: r.cls.from, name: r.cls.value });
  for (const c of doc.classes) if (c.ids.some((x) => x.value === id)) hits.push({ at: c.line.from, name: c.name.value });
  hits.sort((a, b) => a.at - b.at);
  return hits.at(-1)?.name ?? '';
}

/** ノードのクラスを付け替える（name が空なら外す） */
export function setClass(source: string, doc: FlowDoc, id: string, name: string): ChangeSpec[] | null {
  if (name !== '' && !/^[\p{L}\p{N}_-]+$/u.test(name)) return null;
  const changes: ChangeSpec[] = [];
  const inline = doc.statements.flatMap((st) => st.groups.flat()).filter((r) => r.id === id && r.cls);
  const lines = doc.classes.filter((c) => c.ids.some((x) => x.value === id));
  // 付いている場所が 1 か所だけなら、その名前だけを書き換える
  if (name && inline.length + lines.length === 1) {
    if (inline[0]) return [{ from: inline[0].cls!.from, to: inline[0].cls!.to, insert: name }];
    const c = lines[0];
    if (c.ids.length === 1) return [{ from: c.name.from, to: c.name.to, insert: name }];
  }
  for (const r of inline) changes.push({ from: r.cls!.from - 3, to: r.cls!.to });
  for (const c of lines) changes.push(removeFromList(source, c.line, c.ids, id));
  if (name) changes.push(appendLine(source, `class ${id} ${name}`));
  return changes.length ? changes : null;
}

/** カンマ区切りの並び（items）から value を外す変更。何も残らなければ行ごと消す */
export function removeFromList(source: string, line: SourceLine, items: { from: number; to: number; value: string }[], value: string): ChangeSpec {
  const rest = items.filter((x) => x.value !== value);
  if (rest.length === 0) return removeLine(source, line);
  return { from: items[0].from, to: items.at(-1)!.to, insert: rest.map((x) => x.value).join(',') };
}

/** エッジ index の linkStyle の値（default の行も見る。後のものが勝つ） */
export function linkStyleProp(doc: FlowDoc, index: number, key: string): string {
  let value = '';
  for (const ls of doc.linkStyles) {
    const ids = ls.indices.value.split(',');
    if (!ids.includes(String(index)) && ls.indices.value !== 'default') continue;
    for (const [k, v] of parseProps(ls.props.value)) if (k === key) value = v;
  }
  return value;
}

export function setLinkStyleProp(source: string, doc: FlowDoc, index: number, key: string, value: string): ChangeSpec | null {
  value = value.trim();
  if (INVALID_VALUE.test(value)) return null;
  const own = doc.linkStyles.filter((ls) => ls.indices.value.split(',').includes(String(index)));
  const only = own.filter((ls) => ls.indices.value === String(index)).at(-1);
  if (only) {
    const props = withProp(only.props.value, key, value);
    return props === '' ? removeLine(source, only.line) : { from: only.props.from, to: only.props.to, insert: props };
  }
  // 他のエッジと共有している行は、このエッジを外して、このエッジだけの行を足す
  const shared = own.at(-1);
  const base = shared ? shared.props.value : '';
  const props = withProp(base, key, value);
  const changes: ChangeSpec[] = [];
  if (shared) changes.push(removeFromList(source, shared.line, splitList(shared.indices), String(index)));
  if (props) changes.push(appendLine(source, `linkStyle ${index} ${props}`));
  return changes.length ? changes : null;
}

// ---- frontmatter の題名 ----

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export function frontmatterTitle(source: string): string {
  const fm = FRONTMATTER.exec(source);
  const m = fm && /^title:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]);
  return m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : '';
}

export function setFrontmatterTitle(source: string, title: string): ChangeSpec | null {
  title = title.trim();
  if (/\n/.test(title)) return null;
  const quoted = /[:#"'{}[\]]/.test(title) ? JSON.stringify(title) : title;
  const fm = FRONTMATTER.exec(source);
  if (!fm) return title ? { from: 0, insert: `---\ntitle: ${quoted}\n---\n` } : null;
  const bodyFrom = fm[0].indexOf('\n') + 1;
  const m = /^title:[ \t]*(.*?)[ \t]*$/dm.exec(fm[1]);
  if (m) {
    const lineFrom = bodyFrom + m.index;
    if (!title) {
      // title の行を消す（改行も一緒に）。中身が無くなる frontmatter は、--- ごと消す（空の frontmatter は構文エラー）
      const rest = fm[1].slice(0, m.index) + fm[1].slice(m.index + m[0].length + 1);
      if (rest.trim() === '') return { from: 0, to: fm[0].length };
      const lineTo = lineFrom + m[0].length;
      return { from: lineFrom, to: Math.min(lineTo + 1, bodyFrom + fm[1].length + 1) };
    }
    return { from: bodyFrom + m.indices![1]![0], to: bodyFrom + m.indices![1]![1], insert: quoted };
  }
  return title ? { from: bodyFrom, insert: `title: ${quoted}\n` } : null;
}
