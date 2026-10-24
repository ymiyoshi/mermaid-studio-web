import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCommands, filterCommands, type Command } from './commands';
import { t } from '../i18n';

// コマンドパレット（Ctrl+K / Ctrl+Shift+P）。打って絞り込み、↑↓ で選んで Enter で実行する。

export function CommandPalette({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useMemo(() => buildCommands(), []);
  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);
  const list = useRef<HTMLUListElement>(null);
  const previousFocus = useRef<Element | null>(document.activeElement);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus && previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    close(false);
    c.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('cmd.title')}>
        <input
          autoFocus
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
          placeholder={t('cmd.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // 変換確定の Enter では実行しない
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, shown.length - 1));
            else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
            else if (e.key === 'Enter') run(shown[active]);
            else if (e.key === 'Escape') close();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <li className="palette-empty muted">{t('cmd.empty')}</li>}
          {shown.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === active}
              className={`palette-item${i === active ? ' active' : ''}`}
              onPointerMove={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-title">{c.title}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
