import { useEffect, useRef, useState } from 'react';
import { Header } from './ui/Header';
import { Sidebar } from './ui/Sidebar';
import { EditorPane } from './ui/EditorPane';
import { DiagramPane } from './ui/DiagramPane';
import { HistoryPane } from './ui/HistoryPane';
import { redo, undo, useSession } from './core/session';
import { putSetting, getSetting } from './storage/db';
import { t } from './i18n';

interface Widths {
  sidebar: number;
  editor: number;
  history: number;
}

const DEFAULT_WIDTHS: Widths = { sidebar: 240, editor: 440, history: 280 };

export function App() {
  const ready = useSession((s) => s.ready);
  const readOnly = useSession((s) => s.current?.readOnly ?? false);
  const toast = useSession((s) => s.toast);
  const [widths, setWidths] = useState<Widths>(DEFAULT_WIDTHS);

  useEffect(() => {
    void getSetting<Widths>('layout').then((w) => w && setWidths({ ...DEFAULT_WIDTHS, ...w }));
  }, []);

  // エディタの外にフォーカスがあるときも、同じ履歴で undo/redo する（§8.1）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('.cm-editor') || target.matches('input, textarea, select')) return;
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

  const columns = `${widths.sidebar}px 5px ${widths.editor}px 5px minmax(240px, 1fr) 5px ${widths.history}px`;

  return (
    <div className="app">
      <Header />
      {readOnly && <div className="readonly-banner">{t('readonly.otherTab')}</div>}
      <main className="workspace" style={{ gridTemplateColumns: columns }}>
        <Sidebar />
        <Splitter onDrag={(dx) => setWidths((w) => ({ ...w, sidebar: clamp(w.sidebar + dx, 160, 480) }))} onEnd={saveLayout} />
        <section className="pane editor-pane">
          <EditorPane />
        </section>
        <Splitter onDrag={(dx) => setWidths((w) => ({ ...w, editor: clamp(w.editor + dx, 240, 1200) }))} onEnd={saveLayout} />
        <DiagramPane />
        <Splitter onDrag={(dx) => setWidths((w) => ({ ...w, history: clamp(w.history - dx, 180, 600) }))} onEnd={saveLayout} />
        <HistoryPane />
      </main>
      {toast && (
        <div className="toast" role="status" key={toast.id}>
          {toast.message}
        </div>
      )}
    </div>
  );

  function saveLayout() {
    setWidths((w) => {
      void putSetting('layout', w);
      return w;
    });
  }
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
        e.currentTarget.setPointerCapture(e.pointerId);
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
