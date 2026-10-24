import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../core/session';
import { renderSvg } from '../render/mermaid';
import type { DocRecord } from '../storage/db';
import { t } from '../i18n';

// 発表モード: 選んだ図を全画面で 1 枚ずつ見せる。← → / Space / PageUp / PageDown で送り、Esc で終える。
// 最初に、見せる図をタグで絞り、並び順を決める。

type Order = 'updated' | 'title' | 'created';

/** 見せる図の並び（ゴミ箱の図は除く） */
export function slideOrder(docs: DocRecord[], tag: string, order: Order): DocRecord[] {
  const list = docs.filter((d) => d.deletedAt === null && (tag === '' || d.tags.includes(tag)));
  const by: Record<Order, (a: DocRecord, b: DocRecord) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => a.createdAt - b.createdAt,
    title: (a, b) => a.title.localeCompare(b.title, 'ja'),
  };
  return [...list].sort(by[order]);
}

function Slides({ slides, onClose }: { slides: { id: string; title: string; text: string }[]; onClose(): void }) {
  const [index, setIndex] = useState(0);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[index];

  useEffect(() => {
    let alive = true;
    setFailed(false);
    void renderSvg(slide.text).then((r) => {
      if (!alive) return;
      setSvg(r.ok ? r.svg : null);
      setFailed(!r.ok);
    });
    return () => {
      alive = false;
    };
  }, [slide.text]);

  // 全画面にする（できなければ画面いっぱいの表示のまま）。全画面を抜けたら発表も終える
  useEffect(() => {
    const el = root.current;
    el?.requestFullscreen?.().catch(() => {});
    const onChange = () => !document.fullscreenElement && onClose();
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) setIndex((i) => Math.min(i + 1, slides.length - 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(slides.length - 1);
      else if (e.key === 'Escape') onClose();
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [slides.length, onClose]);

  return (
    <div className="presentation" ref={root} role="dialog" aria-modal="true" aria-label={t('present.title')}>
      {/* 左右の半分をクリックしても送れる */}
      <div
        className="presentation-stage"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setIndex((i) => (e.clientX < r.left + r.width / 3 ? Math.max(i - 1, 0) : Math.min(i + 1, slides.length - 1)));
        }}
      >
        {failed ? <pre className="presentation-error">{slide.text}</pre> : <div className="presentation-svg" dangerouslySetInnerHTML={{ __html: svg ?? '' }} />}
      </div>
      <div className="presentation-bar">
        <span className="presentation-title">{slide.title}</span>
        <span role="status">
          {index + 1} / {slides.length}
        </span>
        <button className="btn ghost" onClick={onClose}>
          {t('present.exit')}
        </button>
      </div>
    </div>
  );
}

export function PresentationView({ onClose }: { onClose(): void }) {
  const docs = useSession((s) => s.docs);
  const current = useSession((s) => s.current);
  const [tag, setTag] = useState(() => current?.tags[0] ?? '');
  const [order, setOrder] = useState<Order>('updated');
  const [started, setStarted] = useState(false);
  const tags = useMemo(() => [...new Set(docs.filter((d) => d.deletedAt === null).flatMap((d) => d.tags))].sort(), [docs]);
  // 開いている図は、保存前の最新の内容で見せる
  const slides = useMemo(
    () =>
      slideOrder(docs, tag, order)
        .map((d) => ({ id: d.id, title: d.title || t('doc.untitled'), text: d.id === current?.id ? current.text.toString() : d.text }))
        .filter((s) => s.text.trim() !== ''),
    [docs, tag, order, current],
  );

  useEffect(() => {
    if (started) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [started, onClose]);

  if (started && slides.length > 0) return <Slides slides={slides} onClose={onClose} />;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('present.title')}>
        <h2>{t('present.title')}</h2>
        <label className="field-row">
          <span>{t('present.tag')}</span>
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t('present.tag')}>
            <option value="">{t('present.allTags')}</option>
            {tags.map((x) => (
              <option key={x} value={x}>
                #{x}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span>{t('present.order')}</span>
          <select value={order} onChange={(e) => setOrder(e.target.value as Order)} aria-label={t('present.order')}>
            <option value="updated">{t('doc.sortUpdated')}</option>
            <option value="created">{t('present.created')}</option>
            <option value="title">{t('doc.sortTitle')}</option>
          </select>
        </label>
        <ol className="present-list">
          {slides.map((s) => (
            <li key={s.id}>{s.title}</li>
          ))}
        </ol>
        <p className="modal-note">{t('present.keys')}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={slides.length === 0} onClick={() => setStarted(true)}>
            {t('present.start', { n: String(slides.length) })}
          </button>
        </div>
      </div>
    </div>
  );
}
