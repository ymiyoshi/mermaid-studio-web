import { useState } from 'react';
import { closeFolder, openFolderFile, rescanFolder, useFolders } from '../io/folders';
import { t } from '../i18n';

// 図の一覧の上に出す、開いたフォルダの中のファイル（設計書 §17.9）

export function FolderSection({ query }: { query: string }) {
  const folders = useFolders((s) => s.folders);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (folders.length === 0) return null;
  const q = query.trim().toLowerCase();
  return (
    <div className="folder-section">
      {folders.map((f) => {
        const files = q && !q.startsWith('#') ? f.files.filter((x) => x.path.toLowerCase().includes(q)) : f.files;
        const open = !collapsed[f.id];
        return (
          <section key={f.id} className="folder" aria-label={t('folder.label', { name: f.name })}>
            <div className="folder-head">
              <button className="folder-toggle" aria-expanded={open} onClick={() => setCollapsed((c) => ({ ...c, [f.id]: open }))}>
                {open ? '▾' : '▸'} 📁 {f.name}
              </button>
              <span className="spacer" />
              <button className="icon-btn" title={t('folder.rescan')} onClick={() => void rescanFolder(f.id, true)}>
                ↻
              </button>
              <button className="icon-btn" title={t('folder.close')} onClick={() => void closeFolder(f.id)}>
                ✕
              </button>
            </div>
            {open && (
              <ul className="folder-files">
                {f.status === 'permission' && (
                  <li>
                    <button className="btn" onClick={() => void rescanFolder(f.id, true)}>
                      {t('folder.allow')}
                    </button>
                  </li>
                )}
                {f.status === 'scanning' && <li className="muted small">{t('folder.scanning')}</li>}
                {f.status === 'error' && <li className="muted small">{t('folder.error')}</li>}
                {f.status === 'ready' && files.length === 0 && <li className="muted small">{q ? t('doc.noMatch') : t('folder.empty')}</li>}
                {f.status === 'ready' &&
                  files.map((x) => (
                    <li key={x.path}>
                      <button className="folder-file" title={x.path} onClick={() => void openFolderFile(x)}>
                        {x.path}
                      </button>
                    </li>
                  ))}
                {f.truncated && <li className="muted small">{t('folder.truncated')}</li>}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
