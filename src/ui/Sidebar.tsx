import { useState } from 'react';
import {
  createFromTemplate,
  duplicateDoc,
  openDoc,
  purgeDoc,
  restoreDoc,
  trashDoc,
  useSession,
} from '../core/session';
import { TEMPLATES } from '../core/templates';
import { t } from '../i18n';

const dateFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Sidebar() {
  const docs = useSession((s) => s.docs);
  const currentId = useSession((s) => s.current?.id);
  const [query, setQuery] = useState('');
  const [showTrash, setShowTrash] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const q = query.trim().toLowerCase();
  const visible = docs.filter(
    (d) =>
      (showTrash ? d.deletedAt !== null : d.deletedAt === null) &&
      (q === '' || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q)),
  );

  return (
    <aside className="pane sidebar">
      <div className="pane-toolbar">
        <span className="pane-title">{showTrash ? t('doc.trash') : t('doc.list')}</span>
        <span className="spacer" />
        {!showTrash && (
          <div className="menu-anchor">
            <button className="btn primary" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen}>
              ＋ {t('doc.new')}
            </button>
            {menuOpen && (
              <div className="menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void createFromTemplate(tpl.id);
                    }}
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-search">
        <input
          type="search"
          placeholder={t('doc.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('doc.search')}
        />
      </div>
      <ul className="doc-list">
        {visible.length === 0 && (
          <li className="doc-empty">{showTrash && q === '' ? t('doc.emptyTrash') : t('doc.noMatch')}</li>
        )}
        {visible.map((d) => (
          <li key={d.id} className={`doc-item${d.id === currentId ? ' active' : ''}`}>
            <button className="doc-open" onClick={() => !showTrash && void openDoc(d.id)} disabled={showTrash}>
              <span className="doc-title">{d.title || t('doc.untitled')}</span>
              <span className="doc-meta">
                {firstLine(d.text)} ・ {dateFmt.format(d.updatedAt)}
              </span>
            </button>
            <span className="doc-actions">
              {showTrash ? (
                <>
                  <button className="icon-btn" title={t('doc.restore')} onClick={() => void restoreDoc(d.id)}>
                    ↺
                  </button>
                  <button className="icon-btn danger" title={t('doc.purge')} onClick={() => void purgeDoc(d.id)}>
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <button className="icon-btn" title={t('doc.duplicate')} onClick={() => void duplicateDoc(d.id)}>
                    ⧉
                  </button>
                  <button className="icon-btn" title={t('doc.delete')} onClick={() => void trashDoc(d.id)}>
                    🗑
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <button className="btn ghost" onClick={() => setShowTrash((v) => !v)}>
          {showTrash ? `← ${t('doc.list')}` : `🗑 ${t('doc.trash')}`}
        </button>
      </div>
    </aside>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('%%') && l.trim() !== '---');
  return line?.trim().split(/\s/)[0] ?? '—';
}
