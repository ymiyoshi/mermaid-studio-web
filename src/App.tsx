import { lazy, Suspense, useEffect, useRef } from 'react';
import { Header } from './ui/Header';
import { Sidebar } from './ui/Sidebar';
import { EditorPane } from './ui/EditorPane';
import { DiagramPane } from './ui/DiagramPane';
import { HistoryPane } from './ui/HistoryPane';
import { useSession } from './core/session';
import { ConflictBanner, IoDialogs } from './ui/IoDialogs';
import { loadLayout, saveLayout, useLayout, type MobileTab } from './ui/layoutStore';
import { useExternalChangeCheck, useFileDrop, useGlobalShortcuts, useMobile } from './ui/useAppEvents';
import { loadKeymap, useKeymap } from './ui/keymapStore';
import { useViKeys } from './ui/viDispatch';
import { t } from './i18n';

// 開いたときだけ使う画面は、起動時の読み込みから外す（§18。分けた部分もプリキャッシュするのでオフラインでも開ける）
const CommandPalette = lazy(() => import('./ui/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const SnippetsDialog = lazy(() => import('./ui/SnippetsDialog').then((m) => ({ default: m.SnippetsDialog })));
const PresentationView = lazy(() => import('./ui/PresentationView').then((m) => ({ default: m.PresentationView })));
const TimelapseHost = lazy(() => import('./ui/TimelapseView').then((m) => ({ default: m.TimelapseHost })));
const KeyHelp = lazy(() => import('./ui/KeyHelp').then((m) => ({ default: m.KeyHelp })));

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

  const helpOpen = useKeymap((s) => s.helpOpen);
  useEffect(() => {
    void loadLayout();
    void loadKeymap();
  }, []);
  useGlobalShortcuts();
  useViKeys();
  useExternalChangeCheck();
  const dragging = useFileDrop();

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
        <Suspense fallback={null}>
          {layout.paletteOpen && <CommandPalette onClose={() => useLayout.setState({ paletteOpen: false })} />}
          {layout.snippetsOpen && <SnippetsDialog onClose={() => useLayout.setState({ snippetsOpen: false })} />}
          {layout.presentOpen && <PresentationView onClose={closePresentation} />}
          {layout.timelapseOpen && <TimelapseHost />}
          {helpOpen && <KeyHelp onClose={() => useKeymap.setState({ helpOpen: false })} />}
        </Suspense>
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
      <Suspense fallback={null}>
        {layout.paletteOpen && <CommandPalette onClose={() => useLayout.setState({ paletteOpen: false })} />}
        {layout.snippetsOpen && <SnippetsDialog onClose={() => useLayout.setState({ snippetsOpen: false })} />}
        {layout.presentOpen && <PresentationView onClose={closePresentation} />}
        {layout.timelapseOpen && <TimelapseHost />}
        {helpOpen && <KeyHelp onClose={() => useKeymap.setState({ helpOpen: false })} />}
      </Suspense>
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

// 発表モードの全画面の後始末が onClose に頼るので、描画のたびに変わらない関数にする
const closePresentation = () => useLayout.setState({ presentOpen: false });

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
