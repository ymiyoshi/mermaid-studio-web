import { useEffect, useMemo, useRef, useState } from 'react';
import { duplicateFromHistory, jumpTo, nameCheckpoint, pruneBranches, redo, showToast, undo, useSession } from '../core/session';
import type { HistoryNode, HistoryTree, Origin } from '../core/history';
import { renderSvg } from '../render/mermaid';
import { layoutHistory } from './historyLayout';
import { CompareView } from './CompareView';
import { useLayout } from './layoutStore';
import { registerViPane } from './viDispatch';
import { locale, t } from '../i18n';

const ROW_H = 30;
const LANE_W = 14;
const PREVIEW_DELAY_MS = 350;
/** 見えている範囲の上下に余分に描く行の数 */
const OVERSCAN = 10;
/** 高さを測れないとき（描画前・テスト環境）に仮定する表示領域の高さ */
const FALLBACK_HEIGHT = 800;

const ORIGIN_ICON: Record<Origin, string> = {
  init: '★',
  typing: '⌨',
  'diagram-op': '◇',
  paste: '⎘',
  'file-load': '⇩',
  restore: '↺',
};

/** vi のキー（設計書 §16.5） */
const VI_HISTORY = ['j', 'k', 'h', 'l', 'u', '<C-r>', '=', 'm', 'g p'];

/** head から根へたどって最初に兄弟のある版から、dir の向きの兄弟の分岐の先端（最後に訪れた子をたどる）。無ければ null */
export function siblingBranchTip(tree: HistoryTree, dir: -1 | 1): string | null {
  let node = tree.head;
  while (node.parentId !== null) {
    const parent = tree.get(node.parentId);
    if (parent.children.length > 1) {
      const i = parent.children.indexOf(node.id);
      const sib = parent.children[(i + dir + parent.children.length) % parent.children.length];
      let tip = tree.get(sib);
      while (tip.children.length > 0) tip = tree.get(tip.lastChild ?? tip.children.at(-1)!);
      return tip.id;
    }
    node = parent;
  }
  return null;
}

const timeFmt = new Intl.DateTimeFormat(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 行の追加・削除の数（順番は見ない簡易な差分） */
export function lineDiff(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of before.split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split('\n')) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of count.values()) removed += c;
  return { added, removed };
}

interface Preview {
  node: HistoryNode;
  top: number;
  right: number;
}

/** 履歴の行にマウスを置いたときの、その版の図と差分（§8.4） */
function HistoryPreview({ tree, preview }: { tree: HistoryTree; preview: Preview }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const text = useMemo(() => tree.textAt(preview.node.id), [tree, preview.node.id]);
  const diff = useMemo(
    () => (preview.node.parentId ? lineDiff(tree.textAt(preview.node.parentId), text) : null),
    [tree, preview.node, text],
  );

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setFailed(false);
    if (text.trim() === '') return;
    void renderSvg(text).then((r) => {
      if (!alive) return;
      if (r.ok) setSvg(r.svg);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [text]);

  return (
    <div className="history-preview" style={{ top: preview.top, right: preview.right }} role="tooltip">
      <div className="preview-head">
        <strong>{preview.node.name ?? preview.node.label}</strong>
        <span className="muted small">{new Date(preview.node.ts).toLocaleString(locale())}</span>
        {diff && (
          <span className="small">
            <span className="diff-add">+{diff.added}</span> <span className="diff-del">−{diff.removed}</span> {t('history.lines')}
          </span>
        )}
      </div>
      <div className="preview-body">
        {svg ? (
          <img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} />
        ) : failed ? (
          <pre>{text.split('\n').slice(0, 12).join('\n')}</pre>
        ) : (
          <span className="muted small">…</span>
        )}
      </div>
    </div>
  );
}

export function HistoryPane() {
  const current = useSession((s) => s.current);
  const rev = useSession((s) => s.rev);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [compare, setCompare] = useState<{ before: string; after: string } | null>(null);
  // タイムラプスは App が出す（履歴のペインを閉じていても、コマンドパレットから開けるように）
  const setTimelapse = (v: boolean) => useLayout.setState({ timelapseOpen: v });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 長い履歴でも入力のたびに全行を描き直さないよう、見えている行だけを描く
  const [viewport, setViewport] = useState({ top: 0, height: FALLBACK_HEIGHT });
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const next = { top: el.scrollTop, height: el.clientHeight || FALLBACK_HEIGHT };
    setViewport((v) => (v.top === next.top && v.height === next.height ? v : next));
  };
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [current !== null]);

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

  useEffect(() => () => void (hoverTimer.current && clearTimeout(hoverTimer.current)), []);

  // vi のキー: k / j で親・子の版へ、h / l で隣の分岐へ
  useEffect(
    () =>
      registerViPane('history', {
        commands: () => VI_HISTORY,
        run: (cmd, count) => {
          const cur = useSession.getState().current;
          if (!cur) return false;
          const repeat = (f: () => void) => {
            for (let n = 0; n < count; n++) f();
          };
          if (cmd === 'k' || cmd === 'u') repeat(undo);
          else if (cmd === 'j' || cmd === '<C-r>') repeat(redo);
          else if (cmd === 'h' || cmd === 'l') {
            const tip = siblingBranchTip(cur.tree, cmd === 'h' ? -1 : 1);
            if (tip) jumpTo(tip);
          } else if (cmd === '=') {
            const head = cur.tree.head;
            setCompare({ before: head.parentId ?? head.id, after: head.id });
          } else if (cmd === 'm') {
            if (!cur.readOnly) setNaming(cur.tree.headId);
          } else if (cmd === 'g p') {
            if (cur.tree.nodes.size > 1) setTimelapse(true);
          } else return false;
          return true;
        },
      }),
    [],
  );

  // 別の図に切り替えたら、前の図の版のプレビューを閉じる（待っているプレビューも出さない）
  const docId = current?.id;
  useEffect(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
    setCompare(null);
  }, [docId]);

  if (!current || !layout) return <section className="pane history-pane" tabIndex={-1} />;

  const width = layout.lanes * LANE_W + 6;
  const cx = (lane: number) => lane * LANE_W + LANE_W / 2 + 3;
  const cy = (row: number) => row * ROW_H + ROW_H / 2;
  const total = current.tree.nodes.size - 1;
  const branches = [...current.tree.nodes.values()].filter((n) => n.children.length > 1).length;
  // 短い履歴の図に切り替えた直後は、スクロール位置が古いことがあるので行数に収める
  const top = Math.min(viewport.top, Math.max(0, layout.rows.length * ROW_H - viewport.height));
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(layout.rows.length - 1, Math.ceil((top + viewport.height) / ROW_H) + OVERSCAN);
  const shown = layout.rows.slice(first, last + 1).map((r, k) => ({ r, i: first + k }));

  const hover = (node: HistoryNode, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      setPreview({ node, top: Math.max(8, Math.min(r.top - 40, innerHeight - 320)), right: innerWidth - r.left + 8 });
    }, PREVIEW_DELAY_MS);
  };
  const leave = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  };

  return (
    <section className="pane history-pane" tabIndex={-1}>
      <div className="pane-toolbar">
        <span className="pane-title">{t('history.title')}</span>
        <span className="spacer" />
        <span className="muted small">{t('history.steps', { n: String(total) })}</span>
        <button className="icon-btn" title={t('timelapse.open')} disabled={total === 0} onClick={() => (leave(), setTimelapse(true))}>
          ▶
        </button>
        <button
          className="icon-btn"
          title={t('history.prune')}
          disabled={current.readOnly || branches === 0}
          onClick={() => setConfirmPrune(true)}
        >
          ✂
        </button>
      </div>
      {confirmPrune && (
        <div className="prune-confirm" role="alertdialog">
          <p>{t('history.pruneConfirm')}</p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmPrune(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                setConfirmPrune(false);
                const n = await pruneBranches();
                showToast(t('history.pruned', { n: String(n) }));
              }}
            >
              {t('history.pruneRun')}
            </button>
          </div>
        </div>
      )}
      <div
        className="history-list"
        ref={listRef}
        onScroll={() => {
          leave();
          measure();
        }}
      >
        <div className="history-inner" style={{ height: layout.rows.length * ROW_H }}>
          <svg className="history-graph" width={width} height={layout.rows.length * ROW_H} aria-hidden>
            {layout.edges.map((e, i) => {
              if (e.toRow < first || e.fromRow > last) return null;
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
            {shown.map(({ r, i }) =>
              r.kind === 'node' ? (
                <circle
                  key={r.node.id}
                  cx={cx(r.lane)}
                  cy={cy(i)}
                  r={r.node.id === headId ? 6 : 4}
                  className={`history-dot${r.node.id === headId ? ' head' : ''}${r.node.name ? ' named' : ''}`}
                />
              ) : (
                <circle key={r.key} cx={cx(r.lane)} cy={cy(i)} r={2.5} className="history-dot fold" />
              ),
            )}
          </svg>
          {shown.map(({ r, i }) =>
            r.kind === 'node' ? (
              <div
                key={r.node.id}
                className={`history-row${r.node.id === headId ? ' head' : ''}${r.node.name ? ' named' : ''}`}
                style={{ top: i * ROW_H, left: width, height: ROW_H }}
                onClick={() => naming !== r.node.id && jumpTo(r.node.id)}
                onMouseEnter={(e) => hover(r.node, e.currentTarget)}
                onMouseLeave={leave}
              >
                <span className="history-icon">{r.node.name ? '🔖' : ORIGIN_ICON[r.node.origin]}</span>
                {naming === r.node.id ? (
                  <input
                    className="history-name-input"
                    autoFocus
                    defaultValue={r.node.name ?? ''}
                    placeholder={t('history.namePlaceholder')}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === 'Enter') {
                        nameCheckpoint(r.node.id, (e.target as HTMLInputElement).value);
                        setNaming(null);
                      } else if (e.key === 'Escape') setNaming(null);
                    }}
                    onBlur={(e) => {
                      nameCheckpoint(r.node.id, e.target.value);
                      setNaming(null);
                    }}
                  />
                ) : (
                  <span className="history-label">
                    {r.node.name && <span className="checkpoint-name">{r.node.name}</span>}
                    {r.node.label}
                  </span>
                )}
                <span className="history-time">{timeFmt.format(r.node.ts)}</span>
                <button
                  className="history-dup"
                  title={t('history.name')}
                  disabled={current.readOnly}
                  onClick={(e) => {
                    e.stopPropagation();
                    leave();
                    setNaming(r.node.id);
                  }}
                >
                  🔖
                </button>
                <button
                  className="history-dup"
                  title={t('compare.withHead')}
                  onClick={(e) => {
                    e.stopPropagation();
                    leave();
                    // 今の版を選んだときは、ひとつ前の版と比べる
                    const isHead = r.node.id === current.tree.headId;
                    const before = isHead ? (r.node.parentId ?? r.node.id) : r.node.id;
                    setCompare({ before, after: current.tree.headId });
                  }}
                >
                  ⇄
                </button>
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
      {/* 切り替えた直後の描画では、まだ前の図の版を指していることがある。今の図に無い版は出さない */}
      {preview && current.tree.nodes.has(preview.node.id) && <HistoryPreview tree={current.tree} preview={preview} />}
      {compare && current.tree.nodes.has(compare.before) && current.tree.nodes.has(compare.after) && (
        <CompareView tree={current.tree} initialBefore={compare.before} initialAfter={compare.after} onClose={() => setCompare(null)} />
      )}
    </section>
  );
}
