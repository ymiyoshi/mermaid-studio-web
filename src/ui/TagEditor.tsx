import { useState } from 'react';
import { setTags, useSession } from '../core/session';
import { t } from '../i18n';

// 図のタグ（§9.2）。Enter で追加、✕ で外す。

export function TagEditor() {
  const current = useSession((s) => s.current);
  const [draft, setDraft] = useState('');
  if (!current) return null;
  const tags = current.tags;

  const add = () => {
    if (draft.trim()) setTags([...tags, ...draft.split(/[,\s]+/)]);
    setDraft('');
  };

  return (
    <div className="tag-editor">
      {tags.map((x) => (
        <span key={x} className="tag">
          #{x}
          {!current.readOnly && (
            <button aria-label={t('tags.remove', { tag: x })} onClick={() => setTags(tags.filter((y) => y !== x))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!current.readOnly && (
        <input
          className="tag-input"
          value={draft}
          placeholder={t('tags.add')}
          aria-label={t('tags.add')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') add();
            else if (e.key === 'Backspace' && draft === '' && tags.length) setTags(tags.slice(0, -1));
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}
