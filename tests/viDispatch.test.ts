// @vitest-environment jsdom
// vi のキーの振り分け（設計書 §16）。打ちかけのキーをペインをまたいでつなげないこと、表示のタイムアウト、Ctrl+R。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onViKeyDown, registerViPane, resetViKeys } from '../src/ui/viDispatch';
import { useKeymap } from '../src/ui/keymapStore';

const runs: { pane: string; cmd: string }[] = [];
let diagram: HTMLElement;
let sidebar: HTMLElement;
let header: HTMLElement;
let field: HTMLInputElement;

const press = (el: Element, key: string, mods: Partial<KeyboardEventInit> = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  el.dispatchEvent(e);
  return e;
};

beforeAll(() => {
  document.body.innerHTML = `
    <div class="diagram-pane"><div class="diagram-viewport" tabindex="0"></div></div>
    <aside class="sidebar" tabindex="-1"></aside>
    <header><button>btn</button><input /></header>`;
  diagram = document.querySelector('.diagram-viewport')!;
  sidebar = document.querySelector('.sidebar')!;
  header = document.querySelector('header button')!;
  field = document.querySelector('header input')!;
  registerViPane('diagram', { commands: () => ['d d', 'j'], run: (cmd) => (runs.push({ pane: 'diagram', cmd }), true) });
  registerViPane('sidebar', { commands: () => ['d d', 'j'], run: (cmd) => (runs.push({ pane: 'sidebar', cmd }), true) });
  addEventListener('keydown', onViKeyDown, { capture: true });
});

afterAll(() => removeEventListener('keydown', onViKeyDown, { capture: true }));

beforeEach(() => {
  runs.length = 0;
  resetViKeys();
  useKeymap.setState({ keymap: 'vi' });
});

afterEach(() => {
  vi.useRealTimers();
  useKeymap.setState({ keymap: 'standard' });
});

describe('vi のキーの振り分け', () => {
  it('同じペインで続けて打ったキーはつなげる', () => {
    press(diagram, 'd');
    press(diagram, 'd');
    expect(runs).toEqual([{ pane: 'diagram', cmd: 'd d' }]);
  });

  it('図で打ちかけた d と、一覧で打った d をつなげない（一覧の dd で図をゴミ箱へ移さない）', () => {
    press(diagram, 'd');
    press(sidebar, 'd');
    expect(runs).toEqual([]);
    expect(useKeymap.getState().pendingKeys).toBe('d');
    press(sidebar, 'd');
    expect(runs).toEqual([{ pane: 'sidebar', cmd: 'd d' }]);
  });

  it('打ちかけのまま止まったら、表示も捨てる', () => {
    vi.useFakeTimers();
    press(diagram, 'd');
    expect(useKeymap.getState().pendingKeys).toBe('d');
    vi.advanceTimersByTime(1100);
    expect(useKeymap.getState().pendingKeys).toBe('');
  });

  it('Ctrl+R はどこでも読み込み直さない（ペインの外では redo、入力欄の中では止めるだけ）', () => {
    expect(press(header, 'r', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(field, 'r', { ctrlKey: true }).defaultPrevented).toBe(true);
    // Ctrl+Shift+R（強制的な再読み込み）は止めない
    expect(press(header, 'R', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });

  it('標準のキーバインドでは何もしない', () => {
    useKeymap.setState({ keymap: 'standard' });
    press(diagram, 'd');
    press(diagram, 'd');
    expect(runs).toEqual([]);
    expect(press(header, 'r', { ctrlKey: true }).defaultPrevented).toBe(false);
  });
});
