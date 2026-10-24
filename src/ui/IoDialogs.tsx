import { useEffect, useRef, useState } from 'react';
import { useIo } from '../io/ioStore';
import { exportImage, type Background, type ImageFormat } from '../io/exportImage';
import { ignoreExternalChange, reloadFromFile, saveFile } from '../io/files';
import { useSession } from '../core/session';
import { t } from '../i18n';

// 入出力まわりのダイアログとバナー。

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ExportDialog() {
  const [format, setFormat] = useState<ImageFormat>('png');
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState<Background>('white');
  const [busy, setBusy] = useState(false);
  const close = () => useIo.setState({ exportOpen: false });

  const run = async (action: 'download' | 'copy') => {
    setBusy(true);
    const ok = await exportImage({ format, scale, background }, action);
    setBusy(false);
    if (ok) close();
  };

  return (
    <Modal title={t('export.title')} onClose={close}>
      <fieldset className="field">
        <legend>{t('export.format')}</legend>
        {(['png', 'svg'] as const).map((f) => (
          <label key={f}>
            <input type="radio" name="format" checked={format === f} onChange={() => setFormat(f)} />
            {f.toUpperCase()}
          </label>
        ))}
      </fieldset>
      {format === 'png' && (
        <fieldset className="field">
          <legend>{t('export.scale')}</legend>
          {[1, 2, 3].map((s) => (
            <label key={s}>
              <input type="radio" name="scale" checked={scale === s} onChange={() => setScale(s)} />
              {s}x
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="field">
        <legend>{t('export.background')}</legend>
        <label>
          <input type="radio" name="bg" checked={background === 'white'} onChange={() => setBackground('white')} />
          {t('export.bgWhite')}
        </label>
        <label>
          <input
            type="radio"
            name="bg"
            checked={background === 'transparent'}
            onChange={() => setBackground('transparent')}
          />
          {t('export.bgTransparent')}
        </label>
      </fieldset>
      {format === 'png' && <p className="modal-note">{t('export.pngNote')}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          {t('common.cancel')}
        </button>
        <button className="btn" disabled={busy} onClick={() => void run('copy')}>
          {t('export.copy')}
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void run('download')}>
          {t('export.download')}
        </button>
      </div>
    </Modal>
  );
}

function BlockPicker() {
  const picker = useIo((s) => s.blockPicker)!;
  return (
    <Modal title={t('file.chooseBlock', { name: picker.name })} onClose={() => picker.resolve(null)}>
      <ul className="block-list">
        {picker.blocks.map((b) => (
          <li key={b.index}>
            <button className="block-item" onClick={() => picker.resolve(b.index)}>
              <span className="block-index">#{b.index + 1}</span>
              <pre>{b.text.split('\n').slice(0, 4).join('\n')}</pre>
            </button>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="btn" onClick={() => picker.resolve(null)}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  );
}

export function ConflictBanner() {
  const conflict = useIo((s) => s.conflict);
  const currentId = useSession((s) => s.current?.id);
  if (!conflict || conflict.docId !== currentId) return null;
  return (
    <div className="conflict-banner" role="alert">
      <span>
        {t(conflict.localChanges ? 'file.conflictLocal' : 'file.conflict', { name: conflict.name })}
      </span>
      <button className="btn" onClick={() => void reloadFromFile()}>
        {t('file.reload')}
      </button>
      <button className="btn" onClick={() => void saveFile({ force: true })}>
        {t('file.overwrite')}
      </button>
      <button className="btn ghost" onClick={() => void ignoreExternalChange()}>
        {t('file.ignore')}
      </button>
    </div>
  );
}

export function IoDialogs() {
  const exportOpen = useIo((s) => s.exportOpen);
  const picker = useIo((s) => s.blockPicker);
  return (
    <>
      {exportOpen && <ExportDialog />}
      {picker && <BlockPicker />}
    </>
  );
}
