import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HistoryNode, HistoryTree } from '../core/history';
import { renderSvg, validate } from '../render/mermaid';
import { pluginFor } from '../plugins/registry';
import { diffDiagrams, diffItems, type DiffItem, type DiffKind } from '../render/diagramDiff';
import type { DiagramTarget } from '../plugins/types';
import { lineDiff } from './HistoryPane';
import { locale, t } from '../i18n';

// 図で見る差分（§8.4 の拡張）。履歴の 2 つの版を左右に描き、
// 前の版には消した要素（赤）と変えた要素（黄）、後の版には足した要素（緑）と変えた要素を光らせる。
// 別々の分岐の版どうしも比べられる。

const timeFmt = new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const CLASS: Record<DiffKind, string> = { added: 'mmd-diff-add', removed: 'mmd-diff-del', changed: 'mmd-diff-chg' };

interface SideResult {
  text: string;
  type: string | null;
  items: DiffItem[];
  targets: DiagramTarget[];
}

/** 版の一覧（新しい順）。今の版・名前付き・分岐の先がわかるようにする */
function versionOptions(tree: HistoryTree) {
  return [...tree.nodes.values()]
    .sort((a, b) => b.ts - a.ts || b.depth - a.depth)
    .map((n) => ({ id: n.id, label: describe(tree, n) }));
}

function describe(tree: HistoryTree, n: HistoryNode) {
  const tags = [n.id === tree.headId ? t('compare.head') : '', n.children.length === 0 && n.id !== tree.headId ? t('compare.tip') : '']
    .filter(Boolean)
    .join('');
  return `${timeFmt.format(n.ts)}  ${n.name ? `🔖${n.name}` : n.label}${tags}`;
}

/** 1 つの版を描き、要素に対応付ける。marks が来たら差分の色を付ける */
function Side({ text, title, marks, onReady }: { text: string; title: string; marks: Map<string, DiffKind> | null; onReady(r: SideResult): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<SideResult | null>(null);
  const [failed, setFailed] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let alive = true;
    setResult(null);
    setFailed(false);
    void (async () => {
      const v = await validate(text);
      const r = text.trim() === '' || !v.ok ? null : await renderSvg(text);
      if (!alive) return;
      const el = host.current;
      if (!el || !r?.ok) {
        if (el) el.innerHTML = '';
        setFailed(true);
        onReadyRef.current({ text, type: null, items: [], targets: [] });
        return;
      }
      el.innerHTML = r.svg;
      const svg = el.querySelector('svg')!;
      const type = v.ok ? v.diagramType : null;
      const targets = pluginFor(type).mapTargets(svg, text);
      const res = { text, type, items: diffItems(targets, text), targets };
      setResult(res);
      onReadyRef.current(res);
    })();
    return () => {
      alive = false;
    };
  }, [text]);

  useLayoutEffect(() => {
    if (!result) return;
    result.targets.forEach((x, i) => {
      const kind = marks?.get(result.items[i].key);
      for (const c of Object.values(CLASS)) x.el.classList.toggle(c, kind !== undefined && CLASS[kind] === c);
    });
  }, [result, marks]);

  return (
    <div className="compare-side">
      <div className="compare-side-title">{title}</div>
      <div className="compare-canvas" ref={host} />
      {failed && <pre className="compare-text">{text.split('\n').slice(0, 30).join('\n')}</pre>}
    </div>
  );
}

export function CompareView({ tree, initialBefore, initialAfter, onClose }: { tree: HistoryTree; initialBefore: string; initialAfter: string; onClose(): void }) {
  const [before, setBefore] = useState(initialBefore);
  const [after, setAfter] = useState(initialAfter);
  const options = useMemo(() => versionOptions(tree), [tree]);
  const textBefore = useMemo(() => tree.textAt(before), [tree, before]);
  const textAfter = useMemo(() => tree.textAt(after), [tree, after]);
  const [left, setLeft] = useState<SideResult | null>(null);
  const [right, setRight] = useState<SideResult | null>(null);

  // 両方が描けて、同じ図種のときだけ要素を比べる
  const diff = useMemo(() => {
    if (!left || !right || left.text !== textBefore || right.text !== textAfter) return null;
    if (!left.type || left.type !== right.type) return null;
    return diffDiagrams(left.items, right.items);
  }, [left, right, textBefore, textAfter]);
  const lines = useMemo(() => lineDiff(textBefore, textAfter), [textBefore, textAfter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const picker = (value: string, set: (v: string) => void, label: string) => (
    <label className="compare-pick">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)} aria-label={label}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="modal-backdrop compare-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal compare-view" role="dialog" aria-modal="true" aria-label={t('compare.title')}>
        <div className="compare-head">
          <h2>{t('compare.title')}</h2>
          {picker(before, setBefore, t('compare.before'))}
          <button className="icon-btn" title={t('compare.swap')} onClick={() => (setBefore(after), setAfter(before))}>
            ⇄
          </button>
          {picker(after, setAfter, t('compare.after'))}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            {t('compare.close')}
          </button>
        </div>
        <div className="compare-summary" role="status">
          {diff ? (
            <>
              <span className="diff-add">{t('compare.added', { n: String(diff.added) })}</span>
              <span className="diff-del">{t('compare.removed', { n: String(diff.removed) })}</span>
              <span className="diff-chg">{t('compare.changed', { n: String(diff.changed) })}</span>
            </>
          ) : left && right ? (
            <span className="muted">{t('compare.noElementDiff')}</span>
          ) : (
            <span className="muted">…</span>
          )}
          <span className="muted small">
            {t('compare.lines', { added: String(lines.added), removed: String(lines.removed) })}
          </span>
        </div>
        <div className="compare-body">
          <Side text={textBefore} title={t('compare.before')} marks={diff?.left ?? null} onReady={setLeft} />
          <Side text={textAfter} title={t('compare.after')} marks={diff?.right ?? null} onReady={setRight} />
        </div>
      </div>
    </div>
  );
}
