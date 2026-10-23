import { create } from 'zustand';
import { useSession } from '../core/session';
import { configureMermaid, renderSvg, validate, type ParseError } from './mermaid';

// 設計書 §4.3: テキストが変わるたびに検証し、描画は少し待ってから行う。
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

const RENDER_DEBOUNCE_MS = 150;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function update(text: string) {
  const mySeq = ++seq;
  if (timer) clearTimeout(timer);
  if (text.trim() === '') {
    useRender.setState({ status: 'empty', error: null, diagramType: null, svg: null, svgSource: '', stale: false });
    return;
  }
  const v = await validate(text);
  if (mySeq !== seq) return;
  if (!v.ok) {
    useRender.setState({ status: 'error', error: v.error, stale: useRender.getState().svg !== null });
    return;
  }
  useRender.setState({ status: 'pending', error: null, diagramType: v.diagramType, stale: true });
  timer = setTimeout(async () => {
    const r = await renderSvg(text);
    if (mySeq !== seq) return;
    if (r.ok) useRender.setState({ status: 'ok', svg: r.svg, svgSource: text, stale: false, error: null });
    else useRender.setState({ status: 'error', error: r.error, stale: useRender.getState().svg !== null });
  }, RENDER_DEBOUNCE_MS);
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
    void update(s.current.text.toString());
  };
  run();
  return useSession.subscribe(run);
}
