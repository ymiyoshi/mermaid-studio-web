import { useEffect, useMemo, useRef, useState } from 'react';
import { duplicateFromHistory, jumpTo, useSession } from '../core/session';
import type { Origin } from '../core/history';
import { layoutHistory } from './historyLayout';
import { t } from '../i18n';

const ROW_H = 30;
const LANE_W = 14;

const ORIGIN_ICON: Record<Origin, string> = {
  init: '★',
  typing: '⌨',
  'diagram-op': '◇',
  paste: '⎘',
  'file-load': '⇩',
  restore: '↺',
};

const timeFmt = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function HistoryPane() {
  const current = useSession((s) => s.current);
  const rev = useSession((s) => s.rev);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => {
    if (!current) return null;
    return layoutHistory(current.tree.nodes, current.tree.rootId, current.tree.headId, expanded);
    // 履歴ツリーは中身を書き換えるオブジェクトなので、rev で変化を検知する
  }, [current?.tree, rev, expanded]);

  const headId = current?.tree.headId;
  const headRow = layout?.rows.findIndex((r) => r.kind === 'node' && r.node.id === headId) ?? -1;

  // head が見えるようにスクロールする
  useEffect(() => {
    const el = listRef.current;
    if (!el || headRow < 0) return;
    const top = headRow * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 2;
    }
  }, [headRow]);

  if (!current || !layout) return <section className="pane history-pane" />;

  const width = layout.lanes * LANE_W + 6;
  const cx = (lane: number) => lane * LANE_W + LANE_W / 2 + 3;
  const cy = (row: number) => row * ROW_H + ROW_H / 2;
  const total = current.tree.nodes.size - 1;

  return (
    <section className="pane history-pane">
      <div className="pane-toolbar">
        <span className="pane-title">{t('history.title')}</span>
        <span className="spacer" />
        <span className="muted small">{t('history.steps', { n: String(total) })}</span>
      </div>
      <div className="history-list" ref={listRef}>
        <div className="history-inner" style={{ height: layout.rows.length * ROW_H }}>
          <svg className="history-graph" width={width} height={layout.rows.length * ROW_H} aria-hidden>
            {layout.edges.map((e, i) => {
              const x1 = cx(e.fromLane);
              const y1 = cy(e.fromRow);
              const x2 = cx(e.toLane);
              const y2 = cy(e.toRow);
              const d =
                x1 === x2
                  ? `M${x1},${y1} L${x2},${y2}`
                  : `M${x1},${y1} C${x1},${y1 + ROW_H * 0.8} ${x2},${y1 + ROW_H * 0.2} ${x2},${y1 + ROW_H} L${x2},${y2}`;
              return <path key={i} d={d} className="history-edge" />;
            })}
            {layout.rows.map((r, i) =>
              r.kind === 'node' ? (
                <circle
                  key={r.node.id}
                  cx={cx(r.lane)}
                  cy={cy(i)}
                  r={r.node.id === headId ? 6 : 4}
                  className={r.node.id === headId ? 'history-dot head' : 'history-dot'}
                />
              ) : (
                <circle key={r.key} cx={cx(r.lane)} cy={cy(i)} r={2.5} className="history-dot fold" />
              ),
            )}
          </svg>
          {layout.rows.map((r, i) =>
            r.kind === 'node' ? (
              <div
                key={r.node.id}
                className={`history-row${r.node.id === headId ? ' head' : ''}`}
                style={{ top: i * ROW_H, left: width, height: ROW_H }}
                onClick={() => jumpTo(r.node.id)}
                title={`${r.node.label}\n${new Date(r.node.ts).toLocaleString('ja-JP')}`}
              >
                <span className="history-icon">{ORIGIN_ICON[r.node.origin]}</span>
                <span className="history-label">{r.node.label}</span>
                <span className="history-time">{timeFmt.format(r.node.ts)}</span>
                <button
                  className="history-dup"
                  title={t('history.duplicate')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void duplicateFromHistory(r.node.id);
                  }}
                >
                  ⧉
                </button>
              </div>
            ) : (
              <div
                key={r.key}
                className="history-row fold"
                style={{ top: i * ROW_H, left: width, height: ROW_H }}
                onClick={() => setExpanded((s) => new Set(s).add(r.key))}
              >
                <span className="history-label">{t('history.folded', { n: String(r.ids.length) })}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </section>
  );
}
