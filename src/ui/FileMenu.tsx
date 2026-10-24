import { useEffect, useRef, useState } from 'react';
import { hasFileSystemAccess, openFile, saveFile } from '../io/files';
import { exportBackup, importBackup } from '../io/backup';
import { useIo } from '../io/ioStore';
import { copyShareLink } from '../io/shareActions';
import { useSession } from '../core/session';
import { t } from '../i18n';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = useSession((s) => s.current);
  const disabled = !current;

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [open]);

  const item = (label: string, run: () => void, shortcut?: string, isDisabled = false) => (
    <button
      role="menuitem"
      className="menu-item"
      disabled={isDisabled}
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t('menu.file')} ▾
      </button>
      {open && (
        <div className="menu menu-left" role="menu">
          {item(t('menu.open'), () => void openFile(), `${mod}O`)}
          {item(t('menu.save'), () => void saveFile(), `${mod}S`, disabled)}
          {item(t('menu.saveAs'), () => void saveFile({ saveAs: true }), `${mod}Shift+S`, disabled)}
          {!hasFileSystemAccess() && <div className="menu-note">{t('menu.downloadNote')}</div>}
          <div className="menu-sep" />
          {item(t('menu.exportImage'), () => useIo.setState({ exportOpen: true }), `${mod}Shift+E`, disabled)}
          {item(t('menu.share'), () => void copyShareLink(), undefined, disabled)}
          <div className="menu-sep" />
          {item(t('menu.backupExport'), () => void exportBackup())}
          {item(t('menu.backupImport'), () => void importBackup())}
        </div>
      )}
    </div>
  );
}
