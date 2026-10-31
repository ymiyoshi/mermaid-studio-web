import { useEffect } from 'react';
import { nameCheckpoint, openDoc, redo, showToast, travel, travelTime, useSession } from '../core/session';
import { openFile, saveFile } from '../io/files';
import { togglePane, useLayout, type MobileTab } from './layoutStore';
import { isVi, useKeymap } from './keymapStore';
import { MOBILE_QUERY } from './useAppEvents';
import { keyName, parseKeys, parseTravel, VI_TIMEOUT_MS } from './viKeys';
import { t } from '../i18n';

// vi のキーバインド（設計書 §16）の振り分け。window の capture 段階で 1 か所で受け、
// どのペインにフォーカスがあるかで、どこでも効くキーとペインのキーの表を合わせて読む。
// 表に無いキー（Tab・Delete・矢印など）は何もせずに通し、標準のキー操作に任せる。
// 入力欄・エディタ（vim が自分で受ける）・ダイアログの中では何もしない。

export type ViPaneName = 'diagram' | 'history' | 'sidebar';

export interface ViPaneHandler {
  /** 今受け付けるコマンド（キーを空白でつないだもの）。モードで変わる */
  commands(): readonly string[];
  /** 実行して、キーを使ったら true（false なら標準のキー操作に回す） */
  run(cmd: string, count: number): boolean;
}

const panes = new Map<ViPaneName, ViPaneHandler>();

export function registerViPane(name: ViPaneName, handler: ViPaneHandler) {
  panes.set(name, handler);
  return () => {
    if (panes.get(name) === handler) panes.delete(name);
  };
}

const GLOBAL = [
  '<Space> e',
  '<Space> d',
  '<Space> p',
  '<Space> u',
  '<Space> f',
  '<Space> h',
  '<Space> l',
  '<Space> <Space>',
  '<Space> ?',
  'g t',
  'g T',
  ':',
  '?',
] as const;

// ---- ペインの移動 ----

export type FocusTarget = 'sidebar' | 'editor' | 'diagram' | 'props' | 'history';
const ORDER: FocusTarget[] = ['sidebar', 'editor', 'diagram', 'props', 'history'];
const MOBILE_TAB: Record<FocusTarget, MobileTab> = { sidebar: 'list', editor: 'text', diagram: 'diagram', props: 'diagram', history: 'history' };

function paneElement(name: FocusTarget): HTMLElement | null {
  const q = (s: string) => document.querySelector<HTMLElement>(s);
  switch (name) {
    case 'sidebar':
      return q('.sidebar');
    case 'editor':
      return q('.editor .cm-content');
    case 'diagram':
      return q('.diagram-viewport');
    case 'props':
      return q('.property-panel .panel-body input, .property-panel .panel-body select, .property-panel .panel-body button, .property-panel button');
    case 'history':
      return q('.history-pane');
  }
}

/** フォーカスのある要素が、どのペインの中か */
export function currentPane(el: Element | null = document.activeElement): FocusTarget | null {
  if (!el) return null;
  if (el.closest('.property-panel')) return 'props';
  if (el.closest('.diagram-pane')) return 'diagram';
  if (el.closest('.editor')) return 'editor';
  if (el.closest('.history-pane')) return 'history';
  if (el.closest('.sidebar')) return 'sidebar';
  return null;
}

/** ペインへフォーカスを移す。閉じているペイン（一覧・履歴）は開いてから移す */
export function focusPane(name: FocusTarget) {
  const layout = useLayout.getState();
  let wait = false;
  if (matchMedia(MOBILE_QUERY).matches) {
    if (layout.mobileTab !== MOBILE_TAB[name]) {
      useLayout.setState({ mobileTab: MOBILE_TAB[name] });
      wait = true;
    }
  } else if (name === 'sidebar' && !layout.sidebarOpen) {
    togglePane('sidebarOpen');
    wait = true;
  } else if (name === 'history' && !layout.historyOpen) {
    togglePane('historyOpen');
    wait = true;
  }
  const go = () => paneElement(name)?.focus();
  if (wait) requestAnimationFrame(() => requestAnimationFrame(go));
  else go();
}

/** 左隣・右隣のペインへ（見えているペインだけをたどる） */
function focusNeighbor(dir: -1 | 1) {
  const visible = ORDER.filter((p) => paneElement(p)?.offsetParent);
  if (visible.length === 0) return;
  const here = currentPane();
  const i = here ? visible.indexOf(here) : -1;
  const next = i < 0 ? visible[dir > 0 ? 0 : visible.length - 1] : visible[(i + dir + visible.length) % visible.length];
  focusPane(next);
}

/** 一覧の並びで、n 個先（負なら前）の図を開く（gt / gT） */
export function openRelativeDoc(n: number) {
  const s = useSession.getState();
  const order = useKeymap.getState().docOrder;
  const ids =
    order.length > 0
      ? order
      : s.docs
          .filter((d) => d.deletedAt === null)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((d) => d.id);
  if (ids.length === 0) return;
  const i = s.current ? ids.indexOf(s.current.id) : -1;
  const next = ids[(((i < 0 ? (n > 0 ? -1 : 0) : i) + n) % ids.length + ids.length) % ids.length];
  if (next !== s.current?.id) void openDoc(next);
}

export function openPalette(query = '') {
  useLayout.setState({ paletteOpen: true, paletteQuery: query });
}

export function openKeyHelp() {
  useKeymap.setState({ helpOpen: true });
}

/** どこでも効くキー（エディタの vim からも呼ぶ） */
export function runGlobal(cmd: string, count: number): boolean {
  switch (cmd) {
    case '<Space> e':
      focusPane('editor');
      break;
    case '<Space> d':
      focusPane('diagram');
      break;
    case '<Space> p':
      focusPane('props');
      break;
    case '<Space> u':
      focusPane('history');
      break;
    case '<Space> f':
      focusPane('sidebar');
      break;
    case '<Space> h':
      focusNeighbor(-1);
      break;
    case '<Space> l':
      focusNeighbor(1);
      break;
    case '<Space> <Space>':
      openPalette();
      break;
    case 'g t':
      openRelativeDoc(count);
      break;
    case 'g T':
      openRelativeDoc(-count);
      break;
    case ':':
      openPalette(':');
      break;
    case '?':
    case '<Space> ?':
      openKeyHelp();
      break;
    default:
      return false;
  }
  return true;
}

// ---- Ex コマンド ----

/** Ex コマンド（先頭の : は無くてもよい）を実行する。知らないコマンドなら知らせて false */
export function runEx(input: string): boolean {
  const m = /^\s*:?\s*([a-zA-Z]+)(!?)\s*(.*?)\s*$/.exec(input);
  const cur = useSession.getState().current;
  if (!m) {
    showToast(t('vi.exUnknown', { cmd: input.trim() }));
    return false;
  }
  const [, name, bang, arg] = m;
  const is = (full: string, short: string) => name.length >= short.length && full.startsWith(name);
  if (is('write', 'w')) void saveFile({ force: bang === '!' });
  else if (is('saveas', 'sav')) void saveFile({ saveAs: true });
  else if (is('edit', 'e')) void openFile();
  else if (is('earlier', 'ea') || is('later', 'lat')) {
    const sign = name.startsWith('e') ? -1 : 1;
    const r = parseTravel(arg);
    if (!r) {
      showToast(t('vi.exBadArg', { cmd: name }));
      return false;
    }
    if ('steps' in r) travel(sign * r.steps);
    else travelTime(sign * r.ms);
  } else if (is('checkpoint', 'checkp')) {
    if (!cur) return false;
    if (arg === '') {
      showToast(t('vi.exNeedName'));
      return false;
    }
    nameCheckpoint(cur.tree.headId, arg);
  } else {
    showToast(t('vi.exUnknown', { cmd: name }));
    return false;
  }
  return true;
}

// ---- キーの受け取り ----

let keys: string[] = [];
/** 打ちかけのキーを打ったペイン。別のペインで続きを打っても、前のペインのキーとはつなげない */
let keysPane: ViPaneName | null = null;
let lastAt = 0;
/** 打ちかけのまま止まったら、表示ごと捨てるタイマー */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const setPending = (k: string[]) => useKeymap.setState({ pendingKeys: k.join('').replace(/<Space>/g, '␣') });

function paneOf(el: Element): ViPaneName | null {
  // 図の右クリックのメニューの中では、図の要素を動かさない（Tab・Enter・Esc でメニューを使う）
  if (el.closest('.context-menu')) return null;
  if (el.closest('.diagram-viewport')) return 'diagram';
  if (el.closest('.history-pane')) return 'history';
  if (el.closest('.sidebar')) return 'sidebar';
  return null;
}

/** 打ちかけのキーを捨てる */
export function resetViKeys() {
  keys = [];
  keysPane = null;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  setPending(keys);
}

/** 修飾キーが Ctrl だけの r（Ctrl+Shift+R の強制的な再読み込みは止めない） */
const isCtrlR = (e: KeyboardEvent) => e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'r';

export function onViKeyDown(e: KeyboardEvent) {
  if (!isVi() || e.defaultPrevented) return;
  // 変換中のキーは vi の処理に渡さない（§16.1）
  if (e.isComposing || e.keyCode === 229) return;
  const target = e.target instanceof Element ? e.target : null;
  // エディタの中は vim が受ける（Ctrl-r も vim が redo にする）
  if (target?.closest('.cm-editor')) return;
  // 入力欄・ダイアログの中では vi のキーを使わない。ただし Ctrl+R の再読み込みは、どこでも止める（§16.6）
  if (!target || target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('[aria-modal="true"]')) {
    if (isCtrlR(e)) e.preventDefault();
    return;
  }
  const name = keyName(e);
  if (!name) return;

  const pane = paneOf(target);
  const handler = pane ? panes.get(pane) : undefined;
  const table = [...GLOBAL, ...(handler?.commands() ?? [])];
  const now = performance.now();
  if (now - lastAt > VI_TIMEOUT_MS || pane !== keysPane) resetViKeys();
  lastAt = now;

  const consume = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  // Esc は、打ちかけのキーがあればそれを捨てるだけにする
  if (name === '<Esc>' && keys.length > 0) {
    resetViKeys();
    return consume();
  }
  const next = [...keys, name];
  const r = parseKeys(next, table);
  if (r.kind === 'pending') {
    keys = next;
    keysPane = pane;
    setPending(keys);
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(resetViKeys, VI_TIMEOUT_MS);
    return consume();
  }
  resetViKeys();
  if (r.kind === 'none') {
    // ペインの表に無い所（ヘッダー・プロパティパネルなど）の Ctrl+R も、読み込み直さずに redo にする
    if (isCtrlR(e)) {
      consume();
      redo();
    }
    return;
  }
  const done = (GLOBAL as readonly string[]).includes(r.cmd) ? runGlobal(r.cmd, r.count) : !!handler?.run(r.cmd, r.count);
  if (done) consume();
}

/** vi のキーを受け取る（App で 1 回だけ使う） */
export function useViKeys() {
  useEffect(() => {
    addEventListener('keydown', onViKeyDown, { capture: true });
    // キーバインドを切り替えたら、打ちかけのキーを捨てる
    const off = useKeymap.subscribe((s, prev) => s.keymap !== prev.keymap && resetViKeys());
    return () => {
      removeEventListener('keydown', onViKeyDown, { capture: true });
      off();
    };
  }, []);
}
