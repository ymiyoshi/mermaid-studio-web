import { create } from 'zustand';
import { useSession } from '../core/session';
import { configureMermaid, peekValidated, renderSvg, type ParseError } from './mermaid';
import { bodyLines } from '../plugins/source';

// 設計書 §4.3・§17.1: テキストが変わるたびに描き直す（描画の中で構文も確かめる）。続けて打っている間は、描き終えてから少し待って最新を描く。
// 構文エラーの間は、最後に正常だった描画を残して「古い」印を付ける。

export interface RenderState {
  status: 'empty' | 'ok' | 'error' | 'pending';
  error: ParseError | null;
  diagramType: string | null;
  /** 最後に正常に描画できた SVG */
  svg: string | null;
  /** svg を描画したときのテキスト（ソースとの対応付けに使う） */
  svgSource: string;
  /** svg が現在のテキストより古いか */
  stale: boolean;
}

export const useRender = create<RenderState>(() => ({
  status: 'pending',
  error: null,
  diagramType: null,
  svg: null,
  svgSource: '',
  stale: false,
}));

/**
 * 描いている間に入力があったとき、描き終えてから次に描き始めるまで空ける間隔（設計書 §17.1・§18）。
 * 描いている間に入力が無ければ（描き終えた後の入力なら）、待たずにすぐ描く。続けて打っている間だけ
 * 「描き終えてからこの間隔の後に、最新のテキストを描く」（その間に打鍵を画面に出す）。
 * 描画（mermaid.render）は中で構文解析もするので、描く前に別に検証しない（200 ノードで parse が 80ms ほどかかり、2 回読むことになる）
 */
export const RENDER_GAP_MS = 150;
let seq = 0;
/** 描き始めを待っているときの取り消し */
let timer: (() => void) | null = null;
/** 描いている途中か */
let rendering = false;
/** 最後に描き終えた時刻 */
let lastEnd = -Infinity;
/** 描きたい最新のテキスト（描いている間に変わったら、描き終えてから描く） */
let wanted: string | null = null;
/** 今の描画の途中に入力があったか（続けて打っているか） */
let typedWhileRendering = false;

async function renderLatest() {
  timer = null;
  if (rendering || wanted === null) return;
  const text = wanted;
  const mySeq = seq;
  wanted = null;
  rendering = true;
  typedWhileRendering = false;
  let r: Awaited<ReturnType<typeof renderSvg>>;
  try {
    r = await renderSvg(text);
  } finally {
    rendering = false;
    lastEnd = performance.now();
  }
  // 描いている間にテキストが変わっていれば、この結果は捨てて最新を描く
  if (mySeq === seq) {
    if (r.ok) useRender.setState({ status: 'ok', svg: r.svg, svgSource: text, diagramType: r.diagramType, stale: false, error: null });
    else useRender.setState({ status: 'error', error: r.error, stale: useRender.getState().svg !== null });
  }
  schedule();
}

function later(ms: number, fn: () => void): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * 次に画面を描いた後で fn を呼ぶ。mermaid.render は最初の数十〜百 ms を打鍵と同じタスクの中で進めるので、
 * すぐ呼ぶと、打った文字がエディタに出るのが描画の分だけ遅れる（§18）
 */
function afterPaint(fn: () => void): () => void {
  // 隠れたタブでは画面を描かない（requestAnimationFrame が呼ばれない）ので、待たずに描く（読み取り専用のタブが保存に追従するため）
  if (typeof requestAnimationFrame !== 'function' || (typeof document !== 'undefined' && document.hidden)) return later(0, fn);
  let cancelTimer: (() => void) | null = null;
  const frame = requestAnimationFrame(() => (cancelTimer = later(0, fn)));
  return () => {
    cancelAnimationFrame(frame);
    cancelTimer?.();
  };
}

function schedule() {
  if (rendering || wanted === null || timer) return;
  const wait = typedWhileRendering ? lastEnd + RENDER_GAP_MS - performance.now() : 0;
  const run = () => void renderLatest();
  timer = wait <= 0 ? afterPaint(run) : later(wait, run);
}

function update(text: string) {
  ++seq;
  if (rendering) typedWhileRendering = true;
  if (text.trim() === '') {
    timer?.();
    timer = null;
    wanted = null;
    useRender.setState({ status: 'empty', error: null, diagramType: null, svg: null, svgSource: '', stale: false });
    return;
  }
  // 図からの操作で検証済みのテキストなら、描く前に図種が分かる（描き終えるまで、パネルの操作を図種に合わせて出せる）
  const known = peekValidated(text);
  if (known && !known.ok) {
    wanted = null;
    useRender.setState({ status: 'error', error: known.error, stale: useRender.getState().svg !== null });
    return;
  }
  // 検証していないテキストでは、描き終えるまで前の図種のままにする。ただし宣言の語（flowchart・sequenceDiagram など）が
  // 変わったときは、前の図種の操作を新しいテキストに当てないよう、図種を分からないことにする（§17.1）
  const declOf = (s: string) => /^\S*/.exec(bodyLines(s).header?.text.trim() ?? '')![0];
  const typeChanged = !known?.ok && declOf(text) !== declOf(useRender.getState().svgSource);
  useRender.setState({
    status: 'pending',
    error: null,
    ...(known?.ok ? { diagramType: known.diagramType } : typeChanged ? { diagramType: null } : {}),
    stale: true,
  });
  wanted = text;
  schedule();
}

export function startRenderPipeline() {
  let lastText: unknown = null;
  let lastTheme: unknown = null;
  let lastDocId: string | null = null;
  const run = () => {
    const s = useSession.getState();
    if (!s.current) return;
    if (s.current.text === lastText && s.theme === lastTheme) return;
    if (s.theme !== lastTheme) configureMermaid(s.theme);
    // 別の文書の「最後に正常だった図」を出さない
    if (s.current.id !== lastDocId) {
      lastDocId = s.current.id;
      useRender.setState({ svg: null, svgSource: '', stale: false });
    }
    lastText = s.current.text;
    lastTheme = s.theme;
    update(s.current.text.toString());
  };
  run();
  return useSession.subscribe(run);
}
