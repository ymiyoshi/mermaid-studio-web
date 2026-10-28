import type { ChangeSpec } from '@codemirror/state';
import { withValue, type ActionResult, type DiagramPlugin, type DiagramTarget, type ElementRef, type PropertyField, type SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines, indentOf, insertLineAfter, splitLines, uniqueId, type SourceLine } from './source';
import { removeLine } from './lineOps';
import { addHitArea, matchInOrder } from './svg';
import { t } from '../i18n';

// eventmodeling 図のプラグイン。
// 1 行が 1 つの枠（tf 01 ui CartScreen ->> 00）。枠は左から書いた順に並び、->> の先の番号の枠から矢印が来る。
// SVG の枠（g.em-box）は枠の行の順に描かれるが、番号は描かれないので、順番で対応付けたうえで、
// 枠の中の太字（<b>名前</b>）が行の名前と合うかを確かめる（合わない枠は対応付けない）。
// 矢印（path.em-relation）は、始点と終点がどの枠の縁にあるかで対応付ける。
// 名前は英字か _ で始まる英数字（日本語は使えない）。名前空間.名前 と書くと、名前空間がレーンになる。

export type FrameType = 'ui' | 'cmd' | 'evt' | 'rmo' | 'pcr';

export interface Frame {
  line: SourceLine;
  /** 枠の番号（書いたとおりの文字列。01 など） */
  id: string;
  /** tf / timeframe / rf / resetframe */
  kw: { value: string; range: SourceRange };
  type: { value: string; canonical: FrameType; range: SourceRange };
  entity: { value: string; range: SourceRange };
  /** ->> の先の番号。clause は前の空白から番号の終わりまで */
  sources: { id: string; range: SourceRange; clause: SourceRange }[];
  /** ->> を足す位置（名前か最後の ->> の後ろ） */
  sourcesEnd: number;
}

const FRAME = /^\s*(?<kw>tf|timeframe|rf|resetframe)\s+(?<id>\d{1,3})\s+(?<type>ui|cmd|command|evt|event|rmo|readmodel|pcr|processor)\s+(?<entity>[_a-zA-Z][\w.]*)(?<src>(?:\s*->>\s*\d{1,3})*)/d;
const SOURCE = /\s*->>\s*(\d{1,3})/dg;

const CANONICAL: Record<string, FrameType> = {
  ui: 'ui',
  cmd: 'cmd',
  command: 'cmd',
  evt: 'evt',
  event: 'evt',
  rmo: 'rmo',
  readmodel: 'rmo',
  pcr: 'pcr',
  processor: 'pcr',
};
export const FRAME_TYPES: FrameType[] = ['ui', 'cmd', 'evt', 'rmo', 'pcr'];
/** 次の枠の種類（画面 → コマンド → イベント → 読み取りモデル → 画面） */
const NEXT_TYPE: Record<FrameType, FrameType> = { ui: 'cmd', cmd: 'evt', evt: 'rmo', rmo: 'ui', pcr: 'cmd' };
/** 新しい枠の名前（mermaid の名前は英数字だけなので、訳さない） */
const NAME_PREFIX: Record<FrameType, string> = { ui: 'Screen', cmd: 'Command', evt: 'Event', rmo: 'ReadModel', pcr: 'Processor' };

/** 名前に使える文字列（名前空間.名前。data はキーワードなので使えない） */
export const VALID_ENTITY = /^[_a-zA-Z]\w*(?:\.[_a-zA-Z]\w*)*$/;
const isValidEntity = (v: string) => VALID_ENTITY.test(v) && !v.split('.').includes('data');

/** 枠の行（data のブロック・note のブロック・コメントの中は読まない） */
export function parseFrames(source: string): Frame[] {
  const out: Frame[] = [];
  const header = bodyLines(source).header;
  if (!header) return out;
  let inComment = false;
  let depth = 0;
  for (const line of splitLines(source).slice(header.index + 1)) {
    const text = line.text;
    if (inComment) {
      if (text.includes('*/')) inComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(text)) {
      if (!text.includes('*/')) inComment = true;
      continue;
    }
    if (/^\s*(?:%%|\/\/)/.test(text)) continue;
    const braces = (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
    if (depth > 0) {
      depth = Math.max(0, depth + braces);
      continue;
    }
    const m = FRAME.exec(text);
    if (m?.groups && m.indices?.groups) {
      const g = m.indices.groups;
      const at = (r: [number, number]): SourceRange => ({ from: line.from + r[0], to: line.from + r[1] });
      const sources: Frame['sources'] = [];
      const src = m.groups.src!;
      SOURCE.lastIndex = 0;
      for (let s = SOURCE.exec(src); s; s = SOURCE.exec(src)) {
        const base = g.src![0];
        const idAt = s.indices![1]!;
        sources.push({ id: s[1], range: at([base + idAt[0], base + idAt[1]]), clause: at([base + s.index, base + s.index + s[0].length]) });
      }
      out.push({
        line,
        id: m.groups.id!,
        kw: { value: m.groups.kw!, range: at(g.kw!) },
        type: { value: m.groups.type!, canonical: CANONICAL[m.groups.type!], range: at(g.type!) },
        entity: { value: m.groups.entity!, range: at(g.entity!) },
        sources,
        sourcesEnd: line.from + g.src![1],
      });
      continue;
    }
    // data Name { … } などのブロックの中は、枠の行ではない
    depth = Math.max(0, braces);
  }
  return out;
}

/** ->> の番号が指す枠（同じ文字列の番号。無ければ数として同じ番号） */
export function resolveSource(frames: Frame[], id: string): number {
  const exact = frames.findIndex((f) => f.id === id);
  return exact >= 0 ? exact : frames.findIndex((f) => Number(f.id) === Number(id));
}

const refOf = (f: Frame): ElementRef => ({ kind: 'frame', id: `f${f.id}` });
const findFrame = (frames: Frame[], ref: ElementRef | null | undefined) => (ref?.kind === 'frame' ? frames.find((f) => `f${f.id}` === ref.id) : undefined);

/** まだ使われていない枠の番号（いちばん大きい番号の次。桁数は今の番号にそろえる） */
export function nextFrameId(frames: Frame[]): string | null {
  const width = Math.max(2, ...frames.map((f) => f.id.length));
  const used = new Set(frames.map((f) => Number(f.id)));
  const max = Math.max(0, ...used);
  const n = max < 999 ? max + 1 : [...Array(999).keys()].map((k) => k + 1).find((k) => !used.has(k));
  return n === undefined ? null : String(n).padStart(Math.min(3, width), '0');
}

/** 名前のうち、枠の中に太字で描かれる部分の範囲（名前空間.名前 なら 名前）。描かれた文字と合わなければ null */
function shownRange(f: Frame, shown: string): SourceRange | null {
  const e = f.entity;
  if (e.value === shown) return e.range;
  if (shown !== '' && e.value.endsWith(`.${shown}`)) return { from: e.range.to - shown.length, to: e.range.to };
  return null;
}

/** 枠の行を消す変更。ほかの枠の ->> でこの枠を指すものも外す */
export function deleteFrame(source: string, frames: Frame[], f: Frame): ChangeSpec[] {
  const changes: ChangeSpec[] = [removeLine(source, f.line)];
  const index = frames.indexOf(f);
  for (const other of frames) {
    if (other === f) continue;
    for (const s of other.sources) if (resolveSource(frames, s.id) === index) changes.push(s.clause);
  }
  return changes;
}

/** 2 つの枠の行を入れ替える（行の中身だけを置き換え、間の行には触れない） */
function swapLines(a: SourceLine, b: SourceLine): ChangeSpec[] {
  return [
    { from: a.from, to: a.to, insert: b.text },
    { from: b.from, to: b.to, insert: a.text },
  ];
}

/** 枠 ref を target の前（before）か後ろへ動かす */
function moveFrame(source: string, ref: ElementRef, target: ElementRef, before: boolean): ActionResult | null {
  const frames = parseFrames(source);
  const f = findFrame(frames, ref);
  const to = findFrame(frames, target);
  if (!f || !to || f === to) return null;
  const i = frames.indexOf(f);
  const j = frames.indexOf(to);
  // 動かしても並びが変わらないとき
  if ((before && j === i + 1) || (!before && j === i - 1)) return null;
  const insert = before ? { from: to.line.from, insert: `${f.line.text}\n` } : { from: to.line.to, insert: `\n${f.line.text}` };
  return { change: [removeLine(source, f.line), insert], label: t('em.history.move', { id: f.id }), select: ref };
}

/** 枠 ref を隣の枠と入れ替える */
function moveBy(source: string, ref: ElementRef, delta: number): ActionResult | null {
  const frames = parseFrames(source);
  const f = findFrame(frames, ref);
  if (!f) return null;
  const other = frames[frames.indexOf(f) + delta];
  if (!other) return null;
  return { change: swapLines(f.line, other.line), label: t('em.history.move', { id: f.id }), select: ref };
}

const TYPE_OPTIONS = FRAME_TYPES.map((v) => ({ value: v, label: t(`em.type.${v}` as 'em.type.ui') }));
const KIND_OPTIONS = [
  { value: 'tf', label: t('em.frame.tf') },
  { value: 'rf', label: t('em.frame.rf') },
];
const kindOf = (f: Frame) => (f.kw.value.startsWith('r') ? 'rf' : 'tf');

const parsePath = (el: Element): [[number, number], [number, number]] | null => {
  const nums = (el.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g)?.map(Number) ?? [];
  return nums.length >= 4 ? [[nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]]] : null;
};

/** 点が枠（rect）の縁か中にあるか */
function onRect(rect: Element | null | undefined, [x, y]: [number, number]): boolean {
  if (!rect) return false;
  const num = (k: string) => Number(rect.getAttribute(k) ?? 'NaN');
  const [rx, ry, w, h] = [num('x'), num('y'), num('width'), num('height')];
  return x >= rx - 3 && x <= rx + w + 3 && y >= ry - 3 && y <= ry + h + 3;
}

export const eventmodelingPlugin: DiagramPlugin = {
  type: 'eventmodeling',

  mapTargets(svg, source) {
    const frames = parseFrames(source);
    const mapped: DiagramTarget[] = [];
    const boxes = [...svg.querySelectorAll('g.em-box')];
    // 枠の数が合わなければ、順番での対応付けは信用できない
    const rects: (Element | null)[] = [];
    if (boxes.length === frames.length) {
      boxes.forEach((g, i) => {
        const f = frames[i];
        const b = g.querySelector('b');
        const shown = b ? labelText(b) : '';
        const range = shownRange(f, shown);
        if (!range) {
          rects.push(null);
          return;
        }
        rects.push(g.querySelector('rect'));
        mapped.push({ id: `em-frame-${i}`, el: g, labelEl: b ?? g, label: shown, range, ref: refOf(f) });
      });
    }
    // 矢印: ->> の先の枠から、その行の枠へ
    const relations = frames.flatMap((f, i) => f.sources.map((s, k) => ({ to: i, from: resolveSource(frames, s.id), k })));
    const paths = [...svg.querySelectorAll('path.em-relation')];
    const order = matchInOrder(paths, relations, (el, r) => {
      const ends = parsePath(el);
      return !!ends && r.from >= 0 && onRect(rects[r.from], ends[0]) && onRect(rects[r.to], ends[1]);
    });
    paths.forEach((el, n) => {
      const r = relations[order[n]];
      if (!r) return;
      mapped.push({ id: `em-relation-${n}`, el, hits: [addHitArea(el)], labelEl: el, label: '', range: null, ref: { kind: 'relation', id: `${r.to}:${r.k}` } });
    });
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    const frames = parseFrames(source);
    if (ref?.kind === 'relation') {
      const [i, k] = ref.id.split(':').map(Number);
      const f = frames[i];
      const s = f?.sources[k];
      return s ? [{ id: 'ends', label: t('em.field.ends'), type: 'text', value: `${s.id} → ${f.id}`, readonly: true }] : [];
    }
    const f = findFrame(frames, ref);
    if (!f) return [];
    return [
      { id: 'id', label: t('em.field.id'), type: 'text', value: f.id, readonly: true },
      { id: 'name', label: t('em.field.name'), type: 'text', value: f.entity.value },
      { id: 'type', label: t('em.field.type'), type: 'select', value: f.type.canonical, options: withValue(TYPE_OPTIONS, f.type.canonical) },
      { id: 'kind', label: t('em.field.frame'), type: 'select', value: kindOf(f), options: KIND_OPTIONS },
      { id: 'sources', label: t('em.field.sources'), type: 'text', value: f.sources.map((s) => s.id).join(' '), placeholder: '01 02' },
    ];
  },

  setProperty(source, ref, field, value) {
    const frames = parseFrames(source);
    const f = findFrame(frames, ref);
    if (!f) return null;
    const v = value.trim();
    if (field === 'name') return isValidEntity(v) && v !== f.entity.value ? { ...f.entity.range, insert: v } : null;
    if (field === 'type') return FRAME_TYPES.includes(v as FrameType) && v !== f.type.canonical ? { ...f.type.range, insert: v } : null;
    if (field === 'kind') return (v === 'tf' || v === 'rf') && v !== kindOf(f) ? { ...f.kw.range, insert: v } : null;
    if (field === 'sources') {
      const ids = v === '' ? [] : v.split(/[\s,]+/);
      if (!ids.every((id) => /^\d{1,3}$/.test(id))) return null;
      const from = f.sources[0]?.clause.from ?? f.sourcesEnd;
      return { from, to: f.sourcesEnd, insert: ids.map((id) => ` ->> ${id}`).join('') };
    }
    return null;
  },

  actions: [
    {
      id: 'add-frame',
      title: t('em.action.addFrame'),
      arity: 0,
      run(source) {
        const frames = parseFrames(source);
        const id = nextFrameId(frames);
        if (!id) return null;
        const last = frames.at(-1)?.line ?? null;
        const after = last ?? bodyLines(source).body.at(-1) ?? bodyLines(source).header;
        const indent = last ? indentOf(last.text) : '';
        const change = insertLineAfter(source, after, `${indent}tf ${id} ui ${uniqueId(source, NAME_PREFIX.ui)}`);
        return { change, label: t('em.history.addFrame', { id }), focus: { kind: 'frame', id: `f${id}` } };
      },
    },
    {
      id: 'add-next',
      title: t('em.action.addNext'),
      arity: 1,
      appliesTo: ['frame'],
      key: 'Tab',
      run(source, [ref]) {
        const frames = parseFrames(source);
        const f = findFrame(frames, ref);
        const id = nextFrameId(frames);
        if (!f || !id) return null;
        const type = NEXT_TYPE[f.type.canonical];
        const change = insertLineAfter(source, f.line, `${indentOf(f.line.text)}tf ${id} ${type} ${uniqueId(source, NAME_PREFIX[type])} ->> ${f.id}`);
        return { change, label: t('em.history.addNext', { id, ref: f.id }), focus: { kind: 'frame', id: `f${id}` } };
      },
    },
    {
      id: 'connect',
      title: t('em.action.connect'),
      arity: 2,
      appliesTo: ['frame'],
      prompt: t('em.prompt.connect'),
      run(source, [a, b]) {
        const frames = parseFrames(source);
        const from = findFrame(frames, a);
        const to = findFrame(frames, b);
        if (!from || !to || from === to) return null;
        // 矢印は ->> の先の枠から来るので、後に続く枠（b）の行に ->> a を足す
        if (to.sources.some((s) => resolveSource(frames, s.id) === frames.indexOf(from))) return null;
        return { change: { from: to.sourcesEnd, insert: ` ->> ${from.id}` }, label: t('em.history.connect', { a: from.id, b: to.id }) };
      },
    },
    {
      id: 'move-up',
      title: t('em.action.moveBack'),
      arity: 1,
      appliesTo: ['frame'],
      run: (source, [ref]) => moveBy(source, ref, -1),
    },
    {
      id: 'move-down',
      title: t('em.action.moveForward'),
      arity: 1,
      appliesTo: ['frame'],
      run: (source, [ref]) => moveBy(source, ref, 1),
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: ['frame', 'relation'],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const frames = parseFrames(source);
        if (ref.kind === 'relation') {
          const [i, k] = ref.id.split(':').map(Number);
          const f = frames[i];
          const s = f?.sources[k];
          return s ? { change: s.clause, label: t('em.history.deleteRelation', { a: s.id, b: f.id }) } : null;
        }
        const f = findFrame(frames, ref);
        return f ? { change: deleteFrame(source, frames, f), label: t('em.history.deleteFrame', { id: f.id }) } : null;
      },
    },
  ],

  reorder: {
    axis: (source, ref) => (findFrame(parseFrames(source), ref) ? 'x' : null),
    accepts: (ref, target) => ref.kind === 'frame' && target.kind === 'frame',
    move: moveFrame,
  },
};
