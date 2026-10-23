import { redo, renameCurrent, setTheme, undo, useSession } from '../core/session';
import type { Theme } from '../render/mermaid';
import { t } from '../i18n';

const THEMES: Theme[] = ['default', 'neutral', 'forest', 'dark'];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function Header() {
  const current = useSession((s) => s.current);
  useSession((s) => s.rev);
  const theme = useSession((s) => s.theme);
  const storage = useSession((s) => s.storage);
  const canUndo = !!current && !current.readOnly && current.tree.canUndo();
  const canRedo = !!current && !current.readOnly && current.tree.canRedo();

  return (
    <header className="app-header">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={22} height={22} />
        <span>{t('app.title')}</span>
      </div>
      <input
        className="title-input"
        value={current?.title ?? ''}
        placeholder={t('doc.untitled')}
        disabled={!current || current.readOnly}
        onChange={(e) => void renameCurrent(e.target.value)}
        aria-label="title"
      />
      {current?.readOnly && (
        <span className="badge warn" title={t('readonly.otherTab')}>
          {t('readonly.badge')}
        </span>
      )}
      <div className="header-actions">
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title={t('toolbar.undo')}>
          ↶
        </button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title={t('toolbar.redo')}>
          ↷
        </button>
        <label className="theme-select">
          <span>{t('toolbar.theme')}</span>
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            {THEMES.map((th) => (
              <option key={th} value={th}>
                {th}
              </option>
            ))}
          </select>
        </label>
        {storage && (
          <span
            className={`storage${storage.persisted ? '' : ' warn'}`}
            title={storage.persisted ? '' : t('storage.notPersisted')}
          >
            {t('storage.usage', { used: formatBytes(storage.usage), quota: formatBytes(storage.quota) })}
          </span>
        )}
      </div>
    </header>
  );
}
