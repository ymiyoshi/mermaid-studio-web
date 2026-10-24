import { useEffect, useMemo, useState } from 'react';
import { ChangeSet } from '@codemirror/state';
import { applyChanges, showToast, useSession } from '../core/session';
import { bodyLines } from '../plugins/source';
import { addSnippet, diagramKind, loadSnippets, normalizeSnippet, removeSnippet, snippetInsertion, useSnippets, type Snippet } from './snippets';
import { t } from '../i18n';

// 部品集の画面。選んだ範囲（または図の本文）を名前を付けて登録し、一覧から差し込む。

export function SnippetsDialog({ onClose }: { onClose(): void }) {
  const { loaded, items } = useSnippets();
  const current = useSession((s) => s.current);
  const selection = useSession((s) => s.selection);
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!loaded) void loadSnippets();
  }, [loaded]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const source = current?.text.toString() ?? '';
  const kind = diagramKind(source);
  const selected = source.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head));
  const editable = !!current && !current.readOnly;

  // 同じ図種の部品を先に出す
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter((s) => words.every((w) => `${s.name} ${s.kind} ${s.text}`.toLowerCase().includes(w)))
      .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind) || b.createdAt - a.createdAt);
  }, [items, q, kind]);

  const register = async (text: string) => {
    if (normalizeSnippet(text) === '') return;
    const s = await addSnippet(name, text, kind);
    setName('');
    showToast(t('snippet.added', { name: s.name }));
  };

  const insert = (s: Snippet) => {
    const cur = useSession.getState().current;
    if (!cur || cur.readOnly) return;
    const src = cur.text.toString();
    const r = snippetInsertion(src, useSession.getState().selection, s.text);
    applyChanges(ChangeSet.of({ from: r.from, to: r.to, insert: r.insert }, src.length), { origin: 'paste', label: t('snippet.inserted', { name: s.name }), selAfter: r.selection });
    onClose();
  };

  // 図の本文（宣言行より後）
  const body = bodyLines(source);
  const bodyText = body.header ? source.slice(body.header.to + 1) : '';

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal snippets-dialog" role="dialog" aria-modal="true" aria-label={t('snippet.title')}>
        <h2>{t('snippet.title')}</h2>
        <section className="snippet-register">
          <input value={name} placeholder={t('snippet.namePlaceholder')} aria-label={t('snippet.name')} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={selected.trim() === ''} onClick={() => void register(selected)}>
            {t('snippet.addSelection')}
          </button>
          <button className="btn" disabled={bodyText.trim() === ''} onClick={() => void register(bodyText)}>
            {t('snippet.addBody')}
          </button>
        </section>
        <input className="snippet-search" value={q} placeholder={t('snippet.search')} aria-label={t('snippet.search')} onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 ? (
          <p className="muted small">{items.length === 0 ? t('snippet.empty') : t('doc.noMatch')}</p>
        ) : (
          <ul className="snippet-list">
            {shown.map((s) => (
              <li key={s.id} className="snippet-item">
                <div className="snippet-head">
                  <strong>{s.name}</strong>
                  {s.kind && <span className={`badge${s.kind === kind ? '' : ' muted'}`}>{s.kind}</span>}
                  <span className="spacer" />
                  <button className="btn primary" disabled={!editable} onClick={() => insert(s)}>
                    {t('snippet.insert')}
                  </button>
                  <button className="icon-btn danger" title={t('snippet.remove')} onClick={() => void removeSnippet(s.id)}>
                    ✕
                  </button>
                </div>
                <pre>{s.text.split('\n').slice(0, 4).join('\n')}</pre>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t('compare.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
