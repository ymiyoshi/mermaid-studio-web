import { renameCurrent, useSession } from '../core/session';
import { HeaderMenus, SettingsMenu } from './HeaderMenus';
import { TagEditor } from './TagEditor';
import { togglePane, useLayout } from './layoutStore';
import { t } from '../i18n';

export function Header() {
  const current = useSession((s) => s.current);
  useSession((s) => s.rev);
  const sidebarOpen = useLayout((s) => s.sidebarOpen);

  return (
    <header className="app-header">
      <button
        className={`icon-btn pane-toggle${sidebarOpen ? ' active' : ''}`}
        title={t('layout.toggleList')}
        aria-pressed={sidebarOpen}
        onClick={() => togglePane('sidebarOpen')}
      >
        ☰
      </button>
      <div className="brand">
        {/* GitHub Pages ではサブパス（/<リポジトリ名>/）に置くので、base からの相対にする */}
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={22} height={22} />
        <span>{t('app.title')}</span>
      </div>
      <HeaderMenus />
      <input
        className="title-input"
        value={current?.title ?? ''}
        placeholder={t('doc.untitled')}
        disabled={!current || current.readOnly}
        onChange={(e) => void renameCurrent(e.target.value)}
        aria-label="title"
      />
      <TagEditor />
      {current?.file && (
        <span
          className="file-badge"
          title={current.text.toString() !== current.file.savedText ? t('file.unsaved') : t('file.bound')}
        >
          📄 {current.file.name}
          {current.text.toString() !== current.file.savedText && <span className="dirty-dot">●</span>}
        </span>
      )}
      {current?.readOnly && (
        <span className="badge warn" title={t('readonly.otherTab')}>
          {t('readonly.badge')}
        </span>
      )}
      <div className="header-actions">
        <SettingsMenu />
      </div>
    </header>
  );
}
