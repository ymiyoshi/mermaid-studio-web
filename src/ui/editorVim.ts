import { Vim, getCM, vim } from '@replit/codemirror-vim';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { redo, travel, undo } from '../core/session';
import { DIAGRAM_COMMAND_EVENT, type DiagramCommand } from './commands';
import { focusPane, runEx, runGlobal } from './viDispatch';

// エディタの vim（設計書 §16.3）。@replit/codemirror-vim の割り当ては全体で 1 つなので、最初に使うときに 1 回だけ変える。
// undo は CodeMirror の history() ではなくアプリの履歴ツリーで行う（§8.1。vim の既定の u / Ctrl-r は history() が要る）。

/** vim の編集単位の境目を知らせる先（§8.3） */
export interface VimTracker {
  /** モードが変わった（'insert' / 'normal' / 'visual' / 'replace'） */
  onMode(mode: string): void;
  /** ノーマルモードの 1 つのコマンドが終わった */
  onCommandDone(): void;
}

/** エディタからも、どこでも効くキー（Space で始まるキー・gt / gT）を使う。vim の書き方と、viDispatch のコマンド */
const GLOBAL_KEYS: [string, string][] = [
  ['<Space>e', '<Space> e'],
  ['<Space>d', '<Space> d'],
  ['<Space>p', '<Space> p'],
  ['<Space>u', '<Space> u'],
  ['<Space>f', '<Space> f'],
  ['<Space>h', '<Space> h'],
  ['<Space>l', '<Space> l'],
  ['<Space><Space>', '<Space> <Space>'],
  ['<Space>?', '<Space> ?'],
  ['gt', 'g t'],
  ['gT', 'g T'],
];

let configured = false;

function configureVim() {
  if (configured) return;
  configured = true;
  type Args = { repeat?: number };
  const times = (args: Args, f: () => void) => {
    for (let n = 0; n < Math.max(1, args.repeat ?? 1); n++) f();
  };
  const action = (name: string, keys: string, fn: (args: Args) => void) => {
    Vim.defineAction(name, (_cm: unknown, args: Args) => fn(args));
    Vim.mapCommand(keys, 'action', name, {}, { context: 'normal' });
  };
  action('appUndo', 'u', (a) => times(a, undo));
  action('appRedo', '<C-r>', (a) => times(a, redo));
  action('appEarlier', 'g-', (a) => travel(-Math.max(1, a.repeat ?? 1)));
  action('appLater', 'g+', (a) => travel(Math.max(1, a.repeat ?? 1)));
  // gd: カーソルの行の要素を図で選び、図へ移る
  action('appShowInDiagram', 'gd', () => {
    focusPane('diagram');
    dispatchEvent(new CustomEvent<DiagramCommand>(DIAGRAM_COMMAND_EVENT, { detail: 'selectCursor' }));
  });
  // 既定の <Space>（右へ移動）があると、Space で始まるキーに届かないので外す
  Vim.unmap('<Space>', undefined as unknown as string);
  GLOBAL_KEYS.forEach(([keys, cmd], i) => action(`appGlobal${i}`, keys, (a) => runGlobal(cmd, Math.max(1, a.repeat ?? 1))));

  const ex = (name: string, prefix: string) => Vim.defineEx(name, prefix, (_cm: unknown, params: { input: string }) => void runEx(params.input));
  ex('write', 'w');
  ex('saveas', 'sav');
  ex('edit', 'e');
  ex('earlier', 'ea');
  ex('later', 'lat');
  ex('checkpoint', 'checkp');
}

/** vi のときにエディタへ入れる拡張。vim の拡張と、編集単位の境目を tracker に知らせるプラグイン */
export function vimExtension(tracker: VimTracker): Extension {
  configureVim();
  const listen = ViewPlugin.define((view: EditorView) => {
    type CM = { on(type: string, f: (e?: { mode?: string }) => void): void; off(type: string, f: (e?: { mode?: string }) => void): void };
    const onMode = (e?: { mode?: string }) => tracker.onMode(e?.mode ?? 'normal');
    const onDone = () => tracker.onCommandDone();
    let cm: CM | null = null;
    const attach = () => {
      cm = getCM(view) as unknown as CM | null;
      cm?.on('vim-mode-change', onMode);
      cm?.on('vim-command-done', onDone);
      // 作り直した vim（別の図を開いた・キーバインドを切り替えた）はノーマルモードから始まる。
      // 挿入中のまま切り替えても、次のコマンドを前の編集単位にまとめないよう、ここで単位を区切る
      tracker.onMode('normal');
    };
    // vim のプラグインより後に作られるので、ふつうはもう CodeMirror の互換オブジェクトがある
    if (getCM(view)) attach();
    else queueMicrotask(attach);
    return {
      destroy() {
        cm?.off('vim-mode-change', onMode);
        cm?.off('vim-command-done', onDone);
      },
    };
  });
  return [vim({ status: true }), listen];
}
