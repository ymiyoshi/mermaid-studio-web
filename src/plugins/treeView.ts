import type { ChangeSpec } from '@codemirror/state';
import type { DiagramPlugin, DiagramTarget, PropertyField, SourceRange } from './types';
import { labelText, withGeneric } from './generic';
import { bodyLines } from './source';
import { addChild, addSibling, deleteSubtree, movedIndex, moveSibling, type OutlineNode } from './outline';
import { keywordFields, setKeyword, type KeywordSpec } from './keywordLine';
import { t } from '../i18n';

// treeView（ファイルの木）のプラグイン（設計書 §7.3）。
// 1 行が 1 つの項目で、インデントで親子を表す（親は「前にある、インデントが浅い最も近い行」）。名前が / で終われば フォルダ。
// 名前の後ろに :::クラス・icon(名前)・## 説明 を付けられる。
// 図の項目（.tree-view の g）は、仮の根（/）の後ろにソースの行と同じ順番に並ぶので、名前が一致することを確かめて対応付ける。
// 罫線（├── など）で書いた木は、名前と注記の変更だけにする（足す・消す・動かすと罫線が合わなくなるため）。

const NEW_FILE = t('tv.newFile');
const BOX = /^[\s│├└─┣┗━┃]*/;
/** 項目より前にだけ書ける行 */
const META = /^(title|accTitle|accDescr)\b/;

export interface TreeEntry extends OutlineNode {
  /** 名前（引用符と末尾の / を除く） */
  name: SourceRange;
  /** 引用符を含む名前全体（末尾の / を含む） */
  token: SourceRange;
  quoted: boolean;
  /** フォルダなら / の位置 */
  slash: number | null;
  cls: Annotation | null;
  icon: Annotation | null;
  desc: Annotation | null;
  /** 注記を足す位置（行の中身の終わり） */
  end: number;
}

interface Annotation {
  /** 前の空白を含む、注記全体 */
  whole: SourceRange;
  value: SourceRange;
}

/** 行の中身を読む（line.from からの位置で返す） */
function readEntry(text: string, start: number) {
  let i = start;
  let quoted = false;
  let nameFrom: number;
  let nameTo: number;
  let tokenTo: number;
  const q = text[i];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, i + 1);
    if (close < 0) return null;
    quoted = true;
    nameFrom = i + 1;
    nameTo = close;
    tokenTo = close + 1;
  } else {
    // 名前は、空白の後ろの :::・icon(・##・%% の前まで
    const stop = /\s+(?::::|icon\(|##|%%)/.exec(text.slice(i));
    nameFrom = i;
    tokenTo = nameTo = i + (stop ? stop.index : text.slice(i).trimEnd().length);
  }
  let slash: number | null = null;
  if (text[nameTo - 1] === '/' && nameTo > nameFrom) {
    slash = nameTo - 1;
    nameTo--;
  } else if (quoted && text[tokenTo] === '/') {
    slash = tokenTo;
    tokenTo++;
  }
  i = tokenTo;
  let cls: Annotation | null = null;
  let icon: Annotation | null = null;
  let desc: Annotation | null = null;
  let end = tokenTo;
  for (;;) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^(\s+):::([^\s]+)/.exec(rest))) {
      cls = { whole: { from: i, to: i + m[0].length }, value: { from: i + m[1].length + 3, to: i + m[0].length } };
    } else if ((m = /^(\s+)icon\(([^)]*)\)/.exec(rest))) {
      icon = { whole: { from: i, to: i + m[0].length }, value: { from: i + m[1].length + 5, to: i + m[0].length - 1 } };
    } else if ((m = /^(\s+)##(\s*)(.*?)\s*$/.exec(rest))) {
      const vFrom = i + m[1].length + 2 + m[2].length;
      desc = { whole: { from: i, to: i + m[0].trimEnd().length }, value: { from: vFrom, to: vFrom + m[3].length } };
      end = desc.whole.to;
      break;
    } else break;
    i += m[0].length;
    end = i;
  }
  return { nameFrom, nameTo, tokenTo, quoted, slash, cls, icon, desc, end };
}

export function parseTreeView(source: string): { entries: TreeEntry[]; boxed: boolean } {
  const { body } = bodyLines(source);
  const entries: TreeEntry[] = [];
  const stack: TreeEntry[] = [];
  const top: TreeEntry[] = [];
  let boxed = false;
  let inDescr = false;
  for (const line of body) {
    const trimmed = line.text.trim();
    if (entries.length === 0) {
      // 項目より前の title・accTitle・accDescr（accDescr { … } は複数行）
      if (inDescr) {
        if (trimmed.includes('}')) inDescr = false;
        continue;
      }
      if (META.test(trimmed)) {
        if (/^accDescr\s*\{/.test(trimmed) && !trimmed.includes('}')) inDescr = true;
        continue;
      }
    }
    const lead = BOX.exec(line.text)![0];
    if (/[│├└─┣┗━┃]/.test(lead)) boxed = true;
    if (/^[\s│┃]*$/.test(line.text)) continue; // 罫線だけの行
    const r = readEntry(line.text, lead.length);
    if (!r) continue;
    const width = lead.length;
    while (stack.length && stack[stack.length - 1].width >= width) stack.pop();
    const parent = stack[stack.length - 1] ?? null;
    const at = (p: number) => line.from + p;
    const ann = (a: Annotation | null) => a && { whole: { from: at(a.whole.from), to: at(a.whole.to) }, value: { from: at(a.value.from), to: at(a.value.to) } };
    const entry: TreeEntry = {
      index: entries.length,
      line,
      width,
      depth: stack.length,
      parent,
      children: [],
      siblings: [],
      attached: [],
      name: { from: at(r.nameFrom), to: at(r.nameTo) },
      token: { from: at(r.quoted ? r.nameFrom - 1 : r.nameFrom), to: at(r.tokenTo) },
      quoted: r.quoted,
      slash: r.slash === null ? null : at(r.slash),
      cls: ann(r.cls),
      icon: ann(r.icon),
      desc: ann(r.desc),
      end: at(r.end),
    };
    entry.siblings = parent ? parent.children : top;
    entry.siblings.push(entry);
    entries.push(entry);
    stack.push(entry);
  }
  return { entries, boxed };
}

/** 名前の書き方。区切りになる文字列を含む・引用符で始まる名前は引用符で囲む。両方の引用符を含む名前は書けない */
function nameToken(name: string, dir: boolean): string | null {
  if (!name || /[\r\n]/.test(name)) return null;
  const plain = !/^["'\s]|\s$|\s(?::::|icon\(|##|%%)|%%/.test(name) && !name.endsWith('/');
  const slash = dir ? '/' : '';
  if (plain) return name + slash;
  if (!name.includes('"')) return `"${name}"${slash}`;
  if (!name.includes("'")) return `'${name}'${slash}`;
  return null;
}

function setAnnotation(e: TreeEntry, a: Annotation | null, value: string, make: (v: string) => string): ChangeSpec | null {
  const v = value.trim();
  if (a) return v ? { from: a.value.from, to: a.value.to, insert: v } : { from: a.whole.from, to: a.whole.to, insert: '' };
  if (!v) return null;
  // 説明は行の最後に書く（## から行末までが説明）ので、他の注記は説明の前に足す
  const at = e.desc ? e.desc.whole.from : e.end;
  return { from: at, insert: ' ' + make(v) };
}

const TITLE: KeywordSpec = { id: 'title', label: t('data.title'), keyword: 'title' };
const KIND = 'entry';

const entryOf = (source: string, id: string) => parseTreeView(source).entries[Number(id)];

export const treeViewPlugin: DiagramPlugin = {
  type: 'treeView',

  mapTargets(svg, source) {
    const { entries } = parseTreeView(source);
    const tree = svg.querySelector('g.tree-view');
    // 最初の g は仮の根（/）
    const groups = tree ? [...tree.children].filter((c) => c.tagName.toLowerCase() === 'g').slice(1) : [];
    const mapped: DiagramTarget[] = [];
    const labels = groups.map((g) => g.querySelector('text.treeView-node-label'));
    const same = groups.length === entries.length && entries.every((e, i) => labels[i] && labelText(labels[i]!) === source.slice(e.name.from, e.name.to).trim());
    if (same) {
      groups.forEach((g, i) => {
        const labelEl = labels[i]!;
        mapped.push({ id: `tree-${i}`, el: g, labelEl, label: labelText(labelEl), range: entries[i].name, ref: { kind: KIND, id: String(i) } });
      });
    }
    return withGeneric(svg, source, mapped);
  },

  inspect(source, ref): PropertyField[] {
    if (!ref) return keywordFields(source, [TITLE]);
    const e = ref.kind === KIND ? entryOf(source, ref.id) : undefined;
    if (!e) return [];
    const val = (a: Annotation | null) => (a ? source.slice(a.value.from, a.value.to) : '');
    return [
      { id: 'name', label: t('tv.field.name'), type: 'text', value: source.slice(e.name.from, e.name.to) },
      {
        id: 'kind',
        label: t('tv.field.kind'),
        type: 'select',
        value: e.slash === null ? 'file' : 'dir',
        options: [
          { value: 'file', label: t('tv.kind.file') },
          { value: 'dir', label: t('tv.kind.dir') },
        ],
      },
      { id: 'desc', label: t('tv.field.desc'), type: 'text', value: val(e.desc) },
      { id: 'icon', label: t('tv.field.icon'), type: 'text', value: val(e.icon), placeholder: 'mdi:folder' },
      { id: 'class', label: t('tv.field.class'), type: 'text', value: val(e.cls), placeholder: 'highlight' },
    ];
  },

  setProperty(source, ref, field, value) {
    if (!ref) return field === 'title' ? setKeyword(source, TITLE, value) : null;
    const e = ref.kind === KIND ? entryOf(source, ref.id) : undefined;
    if (!e) return null;
    if (field === 'name') {
      const name = source.slice(e.name.from, e.name.to);
      if (value === name) return null;
      // 書き方を変えずに済むなら名前の範囲だけ、だめなら引用符ごと書き直す
      if (nameToken(value, false) === value && (e.quoted ? !value.includes(source[e.token.from]) : true)) {
        return { from: e.name.from, to: e.name.to, insert: value };
      }
      const token = nameToken(value, e.slash !== null);
      return token ? { from: e.token.from, to: e.token.to, insert: token } : null;
    }
    if (field === 'kind') {
      if ((value === 'dir') === (e.slash !== null)) return null;
      if (e.slash !== null) return { from: e.slash, to: e.slash + 1, insert: '' };
      return { from: e.quoted ? e.token.to : e.name.to, insert: '/' };
    }
    if (field === 'desc') {
      const v = value.replace(/[\r\n]+/g, ' ').trim();
      if (e.desc) return v ? { from: e.desc.value.from, to: e.desc.value.to, insert: v } : { from: e.desc.whole.from, to: e.desc.whole.to, insert: '' };
      return v ? { from: e.end, insert: ` ## ${v}` } : null;
    }
    if (field === 'icon') {
      if (/[()\s]/.test(value.trim())) return null;
      return setAnnotation(e, e.icon, value, (v) => `icon(${v})`);
    }
    if (field === 'class') {
      if (/\s/.test(value.trim())) return null;
      return setAnnotation(e, e.cls, value, (v) => `:::${v}`);
    }
    return null;
  },

  actions: [
    {
      id: 'add-child',
      title: t('tv.action.addChild'),
      arity: 1,
      appliesTo: [KIND],
      key: 'Tab',
      run(source, [ref]) {
        const { entries, boxed } = parseTreeView(source);
        const e = entries[Number(ref.id)];
        if (!e || boxed) return null;
        // 中に足すので、ファイルだったらフォルダにする（/ は、同じ位置に差し込む子の行より前に置く）
        const change: ChangeSpec[] = e.slash === null ? [{ from: e.quoted ? e.token.to : e.name.to, insert: '/' }] : [];
        change.push(addChild(e, NEW_FILE));
        return { change, label: t('tv.history.add'), focus: { kind: KIND, id: String(lastIndex(e) + 1) } };
      },
    },
    {
      id: 'add-sibling',
      title: t('tv.action.addSibling'),
      arity: 1,
      appliesTo: [KIND],
      run(source, [ref]) {
        const { entries, boxed } = parseTreeView(source);
        const e = entries[Number(ref.id)];
        if (!e || boxed) return null;
        return { change: addSibling(e, NEW_FILE), label: t('tv.history.add'), focus: { kind: KIND, id: String(lastIndex(e) + 1) } };
      },
    },
    {
      id: 'move-up',
      title: '↑',
      arity: 1,
      appliesTo: [KIND],
      run(source, [ref]) {
        const { entries, boxed } = parseTreeView(source);
        const e = entries[Number(ref.id)];
        const change = e && !boxed && moveSibling(source, e, -1);
        return change ? { change, label: t('tv.history.move'), select: { kind: KIND, id: String(movedIndex(e, -1)) } } : null;
      },
    },
    {
      id: 'move-down',
      title: '↓',
      arity: 1,
      appliesTo: [KIND],
      run(source, [ref]) {
        const { entries, boxed } = parseTreeView(source);
        const e = entries[Number(ref.id)];
        const change = e && !boxed && moveSibling(source, e, 1);
        return change ? { change, label: t('tv.history.move'), select: { kind: KIND, id: String(movedIndex(e, 1)) } } : null;
      },
    },
    {
      id: 'delete',
      title: t('plg.delete'),
      arity: 1,
      appliesTo: [KIND],
      key: 'Delete',
      danger: true,
      run(source, [ref]) {
        const { entries, boxed } = parseTreeView(source);
        const e = entries[Number(ref.id)];
        // 項目が 1 つも残らない消し方はしない（ただ 1 つの最上位の項目を消すと、中身ごと消えて空の木になる）
        if (!e || boxed || (!e.parent && e.siblings.length === 1)) return null;
        return { change: deleteSubtree(source, e), label: t('tv.history.delete') };
      },
    },
  ],
};

function lastIndex(n: OutlineNode): number {
  while (n.children.length) n = n.children[n.children.length - 1];
  return n.index;
}
