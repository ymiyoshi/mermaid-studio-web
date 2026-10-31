import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRender } from '../render/pipeline';
import { applyDiagramChange, redo, revealRange, showToast, undo, useSession } from '../core/session';
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
import { useKeymap } from './keymapStore';
import { focusPane, registerViPane } from './viDispatch';
import { nearestInDirection, type Dir } from './viKeys';
import { followLinks, linksOf } from '../plugins/structure';
import { OutlinePanel, outlineRows } from './OutlinePanel';
import { t } from '../i18n';

/** 再描画をまたいで同じ要素を指すためのキー。意味上の参照があればそれを使う */
const keyOf = (x: DiagramTarget) => (x.ref ? `e:${refKey(x.ref)}` : x.id);

/** vi のキー（設計書 §16.4）。ノーマルモードとビジュアルモードで受け付けるコマンド */
const VI_MOVE = ['h', 'j', 'k', 'l', 'w', 'b', 'g g', 'G'];
const VI_NORMAL = [
  ...VI_MOVE,
  '/',
  'n',
  'N',
  'g d',
  'z h',
  'z j',
  'z k',
  'z l',
  'z z',
  '+',
  '-',
  '=',
  'i',
  'a',
  '<CR>',
  'c c',
  'S',
  'o',
  'd d',
  'x',
  'J',
  'K',
  'c e',
  'u',
  '<C-r>',
  '.',
  'y y',
  'm',
  'v',
  '] e',
  '[ e',
  '] g',
  '[ g',
  '> >',
  '< <',
  'p',
];
const VI_VISUAL = [...VI_MOVE, 'd', 'x', 'v', '<Esc>', 'u', '<C-r>', 'y', 'p'];
/** zh などで図をずらす量（画面の座標） */
const VI_PAN_PX = 80;

const norm = (x: string) => x.normalize('NFKC').toLowerCase();

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
  const { view, fit, zoomBy, scrollIntoView, panBy, center, beginDrag, moveDrag, endDrag } = usePanZoom(viewport, canvas, () => endReorder());
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
  // 要素の一覧（設計書 §17.4）
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outlineQuery, setOutlineQuery] = useState('');
  useEffect(() => {
    void getSetting<boolean>('outlineOpen').then((v) => v !== undefined && setOutlineOpen(v));
  }, []);
  const toggleOutline = () =>
    setOutlineOpen((v) => {
      void putSetting('outlineOpen', !v);
      return !v;
    });
  // コマンドパレットからの操作
  const commandRef = useRef<(cmd: DiagramCommand) => void>(() => {});
  commandRef.current = (cmd) => {
    if (cmd === 'fit') fit();
    else if (cmd === 'zoomIn') zoomBy(1.25);
    else if (cmd === 'zoomOut') zoomBy(1 / 1.25);
    else if (cmd === 'togglePanel') togglePanel();
    else if (cmd === 'toggleOutline') toggleOutline();
    else if (cmd === 'selectCursor' && cursorKey) setSelectedKey(cursorKey);
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

  const startLabelEdit = (target: DiagramTarget, caret?: LabelSession['caret']) => {
    const base = { key: crypto.randomUUID(), targetKey: keyOf(target), original: target.label, caret };
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
      // 読み上げ（設計書 §11・§17.2）: 選べる要素に名前を付ける
      if (x.range !== null || x.ref !== undefined) {
        x.el.setAttribute('role', 'graphics-symbol');
        x.el.setAttribute('aria-label', x.label.trim() || x.ref?.id || '');
      }
    }
  }, [targets, selectedKeys, cursorKey, connect, dragKey]);

  /** 選んだ要素の読み上げの文（名前・囲む枠・つながる線の数） */
  const announcement = useMemo(() => {
    if (!selected) return '';
    const name = selected.label.trim() || selected.ref?.id || '';
    if (!selected.ref || !plugin.structure) return t('a11y.selected', { name });
    const parentRef = plugin.structure.parent(svgSource, selected.ref);
    const parent = parentRef ? targets.find((x) => sameRef(x.ref, parentRef)) : undefined;
    const links = linksOf(plugin.structure, svgSource, selected.ref);
    const out = links.filter((l) => sameRef(l.from, selected.ref)).length;
    const inn = links.filter((l) => sameRef(l.to, selected.ref)).length;
    return [
      t('a11y.selected', { name }),
      parentRef ? t('a11y.inside', { name: parent?.label.trim() || parentRef.id }) : '',
      plugin.structure.links ? t('a11y.links', { out: String(out), in: String(inn) }) : '',
    ]
      .filter(Boolean)
      .join(' ');
  }, [selected, plugin, svgSource, targets]);

  const outline = useMemo(
    () => (outlineOpen ? outlineRows(targets, plugin, svgSource, keyOf, outlineQuery) : []),
    [outlineOpen, targets, plugin, svgSource, outlineQuery],
  );

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
    // 足した要素のラベル編集は、適用してから予約する。適用の前（検証の間）に予約すると、ひとつ前の操作の描画が
    // その間に終わったとき、まだ要素の無い図で予約を使い切ってしまう（描き直しを待たずに続けて操作したとき）
    pendingFocus.current = null;
    const r = await applyDiagramChange(res.change, { label: res.label, selAfter: res.selAfter });
    if (r === 'ok') pendingFocus.current = res.focus !== undefined ? { ref: res.focus } : res.focusAt !== undefined ? { at: res.focusAt } : null;
    if (r !== 'ok') {
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
    // 形の一覧の中のキー（Tab での移動・Enter での選択）と、操作ボタンの上の Enter は、ボタン自身に任せる。
    // 右クリックのメニューの中も同じ（Esc だけはメニューを閉じるのに使う）
    if (target.closest('.inline-label-editor, .shape-action-palette')) return;
    if (target.closest('.context-menu') && e.key !== 'Escape') return;
    if (e.key === 'Enter' && target.closest('.element-toolbar button')) return;
    if (e.key === 'Escape') {
      if (reorder.current) endReorder();
      else if (menu) setMenu(null);
      else if (connect) setConnect(null);
      else setSelectedKey(null);
      return;
    }
    // コピー・貼り付け・複製（設計書 §17.3）。貼り付けは、同じ図の中でコピーした要素を複製する
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const letter = e.key.toLowerCase();
    if (mod && (letter === 'c' || letter === 'v' || letter === 'd')) {
      if (letter === 'c') {
        if (copySelection()) e.preventDefault();
      } else if (letter === 'v') {
        e.preventDefault();
        void duplicate();
      } else if (selectionRefs().length > 0) {
        e.preventDefault();
        void duplicate(selectionRefs());
      }
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

  // ---- vi のキー（設計書 §16.4）。キーの受け取りは viDispatch が行い、ここでは図の上の操作をする ----
  const keymap = useKeymap((s) => s.keymap);
  const pendingKeys = useKeymap((s) => s.pendingKeys);
  const [visual, setVisual] = useState(false);
  /** 検索の欄に打っている文字（開いていなければ null） */
  const [search, setSearch] = useState<string | null>(null);
  const lastQuery = useRef('');
  /** . で繰り返す、最後の図の操作。図種が変わったら繰り返さないよう、図種と操作の ID で覚える */
  const lastAction = useRef<{ type: string; id: string } | null>(null);
  // 選択が無くなったら（クリックで外したなど）ビジュアルモードを終える
  useEffect(() => {
    if (selectedKeys.length === 0) setVisual(false);
  }, [selectedKeys.length]);

  /** vi で選べる要素を、ソースの順に並べたもの。番号で指す要素は、描いた図が今のテキストと合っているときだけ選ぶ */
  const pickable = () =>
    targets
      .map((x, i) => ({ x, at: x.range?.from ?? x.insertAt?.at ?? Number.MAX_SAFE_INTEGER - targets.length + i }))
      .filter(({ x }) => (x.range !== null || x.ref !== undefined) && (!x.ref || usable(x.ref)))
      .sort((a, b) => a.at - b.at)
      .map(({ x }) => x);

  /** 移動の起点。ビジュアルモードでは最後に足した要素 */
  const viCursor = () => {
    const k = visual ? selectedKeys.at(-1) : selectedKey;
    return targets.find((x) => keyOf(x) === k) ?? null;
  };

  const viSelect = (x: DiagramTarget) => {
    const k = keyOf(x);
    if (visual) setSelectedKeys((ks) => [...ks.filter((y) => y !== k), k]);
    else setSelectedKey(k);
    scrollIntoView(x.el);
    if (x.range) revealRange(x.range.from, x.range.to);
  };

  const viMoveDir = (dir: Dir, count: number) => {
    const vp = viewport.current;
    const list = pickable();
    if (!vp || list.length === 0) return;
    const start = viCursor();
    if (!start) return viSelect(list[0]);
    let cur: DiagramTarget = start;
    for (let n = 0; n < count; n++) {
      const from: DiagramTarget = cur;
      const cands = list.filter((x) => x !== from);
      const i = nearestInDirection(
        targetRect(from, vp),
        cands.map((x) => targetRect(x, vp)),
        dir,
      );
      if (i < 0) break;
      cur = cands[i];
    }
    viSelect(cur);
  };

  const viMoveOrder = (to: number | 'first' | 'last') => {
    const list = pickable();
    if (list.length === 0) return;
    const cur = viCursor();
    const i = cur ? list.indexOf(cur) : -1;
    const j = to === 'first' ? 0 : to === 'last' ? list.length - 1 : i < 0 ? 0 : Math.min(Math.max(i + to, 0), list.length - 1);
    viSelect(list[j]);
  };

  /** ラベルに q を含む要素を、今の要素の次（back なら前）から探す。端まで行ったら反対の端から続ける */
  const viFind = (q: string, back: boolean, count = 1) => {
    if (q === '') return;
    const list = pickable();
    const hits = list.filter((x) => norm(x.label).includes(norm(q)));
    if (hits.length === 0) return showToast(t('vi.searchNone', { q }));
    let at = list.indexOf(viCursor() as DiagramTarget);
    let found: DiagramTarget | undefined;
    for (let n = 0; n < count; n++) {
      const from = at;
      found = back
        ? ([...hits].reverse().find((x) => list.indexOf(x) < from) ?? hits.at(-1))
        : (hits.find((x) => list.indexOf(x) > from) ?? hits[0]);
      at = list.indexOf(found!);
    }
    if (found) viSelect(found);
  };

  /**
   * 並べ替え（J / K）を count 回。プラグインの ArrowDown / ArrowUp の操作があればそれを 1 回ずつ（1 回ごとに 1 ステップ）、
   * 無ければドラッグと同じ移動で count 個先の隣へ 1 回で動かす
   */
  const viSwap = async (down: boolean, count: number) => {
    const first = selected?.ref;
    if (!selected || !first || !editable) return;
    const bound = elementActions.find((a) => a.key === (down ? 'ArrowDown' : 'ArrowUp') && a.arity === 1);
    if (bound) {
      // 番号で指す要素（メッセージなど）は動かすと番号が変わるので、操作が返す移動後の参照で続ける
      let ref = first;
      for (let n = 0; n < count; n++) {
        const source = useSession.getState().current?.text.toString();
        const res = source === undefined ? null : bound.run(source, [ref]);
        if (!res) break;
        await commit(res);
        if (useSession.getState().current?.text.toString() === source) break;
        ref = res.select ?? ref;
      }
      return;
    }
    const spec = plugin.reorder;
    const source = useSession.getState().current?.text.toString();
    if (!spec?.move || source === undefined || !spec.axis(source, first)) return;
    const list = pickable();
    const i = list.indexOf(selected);
    const side = down ? list.slice(i + 1) : list.slice(0, i).reverse();
    const accepted = side.filter((x) => x.ref && spec.accepts?.(first, x.ref, source));
    const next = accepted[Math.min(count, accepted.length) - 1];
    if (next?.ref) await commit(spec.move(source, first, next.ref, !down));
  };

  /** 要素のソース（ラベルの範囲を含む行）をコピーする */
  const viYank = () => {
    const text = useSession.getState().current?.text;
    if (!selected?.range || !text) return;
    const from = text.lineAt(selected.range.from).from;
    const to = text.lineAt(selected.range.to).to;
    if (!navigator.clipboard) return showToast(t('vi.yankFailed'));
    void navigator.clipboard.writeText(text.sliceString(from, to)).then(
      () => showToast(t('vi.yanked')),
      () => showToast(t('vi.yankFailed')),
    );
  };

  // ---- 構造をたどる（設計書 §17.2）と複製（§17.3） ----

  /** 参照の要素を図の上で探す（描き直しを待つ間の番号で指す要素は選ばない） */
  const targetOf = (ref: ElementRef | null | undefined) => (ref && usable(ref) ? (targets.find((x) => sameRef(x.ref, ref)) ?? null) : null);

  /** ]e / [e: 線をたどって、出ていく先（入ってくる元）へ。線を選んでいれば、その端へ */
  const viFollow = (forward: boolean, count: number) => {
    const spec = plugin.structure;
    const source = useSession.getState().current?.text.toString();
    if (!spec?.links || source === undefined) return showToast(t('struct.unsupported'));
    let ref = viCursor()?.ref;
    let found: DiagramTarget | null = null;
    for (let n = 0; n < count && ref; n++) {
      const next = followLinks(spec, source, ref, forward).map(targetOf).find((x) => x !== null) ?? null;
      if (!next) break;
      found = next;
      ref = next.ref;
    }
    if (found) viSelect(found);
    else showToast(t(forward ? 'struct.noOutgoing' : 'struct.noIncoming'));
  };

  /** ]g / [g: 囲む枠（親）へ・中の最初の要素（子）へ */
  const viNest = (out: boolean, count: number) => {
    const spec = plugin.structure;
    const source = useSession.getState().current?.text.toString();
    if (!spec || source === undefined) return showToast(t('struct.unsupported'));
    let ref = viCursor()?.ref;
    let found: DiagramTarget | null = null;
    for (let n = 0; n < count && ref; n++) {
      const next = out ? targetOf(spec.parent(source, ref)) : (spec.children(source, ref).map(targetOf).find((x) => x !== null) ?? null);
      if (!next) break;
      found = next;
      ref = next.ref;
    }
    if (found) viSelect(found);
    else showToast(t(out ? 'struct.noParent' : 'struct.noChild'));
  };

  /** >> / <<: 前の兄弟の中へ入れる・囲む枠の外へ出す（ドラッグでの移動と同じ変更を使う） */
  const viShift = async (inward: boolean) => {
    const spec = plugin.reorder;
    const st = plugin.structure;
    const ref = selected?.ref;
    const source = useSession.getState().current?.text.toString();
    if (!spec || !st || !ref || source === undefined || !canEdit || !usable(ref)) return;
    const parent = st.parent(source, ref);
    let res: ActionResult | null = null;
    if (inward) {
      // 同じ親の中で、ソースの順で直前にある「中へ入れられる」要素
      const list = pickable();
      const at = list.indexOf(selected);
      // 選んだ要素が候補の中に無ければ（線を選んでいるときなど）、「直前」が決まらない
      const before = at < 0 ? [] : list.slice(0, at).reverse();
      const sameParent = (r: ElementRef) => {
        const p = st.parent(source, r);
        return p === null ? parent === null : sameRef(p, parent);
      };
      const into = before.find((x) => x.ref && !sameRef(x.ref, ref) && sameParent(x.ref) && spec.acceptsInto?.(source, ref, x.ref));
      res = into?.ref ? (spec.into?.(source, ref, into.ref) ?? null) : null;
    } else if (parent) {
      // 木の図種は親のすぐ後ろへ、枠の図種は親の外側の枠（無ければ図の一番外）へ
      res =
        spec.move && spec.accepts?.(ref, parent, source)
          ? spec.move(source, ref, parent, false)
          : (spec.into?.(source, ref, st.parent(source, parent)) ?? null);
    }
    if (res) await commit(res);
    else showToast(t(inward ? 'struct.cannotIndent' : 'struct.cannotOutdent'));
  };

  /** コピーした要素（文書と、コピーしたときのテキスト。番号で指す要素は、テキストが変わっていなければ使う） */
  const copied = useRef<{ docId: string; text: string; refs: ElementRef[] } | null>(null);
  const selectionRefs = () => (multi.length > 1 ? multi : selected?.ref ? [selected.ref] : []);

  const copySelection = (quiet = false) => {
    const cur = useSession.getState().current;
    const refs = selectionRefs().filter((r) => plugin.duplicate?.accepts(r));
    if (!cur || refs.length === 0) return false;
    copied.current = { docId: cur.id, text: cur.text.toString(), refs };
    if (!quiet) showToast(t('dup.copied', { n: String(refs.length) }));
    return true;
  };

  /** 要素を複製する（refs を省くと、コピーした要素） */
  const duplicate = async (refs?: ElementRef[]) => {
    const cur = useSession.getState().current;
    if (!cur || !canEdit) return;
    const source = cur.text.toString();
    let list = refs;
    if (!list) {
      const c = copied.current;
      if (!c || c.docId !== cur.id) return showToast(t('dup.nothing'));
      // 番号で指す要素は、コピーした後にテキストが変わると別の要素を指すので使わない
      list = c.refs.filter((r) => !isPositional(r) || c.text === source);
      if (list.length === 0) return showToast(t('dup.stale'));
    }
    const spec = plugin.duplicate;
    const usableRefs = list.filter((r) => spec?.accepts(r) && usable(r));
    if (!spec || usableRefs.length === 0) return showToast(t('dup.unsupported'));
    await commit(spec.run(source, usableRefs));
  };

  /** 操作を count 回、順に当てる（1 回ごとに 1 ステップ） */
  const runRepeated = async (action: DiagramAction, ref: ElementRef, count: number) => {
    for (let n = 0; n < count; n++) await runAction(action, [ref]);
  };

  const viRun = (cmd: string, count: number): boolean => {
    const repeat = (f: () => void) => {
      for (let n = 0; n < count; n++) f();
    };
    const ref = selected?.ref;
    switch (cmd) {
      case 'h':
      case 'j':
      case 'k':
      case 'l':
        viMoveDir(cmd, count);
        return true;
      case 'w':
        viMoveOrder(count);
        return true;
      case 'b':
        viMoveOrder(-count);
        return true;
      case 'g g':
        viMoveOrder('first');
        return true;
      case 'G':
        viMoveOrder('last');
        return true;
      case '/':
        setSearch('');
        return true;
      case 'n':
      case 'N':
        viFind(lastQuery.current, cmd === 'N', count);
        return true;
      case 'g d':
        if (selected?.range) {
          revealRange(selected.range.from, selected.range.to);
          focusPane('editor');
        }
        return true;
      case 'z h':
        panBy(VI_PAN_PX * count, 0);
        return true;
      case 'z l':
        panBy(-VI_PAN_PX * count, 0);
        return true;
      case 'z j':
        panBy(0, -VI_PAN_PX * count);
        return true;
      case 'z k':
        panBy(0, VI_PAN_PX * count);
        return true;
      case 'z z':
        if (selected) center(selected.el);
        return true;
      case '+':
        zoomBy(1.25 ** count);
        return true;
      case '-':
        zoomBy(1 / 1.25 ** count);
        return true;
      case '=':
        fit();
        return true;
      case 'i':
      case 'a':
      case 'c c':
      case 'S':
        if (selected && editable && !session) startLabelEdit(selected, cmd === 'i' ? 'start' : cmd === 'a' ? 'end' : 'clear');
        return true;
      case '<CR>':
        // 接続モード: 選んでいる要素へ接続する。それ以外は標準の Enter（ラベルの編集）に任せる
        if (!connect) return false;
        if (ref && (connect.action.targetKinds ?? connect.action.appliesTo ?? ['node']).includes(ref.kind)) {
          void runAction(connect.action, [connect.from, ref]);
          setConnect(null);
        }
        return true;
      case 'o':
      case 'd d':
      case 'x':
      case '.': {
        if (!canEdit) return true;
        const del = cmd === 'd d' || cmd === 'x';
        if (del && multi.length > 1) {
          void deleteMany(multi);
          return true;
        }
        // 3dd: 選んだ要素から、ソースの順で 3 つをまとめて消す（履歴は 1 ステップ）
        if (del && count > 1 && selected && ref) {
          const list = pickable();
          const refs = list
            .slice(list.indexOf(selected))
            .flatMap((x) => (x.ref ? [x.ref] : []))
            .slice(0, count);
          void deleteMany(refs);
          return true;
        }
        const last = lastAction.current;
        const action =
          cmd === '.'
            ? last && last.type === plugin.type
              ? elementActions.find((a) => a.id === last.id)
              : undefined
            : elementActions.find((a) => a.key === (cmd === 'o' ? 'Tab' : 'Delete') && a.arity === 1);
        if (action && ref) {
          lastAction.current = { type: plugin.type, id: action.id };
          // 消す操作は、回数が 1 のときだけここに来る（上でまとめて消す）
          void runRepeated(action, ref, del ? 1 : count);
        }
        return true;
      }
      case 'J':
      case 'K':
        void viSwap(cmd === 'J', count);
        return true;
      case 'c e': {
        const action = elementActions.find((a) => a.arity === 2);
        if (action && canEdit) triggerAction(action);
        return true;
      }
      case 'u':
        repeat(undo);
        return true;
      case '<C-r>':
        repeat(redo);
        return true;
      case 'y y':
        viYank();
        copySelection(true);
        return true;
      case 'y':
        // ビジュアルモードの y: 選んだ要素をまとめてコピーする（p で複製する）
        copySelection();
        setVisual(false);
        return true;
      case 'p':
        // 選んでいる要素を複製する。yy・y でコピーした要素があれば、それを複製する
        if (canEdit) void (copied.current?.docId === useSession.getState().current?.id ? duplicate() : duplicate(selectionRefs()));
        if (visual) setVisual(false);
        return true;
      case '] e':
      case '[ e':
        viFollow(cmd === '] e', count);
        return true;
      case '] g':
      case '[ g':
        viNest(cmd === '] g', count);
        return true;
      case '> >':
      case '< <':
        void viShift(cmd === '> >');
        return true;
      case 'm': {
        const vp = viewport.current;
        if (selected && vp) {
          const r = targetRect(selected, vp);
          setMenu({ x: r.left, y: r.top + r.height });
          // キーボードで選べるよう、最初の項目へフォーカスを移す（Tab で次へ、Enter で実行、Esc で閉じる）
          requestAnimationFrame(() => vp.querySelector<HTMLElement>('.context-menu .menu-item:not(:disabled)')?.focus());
        }
        return true;
      }
      case 'v':
        if (visual) {
          setVisual(false);
          setSelectedKeys((ks) => ks.slice(-1));
        } else {
          setVisual(true);
          if (!selected) viMoveOrder('first');
        }
        return true;
      case 'd':
        // ビジュアルモードの d / x: 選んだ要素をまとめて消す（履歴は 1 ステップ）
        if (multi.length > 1) {
          if (canEdit) void deleteMany(multi);
        } else if (ref) {
          const del = elementActions.find((a) => a.key === 'Delete' && a.arity === 1);
          if (del && canEdit) void runAction(del, [ref]);
        }
        setVisual(false);
        return true;
      case '<Esc>':
        setVisual(false);
        setSelectedKeys((ks) => ks.slice(-1));
        return true;
    }
    return false;
  };
  const viRef = useRef({ run: viRun, visual });
  viRef.current = { run: viRun, visual };
  useEffect(
    () =>
      registerViPane('diagram', {
        commands: () => (viRef.current.visual ? VI_VISUAL : VI_NORMAL),
        // ビジュアルモードの x は d と同じ
        run: (cmd, count) => viRef.current.run(cmd === 'x' && viRef.current.visual ? 'd' : cmd, count),
      }),
    [],
  );
  const viMode = search !== null ? 'search' : connect ? 'connect' : visual ? 'visual' : 'normal';
  // メニューを閉じて（項目を実行して）フォーカスの行き先が無くなったら、図に戻す
  useEffect(() => {
    if (!menu && keymap === 'vi' && document.activeElement === document.body) viewport.current?.focus();
  }, [menu, keymap]);

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
        <button className={`btn${outlineOpen ? ' active' : ''}`} onClick={toggleOutline} aria-pressed={outlineOpen}>
          {t('outline.toggle')}
        </button>
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
      <div className="diagram-body">
      {outlineOpen && (
        <OutlinePanel
          rows={outline}
          selectedKeys={selectedKeys}
          query={outlineQuery}
          onQuery={setOutlineQuery}
          onSelect={(row, additive) => {
            const x = row.target;
            if (x.ref && !usable(x.ref)) return;
            const k = row.key;
            if (additive && x.ref) setSelectedKeys((ks) => (ks.includes(k) ? ks.filter((y) => y !== k) : [...ks, k]));
            else {
              setSelectedKey(k);
              if (x.range) revealRange(x.range.from, x.range.to);
            }
            scrollIntoView(x.el);
          }}
        />
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
            {canEdit && selected.ref && plugin.duplicate?.accepts(selected.ref) && (
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  void duplicate(selectionRefs());
                }}
              >
                <span>{t('dup.menu')}</span>
                <kbd>Ctrl+D</kbd>
              </button>
            )}
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
        {search !== null && (
          <div className="vi-search" onPointerDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              value={search}
              placeholder={t('vi.searchPlaceholder')}
              aria-label={t('vi.searchPlaceholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                // 変換確定の Enter では決めない
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  if (e.key === 'Enter') {
                    lastQuery.current = search;
                    viFind(search, false);
                  }
                  setSearch(null);
                  viewport.current?.focus();
                }
              }}
              onBlur={() => setSearch(null)}
            />
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
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
      </div>
      </div>
      {panelOpen && (
        <PropertyPanel key={plugin.type} plugin={plugin} selected={selected?.ref ?? null} selectedFrom={selected?.range?.from ?? null} multi={multi} editable={canEdit} />
      )}
      <div className="pane-footer">
        {keymap === 'vi' && (
          <span className="vi-status">
            <span className={`vi-mode ${viMode}`}>{t(`vi.mode.${viMode}`)}</span>
            {pendingKeys && <kbd>{pendingKeys}</kbd>}
          </span>
        )}
        {plugin.actions?.some((a) => a.key === 'Tab')
          ? t('diagram.hintActions')
          : plugin.actions
            ? t('diagram.hintSelect')
            : t('diagram.hint')}
      </div>
    </section>
  );
}
