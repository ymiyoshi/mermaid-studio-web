import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRender } from '../render/pipeline';
import { applyDiagramChange, revealRange, showToast, useSession } from '../core/session';
import { pluginFor } from '../plugins/registry';
import { refKey, sameRef, type DiagramAction, type DiagramTarget, type ElementRef } from '../plugins/types';
import { InlineLabelEditor, type LabelSession } from './InlineLabelEditor';
import { PropertyPanel } from './PropertyPanel';
import { getSetting, putSetting } from '../storage/db';
import { t } from '../i18n';

interface ViewBox {
  scale: number;
  x: number;
  y: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

/** 再描画をまたいで同じ要素を指すためのキー。意味上の参照があればそれを使う */
const keyOf = (x: DiagramTarget) => (x.ref ? `e:${refKey(x.ref)}` : x.id);

/** 操作が要素に使えるか */
const applies = (a: DiagramAction, ref: ElementRef | undefined) => !!ref && (a.appliesTo ?? ['node']).includes(ref.kind);

/** mermaid の SVG は幅 100% で出力されるので、拡大縮小のために本来の大きさに固定する */
function fixSvgSize(svg: SVGSVGElement) {
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0) {
    svg.setAttribute('width', String(vb.width));
    svg.setAttribute('height', String(vb.height));
  }
  svg.style.maxWidth = 'none';
}

const TOOLBAR_H = 30;
const TOOLBAR_W = 220;

/** 選択中の要素の操作ボタンは要素の上に置く。上に余白が無ければ下に置き、横ははみ出さないようにする */
function toolbarPosition(r: Rect, vp: HTMLElement | null) {
  const width = vp?.clientWidth ?? Infinity;
  const top = r.top - TOOLBAR_H - 6 >= 4 ? r.top - TOOLBAR_H - 6 : r.top + r.height + 6;
  const left = Math.max(4, Math.min(r.left, width - TOOLBAR_W));
  return { left, top };
}

function rectIn(el: Element, container: HTMLElement): Rect {
  const a = el.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  return { left: a.left - c.left, top: a.top - c.top, width: a.width, height: a.height };
}

export function DiagramPane() {
  const { svg, svgSource, stale, status, error, diagramType } = useRender();
  const readOnly = useSession((s) => s.current?.readOnly ?? true);
  const selection = useSession((s) => s.selection);
  const sourceText = useSession((s) => s.current?.text);

  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewBox>({ scale: 1, x: 0, y: 0 });
  const [targets, setTargets] = useState<DiagramTarget[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [session, setSession] = useState<LabelSession | null>(null);
  const [connect, setConnect] = useState<{ action: DiagramAction; from: ElementRef } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  useEffect(() => {
    void getSetting<boolean>('panelOpen').then((v) => v !== undefined && setPanelOpen(v));
  }, []);
  const togglePanel = () =>
    setPanelOpen((v) => {
      void putSetting('panelOpen', !v);
      return !v;
    });
  const [renderTick, setRenderTick] = useState(0);
  const [toolbarRect, setToolbarRect] = useState<Rect | null>(null);
  const fittedFor = useRef<string | null>(null);
  /** 追加した要素。描画されたらラベル編集を始める */
  const pendingFocus = useRef<{ ref?: ElementRef; at?: number } | null>(null);

  const plugin = pluginFor(diagramType);
  const editable = !readOnly && !stale && status === 'ok';
  const selected = targets.find((x) => keyOf(x) === selectedKey) ?? null;

  const startLabelEdit = (target: DiagramTarget) => {
    if (!target.range) {
      showToast(t('label.notUnique'));
      return;
    }
    setSelectedKey(keyOf(target));
    setSession({ key: crypto.randomUUID(), targetKey: keyOf(target), range: target.range, original: target.label });
  };

  // SVG を差し込み、要素とソースを対応付ける
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.innerHTML = svg ?? '';
    const svgEl = el.querySelector('svg');
    if (!svgEl) {
      setTargets([]);
      return;
    }
    fixSvgSize(svgEl);
    const mapped = plugin.mapTargets(svgEl, svgSource);
    setTargets(mapped);
    setRenderTick((n) => n + 1);

    // 追加操作の後の描画なら、追加した要素のラベル編集を始める（見つからなければ諦める）
    if (pendingFocus.current !== null && svgSource === useSession.getState().current?.text.toString()) {
      const p = pendingFocus.current;
      pendingFocus.current = null;
      const added = mapped.find((x) =>
        p.ref !== undefined ? sameRef(x.ref, p.ref) : x.range !== null && x.range.from === p.at,
      );
      if (added) {
        scrollIntoView(added.el);
        startLabelEdit(added);
      }
    }
    // 図の種類が変わったとき（文書を開いたときなど）は全体表示にする
    const key = `${useSession.getState().current?.id}:${diagramType}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      requestAnimationFrame(() => fit());
    }
  }, [svg, svgSource, plugin]);

  const fit = useCallback(() => {
    const vp = viewport.current;
    const svgEl = canvas.current?.querySelector('svg');
    if (!vp || !svgEl) return;
    const w = Number(svgEl.getAttribute('width')) || svgEl.getBBox().width;
    const h = Number(svgEl.getAttribute('height')) || svgEl.getBBox().height;
    const pad = 32;
    const scale = Math.min(2, Math.max(MIN_SCALE, Math.min((vp.clientWidth - pad * 2) / w, (vp.clientHeight - pad * 2) / h)));
    setView({ scale, x: (vp.clientWidth - w * scale) / 2, y: (vp.clientHeight - h * scale) / 2 });
  }, []);

  /** 要素が表示範囲の外にあれば、見えるところまで動かす */
  const scrollIntoView = (el: Element) => {
    const vp = viewport.current;
    if (!vp) return;
    const r = rectIn(el, vp);
    const margin = 48;
    const dx =
      r.left < margin ? margin - r.left : r.left + r.width > vp.clientWidth - margin ? vp.clientWidth - margin - r.left - r.width : 0;
    const dy =
      r.top < margin ? margin - r.top : r.top + r.height > vp.clientHeight - margin ? vp.clientHeight - margin - r.top - r.height : 0;
    if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  // テキストのカーソル位置に対応する要素を強調する
  const cursorKey = useMemo(() => {
    if (!sourceText || sourceText.toString() !== svgSource) return null;
    const line = sourceText.lineAt(Math.min(selection.head, sourceText.length));
    const hit = targets.find((x) => x.range && x.range.from >= line.from && x.range.from <= line.to);
    return hit ? keyOf(hit) : null;
  }, [targets, selection, sourceText, svgSource]);

  useEffect(() => {
    for (const x of targets) {
      const k = keyOf(x);
      x.el.classList.toggle('mmd-target', x.range !== null || x.ref !== undefined);
      x.el.classList.toggle('mmd-selected', k === selectedKey);
      x.el.classList.toggle('mmd-cursor', k === cursorKey && k !== selectedKey);
      x.el.classList.toggle('mmd-connect-from', !!connect && sameRef(x.ref, connect.from));
    }
  }, [targets, selectedKey, cursorKey, connect]);

  // 選択中の要素の操作ボタンの位置
  useLayoutEffect(() => {
    const vp = viewport.current;
    setToolbarRect(selected && vp ? rectIn(selected.el, vp) : null);
  }, [selected, view, renderTick]);

  const targetAt = (node: EventTarget | null) => {
    if (!(node instanceof Element)) return null;
    // 内側の要素（ノード）を優先する
    let best: DiagramTarget | null = null;
    for (const x of targets) {
      const hit = x.el === node || x.el.contains(node) || x.hits?.some((h) => h === node || h.contains(node));
      if (hit && (!best || best.el.contains(x.el))) best = x;
    }
    return best;
  };

  // ---- 追加・接続の操作 ----
  const runAction = async (action: DiagramAction, refs: ElementRef[]) => {
    const source = useSession.getState().current?.text.toString();
    if (source === undefined || !editable) return;
    const res = action.run(source, refs);
    if (!res) {
      showToast(t('action.unsupported'));
      return;
    }
    pendingFocus.current = res.focus !== undefined ? { ref: res.focus } : res.focusAt !== undefined ? { at: res.focusAt } : null;
    const r = await applyDiagramChange(res.change, { label: res.label, selAfter: res.selAfter });
    if (r !== 'ok') {
      pendingFocus.current = null;
      if (r === 'invalid') showToast(t('action.invalid'));
    } else if (action.danger) {
      setSelectedKey(null);
    }
  };

  const triggerAction = (action: DiagramAction) => {
    setMenu(null);
    if (action.arity === 0) return void runAction(action, []);
    const from = selected?.ref;
    if (!from) return;
    if (action.arity === 1) return void runAction(action, [from]);
    setConnect({ action, from });
    viewport.current?.focus();
  };

  const toolbarActions = plugin.actions?.filter((a) => a.arity === 0) ?? [];
  const elementActions = plugin.actions?.filter((a) => a.arity > 0 && applies(a, selected?.ref)) ?? [];

  // ---- パンとズーム ----
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as Element).closest('.inline-label-editor, .element-toolbar, .context-menu')) return;
    setMenu(null);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ペンや合成イベントなどで捕捉できないときは、捕捉なしで続ける
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const hit = targetAt(document.elementFromPoint(e.clientX, e.clientY));
    if (connect) {
      // 接続モード: クリックした要素へ接続する
      const kinds = connect.action.targetKinds ?? connect.action.appliesTo ?? ['node'];
      if (hit?.ref && kinds.includes(hit.ref.kind)) void runAction(connect.action, [connect.from, hit.ref]);
      setConnect(null);
      return;
    }
    // クリック: 要素を選択し、ソースの該当箇所を表示する
    setSelectedKey(hit ? keyOf(hit) : null);
    if (hit?.range) revealRange(hit.range.from, hit.range.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest('.inline-label-editor')) return;
    if (e.key === 'Escape') {
      if (menu) setMenu(null);
      else if (connect) setConnect(null);
      else setSelectedKey(null);
      return;
    }
    if (!editable || !selected) return;
    const key = e.key === 'Backspace' ? 'Delete' : e.key;
    const bound = selected.ref ? elementActions.find((a) => a.key === key && a.arity === 1) : undefined;
    if (bound && selected.ref) {
      e.preventDefault();
      void runAction(bound, [selected.ref]);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startLabelEdit(selected);
    }
  };

  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.0015)));
        const k = scale / v.scale;
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const vp = viewport.current;
    if (!vp) return;
    const px = vp.clientWidth / 2;
    const py = vp.clientHeight / 2;
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  // 右クリック: 要素に使える操作のメニュー
  const onContextMenu = (e: React.MouseEvent) => {
    const hit = targetAt(document.elementFromPoint(e.clientX, e.clientY));
    if (!hit) return;
    e.preventDefault();
    setSelectedKey(keyOf(hit));
    const vp = viewport.current!.getBoundingClientRect();
    setMenu({ x: e.clientX - vp.left, y: e.clientY - vp.top });
  };

  // ---- ラベルの直接編集 ----
  const onDoubleClick = (e: React.MouseEvent) => {
    // ポインタキャプチャ中は e.target が viewport になるので、座標から要素を引く
    const hit = targetAt(document.elementFromPoint(e.clientX, e.clientY));
    if (!hit || !editable || connect) return;
    startLabelEdit(hit);
  };

  // 再描画のあと、編集中の要素を探し直して入力欄の位置を合わせる（§6.1）
  const sessionTarget = session
    ? (targets.find((x) => x.range?.from === session.range.from) ?? targets.find((x) => keyOf(x) === session.targetKey))
    : undefined;

  return (
    <section className="pane diagram-pane">
      <div className="pane-toolbar">
        <span className="pane-title">{diagramType ?? '—'}</span>
        {toolbarActions.map((a) => (
          <button key={a.id} className="btn" disabled={!editable} onClick={() => triggerAction(a)}>
            {a.title}
          </button>
        ))}
        <span className="spacer" />
        {(plugin.inspect || plugin.tables) && (
          <button className={`btn${panelOpen ? ' active' : ''}`} onClick={togglePanel} aria-pressed={panelOpen}>
            {t('panel.toggle')}
          </button>
        )}
        <button className="icon-btn" title={t('toolbar.zoomOut')} onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <span className="zoom-label">{Math.round(view.scale * 100)}%</span>
        <button className="icon-btn" title={t('toolbar.zoomIn')} onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button className="btn" onClick={fit}>
          {t('toolbar.fit')}
        </button>
      </div>
      {status === 'error' && error && (
        <div className="error-banner" role="alert">
          <strong>{svg ? t('error.banner') : t('error.bannerNoSvg')}</strong>
          {error.line && <span>{t('error.line', { line: String(error.line) })}</span>}
          <pre>{error.message.split('\n').slice(0, 4).join('\n')}</pre>
        </div>
      )}
      {connect && (
        <div className="connect-banner" role="status">
          {connect.action.prompt}
        </div>
      )}
      <div
        className={`diagram-viewport${stale ? ' stale' : ''}${editable ? ' editable' : ''}${connect ? ' connecting' : ''}`}
        ref={viewport}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        <div
          className="diagram-canvas"
          ref={canvas}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
        {status === 'empty' && <div className="diagram-empty">{t('diagram.empty')}</div>}
        {editable && !session && !connect && !menu && selected?.ref && toolbarRect && elementActions.length > 0 && (
          <div
            className="element-toolbar"
            style={toolbarPosition(toolbarRect, viewport.current)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {elementActions.map((a) => (
              <button
                key={a.id}
                className={`btn${a.danger ? ' danger' : ''}`}
                onClick={() => triggerAction(a)}
                title={a.key ? `${a.title} (${a.key})` : a.title}
              >
                {a.title}
              </button>
            ))}
          </div>
        )}
        {menu && selected && (
          <div className="context-menu menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
            {editable &&
              elementActions.map((a) => (
                <button key={a.id} role="menuitem" className={`menu-item${a.danger ? ' danger' : ''}`} onClick={() => triggerAction(a)}>
                  <span>{a.title}</span>
                  {a.key && <kbd>{a.key}</kbd>}
                </button>
              ))}
            <button
              role="menuitem"
              className="menu-item"
              disabled={!editable || !selected.range}
              onClick={() => {
                setMenu(null);
                startLabelEdit(selected);
              }}
            >
              <span>{t('menu.editLabel')}</span>
              <kbd>Enter</kbd>
            </button>
            {plugin.inspect && (
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  if (!panelOpen) togglePanel();
                }}
              >
                <span>{t('menu.properties')}</span>
              </button>
            )}
          </div>
        )}
        {session && (
          <InlineLabelEditor
            key={session.key}
            session={session}
            anchor={sessionTarget?.labelEl ?? null}
            container={viewport.current}
            renderTick={renderTick}
            viewTick={view}
            onRangeChange={(range) => setSession((s) => (s ? { ...s, range } : s))}
            onClose={() => {
              setSession(null);
              viewport.current?.focus();
            }}
          />
        )}
      </div>
      {panelOpen && (plugin.inspect || plugin.tables) && (
        <PropertyPanel key={plugin.type} plugin={plugin} selected={selected?.ref ?? null} selectedFrom={selected?.range?.from ?? null} editable={editable} />
      )}
      <div className="pane-footer">
        {plugin.actions?.some((a) => a.key === 'Tab')
          ? t('diagram.hintActions')
          : plugin.actions
            ? t('diagram.hintSelect')
            : t('diagram.hint')}
      </div>
    </section>
  );
}
