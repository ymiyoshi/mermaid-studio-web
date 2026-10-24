import { useEffect, useState } from 'react';
import { redo, undo, useSession } from '../core/session';
import { checkExternalChange, importFromDrop, openFile, saveFile } from '../io/files';
import { useIo } from '../io/ioStore';

// アプリ全体（window）で受け取るイベント。App から切り出したもの。

const isMod = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey;

/**
 * キーボードのショートカット。
 * - ファイル操作（Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+Shift+E）はどこにフォーカスがあっても効かせる
 * - undo / redo は、エディタや入力欄の外にフォーカスがあるときも同じ履歴で行う（§8.1）
 */
export function useGlobalShortcuts() {
  useEffect(() => {
    const onFileKey = (e: KeyboardEvent) => {
      if (!isMod(e)) return;
      const k = e.key.toLowerCase();
      if (k === 's') void saveFile({ saveAs: e.shiftKey });
      else if (k === 'o' && !e.shiftKey) void openFile();
      else if (k === 'e' && e.shiftKey) useIo.setState({ exportOpen: true });
      else return;
      e.preventDefault();
    };
    const onHistoryKey = (e: KeyboardEvent) => {
      if (!isMod(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.cm-editor') || target?.matches('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onFileKey, { capture: true });
    addEventListener('keydown', onHistoryKey);
    return () => {
      removeEventListener('keydown', onFileKey, { capture: true });
      removeEventListener('keydown', onHistoryKey);
    };
  }, []);
}

/** 結び付いたファイルが外部で変更されていないか、図を開いたときとフォーカスが戻ったときに調べる（§9.3） */
export function useExternalChangeCheck() {
  const currentId = useSession((s) => s.current?.id);
  useEffect(() => {
    void checkExternalChange();
  }, [currentId]);
  useEffect(() => {
    const check = () => void checkExternalChange();
    addEventListener('focus', check);
    return () => removeEventListener('focus', check);
  }, []);
}

/** ファイルのドラッグ＆ドロップで読み込む。ドラッグ中かどうかを返す（ドロップ先の表示用） */
export function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      importFromDrop(e);
    };
    addEventListener('dragover', over);
    addEventListener('dragleave', leave);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragover', over);
      removeEventListener('dragleave', leave);
      removeEventListener('drop', drop);
    };
  }, []);
  return dragging;
}

const MOBILE_QUERY = '(max-width: 900px)';

/** 狭い画面（タブで切り替える表示）かどうか */
export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}
