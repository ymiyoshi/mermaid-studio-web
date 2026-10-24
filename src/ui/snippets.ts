import { create } from 'zustand';
import type { Sel } from '../core/history';
import { getSetting, putSetting } from '../storage/db';

// 部品集: よく使う図の一部を登録しておき、カーソルのある行の下に差し込む。
// 部品は IndexedDB の設定（settings の 'snippets'）に保存する。保存形式（DB の版）は変えない。

export interface Snippet {
  id: string;
  name: string;
  text: string;
  /** 登録したときの図種（宣言行の最初の語）。同じ図種の部品を先に出す */
  kind: string;
  createdAt: number;
}

const KEY = 'snippets';

export const useSnippets = create<{ loaded: boolean; items: Snippet[]; open: boolean }>(() => ({ loaded: false, items: [], open: false }));

export async function loadSnippets() {
  const items = (await getSetting<Snippet[]>(KEY)) ?? [];
  useSnippets.setState({ loaded: true, items: Array.isArray(items) ? items.filter((x) => typeof x?.text === 'string') : [] });
}

async function save(items: Snippet[]) {
  useSnippets.setState({ items });
  await putSetting(KEY, items);
}

export async function addSnippet(name: string, text: string, kind: string) {
  const s: Snippet = { id: crypto.randomUUID(), name: name.trim() || text.trim().split('\n')[0].slice(0, 30), text, kind, createdAt: Date.now() };
  await save([...useSnippets.getState().items, s]);
  return s;
}

export async function removeSnippet(id: string) {
  await save(useSnippets.getState().items.filter((x) => x.id !== id));
}

/** 図の宣言行の最初の語（flowchart / sequenceDiagram など）。宣言が無ければ '' */
export function diagramKind(source: string): string {
  for (const line of source.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('%%')) continue;
    return /^[\w-]+/.exec(t)?.[0] ?? '';
  }
  return '';
}

/** 部品の行をそろえる: 共通のインデントを外し、前後の空行を外す */
export function normalizeSnippet(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/**
 * 部品を差し込む変更。カーソルのある行の下に、その行のインデントにそろえて足す。
 * 宣言行の上なら本文のインデント（4 つ）にし、空の行ならその行を置き換える。差し込んだ範囲を選んだ状態にする
 */
export function snippetInsertion(source: string, sel: Sel, text: string): { from: number; to: number; insert: string; selection: Sel } {
  const body = normalizeSnippet(text);
  const pos = Math.min(Math.max(sel.head, 0), source.length);
  const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
  const nl = source.indexOf('\n', pos);
  const lineEnd = nl < 0 ? source.length : nl;
  const line = source.slice(lineStart, lineEnd);
  const kind = diagramKind(source);
  const isHeader = kind !== '' && line.trim().startsWith(kind) && !/\S/.test(source.slice(0, lineStart).replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*%%.*$/gm, ''));
  const blank = line.trim() === '';
  const indent = isHeader || (blank && kind !== '' && line === '') ? '    ' : /^\s*/.exec(line)![0];
  const lines = body
    .split('\n')
    .map((l) => (l === '' ? l : indent + l))
    .join('\n');
  if (blank) return { from: lineStart, to: lineEnd, insert: lines, selection: { anchor: lineStart, head: lineStart + lines.length } };
  const insert = `\n${lines}`;
  return { from: lineEnd, to: lineEnd, insert, selection: { anchor: lineEnd + 1, head: lineEnd + insert.length } };
}