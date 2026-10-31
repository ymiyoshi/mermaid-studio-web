import type { ChangeSpec } from '@codemirror/state';
import { withValue, type DiagramPlugin, type DiagramTarget, type PropertyField, type SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, escapeRe, indentOf, insertLineAfter, isComment, lastParse, uniqueId, type SourceLine } from './source';
import { removeLineSet } from './lineOps';
import { addHitArea, matchInOrder } from './svg';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { t } from '../i18n';

// architecture 図（architecture-beta）のプラグイン。
// サービス・junction・グループの宣言と、辺どうしをつなぐ線（a:R -- L:b）を図から編集する。
// SVG のサービスは g#…-service-<ID>、junction は rect#…-node-<ID>、グループは rect#…-group-<ID> で、
// 線は path#…-L_<始点>_<終点>_<連番> の両端で対応付ける（ID に _ を含みうるので、分割せずに両端と照らし合わせる）。
// ID は英数字・_・- だけ（mermaid の字句の規則。日本語は使えない）。

export type ArchKind = 'service' | 'group' | 'junction';

interface Label {
  value: string;
  /** 中身の範囲（引用符があれば、その内側） */
  range: SourceRange;
  /** [ ] を含む範囲 */
  outer: SourceRange;
  /** 囲んでいる引用符（無ければ ''） */
  quote: string;
}

export interface ArchNode {
  kind: ArchKind;
  id: string;
  line: SourceLine;
  idRange: SourceRange;
  /** (server) のアイコン、または "文字" のアイコン（範囲は括弧・引用符を含む） */
  icon: { value: string; text: boolean; range: SourceRange } | null;
  label: Label | null;
  /** in <グループ>。clause は前の空白から ID の終わりまで */
  parent: { value: string; range: SourceRange; clause: SourceRange } | null;
  /** 宣言の終わり（in やアイコン・ラベルを足す位置） */
  end: number;
}

export interface ArchEdge {
  line: SourceLine;
  a: string;
  b: string;
  aRange: SourceRange;
  bRange: SourceRange;
  as: { value: string; range: SourceRange };
  bs: { value: string; range: SourceRange };
  /** 線（<-[ラベル]-> まで）の範囲 */
  arrow: SourceRange;
  left: boolean;
  right: boolean;
  label: Label | null;
}

interface Align {
  line: SourceLine;
  members: { id: string; range: SourceRange }[];
}

export interface ParsedArchitecture {
  nodes: ArchNode[];
  edges: ArchEdge[];
  aligns: Align[];
}

const LABEL = String.raw`\[(?<label>"[^"]*"|'[^']*'|[^\[\]]*)\]`;
const NODE = new RegExp(
  String.raw`^\s*(?<kw>service|group|junction)\s+(?<id>[\w-]+)\s*(?:\((?<icon>[\w:-]+)\)|(?<iconText>"[^"]*"))?\s*(?:${LABEL})?(?<in>\s+in\s+(?<parent>[\w-]+))?\s*(?:%%.*)?$`,
  'd',
);
const EDGE = new RegExp(
  String.raw`^\s*(?<a>[\w-]+)(?:\{group\})?\s*:\s*(?<as>[LRTB])\s*(?<arrow>(?<l><)?-(?:-|${LABEL}-)(?<r>>)?)\s*(?<bs>[LRTB])\s*:\s*(?<b>[\w-]+)(?:\{group\})?\s*(?:%%.*)?$`,
  'd',
);
const ALIGN = /^\s*align\s+(?:row|column)\b/;

export const VALID_ARCH_ID = /^[\w-]+$/;
export const ARCH_ICONS = ['cloud', 'database', 'disk', 'internet', 'server'];
export const SIDES = ['L', 'R', 'T', 'B'];

function readLabel(line: SourceLine, m: RegExpExecArray): Label | null {
  const r = m.indices!.groups!.label;
  if (!r) return null;
  const raw = m.groups!.label!;
  const quote = /^(["']).*\1$/s.test(raw) ? raw[0] : '';
  const q = quote ? 1 : 0;
  return {
    value: quote ? raw.slice(1, -1) : raw,
    range: { from: line.from + r[0] + q, to: line.from + r[1] - q },
    outer: { from: line.from + r[0] - 1, to: line.from + r[1] + 1 },
    quote,
  };
}

export function parseArchitecture(source: string): ParsedArchitecture {
  const out: ParsedArchitecture = { nodes: [], edges: [], aligns: [] };
  for (const line of bodyLines(source).body) {
    if (isComment(line.text)) continue;
    const at = (r: [number, number]) => ({ from: line.from + r[0], to: line.from + r[1] });
    const n = NODE.exec(line.text);
    if (n?.groups && n.indices?.groups) {
      const g = n.indices.groups;
      const iconR = g.icon ? [g.icon[0] - 1, g.icon[1] + 1] : g.iconText;
      const label = readLabel(line, n);
      const idRange = at(g.id!);
      const icon = iconR ? { value: n.groups.icon ?? n.groups.iconText!, text: !n.groups.icon, range: at(iconR as [number, number]) } : null;
      out.nodes.push({
        kind: n.groups.kw as ArchKind,
        id: n.groups.id!,
        line,
        idRange,
        icon,
        label,
        parent: g.parent ? { value: n.groups.parent!, range: at(g.parent), clause: at(g.in!) } : null,
        end: g.in ? line.from + g.in[1] : (label?.outer.to ?? icon?.range.to ?? idRange.to),
      });
      continue;
    }
    const e = EDGE.exec(line.text);
    if (e?.groups && e.indices?.groups) {
      const g = e.indices.groups;
      out.edges.push({
        line,
        a: e.groups.a!,
        b: e.groups.b!,
        aRange: at(g.a!),
        bRange: at(g.b!),
        as: { value: e.groups.as!, range: at(g.as!) },
        bs: { value: e.groups.bs!, range: at(g.bs!) },
        arrow: at(g.arrow!),
        left: !!e.groups.l,
        right: !!e.groups.r,
        label: readLabel(line, e),
      });
      continue;
    }
    const a = ALIGN.exec(line.text);
    if (a) {
      const members: Align['members'] = [];
      // 行末のコメント（%% …）の語はメンバーにしない
      const comment = line.text.indexOf('%%', a[0].length);
      const text = comment < 0 ? line.text : line.text.slice(0, comment);
      const re = /[\w-]+/g;
      re.lastIndex = a[0].length;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        members.push({ id: m[0], range: { from: line.from + m.index, to: line.from + m.index + m[0].length } });
      }
      out.aligns.push({ line, members });
    }
  }
  return out;
}

/** グループ id と、その中に入れ子になったグループの ID */
function groupTree(p: ParsedArchitecture, id: string): Set<string> {
  const inside = new Set([id]);
  for (let grown = true; grown; ) {
    grown = false;
    for (const n of p.nodes) {
      if (n.kind === 'group' && n.parent && inside.has(n.parent.value) && !inside.has(n.id)) {
        inside.add(n.id);
        grown = true;
      }
    }
  }
  return inside;
}

/** ids の要素（サービス・junction・グループ）を消す変更。つながる線の行も消し、align からも外す */
function removeIds(source: string, p: ParsedArchitecture, ids: Set<string>): ChangeSpec[] {
  const lines = new Set<number>();
  for (const n of p.nodes) if (ids.has(n.id)) lines.add(n.line.index);
  for (const e of p.edges) if (ids.has(e.a) || ids.has(e.b)) lines.add(e.line.index);
  const partial: ChangeSpec[] = [];
  for (const a of p.aligns) {
    const left = a.members.filter((m) => !ids.has(m.id));
    if (left.length === a.members.length) continue;
    // 2 つ未満になった align は書けないので行ごと消す。残るなら、外す ID を前の空白ごと消す
    if (left.length < 2) lines.add(a.line.index);
    else for (const m of a.members) if (ids.has(m.id)) partial.push({ from: m.range.from - /\s*$/.exec(source.slice(a.line.from, m.range.from))![0].length, to: m.range.to });
  }
  return [...removeLineSet(source, lines), ...partial];
}

/** ID が使われているすべての範囲（宣言・in・線の両端・align） */
function idRanges(p: ParsedArchitecture, id: string): SourceRange[] {
  const out: SourceRange[] = [];
  for (const n of p.nodes) {
    if (n.id === id) out.push(n.idRange);
    if (n.parent?.value === id) out.push(n.parent.range);
  }
  for (const e of p.edges) {
    if (e.a === id) out.push(e.aRange);
    if (e.b === id) out.push(e.bRange);
  }
  for (const a of p.aligns) for (const m of a.members) if (m.id === id) out.push(m.range);
  return out;
}

function rename(source: string, from: string, to: string): ChangeSpec[] | null {
  const p = parseArchitecture(source);
  if (to === from || !VALID_ARCH_ID.test(to) || p.nodes.some((n) => n.id === to)) return null;
  return idRanges(p, from).map((r) => ({ ...r, insert: to }));
}

/** グループの枠を外す（宣言の行を消し、中の要素は外側のグループへ移す） */
export function unwrapGroup(source: string, id: string): ChangeSpec[] | null {
  const p = parseArchitecture(source);
  const group = p.nodes.find((n) => n.kind === 'group' && n.id === id);
  if (!group) return null;
  const changes: ChangeSpec[] = removeLineSet(source, new Set([group.line.index]));
  for (const n of p.nodes) {
    if (n.parent?.value !== id) continue;
    changes.push(group.parent ? { ...n.parent.range, insert: group.parent.value } : n.parent.clause);
  }
  return changes;
}

/** グループを中身ごと消す（入れ子のグループと、中のサービス・junction・それにつながる線） */
export function deleteGroup(source: string, id: string): ChangeSpec[] | null {
  const p = parseArchitecture(source);
  if (!p.nodes.some((n) => n.kind === 'group' && n.id === id)) return null;
  const groups = groupTree(p, id);
  const ids = new Set(p.nodes.filter((n) => groups.has(n.id) || (n.parent && groups.has(n.parent.value))).map((n) => n.id));
  return removeIds(source, p, ids);
}

export function deleteNode(source: string, id: string): ChangeSpec[] | null {
  const p = parseArchitecture(source);
  return p.nodes.some((n) => n.id === id) ? removeIds(source, p, new Set([id])) : null;
}

/** ラベルに書けない文字（[ ] と改行）を置き換える */
const cleanLabel = (v: string) => v.replace(/\[/g, '(').replace(/\]/g, ')').replace(/[\r\n]+/g, ' ');

/** ラベル（[ ] の中）を変える。空にしたら [ ] ごと外す。無ければ at に足す */
function setLabel(source: string, label: Label | null, at: number, value: string): ChangeSpec | null {
  const v = cleanLabel(value);
  if (!label) return v.trim() === '' ? null : { from: at, insert: `[${v}]` };
  if (v.trim() === '') {
    // 前の空白も一緒に消す（service a(server) [A] in g → service a(server) in g）
    const before = /[ \t]*$/.exec(source.slice(0, label.outer.from))![0].length;
    return { from: label.outer.from - before, to: label.outer.to };
  }
  return { ...label.range, insert: label.quote ? v.replaceAll(label.quote, '') : v };
}

/** 宣言の後ろ（最後の宣言の行）。無ければ図種の宣言行 */
function lastDeclLine(source: string, p: ParsedArchitecture): SourceLine | null {
  return p.nodes.at(-1)?.line ?? bodyLines(source).header;
}

/** 線を足す位置（最後の線の後ろ。無ければ最後の行の後ろ） */
function lastEdgeLine(source: string, p: ParsedArchitecture): SourceLine | null {
  const { header, body } = bodyLines(source);
  return p.edges.at(-1)?.line ?? body.at(-1) ?? header;
}

const indentFor = (source: string, line: SourceLine | null) => {
  const { header, body } = bodyLines(source);
  return line && line.index !== header?.index ? indentOf(line.text) : body[0] ? indentOf(body[0].text) || '    ' : '    ';
};

const NEW_SERVICE = t('arch.newService');
const NEW_GROUP = t('arch.newGroup');
const TITLE: KeywordSpec = { id: 'title', label: t('arch.field.title'), keyword: 'title' };

const ICON_OPTIONS = [{ value: '', label: t('plg.none') }, ...ARCH_ICONS.map((v) => ({ value: v, label: t(`arch.icon.${v}` as 'arch.icon.cloud') }))];
const SIDE_OPTIONS = SIDES.map((v) => ({ value: v, label: t(`arch.side.${v}` as 'arch.side.L') }));
const ARROW_OPTIONS = [
  { value: 'none', label: t('arch.arrow.none') },
  { value: 'forward', label: t('arch.arrow.forward') },
  { value: 'back', label: t('arch.arrow.back') },
  { value: 'both', label: t('arch.arrow.both') },
];
const arrowValue = (e: ArchEdge) => (e.left ? (e.right ? 'both' : 'back') : e.right ? 'forward' : 'none');

// ---- 配置（線を足すとき、重ならない辺を選ぶため）--------------------------------
// mermaid は線の「元の辺＋先の辺」の組（RL・TB・RT など）で、相手を隣の升目に置く（getDataStructures の BFS）。
// 同じ升目に 2 つ置かれると重なるので、線を足すときは同じ計算をして、空いている升目に向かう辺を選ぶ。

type Cell = [number, number];
const OPPOSITE: Record<string, string> = { L: 'R', R: 'L', T: 'B', B: 'T' };
const isX = (d: string) => d === 'L' || d === 'R';

/** 辺の組 pair で、pos の隣に置かれる升目（mermaid の shiftPositionByArchitectureDirectionPair と同じ。y は上が正） */
function shift([x, y]: Cell, pair: string): Cell {
  const [l, r] = pair;
  if (isX(l)) return isX(r) ? [x + (l === 'L' ? -1 : 1), y] : [x + (l === 'L' ? -1 : 1), y + (r === 'T' ? 1 : -1)];
  return isX(r) ? [x + (r === 'L' ? 1 : -1), y + (l === 'T' ? 1 : -1)] : [x, y + (l === 'T' ? 1 : -1)];
}

/** 要素ごとの、つながった線での隣（辺の組 → 相手。同じ組は後の線で上書きされる）と、升目の位置 */
export function archLayout(p: ParsedArchitecture) {
  // mermaid はサービスを先に、junction を後に登録する
  const ids = [...p.nodes.filter((n) => n.kind === 'service'), ...p.nodes.filter((n) => n.kind === 'junction')].map((n) => n.id);
  const adj = new Map<string, Map<string, string>>(ids.map((id) => [id, new Map()]));
  for (const e of p.edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.as.value + e.bs.value === e.as.value.repeat(2)) continue;
    adj.get(e.a)!.set(e.as.value + e.bs.value, e.b);
    adj.get(e.b)!.set(e.bs.value + e.as.value, e.a);
  }
  const pos = new Map<string, Cell>();
  /** 要素の属するつながり（同じ番号どうしだけが同じ升目の座標を共有する） */
  const comp = new Map<string, number>();
  for (const start of ids) {
    if (pos.has(start)) continue;
    const c = comp.size === 0 ? 0 : Math.max(...comp.values()) + 1;
    pos.set(start, [0, 0]);
    comp.set(start, c);
    const queue = [start];
    const visited = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      visited.add(id);
      adj.get(id)!.forEach((other, pair) => {
        if (visited.has(other)) return;
        pos.set(other, shift(pos.get(id)!, pair));
        comp.set(other, c);
        queue.push(other);
      });
    }
  }
  return { adj, pos, comp };
}

/** from から新しい要素へ線を引くとき、重ならない升目に向かう from の辺（無ければ R） */
function freeSide(p: ParsedArchitecture, from: string): string {
  const { adj, pos, comp } = archLayout(p);
  const at = pos.get(from);
  if (!at) return 'R';
  const taken = new Set([...pos].filter(([id]) => comp.get(id) === comp.get(from)).map(([, c]) => c.join(',')));
  const side = ['R', 'B', 'T', 'L'].find((d) => {
    const pair = d + OPPOSITE[d];
    return !adj.get(from)?.has(pair) && !taken.has(shift(at, pair).join(','));
  });
  return side ?? 'R';
}

/** a と b をつなぐ辺。同じつながりにあれば、今の位置の向きに合わせる（合わない向きにすると配置が崩れる） */
function connectSides(p: ParsedArchitecture, a: string, b: string): [string, string] {
  const { pos, comp } = archLayout(p);
  const pa = pos.get(a);
  const pb = pos.get(b);
  if (pa && pb && comp.get(a) === comp.get(b)) {
    const [dx, dy] = [pb[0] - pa[0], pb[1] - pa[1]];
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'R' : 'L') : dy > 0 ? 'T' : 'B';
    return [side, OPPOSITE[side]];
  }
  const side = freeSide(p, a);
  return [side, OPPOSITE[side]];
}

const svgId = (el: Element) => el.id.replace(/^mmd-render-\d+-/, '');

/** 新しいサービスの宣言（parent があればそのグループの中） */
const serviceLine = (id: string, parent: string | null | undefined) => `service ${id}(server)[${NEW_SERVICE}]${parent ? ` in ${parent}` : ''}`;

const parseArchitectureOnce = lastParse(parseArchitecture);

export const architecturePlugin: DiagramPlugin = {
  type: 'architecture',

  mapTargets(svg, source) {
    const p = parseArchitecture(source);
    const node = (kind: ArchKind, id: string) => p.nodes.find((n) => n.kind === kind && n.id === id);
    const mapped: DiagramTarget[] = [];
    svg.querySelectorAll('g.architecture-service').forEach((g, i) => {
      const n = node('service', svgId(g).replace(/^service-/, ''));
      if (!n) return;
      const text = g.querySelector('text');
      mapped.push({
        id: `arch-service-${i}`,
        el: g,
        labelEl: text ?? g,
        label: text ? labelText(text) : '',
        range: n.label?.range ?? null,
        // ラベルの無いサービス（service a(server)）は、[…] として差し込む
        insertAt: n.label ? undefined : { at: n.icon?.range.to ?? n.idRange.to, prefix: '[', suffix: ']' },
        ref: { kind: 'service', id: n.id },
      });
    });
    svg.querySelectorAll('g.architecture-junction').forEach((g, i) => {
      const rect = g.querySelector('rect[id]');
      const n = rect && node('junction', svgId(rect).replace(/^node-/, ''));
      if (!n) return;
      mapped.push({ id: `arch-junction-${i}`, el: g, labelEl: g, label: '', range: null, ref: { kind: 'junction', id: n.id } });
    });
    // グループ: 枠の rect の次の g に、アイコンと題名がある
    svg.querySelectorAll('g.architecture-groups > rect[id]').forEach((rect, i) => {
      const n = node('group', svgId(rect).replace(/^group-/, ''));
      if (!n) return;
      const head = rect.nextElementSibling?.tagName.toLowerCase() === 'g' ? rect.nextElementSibling : null;
      const text = head?.querySelector('text') ?? null;
      mapped.push({
        id: `arch-group-${i}`,
        el: rect,
        hits: head ? [head] : [],
        labelEl: text ?? rect,
        label: text ? labelText(text) : '',
        range: n.label?.range ?? null,
        insertAt: n.label ? undefined : { at: n.icon?.range.to ?? n.idRange.to, prefix: '[', suffix: ']' },
        ref: { kind: 'group', id: n.id },
      });
    });
    const paths = [...svg.querySelectorAll('g.architecture-edges path.edge[id]')];
    const order = matchInOrder(paths, p.edges, (el, e) => new RegExp(`^L_${escapeRe(e.a)}_${escapeRe(e.b)}_\\d+$`).test(svgId(el)));
    paths.forEach((path, k) => {
      const i = order[k];
      if (i < 0) return;
      const e = p.edges[i];
      // 線のラベルは、線と同じ g の中の g に描かれる
      const labelG = [...(path.parentElement?.children ?? [])].find((c) => c.tagName.toLowerCase() === 'g') ?? null;
      const text = labelG?.querySelector('text') ?? null;
      mapped.push({
        id: `arch-edge-${k}`,
        el: path,
        hits: [addHitArea(path), ...(labelG ? [labelG] : [])],
        labelEl: text ?? path,
        label: text ? labelText(text) : '',
        range: e.label?.range ?? null,
        // ラベルの無い線（--）は、-[…]- として差し込む
        insertAt: e.label ? undefined : { at: e.arrow.from + (e.left ? 1 : 0) + 1, prefix: '[', suffix: ']' },
        ref: { kind: 'edge', id: String(i) },
      });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    if (!ref) return keywordFields(source, [TITLE]);
    const p = parseArchitecture(source);
    if (ref.kind === 'edge') {
      const e = p.edges[Number(ref.id)];
      if (!e) return [];
      return [
        { id: 'ends', label: t('arch.field.ends'), type: 'text', value: `${e.a} — ${e.b}`, readonly: true },
        { id: 'as', label: t('arch.field.side', { id: e.a }), type: 'select', value: e.as.value, options: SIDE_OPTIONS },
        { id: 'bs', label: t('arch.field.side', { id: e.b }), type: 'select', value: e.bs.value, options: SIDE_OPTIONS },
        { id: 'arrow', label: t('arch.field.arrow'), type: 'select', value: arrowValue(e), options: ARROW_OPTIONS },
        { id: 'label', label: t('plg.label'), type: 'text', value: e.label?.value ?? '' },
      ];
    }
    const n = p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id);
    if (!n) return [];
    // 入れられるグループ（グループなら、自分と自分の中のグループは除く）
    const own = n.kind === 'group' ? groupTree(p, n.id) : new Set<string>();
    const groups = [{ value: '', label: t('plg.none') }, ...p.nodes.filter((g) => g.kind === 'group' && !own.has(g.id)).map((g) => ({ value: g.id, label: g.label ? t('arch.groupOption', { id: g.id, label: g.label.value }) : g.id }))];
    const fields: PropertyField[] = [{ id: 'id', label: 'ID', type: 'text', value: n.id, commitOnBlur: true }];
    if (n.kind !== 'junction') {
      fields.push({ id: 'label', label: t('plg.label'), type: 'text', value: n.label?.value ?? '' });
      // 文字のアイコン（"…"）や、同梱していないアイコン（logos:aws など）も、そのまま選択肢に出す
      const icon = n.icon ? n.icon.value : '';
      fields.push({ id: 'icon', label: t('arch.field.icon'), type: 'select', value: icon, options: withValue(ICON_OPTIONS, icon) });
    }
    const parent = n.parent?.value ?? '';
    fields.push({ id: 'parent', label: n.kind === 'group' ? t('arch.field.parentGroup') : t('arch.field.group'), type: 'select', value: parent, options: withValue(groups, parent) });
    return fields;
  },

  setProperty(source, ref, field, value) {
    if (!ref) return field === 'title' ? setKeyword(source, TITLE, value.trim()) : null;
    const p = parseArchitecture(source);
    if (ref.kind === 'edge') {
      const e = p.edges[Number(ref.id)];
      if (!e) return null;
      if ((field === 'as' || field === 'bs') && SIDES.includes(value)) return { ...e[field].range, insert: value };
      if (field === 'label') return setLabel(source, e.label, e.arrow.from + (e.left ? 1 : 0) + 1, value);
      if (field === 'arrow') {
        const left = value === 'back' || value === 'both';
        const right = value === 'forward' || value === 'both';
        const changes: ChangeSpec[] = [];
        if (left !== e.left) changes.push(left ? { from: e.arrow.from, insert: '<' } : { from: e.arrow.from, to: e.arrow.from + 1 });
        if (right !== e.right) changes.push(right ? { from: e.arrow.to, insert: '>' } : { from: e.arrow.to - 1, to: e.arrow.to });
        return changes.length ? changes : null;
      }
      return null;
    }
    const n = p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id);
    if (!n) return null;
    const v = value.trim();
    if (field === 'id') return rename(source, n.id, v);
    if (field === 'label' && n.kind !== 'junction') return setLabel(source, n.label, n.icon?.range.to ?? n.idRange.to, value);
    if (field === 'icon' && n.kind !== 'junction') {
      if (v !== '' && !/^[\w:-]+$/.test(v)) return null;
      if (!n.icon) return v === '' ? null : { from: n.idRange.to, insert: `(${v})` };
      return { ...n.icon.range, insert: v === '' ? '' : `(${v})` };
    }
    if (field === 'parent') {
      if (v !== '' && (!p.nodes.some((g) => g.kind === 'group' && g.id === v) || (n.kind === 'group' && groupTree(p, n.id).has(v)))) return null;
      if (n.parent) return v === '' ? n.parent.clause : { ...n.parent.range, insert: v };
      return v === '' ? null : { from: n.end, insert: ` in ${v}` };
    }
    return null;
  },

  actions: [
    {
      id: 'add-service',
      title: t('arch.action.addService'),
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'svc');
        const after = lastDeclLine(source, parseArchitecture(source));
        const change = insertLineAfter(source, after, indentFor(source, after) + serviceLine(id, null));
        return { change, label: t('arch.history.addService', { id }), focus: { kind: 'service', id } };
      },
    },
    {
      id: 'add-group',
      title: t('arch.action.addGroup'),
      arity: 0,
      run(source) {
        const id = uniqueId(source, 'grp');
        const after = lastDeclLine(source, parseArchitecture(source));
        const change = insertLineAfter(source, after, `${indentFor(source, after)}group ${id}(cloud)[${NEW_GROUP}]`);
        return { change, label: t('arch.history.addGroup', { id }), focus: { kind: 'group', id } };
      },
    },
    {
      id: 'add-next',
      title: t('arch.action.addNext'),
      arity: 1,
      appliesTo: ['service', 'junction'],
      key: 'Tab',
      run(source, [ref]) {
        const p = parseArchitecture(source);
        const n = p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id);
        if (!n) return null;
        const id = uniqueId(source, 'svc');
        const indent = indentOf(n.line.text);
        const decl = indent + serviceLine(id, n.parent?.value);
        const side = freeSide(p, n.id);
        const edge = `${n.id}:${side} -- ${OPPOSITE[side]}:${id}`;
        // 同じグループに入れ、元の宣言の次の行に足す。線は最後の線の後ろ（宣言より前にしかなければ、宣言と一緒に足す）
        const edgeAfter = lastEdgeLine(source, p);
        const change =
          edgeAfter && edgeAfter.index > n.line.index
            ? [insertLineAfter(source, n.line, decl), insertLineAfter(source, edgeAfter, indentOf(edgeAfter.text) + edge)]
            : insertLineAfter(source, n.line, `${decl}\n${indent}${edge}`);
        return { change, label: t('arch.history.addNext', { id, ref: n.id }), focus: { kind: 'service', id } };
      },
    },
    {
      id: 'add-inside',
      title: t('arch.action.addInside'),
      arity: 1,
      appliesTo: ['group'],
      key: 'Tab',
      run(source, [ref]) {
        const p = parseArchitecture(source);
        const group = p.nodes.find((x) => x.kind === 'group' && x.id === ref.id);
        if (!group) return null;
        // グループの中の最後の要素の後ろ（無ければグループの宣言の後ろ）に足す
        const after = p.nodes.filter((x) => x.parent?.value === ref.id).at(-1)?.line ?? group.line;
        const id = uniqueId(source, 'svc');
        const change = insertLineAfter(source, after, indentOf(after.text) + serviceLine(id, ref.id));
        return { change, label: t('arch.history.addInside', { id, ref: ref.id }), focus: { kind: 'service', id } };
      },
    },
    {
      id: 'connect',
      title: t('arch.action.connect'),
      arity: 2,
      appliesTo: ['service', 'junction'],
      prompt: t('arch.prompt.connect'),
      run(source, [a, b]) {
        if (a.id === b.id) return null;
        const p = parseArchitecture(source);
        const [as, bs] = connectSides(p, a.id, b.id);
        const after = lastEdgeLine(source, p);
        const change = insertLineAfter(source, after, `${indentFor(source, after)}${a.id}:${as} -- ${bs}:${b.id}`);
        return { change, label: t('arch.history.connect', { a: a.id, b: b.id }) };
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['service', 'junction', 'edge'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        if (ref.kind === 'edge') {
          const e = parseArchitecture(source).edges[Number(ref.id)];
          return e ? { change: removeLineSet(source, new Set([e.line.index])), label: t('arch.history.deleteEdge', { a: e.a, b: e.b }) } : null;
        }
        const change = deleteNode(source, ref.id);
        return change && { change, label: t(ref.kind === 'junction' ? 'arch.history.deleteJunction' : 'arch.history.deleteService', { id: ref.id }) };
      },
    },
    {
      id: 'unwrap',
      title: t('arch.action.unwrap'),
      arity: 1,
      appliesTo: ['group'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const change = unwrapGroup(source, ref.id);
        return change && { change, label: t('arch.history.unwrap', { id: ref.id }) };
      },
    },
    {
      id: 'delete-group',
      title: t('arch.action.deleteGroup'),
      arity: 1,
      appliesTo: ['group'],
      danger: true,
      menuOnly: true,
      run(source, [ref]) {
        const change = deleteGroup(source, ref.id);
        return change && { change, label: t('arch.history.deleteGroup', { id: ref.id }) };
      },
    },
  ],

  // ドラッグ: サービス・junction・グループを、別のグループの中へ、または外へ移す（in の書き換え。位置は自動レイアウトのまま）
  reorder: {
    axis: (source, ref) => (parseArchitecture(source).nodes.some((n) => n.kind === ref.kind && n.id === ref.id) ? 'xy' : null),
    acceptsInto(source, ref, container) {
      const p = parseArchitectureOnce(source);
      // 図の一番外へは、グループの中にある要素だけ（外にある要素は、外へ動かしても変わらない）
      if (container === null) return !!p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id)?.parent?.value;
      // グループを自分の中のグループへは入れない
      return container.kind === 'group' && (ref.kind !== 'group' || !groupTree(p, ref.id).has(container.id));
    },
    into(source, ref, container) {
      const p = parseArchitecture(source);
      const n = p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id);
      const to = container?.id ?? '';
      if (!n || (n.parent?.value ?? '') === to) return null;
      // 相手の端に {group} を付けた線（グループの枠へつなぐ線）は、両端が同じグループにあると書けない
      const other = (e: (typeof p.edges)[number]) => (e.a === n.id ? e.b : e.a);
      const parentOf = (id: string) => p.nodes.find((x) => x.id === id)?.parent?.value ?? '';
      if (to && p.edges.some((e) => (e.a === n.id || e.b === n.id) && e.line.text.includes('{group}') && parentOf(other(e)) === to)) return null;
      const change = architecturePlugin.setProperty!(source, ref, 'parent', to);
      const label = to ? t('arch.history.moveInto', { id: ref.id, group: to }) : t('arch.history.moveOut', { id: ref.id });
      return change && { change, label, select: ref };
    },
  },

  // 構造（設計書 §17.2）: 親は in のグループ、線は両端の要素
  structure: {
    parent(source, ref) {
      const p = parseArchitectureOnce(source);
      const g = p.nodes.find((x) => x.kind === ref.kind && x.id === ref.id)?.parent?.value;
      return g ? { kind: 'group', id: g } : null;
    },
    children(source, ref) {
      if (ref.kind !== 'group') return [];
      return parseArchitectureOnce(source)
        .nodes.filter((x) => x.parent?.value === ref.id)
        .map((x) => ({ kind: x.kind, id: x.id }));
    },
    links(source) {
      const p = parseArchitectureOnce(source);
      const end = (id: string) => ({ kind: p.nodes.find((x) => x.id === id)?.kind ?? 'service', id });
      return p.edges.map((e, i) => ({ edge: { kind: 'edge', id: String(i) }, from: end(e.a), to: end(e.b) }));
    },
  },
};
