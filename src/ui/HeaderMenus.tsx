import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hasFileSystemAccess, openFile, saveFile } from '../io/files';
import { exportBackup, importBackup } from '../io/backup';
import { useIo } from '../io/ioStore';
import { copyShareLink } from '../io/shareActions';
import { redo, setTheme, undo, useSession } from '../core/session';
import type { Theme } from '../render/mermaid';
import { runDiagramCommand } from './commands';
import { togglePane, useLayout } from './layoutStore';
import { setKeymap, useKeymap, type Keymap } from './keymapStore';
import { useMobile } from './useAppEvents';
import { getLang, setLang, t, type Lang } from '../i18n';

// ヘッダーのメニュー（ファイル・編集・表示・設定）。分け方と並びはコマンドパレット（commands.ts）にそろえる。

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

const THEMES: Theme[] = ['default', 'neutral', 'forest', 'dark'];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * ボタンと、開くと出る欄。外を押すか Esc で閉じる。
 * 設定の欄には select があるので、マウスが離れただけでは閉じない（select の一覧は欄の外に出るため）。
 */
function Dropdown(props: {
  label: ReactNode;
  /** label が記号だけのときの名前 */
  name?: string;
  title?: string;
  className?: string;
  align: 'left' | 'right';
  /** 'menu' は項目の並び、'dialog' は入力欄を置く欄 */
  role: 'menu' | 'dialog';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div
      className="menu-anchor"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.stopPropagation();
        close();
        button.current?.focus();
      }}
    >
      <button
        ref={button}
        className={`btn ghost menubar-btn${props.className ? ` ${props.className}` : ''}`}
        aria-haspopup={props.role}
        aria-expanded={open}
        aria-label={props.name}
        title={props.title}
        onClick={() => setOpen((v) => !v)}
      >
        {props.label}
      </button>
      {open && (
        <div
          className={`menu${props.align === 'left' ? ' menu-left' : ''}${props.role === 'dialog' ? ' settings-menu' : ''}`}
          role={props.role}
          aria-label={props.name ?? (typeof props.label === 'string' ? props.label : undefined)}
        >
          {props.children(close)}
        </div>
      )}
    </div>
  );
}

/** メニューの項目。押すとメニューを閉じてから実行する */
function Item(props: { close: () => void; label: string; run: () => void; shortcut?: string; disabled?: boolean; checked?: boolean }) {
  const check = props.checked !== undefined;
  return (
    <button
      role={check ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={check ? props.checked : undefined}
      className="menu-item"
      disabled={props.disabled}
      onClick={() => {
        props.close();
        props.run();
      }}
    >
      <span>
        {check && <span className="menu-check">{props.checked ? '✓' : ''}</span>}
        {props.label}
      </span>
      {props.shortcut && <kbd>{props.shortcut}</kbd>}
    </button>
  );
}

export function HeaderMenus() {
  const current = useSession((s) => s.current);
  useSession((s) => s.rev);
  const hasDoc = !!current;
  const canUndo = !!current && !current.readOnly && current.tree.canUndo();
  const canRedo = !!current && !current.readOnly && current.tree.canRedo();
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const historyOpen = useLayout((s) => s.historyOpen);
  const keymap = useKeymap((s) => s.keymap);
  // 狭い画面はタブで切り替えるので、ペインの表示・非表示は出さない
  const mobile = useMobile();

  return (
    <nav className="menubar" aria-label={t('menu.bar')}>
      <Dropdown label={t('cmd.groupFile')} align="left" role="menu">
        {(close) => (
          <>
            <Item close={close} label={t('menu.open')} run={() => void openFile()} shortcut={`${mod}O`} />
            <Item close={close} label={t('menu.save')} run={() => void saveFile()} shortcut={`${mod}S`} disabled={!hasDoc} />
            <Item close={close} label={t('menu.saveAs')} run={() => void saveFile({ saveAs: true })} shortcut={`${mod}Shift+S`} disabled={!hasDoc} />
            {!hasFileSystemAccess() && <div className="menu-note">{t('menu.downloadNote')}</div>}
            <div className="menu-sep" />
            <Item close={close} label={t('menu.exportImage')} run={() => useIo.setState({ exportOpen: true })} shortcut={`${mod}Shift+E`} disabled={!hasDoc} />
            <Item close={close} label={t('menu.share')} run={() => void copyShareLink()} disabled={!hasDoc} />
            <div className="menu-sep" />
            <Item close={close} label={t('menu.backupExport')} run={() => void exportBackup()} />
            <Item close={close} label={t('menu.backupImport')} run={() => void importBackup()} />
          </>
        )}
      </Dropdown>
      <Dropdown label={t('cmd.groupEdit')} align="left" role="menu">
        {(close) => (
          <>
            <Item close={close} label={t('menu.undo')} run={undo} shortcut={`${mod}Z`} disabled={!canUndo} />
            <Item close={close} label={t('menu.redo')} run={redo} shortcut={`${mod}Shift+Z`} disabled={!canRedo} />
          </>
        )}
      </Dropdown>
      <Dropdown label={t('cmd.groupView')} align="left" role="menu">
        {(close) => (
          <>
            {!mobile && (
              <>
                <Item close={close} label={t('menu.list')} run={() => togglePane('sidebarOpen')} checked={sidebarOpen} />
                <Item close={close} label={t('menu.history')} run={() => togglePane('historyOpen')} checked={historyOpen} />
                <div className="menu-sep" />
              </>
            )}
            <Item close={close} label={t('toolbar.fit')} run={() => runDiagramCommand('fit')} disabled={!hasDoc} />
            <Item close={close} label={t('toolbar.zoomIn')} run={() => runDiagramCommand('zoomIn')} disabled={!hasDoc} />
            <Item close={close} label={t('toolbar.zoomOut')} run={() => runDiagramCommand('zoomOut')} disabled={!hasDoc} />
            <Item close={close} label={t('cmd.togglePanel')} run={() => runDiagramCommand('togglePanel')} disabled={!hasDoc} />
            <div className="menu-sep" />
            <Item close={close} label={t('menu.present')} run={() => useLayout.setState({ presentOpen: true })} />
            <Item close={close} label={t('menu.snippets')} run={() => useLayout.setState({ snippetsOpen: true })} disabled={!hasDoc} />
            <Item close={close} label={t('menu.timelapse')} run={() => useLayout.setState({ timelapseOpen: true })} disabled={!hasDoc} />
            <div className="menu-sep" />
            <Item close={close} label={t('cmd.keyHelp')} run={() => useKeymap.setState({ helpOpen: true })} shortcut={keymap === 'vi' ? '?' : undefined} />
          </>
        )}
      </Dropdown>
    </nav>
  );
}

/** 設定（言語・キー・テーマ）と保存領域の使用量。永続化されていないときだけ、ボタンに ⚠ を出す */
export function SettingsMenu() {
  const theme = useSession((s) => s.theme);
  const storage = useSession((s) => s.storage);
  const keymap = useKeymap((s) => s.keymap);
  const warn = !!storage && !storage.persisted;

  return (
    <Dropdown
      label={
        <>
          {/* 字形が小さいフォントがあるので、絵文字として出す */}
          {'⚙️'}
          {warn && <span className="settings-warn"> ⚠</span>}
        </>
      }
      name={t('cmd.groupSettings')}
      className="settings-btn"
      title={warn ? `${t('cmd.groupSettings')}（${t('storage.notPersisted')}）` : t('cmd.groupSettings')}
      align="right"
      role="dialog"
    >
      {() => (
        <>
          <label className="setting-row">
            <span>{t('lang.label')}</span>
            {/* 言語の名前は、それぞれの言語で書く */}
            <select value={getLang()} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('lang.label')}>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="setting-row">
            <span>{t('keymap.label')}</span>
            <select value={keymap} onChange={(e) => setKeymap(e.target.value as Keymap)} aria-label={t('keymap.label')}>
              <option value="standard">{t('keymap.standard')}</option>
              <option value="vi">{t('keymap.vi')}</option>
            </select>
          </label>
          <label className="setting-row">
            <span>{t('toolbar.theme')}</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)} aria-label={t('toolbar.theme')}>
              {THEMES.map((th) => (
                <option key={th} value={th}>
                  {th}
                </option>
              ))}
            </select>
          </label>
          {storage && (
            <>
              <div className="menu-sep" />
              <div className={`storage${warn ? ' warn' : ''}`}>
                {t('storage.usage', { used: formatBytes(storage.usage), quota: formatBytes(storage.quota) })}
                {warn && <div>{t('storage.notPersisted')}</div>}
              </div>
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}
