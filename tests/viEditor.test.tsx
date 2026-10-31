// @vitest-environment jsdom
// エディタの vim（設計書 §16.3）。u / Ctrl-r がアプリの履歴を動かすこと、vim の編集単位が履歴の 1 ステップになること（§8.3）。
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Vim, getCM } from '@replit/codemirror-vim';
import { createDoc, openDoc, useSession } from '../src/core/session';
import { configureMermaid } from '../src/render/mermaid';
import * as db from '../src/storage/db';
import { EditorPane } from '../src/ui/EditorPane';
import { setKeymap, useKeymap } from '../src/ui/keymapStore';

const text = () => useSession.getState().current!.text.toString();
const steps = () => useSession.getState().current!.tree.nodes.size - 1;

beforeAll(async () => {
  // jsdom には文字の位置を測る仕組みが無いので、CodeMirror が測るときの値を空にする
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
  configureMermaid('default');
});

afterEach(() => {
  cleanup();
  useKeymap.setState({ keymap: 'standard' });
});

async function setup(doc: string) {
  await createDoc(doc, 'vim');
  setKeymap('vi');
  const { container } = render(<EditorPane />);
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
  /** vim にキーを送る（'<Esc>' などの特別なキーは 1 つずつ）。図を開き直すと vim が作り直されるので、毎回今の vim に送る */
  const keys = (...ks: string[]) =>
    act(() => {
      for (const k of ks) for (const c of k.startsWith('<') ? [k] : [...k]) Vim.handleKey(getCM(view)!, c, 'user');
    });
  /** 挿入モードでの入力（ブラウザの入力と同じく、カーソルの位置に差し込む） */
  const type = (s: string) =>
    act(() => {
      for (const c of s) {
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: c }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
      }
    });
  return { view, keys, type };
}

describe('エディタの vim', () => {
  it('挿入から Esc までは、間が空いても 1 ステップになり、u で丸ごと戻る', async () => {
    const { keys, type } = await setup('flowchart LR\n  A --> B');
    const before = steps();
    keys('G', 'o');
    type('B --> C');
    // 時間が空いても、単語の切れ目があっても区切らない
    await new Promise((r) => setTimeout(r, 1100));
    type(' & D');
    keys('<Esc>');
    expect(text()).toMatch(/^flowchart LR\n {2}A --> B\n\s*B --> C & D$/);
    const added = text();
    expect(steps()).toBe(before + 1);
    keys('u');
    expect(text()).toBe('flowchart LR\n  A --> B');
    keys('<C-r>');
    expect(text()).toBe(added);
  });

  it('ノーマルモードのコマンドは 1 つずつ 1 ステップ。オペレーターから挿入に入ったときは、削除と挿入を合わせて 1 ステップ', async () => {
    const { keys, type } = await setup('flowchart LR\n  A --> B\n  B --> C');
    const before = steps();
    keys('G', 'd', 'd');
    expect(text()).toBe('flowchart LR\n  A --> B');
    expect(steps()).toBe(before + 1);
    keys('2', 'G', 'c', 'w');
    type('X');
    keys('<Esc>');
    expect(text()).toBe('flowchart LR\n  X --> B');
    expect(steps()).toBe(before + 2);
    keys('u');
    expect(text()).toBe('flowchart LR\n  A --> B');
    keys('u');
    expect(text()).toBe('flowchart LR\n  A --> B\n  B --> C');
  });

  it('g- / g+ は分岐をまたいで作った順にたどる', async () => {
    const { keys, type } = await setup('A');
    keys('A');
    type('1');
    keys('<Esc>', 'u', 'A');
    type('2');
    keys('<Esc>');
    expect(text()).toBe('A2');
    keys('g', '-');
    expect(text()).toBe('A1');
    keys('g', '+');
    expect(text()).toBe('A2');
  });

  it('標準に戻すと vim の拡張を外す', async () => {
    const { view } = await setup('A');
    expect(view.dom.querySelector('.cm-vim-panel')).not.toBeNull();
    act(() => setKeymap('standard'));
    expect(view.dom.querySelector('.cm-vim-panel')).toBeNull();
  });
});

describe('エディタの vim（図の切り替え）', () => {
  it('挿入モードのまま別の図を開いても、次の図のコマンドは 1 つずつ 1 ステップになり、前の図の履歴にまとまらない', async () => {
    const { keys, type } = await setup('flowchart LR\n  A --> B');
    const first = useSession.getState().current!.id;
    keys('A');
    type(' --> C');
    const firstSteps = steps();
    // 挿入モードのまま、別の図へ
    await act(async () => {
      await createDoc('X\nY\nZ', 'second');
    });
    const before = steps();
    keys('d', 'd');
    keys('d', 'd');
    expect(text()).toBe('Z');
    expect(steps()).toBe(before + 2);

    // 前の図へ戻っても、前の図の最後のステップには足さない
    await act(async () => {
      await openDoc(first);
    });
    keys('d', 'd');
    expect(steps()).toBe(firstSteps + 1);
  });
});
