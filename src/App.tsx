import { useEffect, useRef, useState } from 'react';
import { Header } from './ui/Header';
import { Sidebar } from './ui/Sidebar';
import { EditorPane } from './ui/EditorPane';
import { DiagramPane } from './ui/DiagramPane';
import { HistoryPane } from './ui/HistoryPane';
import { redo, undo, useSession } from './core/session';
import { checkExternalChange, importFromDrop, openFile, saveFile } from './io/files';
import { useIo } from './io/ioStore';
import { ConflictBanner, IoDialogs } from './ui/IoDialogs';
import { loadLayout, saveLayout, useLayout, type MobileTab } from './ui/layoutStore';
import { t } from './i18n';

const MOBILE_QUERY = '(max-width: 900px)';

function useMobile() {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(MOBILE_QUERY);
    const on = () => setMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mobile;
}

const MOBILE_TABS: { id: MobileTab; label: () => string }[] = [
  { id: 'list', label: () => t('doc.list') },
  { id: 'text', label: () => t('tabs.text') },
  { id: 'diagram', label: () => t('tabs.diagram') },
  { id: 'history', label: () => t('history.title') },
];

export function App() {
  const ready = useSession((s) => s.ready);
  const readOnly = useSession((s) => s.current?.readOnly ?? false);
  const toast = useSession((s) => s.toast);
  const layout = useLayout();
  const mobile = useMobile();
  const setWidths = (f: (l: typeof layout) => Partial<typeof layout>) => useLayout.setState((s) => f(s));

  useEffect(() => {
    void loadLayout();
  }, []);

  // ファイル操作のショートカットはどこにフォーカスがあっても効かせる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') void saveFile({ saveAs: e.shiftKey });
      else if (k === 'o' && !e.shiftKey) void openFile();
      else if (k === 'e' && e.shiftKey) useIo.setState({ exportOpen: true });
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey, { capture: true });
    return () => removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // 結び付いたファイルが外部で変更されていないか、図を開いたときとフォーカスが戻ったときに調べる（§9.3）
  const currentId = useSession((s) => s.current?.id);
  useEffect(() => {
    void checkExternalChange();
  }, [currentId]);
  useEffect(() => {
    const check = () => void checkExternalChange();
    addEventListener('focus', check);
    return () => removeEventListener('focus', check);
  }, []);

  // ファイルのドラッグ＆ドロップで読み込む
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

  // エディタの外にフォーカスがあるときも、同じ履歴で undo/redo する（§8.1）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('.cm-editor') || target?.matches('input, textarea, select')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (!ready) return <div className="loading">{t('app.title')}…</div>;

  const editor = (
    <section className="pane editor-pane">
      <EditorPane />
    </section>
  );

  // 狭い画面では、ペインを 1 つずつタブで切り替える（§10）。隠したペインも状態を保つために描画はしておく
  if (mobile) {
    const tab = layout.mobileTab;
    return (
      <div className="app mobile">
        <Header />
        {readOnly && <div className="readonly-banner">{t('readonly.otherTab')}</div>}
        <ConflictBanner />
        <main className="workspace mobile">
          <div className="mobile-slot" hidden={tab !== 'list'}>
            <Sidebar />
          </div>
          <div className="mobile-slot" hidden={tab !== 'text'}>
            {editor}
          </div>
          <div className="mobile-slot" hidden={tab !== 'diagram'}>
            <DiagramPane />
          </div>
          <div className="mobile-slot" hidden={tab !== 'history'}>
            <HistoryPane />
          </div>
        </main>
        <nav className="mobile-tabs" role="tablist">
          {MOBILE_TABS.map((x) => (
            <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? 'active' : ''} onClick={() => useLayout.setState({ mobileTab: x.id })}>
              {x.label()}
            </button>
          ))}
        </nav>
        <IoDialogs />
        {toast && (
          <div className="toast" role="status" key={toast.id}>
            {toast.message}
          </div>
        )}
      </div>
    );
  }

  const columns = [
    layout.sidebarOpen ? `${layout.sidebar}px 5px` : '',
    `${layout.editor}px 5px minmax(240px, 1fr)`,
    layout.historyOpen ? `5px ${layout.history}px` : '',
  ].join(' ');

  return (
    <div className="app">
      <Header />
      {readOnly && <div className="readonly-banner">{t('readonly.otherTab')}</div>}
      <ConflictBanner />
      <main className="workspace" style={{ gridTemplateColumns: columns }}>
        {layout.sidebarOpen && (
          <>
            <Sidebar />
            <Splitter onDrag={(dx) => setWidths((w) => ({ sidebar: clamp(w.sidebar + dx, 160, 480) }))} onEnd={saveLayout} />
          </>
        )}
        {editor}
        <Splitter onDrag={(dx) => setWidths((w) => ({ editor: clamp(w.editor + dx, 240, 1200) }))} onEnd={saveLayout} />
        <DiagramPane />
        {layout.historyOpen && (
          <>
            <Splitter onDrag={(dx) => setWidths((w) => ({ history: clamp(w.history - dx, 180, 600) }))} onEnd={saveLayout} />
            <HistoryPane />
          </>
        )}
      </main>
      <IoDialogs />
      {dragging && <div className="drop-overlay">{t('file.drop')}</div>}
      {toast && (
        <div className="toast" role="status" key={toast.id}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function Splitter({ onDrag, onEnd }: { onDrag(dx: number): void; onEnd(): void }) {
  const last = useRef<number | null>(null);
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        last.current = e.clientX;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // 捕捉できなくてもドラッグは続けられる
        }
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        onDrag(e.clientX - last.current);
        last.current = e.clientX;
      }}
      onPointerUp={() => {
        last.current = null;
        onEnd();
      }}
    />
  );
}
