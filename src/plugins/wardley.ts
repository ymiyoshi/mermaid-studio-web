import type { ChangeSpec } from '@codemirror/state';
import { withValue, type DiagramPlugin, type DiagramTarget, type ElementRef, type PropertyField, type SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, type SourceLine } from './source';
import { insertIntoBlock, removeLineSet } from './lineOps';
import { addHitArea, matchInOrder } from './svg';
import { findKeyword, keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { t } from '../i18n';

// wardley 図（wardley-beta）のプラグイン。
// 1 行に 1 つの文: anchor / component の宣言、pipeline 親 { component 子 [進化] }、依存の線（A -> B; ラベル）、
// evolve（進化の行き先）、note（メモ）。部品は名前で指す（ID は無く、名前が線・evolve・pipeline からの参照を兼ねる）。
// SVG には ID も data 属性も無いので、部品は種類とラベルの文字（名前）で、線は両端の部品の位置で、
// メモは文字で対応付ける。線のラベルは線とは別の text で、ラベルのある線の順に並ぶので、文字を照らし合わせて付ける。
// 座標は [見える度合い, 進化]（0〜1 か 0〜100。小数点が要る）。

export type WardleyKind = 'anchor' | 'component';

interface WName {
  /** 名前（引用符を外し、引用符の無い名前は空白を 1 つにまとめたもの） */
  value: string;
  /** 引用符を含む範囲 */
  outer: SourceRange;
  /** 引用符の内側の範囲 */
  inner: SourceRange;
}

interface Num {
  value: string;
  range: SourceRange;
}

export interface WNode {
  kind: WardleyKind;
  name: WName;
  line: SourceLine;
  /** 見える度合い（pipeline の中の部品には無い） */
  v: Num | null;
  e: Num;
  /** pipeline の中の部品なら、親の部品の名前 */
  pipeline: string | null;
  /** (build) など。range は前の空白を含む */
  strategy: { value: string; range: SourceRange; valueRange: SourceRange } | null;
  /** inertia。前の空白を含む */
  inertia: SourceRange | null;
  /** 進め方を足す位置（座標か label [..] の後ろ） */
  afterLabel: number;
  /** inertia を足す位置（進め方の後ろ） */
  afterStrategy: number;
}

export interface WPipeline {
  name: WName;
  /** pipeline の行から } の行まで */
  lines: SourceLine[];
  children: WNode[];
}

export interface WLink {
  line: SourceLine;
  a: WName;
  b: WName;
  arrow: { value: string; range: SourceRange };
  /** ; の後ろのラベル。clause は ; の前の空白からラベルの終わりまで */
  label: { value: string; range: SourceRange; clause: SourceRange } | null;
  /** ラベルを足す位置（線の先の名前・ポートの後ろ） */
  end: number;
}

export interface WEvolve {
  line: SourceLine;
  name: WName;
  value: Num;
}

export interface WNote {
  line: SourceLine;
  text: { value: string; range: SourceRange };
  v: Num;
  e: Num;
}

export interface ParsedWardley {
  nodes: WNode[];
  pipelines: WPipeline[];
  links: WLink[];
  evolves: WEvolve[];
  notes: WNote[];
}

// 引用符の無い名前: 英数字と _ ( ) &、矢印にならない -。空白で区切った語を続けられる
const WORD = String.raw`(?:[A-Za-z0-9_()&]|-(?![-.>]))+`;
const NAME = String.raw`"[^"\n]*"|${WORD}(?:[ \t]+${WORD})*`;
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const TAIL = String.raw`\s*(?:%%.*)?$`;
const LABEL_OFFSET = String.raw`\s*label\s*\[\s*${NUM}\s*,\s*${NUM}\s*\]`;
const PORT = String.raw`\+<>|\+<|\+>`;

const NODE = new RegExp(
  String.raw`^\s*(?<kw>component|anchor)\s+(?<name>${NAME})\s*(?<co>\[\s*(?<v>${NUM})\s*,\s*(?<e>${NUM})\s*\])(?<lab>${LABEL_OFFSET})?(?<st>\s*\((?<stv>build|buy|outsource|market)\))?(?<in>\s*inertia)?${TAIL}`,
  'd',
);
const CHILD = new RegExp(String.raw`^\s*component\s+(?<name>${NAME})\s*(?<co>\[\s*(?<e>${NUM})\s*\])(?<lab>${LABEL_OFFSET})?${TAIL}`, 'd');
const PIPELINE = new RegExp(String.raw`^\s*pipeline\s+(?<name>${NAME})\s*\{${TAIL}`, 'd');
const CLOSE = /^\s*\}\s*(?:%%.*)?$/;
const LINK = new RegExp(
  String.raw`^\s*(?<a>${NAME})\s*(?:${PORT})?\s*(?<arrow>-\.->|-->|->|\+'[^'\n]*'(?:<>|<|>)|\+(?:<>|<|>))\s*(?<b>${NAME})(?<bp>\s*(?:${PORT}))?(?<lab>\s*;\s*(?<label>.*?))?${TAIL}`,
  'd',
);
const EVOLVE = new RegExp(String.raw`^\s*evolve\s+(?<name>${NAME})\s+(?<val>${NUM})${TAIL}`, 'd');
const NOTE = new RegExp(String.raw`^\s*note\s+"(?<text>[^"\n]*)"\s*\[\s*(?<v>${NUM})\s*,\s*(?<e>${NUM})\s*\]${TAIL}`, 'd');

export const STRATEGIES = ['build', 'buy', 'outsource', 'market'];

/** 引用符を付けずに書ける名前（語は英字で始める。語の頭がキーワードだと、mermaid がキーワードとして読んでしまう） */
const PLAIN = /^[A-Za-z][A-Za-z0-9_]*(?: [A-Za-z][A-Za-z0-9_]*)*$/;
const KEYWORDS = ['title', 'size', 'evolution', 'evolve', 'anchor', 'component', 'pipeline', 'note', 'annotations', 'annotation', 'accelerator', 'deaccelerator', 'label', 'inertia', 'build', 'buy', 'outsource', 'market'];

/** ソースに書く形の名前（必要なら引用符で囲む） */
export function formatName(name: string): string {
  return PLAIN.test(name) && !KEYWORDS.some((k) => name.startsWith(k)) ? name : `"${name}"`;
}

/** 名前に書けない文字（引用符・改行）を除く */
const cleanName = (v: string) => v.replace(/["\r\n]/g, '').replace(/\s+/g, ' ').trim();

export function parseWardley(source: string): ParsedWardley {
  const out: ParsedWardley = { nodes: [], pipelines: [], links: [], evolves: [], notes: [] };
  let pipe: WPipeline | null = null;
  for (const line of bodyLines(source).body) {
    const at = (r: [number, number]): SourceRange => ({ from: line.from + r[0], to: line.from + r[1] });
    const nameOf = (raw: string, r: [number, number]): WName => {
      const quoted = raw.startsWith('"');
      const outer = at(r);
      return { value: quoted ? raw.slice(1, -1) : raw.replace(/\s+/g, ' '), outer, inner: quoted ? { from: outer.from + 1, to: outer.to - 1 } : outer };
    };
    const num = (value: string, r: [number, number]): Num => ({ value, range: at(r) });
    if (pipe) {
      if (CLOSE.test(line.text)) {
        pipe.lines.push(line);
        pipe = null;
        continue;
      }
      pipe.lines.push(line);
      const c = CHILD.exec(line.text);
      if (c?.groups && c.indices?.groups) {
        const g = c.indices.groups;
        const after = line.from + (g.lab ?? g.co!)[1];
        const node: WNode = {
          kind: 'component',
          name: nameOf(c.groups.name!, g.name!),
          line,
          v: null,
          e: num(c.groups.e!, g.e!),
          pipeline: pipe.name.value,
          strategy: null,
          inertia: null,
          afterLabel: after,
          afterStrategy: after,
        };
        pipe.children.push(node);
        out.nodes.push(node);
      }
      continue;
    }
    const n = NODE.exec(line.text);
    if (n?.groups && n.indices?.groups) {
      const g = n.indices.groups;
      const afterLabel = line.from + (g.lab ?? g.co!)[1];
      out.nodes.push({
        kind: n.groups.kw as WardleyKind,
        name: nameOf(n.groups.name!, g.name!),
        line,
        v: num(n.groups.v!, g.v!),
        e: num(n.groups.e!, g.e!),
        pipeline: null,
        strategy: g.st ? { value: n.groups.stv!, range: at(g.st), valueRange: at(g.stv!) } : null,
        inertia: g.in ? at(g.in) : null,
        afterLabel,
        afterStrategy: g.st ? line.from + g.st[1] : afterLabel,
      });
      continue;
    }
    const pl = PIPELINE.exec(line.text);
    if (pl?.groups && pl.indices?.groups) {
      pipe = { name: nameOf(pl.groups.name!, pl.indices.groups.name!), lines: [line], children: [] };
      out.pipelines.push(pipe);
      continue;
    }
    const ev = EVOLVE.exec(line.text);
    if (ev?.groups && ev.indices?.groups) {
      out.evolves.push({ line, name: nameOf(ev.groups.name!, ev.indices.groups.name!), value: num(ev.groups.val!, ev.indices.groups.val!) });
      continue;
    }
    const no = NOTE.exec(line.text);
    if (no?.groups && no.indices?.groups) {
      const g = no.indices.groups;
      out.notes.push({ line, text: { value: no.groups.text!, range: at(g.text!) }, v: num(no.groups.v!, g.v!), e: num(no.groups.e!, g.e!) });
      continue;
    }
    const l = LINK.exec(line.text);
    if (l?.groups && l.indices?.groups) {
      const g = l.indices.groups;
      out.links.push({
        line,
        a: nameOf(l.groups.a!, g.a!),
        b: nameOf(l.groups.b!, g.b!),
        arrow: { value: l.groups.arrow!, range: at(g.arrow!) },
        label: g.lab ? { value: l.groups.label!, range: at(g.label!), clause: at(g.lab) } : null,
        end: line.from + (g.bp ?? g.b!)[1],
      });
    }
  }
  return out;
}

const findNode = (p: ParsedWardley, ref: ElementRef | null | undefined) => (ref ? p.nodes.find((n) => n.kind === ref.kind && n.name.value === ref.id) : undefined);
const nameExists = (p: ParsedWardley, name: string) => p.nodes.some((n) => n.name.value === name);

/** 座標の値（0〜1 なら割合、100 まで）。mermaid は小数点の無い数を読めないので、整数には .0 を付ける */
export function formatCoord(value: string): string | null {
  const v = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(v) || Number(v) > 100) return null;
  return v.includes('.') ? v : `${v}.0`;
}

/** 座標を 0〜1 の割合にする */
const ratio = (v: string) => (Number(v) > 1 ? Number(v) / 100 : Number(v));

/** 部品の位置（pipeline の中の部品は、親の見える度合いを使う） */
function pointOf(p: ParsedWardley, n: WNode): [number, number] {
  const parent = n.pipeline !== null ? p.nodes.find((x) => x.pipeline === null && x.name.value === n.pipeline) : null;
  const v = n.v ?? parent?.v;
  return [v ? ratio(v.value) : 0.5, ratio(n.e.value)];
}

/** 既存の部品と重ならない位置（候補を順に試す） */
function freePoint(p: ParsedWardley, prefer: [number, number]): [number, number] {
  const taken = p.nodes.map((n) => pointOf(p, n));
  const steps = [0, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3];
  for (const dv of steps) {
    for (const de of steps) {
      const v = Math.min(0.95, Math.max(0.05, prefer[0] + dv));
      const e = Math.min(0.95, Math.max(0.05, prefer[1] + de));
      if (!taken.some(([tv, te]) => Math.abs(tv - v) < 0.05 && Math.abs(te - e) < 0.05)) return [v, e];
    }
  }
  return prefer;
}

const fmt = (x: number) => x.toFixed(2);

/** base と重ならない名前（base、base 2、base 3 …） */
function uniqueName(p: ParsedWardley, base: string): string {
  if (!nameExists(p, base)) return base;
  for (let k = 2; ; k++) if (!nameExists(p, `${base} ${k}`)) return `${base} ${k}`;
}

/**
 * 行の集まり lines を消すとき、一緒に消す行を足して消す変更を作る。
 * 中身が無くなる pipeline（{ } だけは構文の誤り）と、どこにも宣言が残らない名前への線・evolve を消す
 */
function removeWithDependents(source: string, p: ParsedWardley, lines: Set<number>): ChangeSpec[] {
  for (const pl of p.pipelines) {
    // 親の部品が消える pipeline は丸ごと消す（親の無い pipeline は構文の誤り）
    const parentLeft = p.nodes.some((n) => n.pipeline === null && n.name.value === pl.name.value && !lines.has(n.line.index));
    if (!parentLeft || pl.children.every((c) => lines.has(c.line.index))) pl.lines.forEach((l) => lines.add(l.index));
  }
  const gone = new Set(p.nodes.filter((n) => lines.has(n.line.index)).map((n) => n.name.value));
  for (const n of p.nodes) if (!lines.has(n.line.index)) gone.delete(n.name.value);
  for (const l of p.links) if (gone.has(l.a.value) || gone.has(l.b.value)) lines.add(l.line.index);
  for (const e of p.evolves) if (gone.has(e.name.value)) lines.add(e.line.index);
  return removeLineSet(source, lines);
}

export function deleteNode(source: string, name: string): ChangeSpec[] | null {
  const p = parseWardley(source);
  const lines = new Set(p.nodes.filter((n) => n.name.value === name).map((n) => n.line.index));
  return lines.size ? removeWithDependents(source, p, lines) : null;
}

export function deletePipeline(source: string, name: string): ChangeSpec[] | null {
  const p = parseWardley(source);
  const pl = p.pipelines.find((x) => x.name.value === name);
  return pl ? removeWithDependents(source, p, new Set(pl.lines.map((l) => l.index))) : null;
}

/** 名前を変える（宣言・pipeline・線の両端・evolve。引用符ごと、新しい名前に合う書き方で置き換える） */
export function renameNode(source: string, from: string, value: string): ChangeSpec[] | null {
  const to = cleanName(value);
  const p = parseWardley(source);
  if (to === '' || to === from || nameExists(p, to) || !nameExists(p, from)) return null;
  const ranges: SourceRange[] = [];
  for (const n of p.nodes) if (n.name.value === from) ranges.push(n.name.outer);
  for (const pl of p.pipelines) if (pl.name.value === from) ranges.push(pl.name.outer);
  for (const l of p.links) {
    if (l.a.value === from) ranges.push(l.a.outer);
    if (l.b.value === from) ranges.push(l.b.outer);
  }
  for (const e of p.evolves) if (e.name.value === from) ranges.push(e.name.outer);
  const insert = formatName(to);
  return ranges.map((r) => ({ ...r, insert }));
}

/** 最後のトップレベルの部品の行（無ければ title の行、それも無ければ図種の宣言行） */
function lastNodeLine(source: string, p: ParsedWardley): SourceLine | null {
  return p.nodes.filter((n) => n.pipeline === null).at(-1)?.line ?? findKeyword(source, TITLE)?.line ?? bodyLines(source).header;
}

/** 線を足す位置（最後の線の後ろ。無ければ最後の行の後ろ） */
function lastLinkLine(source: string, p: ParsedWardley): SourceLine | null {
  const { header, body } = bodyLines(source);
  return p.links.at(-1)?.line ?? body.at(-1) ?? header;
}

const indentFor = (source: string, line: SourceLine | null) => {
  const { header, body } = bodyLines(source);
  if (line && line.index !== header?.index) return indentOf(line.text);
  return body[0] ? indentOf(body[0].text) : '';
};

const NEW_COMPONENT = t('wm.newComponent');
const NEW_ANCHOR = t('wm.newAnchor');
const NEW_NOTE = t('wm.newNote');
const TITLE: KeywordSpec = { id: 'title', label: t('wm.field.title'), keyword: 'title' };

const STRATEGY_OPTIONS = [{ value: '', label: t('plg.none') }, ...STRATEGIES.map((v) => ({ value: v, label: t(`wm.strategy.${v}` as 'wm.strategy.build') }))];
const INERTIA_OPTIONS = [
  { value: '', label: t('plg.none') },
  { value: 'inertia', label: t('wm.inertia.on') },
];
const STYLE_OPTIONS = [
  { value: '->', label: t('wm.style.solid') },
  { value: '-.->', label: t('wm.style.dashed') },
];
const ARROW = /^(?:-\.->|-->|->|\+'[^'\n]*'(?:<>|<|>)|\+(?:<>|<|>))$/;

/** 新しい部品を足す変更（トップレベルの部品の後ろ） */
function addNodeLine(source: string, p: ParsedWardley, kind: WardleyKind, name: string, [v, e]: [number, number]) {
  const after = lastNodeLine(source, p);
  return insertLineAfter(source, after, `${indentFor(source, after)}${kind} ${formatName(name)} [${fmt(v)}, ${fmt(e)}]`);
}

/** 線のラベル（; の後ろ）を変える。空にしたら ; ごと外す */
function setLinkLabel(l: WLink, value: string): ChangeSpec | null {
  const v = value.replace(/[\r\n]+/g, ' ').replace(/%%/g, '%').trim();
  if (!l.label) return v === '' ? null : { from: l.end, insert: `; ${v}` };
  if (v === '') return l.label.clause;
  return { ...l.label.range, insert: v };
}

/** evolve の値を変える（空なら evolve の行を消す。無ければ足す） */
function setEvolve(source: string, p: ParsedWardley, name: string, value: string): ChangeSpec | ChangeSpec[] | null {
  const lines = p.evolves.filter((e) => e.name.value === name);
  if (value.trim() === '') return lines.length ? removeLineSet(source, new Set(lines.map((e) => e.line.index))) : null;
  const v = formatCoord(value);
  if (!v) return null;
  if (lines.length) return { ...lines[0].value.range, insert: v };
  const after = p.evolves.at(-1)?.line ?? lastLinkLine(source, p);
  return insertLineAfter(source, after, `${indentFor(source, after)}evolve ${formatName(name)} ${v}`);
}

function setCoord(n: Num | null | undefined, value: string): ChangeSpec | null {
  const v = formatCoord(value);
  return n && v ? { ...n.range, insert: v } : null;
}

const center = (g: Element, text: Element): [number, number] => {
  const num = (el: Element, a: string) => Number(el.getAttribute(a) ?? 'NaN');
  const c = g.querySelector('circle');
  if (c) return [num(c, 'cx'), num(c, 'cy')];
  const r = g.querySelector('rect');
  if (r) return [num(r, 'x') + num(r, 'width') / 2, num(r, 'y') + num(r, 'height') / 2];
  return [num(text, 'x'), num(text, 'y')];
};

/** 線の両端が、それぞれの部品の近くにあるか（向きはどちらでもよい） */
function nearEnds(el: Element, a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  if (!a || !b) return false;
  const num = (k: string) => Number(el.getAttribute(k) ?? 'NaN');
  const s: [number, number] = [num('x1'), num('y1')];
  const e: [number, number] = [num('x2'), num('y2')];
  const d = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const R = 30;
  return (d(s, a) < R && d(e, b) < R) || (d(s, b) < R && d(e, a) < R);
}

/** 枠（rect）の中に点があるか */
function inside(rect: Element, pt: [number, number] | undefined): boolean {
  if (!pt) return false;
  const num = (k: string) => Number(rect.getAttribute(k) ?? 'NaN');
  const [x, y, w, h] = [num('x'), num('y'), num('width'), num('height')];
  return pt[0] >= x - 2 && pt[0] <= x + w + 2 && pt[1] >= y - 2 && pt[1] <= y + h + 2;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export const wardleyPlugin: DiagramPlugin = {
  type: 'wardley',

  mapTargets(svg, source) {
    const p = parseWardley(source);
    const mapped: DiagramTarget[] = [];
    const title = svg.querySelector('text.wardley-title');
    const found = findKeyword(source, TITLE);
    if (title && found && norm(labelText(title)) === norm(found.value)) {
      mapped.push({ id: 'wm-title', el: title, labelEl: title, label: labelText(title), range: { from: found.from, to: found.to } });
    }
    // 部品: 種類（anchor / component / pipeline の中）とラベルの文字（名前）で対応付ける。同じ名前の宣言は 1 つにまとめて描かれる
    const pos = new Map<string, [number, number]>();
    const seen = new Set<string>();
    svg.querySelectorAll('g.wardley-nodes > g.wardley-node').forEach((g, i) => {
      const text = g.querySelector('text.wardley-node-label');
      if (!text) return;
      const name = labelText(text);
      const kind: WardleyKind = g.classList.contains('wardley-node--anchor') ? 'anchor' : 'component';
      const child = g.classList.contains('wardley-node--pipeline-component');
      const same = p.nodes.filter((n) => n.kind === kind && norm(n.name.value) === name);
      const n = same.find((x) => (x.pipeline !== null) === child) ?? same[0];
      if (!n || seen.has(`${kind}:${n.name.value}`)) return;
      seen.add(`${kind}:${n.name.value}`);
      pos.set(n.name.value, center(g, text));
      mapped.push({ id: `wm-node-${i}`, el: g, labelEl: text, label: name, range: null, ref: { kind, id: n.name.value } });
    });
    // pipeline の枠: 中の部品を囲んでいるもの
    const boxes = [...svg.querySelectorAll('g.wardley-pipelines > rect.wardley-pipeline-box')];
    const boxOrder = matchInOrder(boxes, p.pipelines, (el, pl) => pl.children.some((c) => inside(el, pos.get(c.name.value))));
    boxes.forEach((rect, k) => {
      const pl = p.pipelines[boxOrder[k]];
      if (pl) mapped.push({ id: `wm-pipeline-${k}`, el: rect, labelEl: rect, label: '', range: null, ref: { kind: 'pipeline', id: pl.name.value } });
    });
    // 線: 両端が宣言された部品の線だけが、ソースの順に描かれる（pipeline の中の部品から、その親への線は描かれない）。
    // 数が合わなければ対応付けない
    const declared = new Set(p.nodes.map((n) => n.name.value));
    const parentOf = new Map(p.nodes.flatMap((n) => (n.pipeline ? [[n.name.value, n.pipeline] as const] : [])));
    const drawn = p.links
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => declared.has(l.a.value) && declared.has(l.b.value) && parentOf.get(l.a.value) !== l.b.value);
    const lines = [...svg.querySelectorAll('g.wardley-links > line.wardley-link')];
    if (lines.length === drawn.length) {
      const order = matchInOrder(lines, drawn, (el, { l }) => nearEnds(el, pos.get(l.a.value), pos.get(l.b.value)));
      const links = lines.flatMap((el, k) => (order[k] < 0 ? [] : [{ el, ...drawn[order[k]] }]));
      // 線のラベルは、ラベルのある線の順に、線の後ろにまとめて描かれる
      const texts = [...svg.querySelectorAll('g.wardley-links > text.wardley-link-label')];
      const labelled = links.filter((x) => x.l.label);
      const labelOrder = matchInOrder(texts, labelled, (el, x) => labelText(el) === norm(x.l.label!.value));
      const labelOf = new Map<number, Element>();
      texts.forEach((el, k) => {
        if (labelOrder[k] >= 0) labelOf.set(labelled[labelOrder[k]].i, el);
      });
      links.forEach(({ el, l, i }, k) => {
        const text = labelOf.get(i);
        // 破線の当たり判定は、隙間でもクリックできるように実線にする
        const hit = addHitArea(el);
        hit.removeAttribute('stroke-dasharray');
        mapped.push({
          id: `wm-link-${k}`,
          el,
          hits: [hit, ...(text ? [text] : [])],
          labelEl: text ?? el,
          label: text ? labelText(text) : '',
          range: text ? l.label!.range : null,
          // ラベルの無い線は、; ラベル として差し込む
          insertAt: l.label ? undefined : { at: l.end, prefix: '; ', suffix: '' },
          ref: { kind: 'link', id: String(i) },
        });
      });
    }
    // メモ: 文字で対応付ける
    const notes = [...svg.querySelectorAll('g.wardley-notes > text')];
    const noteOrder = matchInOrder(notes, p.notes, (el, n) => labelText(el) === norm(n.text.value));
    notes.forEach((el, k) => {
      const i = noteOrder[k];
      if (i < 0) return;
      mapped.push({ id: `wm-note-${k}`, el, labelEl: el, label: labelText(el), range: p.notes[i].text.range, ref: { kind: 'note', id: String(i) } });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    if (!ref) return keywordFields(source, [TITLE]);
    const p = parseWardley(source);
    if (ref.kind === 'link') {
      const l = p.links[Number(ref.id)];
      if (!l) return [];
      return [
        { id: 'ends', label: t('wm.field.ends'), type: 'text', value: `${l.a.value} → ${l.b.value}`, readonly: true },
        { id: 'style', label: t('wm.field.style'), type: 'select', value: l.arrow.value, options: withValue(STYLE_OPTIONS, l.arrow.value) },
        { id: 'label', label: t('plg.label'), type: 'text', value: l.label?.value ?? '' },
      ];
    }
    if (ref.kind === 'note') {
      const n = p.notes[Number(ref.id)];
      if (!n) return [];
      return [
        { id: 'text', label: t('wm.field.text'), type: 'text', value: n.text.value },
        { id: 'v', label: t('wm.field.visibility'), type: 'number', value: n.v.value },
        { id: 'e', label: t('wm.field.evolution'), type: 'number', value: n.e.value },
      ];
    }
    if (ref.kind === 'pipeline') {
      return p.pipelines.some((x) => x.name.value === ref.id) ? [{ id: 'parent', label: t('wm.field.parent'), type: 'text', value: ref.id, readonly: true }] : [];
    }
    const n = findNode(p, ref);
    if (!n) return [];
    const fields: PropertyField[] = [{ id: 'name', label: t('wm.field.name'), type: 'text', value: n.name.value, commitOnBlur: true }];
    if (n.v) fields.push({ id: 'v', label: t('wm.field.visibility'), type: 'number', value: n.v.value });
    fields.push({ id: 'e', label: t('wm.field.evolution'), type: 'number', value: n.e.value });
    if (n.kind === 'component' && n.pipeline === null) {
      const st = n.strategy?.value ?? '';
      fields.push({ id: 'strategy', label: t('wm.field.strategy'), type: 'select', value: st, options: withValue(STRATEGY_OPTIONS, st) });
      fields.push({ id: 'inertia', label: t('wm.field.inertia'), type: 'select', value: n.inertia ? 'inertia' : '', options: INERTIA_OPTIONS });
    }
    if (n.kind === 'component') {
      fields.push({ id: 'evolve', label: t('wm.field.evolve'), type: 'number', value: p.evolves.find((e) => e.name.value === n.name.value)?.value.value ?? '' });
    }
    return fields;
  },

  setProperty(source, ref, field, value) {
    if (!ref) return field === 'title' ? setKeyword(source, TITLE, value.replace(/[\r\n]+/g, ' ').trim()) : null;
    const p = parseWardley(source);
    if (ref.kind === 'link') {
      const l = p.links[Number(ref.id)];
      if (!l) return null;
      if (field === 'style') return ARROW.test(value) && value !== l.arrow.value ? { ...l.arrow.range, insert: value } : null;
      if (field === 'label') return setLinkLabel(l, value);
      return null;
    }
    if (ref.kind === 'note') {
      const n = p.notes[Number(ref.id)];
      if (!n) return null;
      if (field === 'text') return { ...n.text.range, insert: value.replace(/["\r\n]/g, ' ') };
      if (field === 'v' || field === 'e') return setCoord(n[field], value);
      return null;
    }
    const n = findNode(p, ref);
    if (!n) return null;
    if (field === 'name') return renameNode(source, n.name.value, value);
    if (field === 'v' || field === 'e') return setCoord(n[field], value);
    if (n.kind === 'component' && n.pipeline === null) {
      if (field === 'strategy') {
        const v = value.trim();
        if (v !== '' && !STRATEGIES.includes(v)) return null;
        if (n.strategy) return v === '' ? n.strategy.range : { ...n.strategy.valueRange, insert: v };
        return v === '' ? null : { from: n.afterLabel, insert: ` (${v})` };
      }
      if (field === 'inertia') {
        const on = value === 'inertia';
        if (on === !!n.inertia) return null;
        return on ? { from: n.afterStrategy, insert: ' inertia' } : n.inertia!;
      }
    }
    if (field === 'evolve' && n.kind === 'component') return setEvolve(source, p, n.name.value, value);
    return null;
  },

  actions: [
    {
      id: 'add-component',
      title: t('wm.action.addComponent'),
      arity: 0,
      run(source) {
        const p = parseWardley(source);
        const name = uniqueName(p, NEW_COMPONENT);
        const change = addNodeLine(source, p, 'component', name, freePoint(p, [0.5, 0.5]));
        return { change, label: t('wm.history.addComponent', { name }), select: { kind: 'component', id: name } };
      },
    },
    {
      id: 'add-anchor',
      title: t('wm.action.addAnchor'),
      arity: 0,
      run(source) {
        const p = parseWardley(source);
        const name = uniqueName(p, NEW_ANCHOR);
        const change = addNodeLine(source, p, 'anchor', name, freePoint(p, [0.95, 0.5]));
        return { change, label: t('wm.history.addAnchor', { name }), select: { kind: 'anchor', id: name } };
      },
    },
    {
      id: 'add-note',
      title: t('wm.action.addNote'),
      arity: 0,
      run(source) {
        const p = parseWardley(source);
        const { header, body } = bodyLines(source);
        const after = p.notes.at(-1)?.line ?? body.at(-1) ?? header;
        const change = insertLineAfter(source, after, `${indentFor(source, after)}note "${NEW_NOTE}" [0.20, 0.20]`);
        return { change, label: t('wm.history.addNote') };
      },
    },
    {
      id: 'add-next',
      title: t('wm.action.addNext'),
      arity: 1,
      appliesTo: ['anchor', 'component'],
      key: 'Tab',
      run(source, [ref]) {
        const p = parseWardley(source);
        const n = findNode(p, ref);
        if (!n) return null;
        const name = uniqueName(p, NEW_COMPONENT);
        const [v, e] = pointOf(p, n);
        const [nv, ne] = freePoint(p, [Math.max(0.05, v - 0.15), e]);
        // 依存先は見える度合いを下げて、元の部品の次の行（pipeline の中なら最後の部品の行）に足す。線は最後の線の後ろ
        const declAfter = n.pipeline === null ? n.line : lastNodeLine(source, p)!;
        const decl = `${indentFor(source, declAfter)}component ${formatName(name)} [${fmt(nv)}, ${fmt(ne)}]`;
        const link = `${formatName(n.name.value)} -> ${formatName(name)}`;
        const linkAfter = p.links.at(-1)?.line;
        const change =
          linkAfter && linkAfter.index > (declAfter?.index ?? -1)
            ? [insertLineAfter(source, declAfter, decl), insertLineAfter(source, linkAfter, indentOf(linkAfter.text) + link)]
            : insertLineAfter(source, declAfter, `${decl}\n${indentFor(source, declAfter)}${link}`);
        return { change, label: t('wm.history.addNext', { name, ref: n.name.value }), select: { kind: 'component', id: name } };
      },
    },
    {
      id: 'add-child',
      title: t('wm.action.addChild'),
      arity: 1,
      appliesTo: ['pipeline'],
      key: 'Tab',
      run(source, [ref]) {
        const p = parseWardley(source);
        const pl = p.pipelines.find((x) => x.name.value === ref.id);
        if (!pl || pl.lines.length < 2) return null;
        const name = uniqueName(p, NEW_COMPONENT);
        const last = Math.max(...pl.children.map((c) => ratio(c.e.value)), 0.4);
        const change = insertIntoBlock(pl.lines, `component ${formatName(name)} [${fmt(Math.min(0.95, last + 0.1))}]`);
        return { change, label: t('wm.history.addChild', { name, ref: ref.id }), select: { kind: 'component', id: name } };
      },
    },
    {
      id: 'connect',
      title: t('wm.action.connect'),
      arity: 2,
      appliesTo: ['anchor', 'component'],
      prompt: t('wm.prompt.connect'),
      run(source, [a, b]) {
        if (a.id === b.id) return null;
        const p = parseWardley(source);
        if (!findNode(p, a) || !findNode(p, b)) return null;
        const after = lastLinkLine(source, p);
        const change = insertLineAfter(source, after, `${indentFor(source, after)}${formatName(a.id)} -> ${formatName(b.id)}`);
        return { change, label: t('wm.history.connect', { a: a.id, b: b.id }) };
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['anchor', 'component', 'link', 'note', 'pipeline'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const p = parseWardley(source);
        if (ref.kind === 'link') {
          const l = p.links[Number(ref.id)];
          return l ? { change: removeLineSet(source, new Set([l.line.index])), label: t('wm.history.deleteLink', { a: l.a.value, b: l.b.value }) } : null;
        }
        if (ref.kind === 'note') {
          const n = p.notes[Number(ref.id)];
          return n ? { change: removeLineSet(source, new Set([n.line.index])), label: t('wm.history.deleteNote') } : null;
        }
        if (ref.kind === 'pipeline') {
          const change = deletePipeline(source, ref.id);
          return change && { change, label: t('wm.history.deletePipeline', { name: ref.id }) };
        }
        const change = deleteNode(source, ref.id);
        return change && { change, label: t('wm.history.deleteNode', { name: ref.id }) };
      },
    },
  ],
};
