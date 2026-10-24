import type { ChangeSet } from '@codemirror/state';
import type { Sel } from './history';

// エディタ（CodeMirror）への通知。core はエディタを直接触らず、ここに出来事を流す。

export type EditorEvent =
  | { type: 'reset'; text: string; selection: Sel; readOnly: boolean }
  | { type: 'apply'; changes: ChangeSet; selection: Sel }
  | { type: 'select'; selection: Sel; scroll: boolean };

const editorListeners = new Set<(e: EditorEvent) => void>();

export const editorBus = {
  on(fn: (e: EditorEvent) => void) {
    editorListeners.add(fn);
    return () => editorListeners.delete(fn);
  },
  emit(e: EditorEvent) {
    editorListeners.forEach((fn) => fn(e));
  },
};

// エディタが IME 変換中の変更をためている場合、履歴を動かす前に確定させる。
// そうしないと、ためた変更と履歴のステップが別々の文書を前提にしてしまう。
let flushEditor: (() => void) | null = null;

export function registerEditorFlush(fn: (() => void) | null) {
  flushEditor = fn;
}

/** エディタにためている変更があれば確定させる */
export function flushPendingEditor() {
  flushEditor?.();
}
