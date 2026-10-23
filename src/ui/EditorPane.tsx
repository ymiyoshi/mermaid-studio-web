import { useEffect, useRef } from 'react';
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Text } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { applyChanges, editorBus, redo, registerEditorFlush, setSelection, undo, useSession } from '../core/session';
import { useRender } from '../render/pipeline';
import { mermaidHighlighting, mermaidLanguage } from '../render/mermaidLanguage';
import type { Sel } from '../core/history';

// CodeMirror 標準の history() は使わない。undo はアプリの履歴ツリーが一元管理する（§8.1）。

const External = Annotation.define<boolean>();

const toSel = (s: Sel) => EditorSelection.single(s.anchor, s.head);

export function EditorPane() {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const readOnly = new Compartment();
    // IME 変換中の変更はためておき、確定したらまとめて 1 つの変更として送る（§4.3）
    let pending: { changes: ChangeSet; docBefore: Text; selBefore: Sel } | null = null;

    const flushPending = (view: EditorView) => {
      if (!pending) return;
      const p = pending;
      pending = null;
      const sel = view.state.selection.main;
      applyChanges(p.changes, {
        origin: 'typing',
        selBefore: p.selBefore,
        selAfter: { anchor: sel.anchor, head: sel.head },
        fromEditor: true,
      });
    };

    const listener = EditorView.updateListener.of((u) => {
      if (u.transactions.some((tr) => tr.annotation(External))) return;
      if (u.docChanged) {
        const tr = u.transactions[0];
        const selBefore = { anchor: u.startState.selection.main.anchor, head: u.startState.selection.main.head };
        if (u.view.composing || pending) {
          pending = pending
            ? { ...pending, changes: pending.changes.compose(u.changes) }
            : { changes: u.changes, docBefore: u.startState.doc, selBefore };
          if (!u.view.composing) flushPending(u.view);
          return;
        }
        const sel = u.state.selection.main;
        const isPaste = tr?.isUserEvent('input.paste') || tr?.isUserEvent('input.drop');
        applyChanges(u.changes, {
          origin: isPaste ? 'paste' : 'typing',
          selBefore,
          selAfter: { anchor: sel.anchor, head: sel.head },
          fromEditor: true,
        });
      } else if (u.selectionSet && !pending) {
        const sel = u.state.selection.main;
        setSelection({ anchor: sel.anchor, head: sel.head });
      }
    });

    const historyKeys = keymap.of([
      { key: 'Mod-z', run: () => (undo(), true), preventDefault: true },
      { key: 'Mod-Shift-z', run: () => (redo(), true), preventDefault: true },
      { key: 'Mod-y', run: () => (redo(), true), preventDefault: true },
    ]);

    const makeState = (doc: string, sel: Sel, ro: boolean) =>
      EditorState.create({
        doc,
        selection: toSel({ anchor: Math.min(sel.anchor, doc.length), head: Math.min(sel.head, doc.length) }),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          mermaidLanguage,
          mermaidHighlighting,
          lintGutter(),
          historyKeys,
          keymap.of([...defaultKeymap, indentWithTab]),
          readOnly.of(EditorState.readOnly.of(ro)),
          listener,
          EditorView.domEventHandlers({
            compositionend: (_e, view) => {
              // composing が false になった後の更新を待ってから送る
              setTimeout(() => flushPending(view), 0);
            },
          }),
          EditorView.lineWrapping,
        ],
      });

    const cur = useSession.getState().current;
    const view = new EditorView({
      parent: host.current!,
      state: makeState(cur?.text.toString() ?? '', useSession.getState().selection, cur?.readOnly ?? false),
    });
    viewRef.current = view;
    registerEditorFlush(() => flushPending(view));

    const off = editorBus.on((e) => {
      if (e.type === 'reset') {
        pending = null;
        view.setState(makeState(e.text, e.selection, e.readOnly));
      } else if (e.type === 'apply') {
        view.dispatch({
          changes: e.changes,
          selection: toSel(e.selection),
          annotations: External.of(true),
          scrollIntoView: true,
        });
      } else if (e.type === 'select') {
        view.dispatch({ selection: toSel(e.selection), annotations: External.of(true), scrollIntoView: e.scroll });
      }
    });

    return () => {
      off();
      registerEditorFlush(null);
      view.destroy();
    };
  }, []);

  // 構文エラーをエディタに表示する
  const error = useRender((s) => s.error);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const diags: Diagnostic[] = [];
    if (error) {
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(error.line ?? 1, 1), doc.lines));
      diags.push({ from: line.from, to: line.to, severity: 'error', message: error.message });
    }
    view.dispatch(setDiagnostics(view.state, diags));
  }, [error]);

  return <div className="editor" ref={host} />;
}
