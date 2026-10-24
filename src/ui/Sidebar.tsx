import { useEffect, useMemo, useState } from 'react';
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
import { thumbSrc, useThumbs } from '../render/thumbs';
import { getSetting, putSetting, type DocRecord } from '../storage/db';
import { t } from '../i18n';

const dateFmt = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type SortKey = 'updated' | 'created' | 'title';

const SORTS: Record<SortKey, (a: DocRecord, b: DocRecord) => number> = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) => a.title.localeCompare(b.title, 'ja'),
};

export function Sidebar() {
  const docs = useSession((s) => s.docs);
  const currentId = useSession((s) => s.current?.id);
  const thumbs = useThumbs((s) => s.byDoc);
  // 入力中は保存のたびに一覧が描き直されるので、SVG の符号化はサムネイルが変わったときだけにする
  const thumbUrls = useMemo(() => Object.fromEntries(Object.entries(thumbs).map(([id, svg]) => [id, thumbSrc(svg)])), [thumbs]);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('updated');
  const [showTrash, setShowTrash] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    void getSetting<SortKey>('docSort').then((v) => v && SORTS[v] && setSort(v));
  }, []);

  // 「#タグ」で検索するとタグで絞り込む
  const q = query.trim().toLowerCase();
  const hashTag = q.startsWith('#') ? q.slice(1) : null;
  const visible = useMemo(
    () =>
      docs
        .filter(
          (d) =>
            (showTrash ? d.deletedAt !== null : d.deletedAt === null) &&
            (!tag || d.tags.includes(tag)) &&
            (hashTag !== null
              ? d.tags.some((x) => x.toLowerCase().includes(hashTag))
              : q === '' || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q)),
        )
        .sort(SORTS[sort]),
    [docs, showTrash, tag, hashTag, q, sort],
  );
  const allTags = useMemo(() => [...new Set(docs.filter((d) => d.deletedAt === null).flatMap((d) => d.tags))].sort(), [docs]);

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
        <select
          aria-label={t('doc.sort')}
          value={sort}
          onChange={(e) => {
            const v = e.target.value as SortKey;
            setSort(v);
            void putSetting('docSort', v);
          }}
        >
          <option value="updated">{t('doc.sortUpdated')}</option>
          <option value="created">{t('doc.sortCreated')}</option>
          <option value="title">{t('doc.sortTitle')}</option>
        </select>
      </div>
      {allTags.length > 0 && !showTrash && (
        <div className="tag-filter">
          {allTags.map((x) => (
            <button key={x} className={`tag${tag === x ? ' active' : ''}`} onClick={() => setTag(tag === x ? null : x)}>
              #{x}
            </button>
          ))}
        </div>
      )}
      <ul className="doc-list">
        {visible.length === 0 && (
          <li className="doc-empty">{showTrash && q === '' ? t('doc.emptyTrash') : t('doc.noMatch')}</li>
        )}
        {visible.map((d) => (
          <li key={d.id} className={`doc-item${d.id === currentId ? ' active' : ''}`}>
            <button className="doc-open" onClick={() => !showTrash && void openDoc(d.id)} disabled={showTrash}>
              <span className="doc-thumb" aria-hidden>
                {thumbUrls[d.id] ? <img alt="" src={thumbUrls[d.id]} loading="lazy" /> : <span>{firstLine(d.text).slice(0, 2)}</span>}
              </span>
              <span className="doc-text">
                <span className="doc-title">{d.title || t('doc.untitled')}</span>
                <span className="doc-meta">
                  {firstLine(d.text)} ・ {dateFmt.format(d.updatedAt)}
                </span>
                {d.tags.length > 0 && (
                  <span className="doc-tags">
                    {d.tags.map((x) => (
                      <span key={x} className="tag small-tag">
                        #{x}
                      </span>
                    ))}
                  </span>
                )}
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
