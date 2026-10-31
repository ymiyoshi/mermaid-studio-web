import { useEffect, useRef } from 'react';
import { t, type MessageKey } from '../i18n';

// vi のキーの一覧（? / Space ?。設計書 §16）。

const SECTIONS: { title: MessageKey; rows: [string, MessageKey][] }[] = [
  {
    title: 'vi.help.global',
    rows: [
      ['Space e / d / p / u / f', 'vi.h.focus'],
      ['Space h / l', 'vi.h.neighbor'],
      ['Space Space', 'vi.h.palette'],
      ['gt / gT', 'vi.h.docs'],
      [':', 'vi.h.ex'],
      ['?', 'vi.h.help'],
    ],
  },
  {
    title: 'vi.help.editor',
    rows: [
      ['u / Ctrl-r', 'vi.h.undo'],
      ['g- / g+', 'vi.h.chrono'],
      ['gd', 'vi.h.gdEditor'],
      [':w :sav :e :earlier :later :checkpoint', 'vi.h.exList'],
    ],
  },
  {
    title: 'vi.help.diagram',
    rows: [
      ['h j k l', 'vi.h.move'],
      ['w / b · gg / G', 'vi.h.order'],
      ['/ · n / N', 'vi.h.search'],
      ['gd', 'vi.h.gdDiagram'],
      ['zh zj zk zl · zz', 'vi.h.pan'],
      ['+ / - / =', 'vi.h.zoom'],
      ['i / a / Enter · cc / S', 'vi.h.label'],
      ['o', 'vi.h.add'],
      ['dd / x', 'vi.h.delete'],
      ['J / K', 'vi.h.swap'],
      ['ce', 'vi.h.connect'],
      ['u / Ctrl-r', 'vi.h.undo'],
      ['.', 'vi.h.repeat'],
      ['yy', 'vi.h.yank'],
      ['m', 'vi.h.menu'],
      ['v', 'vi.h.visual'],
      ['3j', 'vi.h.count'],
    ],
  },
  {
    title: 'vi.help.history',
    rows: [
      ['k / j', 'vi.h.histUpDown'],
      ['h / l', 'vi.h.histBranch'],
      ['=', 'vi.h.histDiff'],
      ['m', 'vi.h.histName'],
      ['gp', 'vi.h.histPlay'],
    ],
  },
  {
    title: 'vi.help.sidebar',
    rows: [
      ['j / k', 'vi.h.listMove'],
      ['/', 'vi.h.listSearch'],
      ['dd', 'vi.h.listTrash'],
      ['o', 'vi.h.listNew'],
    ],
  },
];

export function KeyHelp({ onClose }: { onClose(): void }) {
  const previousFocus = useRef<Element | null>(document.activeElement);
  const close = () => {
    onClose();
    if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?' || e.key === 'q') {
        e.preventDefault();
        close();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal key-help" role="dialog" aria-modal="true" aria-label={t('vi.help.title')}>
        <div className="modal-head">
          <h2>{t('vi.help.title')}</h2>
          <button className="btn" autoFocus onClick={close}>
            {t('vi.help.close')}
          </button>
        </div>
        <div className="key-help-body">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{t(s.title)}</h3>
              <dl>
                {s.rows.map(([k, d]) => (
                  <div key={k + d} className="key-help-row">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{t(d)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
