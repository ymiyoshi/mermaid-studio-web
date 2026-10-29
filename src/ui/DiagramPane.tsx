import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRender } from '../render/pipeline';
import { applyDiagramChange, revealRange, showToast, useSession } from '../core/session';
import { pluginFor } from '../plugins/registry';
import { isPositional, refKey, sameRef, type ActionResult, type DiagramAction, type DiagramTarget, type ElementRef } from '../plugins/types';
import { InlineLabelEditor, type LabelSession } from './InlineLabelEditor';
import { PropertyPanel } from './PropertyPanel';
import { ErrorBanner } from './ErrorBanner';
import { ShapeActionButton } from './ShapeActionButton';
import { getSetting, putSetting } from '../storage/db';
import { DRAG_THRESHOLD_PX, fixSvgSize, rectIn, unionRect, usePanZoom, type Rect, type ViewBox } from './usePanZoom';
import { contains, markContainers, resolveDrop, type DragCandidate, type DropResult } from './reorderDrop';
import { DIAGRAM_COMMAND_EVENT, type DiagramCommand } from './commands';
import { composeEach } from '../plugins/source';
import { t } from '../i18n';

/** 再描画をまたいで同じ要素を指すためのキー。意味上の参照があればそれを使う */
const keyOf = (x: DiagramTarget) => (x.ref ? `e:${refKey(x.ref)}` : x.id);

/** 操作が要素に使えるか */
const applies = (a: DiagramAction, ref: ElementRef | undefined) => !!ref && (a.appliesTo ?? ['node']).includes(ref.kind);

/** 要素と、そのラベルを合わせた範囲（図ビューの座標） */
function targetRect(x: DiagramTarget, vp: HTMLElement): Rect {
  const a = rectIn(x.el, vp);
  return x.labelEl === x.el ? a : unionRect(a, rectIn(x.labelEl, vp));
}

/** 中へ落とす先の範囲。当たり判定の要素（領域の背景など）も含める */
function dropRect(x: DiagramTarget, vp: HTMLElement): Rect {
  return (x.hits ?? []).reduce((r, h) => unionRect(r, rectIn(h, vp)), targetRect(x, vp));
}

/** 図ビューの座標の点が、要素の形（path・circle など）の中にあるか。形が見つからなければ undefined（範囲で判定する） */
function shapeHit(x: DiagramTarget, vp: HTMLElement): ((p: { x: number; y: number }) => boolean) | undefined {
  const box = vp.getBoundingClientRect();
  const shapes = [x.el, ...(x.hits ?? [])].flatMap((e) =>
    e instanceof SVGGeometryElement ? [e] : [...e.querySelectorAll<SVGGeometryElement>('path, circle, ellipse, rect, polygon')],
  );
  // 画面の座標から、それぞれの形の座標への変換は、測ったときに求めておく
  const tests = shapes.flatMap((s) => {
    const m = s.getScreenCTM();
    return m ? [{ s, inv: m.inverse() }] : [];
  });
  if (tests.length === 0) return undefined;
  return (p) => tests.some(({ s, inv }) => s.isPointInFill(new DOMPoint(p.x + box.left, p.y + box.top).matrixTransform(inv)));
}

/** ドラッグで動かしている間の状態（押した要素。動かし始めるまで candidates は null） */
interface Reorder {
  target: DiagramTarget & { ref: ElementRef };
  axis: 'x' | 'y' | 'xy' | 'free';
  x: number;
  y: number;
  /** 落とし先の候補と、それを測ったときの表示（拡大縮小やパンをしたら測り直す） */
  candidates: DragCandidate<DiagramTarget>[] | null;
  measuredFor: ViewBox | null;
  spot: DropResult<DiagramTarget> | null;
  /** 図の一番外（どの枠の外）へも落とせるか */
  root?: boolean;
  /** 中へ落としても変わらない候補（今いる枠など）。指しても枠を出さない */
  stay?: Set<DiagramTarget>;
  /** free のとき、最後のポインタの位置（画面の座標。押した位置 x・y からの差だけ動かす） */
  at?: { x: number; y: number };
}

/** 落とし先の表示（線・枠・置く位置の影） */
const spotView = (spot: DropResult<DiagramTarget> | null, stay?: Set<DiagramTarget>): { line: Rect | null; box: Rect | null } =>
  !spot || (spot.kind === 'into' && spot.item && stay?.has(spot.item))
    ? { line: null, box: null }
    : spot.kind === 'move'
      ? { line: spot.line, box: null }
      : { line: null, box: spot.box };

const sameSpot = (a: DropResult<DiagramTarget> | null, b: DropResult<DiagramTarget> | null) =>
  a === b ||
  (!!a && !!b && a.kind === b.kind && a.item === b.item && (a.kind !== 'move' || b.kind !== 'move' || a.before === b.before));

const TOOLBAR_H = 30;
const TOOLBAR_W = 220;

/** 選択中の要素の操作ボタンは要素の上に置く。上に余白が無ければ下に置き、横ははみ出さないようにする */
function toolbarPosition(r: Rect, vp: HTMLElement | null) {
  const width = vp?.clientWidth ?? Infinity;
  const top = r.top - TOOLBAR_H - 6 >= 4 ? r.top - TOOLBAR_H - 6 : r.top + r.height + 6;
  const left = Math.max(4, Math.min(r.left, width - TOOLBAR_W));
  return { left, top };
}

export function DiagramPane() {
  const { svg, svgSource, stale, status, error, diagramType } = useRender();
  const readOnly = useSession((s) => s.current?.readOnly ?? true);
  const selection = useSession((s) => s.selection);
  const sourceText = useSession((s) => s.current?.text);

  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const { view, fit, zoomBy, scrollIntoView, beginDrag, moveDrag, endDrag } = usePanZoom(viewport, canvas, () => endReorder());
  const [targets, setTargets] = useState<DiagramTarget[]>([]);
  // 選択中の要素（先頭が主な選択。Shift / Ctrl を押しながらのクリックで足し引きする）
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const selectedKey = selectedKeys[0] ?? null;
  const setSelectedKey = (k: string | null) => setSelectedKeys(k ? [k] : []);
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
  // コマンドパレットからの操作
  const commandRef = useRef<(cmd: DiagramCommand) => void>(() => {});
  commandRef.current = (cmd) => {
    if (cmd === 'fit') fit();
    else if (cmd === 'zoomIn') zoomBy(1.25);
    else if (cmd === 'zoomOut') zoomBy(1 / 1.25);
    else if (cmd === 'togglePanel') togglePanel();
  };
  useEffect(() => {
    const on = (e: Event) => commandRef.current((e as CustomEvent<DiagramCommand>).detail);
    addEventListener(DIAGRAM_COMMAND_EVENT, on);
    return () => removeEventListener(DIAGRAM_COMMAND_EVENT, on);
  }, []);
  const [renderTick, setRenderTick] = useState(0);
  const [toolbarRect, setToolbarRect] = useState<Rect | null>(null);
  const fittedFor = useRef<string | null>(null);
  /** 追加した要素。描画されたらラベル編集を始める */
  const pendingFocus = useRef<{ ref?: ElementRef; at?: number } | null>(null);
  const reorder = useRef<Reorder | null>(null);
  /** ドラッグ中の表示（薄くする要素と、落とす位置の線・枠） */
  const [drag, setDrag] = useState<{ key: string; line: Rect | null; box: Rect | null } | null>(null);
  const dragKey = drag?.key ?? null;

  const plugin = pluginFor(diagramType);
  // 図の要素の位置とソースの範囲（targets）が今のテキストと合っているか。ラベルの直接編集と並べ替えはこれが要る
  const editable = !readOnly && !stale && status === 'ok';
  // 編集してよいか。描き直しを待つ間も、パネル・表と、意味上の参照で動く操作（Tab・Delete など）は使える。
  // これらはいまのソースから変更を作り直し、applyDiagramChange が検証するので、図が古くても壊れない
  const canEdit = !readOnly && (status === 'ok' || status === 'pending') && svg !== null;
  const selected = targets.find((x) => keyOf(x) === selectedKey) ?? null;
  // まとめて編集する要素（2 つ以上選んだとき）
  const multi = useMemo(
    () => (selectedKeys.length > 1 ? selectedKeys.map((k) => targets.find((x) => keyOf(x) === k)?.ref).filter((r): r is ElementRef => !!r) : []),
    [selectedKeys, targets],
  );

  const startLabelEdit = (target: DiagramTarget) => {
    const base = { key: crypto.randomUUID(), targetKey: keyOf(target), original: target.label };
    if (target.range) {
      setSelectedKey(keyOf(target));
      setSession({ ...base, range: target.range });
    } else if (target.insertAt) {
      // ラベルの無い要素: 最初の入力で括弧ごと差し込む
      const { at, prefix, suffix } = target.insertAt;
      setSelectedKey(keyOf(target));
      setSession({ ...base, range: { from: at, to: at }, insert: { prefix, suffix } });
    } else {
      showToast(t('label.notUnique'));
    }
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
        // 図の上で書き換えられるラベルが無い要素（Git グラフのコミットの点など）は、選ぶだけにする（「特定できない」と知らせない）
        if (added.range || added.insertAt) startLabelEdit(added);
        else setSelectedKey(keyOf(added));
      }
    }
    // 図の種類が変わったとき（文書を開いたときなど）は全体表示にする
    const key = `${useSession.getState().current?.id}:${diagramType}`;
    if (fittedFor.current !== key) {
      fittedFor.current = key;
      requestAnimationFrame(() => fit());
    }
  }, [svg, svgSource, plugin]);

  // テキストのカーソル位置に対応する要素を強調する。Text は変わらないオブジェクトなので、文字列にするのはテキストが変わったときだけ
  const sourceString = useMemo(() => sourceText?.toString(), [sourceText]);
  const cursorKey = useMemo(() => {
    if (!sourceText || sourceString !== svgSource) return null;
    const line = sourceText.lineAt(Math.min(selection.head, sourceText.length));
    const hit = targets.find((x) => x.range && x.range.from >= line.from && x.range.from <= line.to);
    return hit ? keyOf(hit) : null;
  }, [targets, selection, sourceText, sourceString, svgSource]);

  useEffect(() => {
    for (const x of targets) {
      const k = keyOf(x);
      x.el.classList.toggle('mmd-target', x.range !== null || x.ref !== undefined);
      x.el.classList.toggle('mmd-selected', selectedKeys.includes(k));
      x.el.classList.toggle('mmd-cursor', k === cursorKey && k !== selectedKey);
      x.el.classList.toggle('mmd-connect-from', !!connect && sameRef(x.ref, connect.from));
      x.el.classList.toggle('mmd-dragging', k === dragKey);
    }
  }, [targets, selectedKeys, cursorKey, connect, dragKey]);

  // 選択中の要素の操作ボタンの位置。ラベルが要素の外にある（メッセージの本文は線の上など）ので、
  // 要素とラベルを合わせた範囲の上に置き、ラベルを覆わない（覆うとダブルクリックやドラッグができない）
  useLayoutEffect(() => {
    const vp = viewport.current;
    setToolbarRect(selected && vp ? targetRect(selected, vp) : null);
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

  // ---- 追加・接続・並べ替えの操作 ----
  /** 操作の結果を適用する（検証に通らなければ通知する） */
  const commit = async (res: ActionResult | null, danger = false) => {
    if (!res) {
      showToast(t('action.unsupported'));
      return;
    }
    pendingFocus.current = res.focus !== undefined ? { ref: res.focus } : res.focusAt !== undefined ? { at: res.focusAt } : null;
    const r = await applyDiagramChange(res.change, { label: res.label, selAfter: res.selAfter });
    if (r !== 'ok') {
      pendingFocus.current = null;
      if (r === 'invalid') showToast(t('action.invalid'));
    } else if (danger) {
      setSelectedKey(null);
    } else if (res.select) {
      setSelectedKey(`e:${refKey(res.select)}`);
    }
  };

  /** 選んだ要素をまとめて消す（要素ごとの削除の操作を順に当て、履歴は 1 ステップにする） */
  /** 描いた図が今のテキストと合っているか（番号で指す要素は、合っているときだけ操作する） */
  const isFresh = () => useSession.getState().current?.text.toString() === svgSource;
  const usable = (ref: ElementRef) => !isPositional(ref) || isFresh();

  const deleteMany = async (refs: ElementRef[]) => {
    const source = useSession.getState().current?.text.toString();
    if (source === undefined || !refs.every(usable)) return;
    const del = (kind: string) => plugin.actions?.find((a) => a.key === 'Delete' && a.arity === 1 && applies(a, { kind, id: '' }));
    const change = composeEach(source, refs, (src, ref) => del(ref.kind)?.run(src, [ref])?.change ?? null, isPositional);
    if (!change) return showToast(t('action.unsupported'));
    await commit({ change, label: t('bulk.deleted', { n: String(refs.length) }) }, true);
  };

  const runAction = async (action: DiagramAction, refs: ElementRef[], shape?: string) => {
    const source = useSession.getState().current?.text.toString();
    if (source === undefined || !canEdit || !refs.every(usable)) return;
    await commit(action.run(source, refs, shape), action.danger);
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
  const buttonActions = elementActions.filter((a) => !a.menuOnly);

  // ---- クリック（選択・接続）とドラッグ（パン・並べ替え） ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as Element).closest('.inline-label-editor, .element-toolbar, .context-menu')) return;
    setMenu(null);
    // 動かせる要素の上で押したら、パンではなく要素を動かすドラッグにする
    const source = useSession.getState().current?.text.toString();
    const hit = e.button === 0 && editable && !connect && plugin.reorder && source !== undefined ? targetAt(e.target) : null;
    const axis = hit?.ref ? plugin.reorder!.axis(source!, hit.ref) : null;
    if (hit?.ref && axis) {
      reorder.current = { target: { ...hit, ref: hit.ref }, axis, x: e.clientX, y: e.clientY, candidates: null, measuredFor: null, spot: null };
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // 捕捉できないときは、捕捉なしで続ける
      }
      return;
    }
    beginDrag(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const r = reorder.current;
    if (!r) return moveDrag(e);
    const vp = viewport.current;
    if (!vp) return;
    if (!r.candidates && Math.hypot(e.clientX - r.x, e.clientY - r.y) < DRAG_THRESHOLD_PX) return;
    // 候補の位置は、動かし始めたとき（と表示が変わったとき）だけ測る
    const spec = plugin.reorder!;
    if (r.axis === 'free') {
      const own = targetRect(r.target, vp);
      // 落とした位置に置く: 要素の影を、ポインタに合わせて動かして示す
      r.candidates ??= [];
      r.at = { x: e.clientX, y: e.clientY };
      setDrag({ key: keyOf(r.target), line: null, box: { ...own, left: own.left + e.clientX - r.x, top: own.top + e.clientY - r.y } });
      return;
    }
    if (!r.candidates || r.measuredFor !== view) {
      const ref = r.target.ref;
      const source = useSession.getState().current?.text.toString() ?? '';
      // 動かしている要素の中（枠の中のメッセージ・サブグラフの中のノードなど）には落とせないので、候補から外す
      // 落とせない要素は、位置を測る前に外す（測るのは落とせる要素だけ）
      const own = targetRect(r.target, vp);
      r.candidates = markContainers(
        targets
          .filter((x) => x.ref && !sameRef(x.ref, ref))
          .map((x) => ({ x, into: !!spec.acceptsInto?.(source, ref, x.ref!), sibling: !!spec.accepts?.(ref, x.ref!, source) }))
          .filter((c) => c.sibling || c.into)
          .map(({ x, into, sibling }) => ({
            item: x,
            rect: into ? dropRect(x, vp) : targetRect(x, vp),
            sibling,
            into,
            hit: into && spec.shaped ? shapeHit(x, vp) : undefined,
          }))
          .filter((c) => !contains(own, c.rect)),
      );
      r.stay = new Set(r.candidates.filter((c) => c.into && !spec.into?.(source, ref, c.item.ref!)).map((c) => c.item));
      r.root = !!spec.acceptsInto?.(source, ref, null);
      r.measuredFor = view;
      // 落とし先が 1 つも無ければ（サブグラフの無いフローチャートのノードなど）、要素を動かさずに図をパンする
      if (r.candidates.length === 0 && !r.root) {
        reorder.current = null;
        setDrag(null);
        beginDrag(e, { x: r.x, y: r.y });
        moveDrag(e);
        return;
      }
    }
    const box = vp.getBoundingClientRect();
    const spot = resolveDrop(r.axis, { x: e.clientX - box.left, y: e.clientY - box.top }, r.candidates, !!r.root);
    // 離したときは描き直しを待たずに最新の落とし先を使うので、ref に持つ。落とし先が変わったときだけ描き直す
    const changed = !sameSpot(r.spot, spot);
    r.spot = spot;
    if (changed || !drag) setDrag({ key: keyOf(r.target), ...spotView(spot, r.stay) });
  };

  const endReorder = () => {
    reorder.current = null;
    setDrag(null);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const r = reorder.current;
    if (r?.candidates) {
      // 落とし先の前後・中へ動かす（free なら離した位置に置く）
      const { spot, at } = r;
      endReorder();
      const source = useSession.getState().current?.text.toString();
      if (source === undefined || !editable) return;
      const spec = plugin.reorder!;
      const ref = r.target.ref;
      const svgEl = canvas.current?.querySelector('svg');
      const ctm = svgEl?.getScreenCTM();
      const toSvg = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(ctm!.inverse());
      const p = at && ctm ? { x: toSvg(at.x, at.y).x - toSvg(r.x, r.y).x, y: toSvg(at.x, at.y).y - toSvg(r.x, r.y).y } : null;
      // 動かせない・動かしても変わらない落とし先（すぐ隣・もう中にある枠など）では何もしない
      const res =
        r.axis === 'free'
          ? p && svgEl && spec.place
            ? spec.place(source, ref, svgEl, p)
            : null
          : spot?.kind === 'move'
            ? spot.item.ref && (spec.move?.(source, ref, spot.item.ref, spot.before) ?? null)
            : spot?.kind === 'into' && (spot.item === null || spot.item.ref)
              ? (spec.into?.(source, ref, spot.item?.ref ?? null) ?? null)
              : null;
      if (res) void commit(res);
      return;
    }
    if (r) endReorder();
    else {
      const d = endDrag();
      if (!d || d.moved) return;
    }
    const hit = r ? r.target : targetAt(document.elementFromPoint(e.clientX, e.clientY));
    if (connect) {
      // 接続モード: クリックした要素へ接続する
      const kinds = connect.action.targetKinds ?? connect.action.appliesTo ?? ['node'];
      if (hit?.ref && kinds.includes(hit.ref.kind)) void runAction(connect.action, [connect.from, hit.ref]);
      setConnect(null);
      return;
    }
    // Shift / Ctrl を押しながらのクリック: まとめて編集する要素に足す・外す
    // 描き直しを待つ間は、番号で指す要素を選ばない（古い図の番号は、今のテキストの別の要素を指すことがある）
    if (hit?.ref && !usable(hit.ref)) return;
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && hit?.ref) {
      const k = keyOf(hit);
      setSelectedKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
      return;
    }
    // クリック: 要素を選択し、ソースの該当箇所を表示する
    setSelectedKey(hit ? keyOf(hit) : null);
    if (hit?.range) revealRange(hit.range.from, hit.range.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as Element;
    // 形の一覧の中のキー（Tab での移動・Enter での選択）と、操作ボタンの上の Enter は、ボタン自身に任せる
    if (target.closest('.inline-label-editor, .shape-action-palette')) return;
    if (e.key === 'Enter' && target.closest('.element-toolbar button')) return;
    if (e.key === 'Escape') {
      if (reorder.current) endReorder();
      else if (menu) setMenu(null);
      else if (connect) setConnect(null);
      else setSelectedKey(null);
      return;
    }
    if (!canEdit || !selected) return;
    const key = e.key === 'Backspace' ? 'Delete' : e.key;
    if (multi.length > 1) {
      if (key === 'Delete') {
        e.preventDefault();
        void deleteMany(multi);
      }
      return;
    }
    const bound = selected.ref ? elementActions.find((a) => a.key === key && a.arity === 1) : undefined;
    if (bound && selected.ref) {
      e.preventDefault();
      void runAction(bound, [selected.ref]);
    } else if ((e.key === 'Enter' || e.key === 'F2') && editable) {
      e.preventDefault();
      startLabelEdit(selected);
    }
  };

  // 右クリック: 要素に使える操作のメニュー
  const onContextMenu = (e: React.MouseEvent) => {
    const hit = targetAt(document.elementFromPoint(e.clientX, e.clientY));
    if (!hit || (hit.ref && !usable(hit.ref))) return;
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
        {toolbarActions.map((a) =>
          a.shapes ? (
            <ShapeActionButton key={a.id} action={{ ...a, shapes: a.shapes }} disabled={!canEdit} run={(shape) => void runAction(a, [], shape)} />
          ) : (
            <button key={a.id} className="btn" disabled={!canEdit} onClick={() => triggerAction(a)}>
              {a.title}
            </button>
          ),
        )}
        <span className="spacer" />
        <button className={`btn${panelOpen ? ' active' : ''}`} onClick={togglePanel} aria-pressed={panelOpen}>
          {t('panel.toggle')}
        </button>
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
      {status === 'error' && error && <ErrorBanner error={error} hasSvg={svg !== null} />}

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
        onPointerCancel={() => {
          endReorder();
          endDrag();
        }}
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
        {drag?.line && <div className="drop-indicator" style={drag.line} aria-hidden />}
        {drag?.box && <div className="drop-box" style={drag.box} aria-hidden />}
        {canEdit && !session && !connect && !menu && multi.length === 0 && selected?.ref && toolbarRect && buttonActions.length > 0 && (
          <div
            className="element-toolbar"
            style={toolbarPosition(toolbarRect, viewport.current)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {buttonActions.map((a) =>
              a.shapes && a.arity === 1 ? (
                <ShapeActionButton
                  key={a.id}
                  action={{ ...a, shapes: a.shapes }}
                  disabled={false}
                  className={a.danger ? 'danger' : undefined}
                  title={a.key ? `${a.title} (${a.key})` : a.title}
                  run={(shape) => void runAction(a, [selected.ref!], shape)}
                />
              ) : (
                <button
                  key={a.id}
                  className={`btn${a.danger ? ' danger' : ''}`}
                  onClick={() => triggerAction(a)}
                  title={a.key ? `${a.title} (${a.key})` : a.title}
                >
                  {a.title}
                </button>
              ),
            )}
          </div>
        )}
        {menu && selected && (
          <div className="context-menu menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
            {canEdit &&
              elementActions.map((a) => (
                <button key={a.id} role="menuitem" className={`menu-item${a.danger ? ' danger' : ''}`} onClick={() => triggerAction(a)}>
                  <span>{a.title}</span>
                  {a.key && <kbd>{a.key}</kbd>}
                </button>
              ))}
            <button
              role="menuitem"
              className="menu-item"
              disabled={!editable || (!selected.range && !selected.insertAt)}
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
      {panelOpen && (
        <PropertyPanel key={plugin.type} plugin={plugin} selected={selected?.ref ?? null} selectedFrom={selected?.range?.from ?? null} multi={multi} editable={canEdit} />
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
