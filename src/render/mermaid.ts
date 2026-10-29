import type { Mermaid } from 'mermaid';

// 設計書 §5: mermaid.js による検証と描画。
// securityLevel は常に 'strict'。`secure` 設定により、
// frontmatter や %%{init}%% から securityLevel やラベルの消毒の設定を上書きすることはできない（§9.4）。
// mermaid 本体は大きい（1MB 超）ので、起動を待たせないよう動的に読み込む。

export type Theme = 'default' | 'dark' | 'forest' | 'neutral';

export interface ParseError {
  message: string;
  /** 1 始まり */
  line: number | null;
}

export type ValidateResult = { ok: true; diagramType: string | null } | { ok: false; error: ParseError };

/** 使いたいテーマ（configureMermaid で決める）と、mermaid に設定済みのテーマ */
let wantedTheme: Theme | null = null;
let appliedTheme: Theme | null = null;
let loading: Promise<Mermaid> | null = null;

/**
 * ラベルの消毒で落とすタグ。style は mermaid の既定（dompurifyConfig を渡すと既定が置き換わるので残す）。
 * 入力欄は、共有リンクの図に外部へ送信するフォーム（パスワード欄など）を仕込まれないように落とす
 */
const FORBID_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option'];

/**
 * 図の側（%%{init}%%・frontmatter）から変えられない設定。mermaid の既定の 6 つに dompurifyConfig を足す
 * （mermaid は initialize で渡した一覧で置き換えるので、既定の分も書く）
 */
const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'dompurifyConfig'];

function baseConfig(theme: Theme, htmlLabels: boolean) {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    secure: SECURE_KEYS,
    dompurifyConfig: { FORBID_TAGS },
    theme,
    suppressErrorRendering: true,
    htmlLabels,
    flowchart: { htmlLabels },
  };
}

export function configureMermaid(theme: Theme) {
  wantedTheme = theme;
}

/** mermaid を読み込み（初回だけ）、使いたいテーマを反映して返す */
async function loadMermaid(): Promise<Mermaid> {
  // 読み込みに失敗したら、次の呼び出しで読み込み直す
  loading ??= import('mermaid').then(
    (m) => m.default,
    (e) => {
      loading = null;
      throw e;
    },
  );
  const mermaid = await loading;
  if (wantedTheme !== null && wantedTheme !== appliedTheme) {
    appliedTheme = wantedTheme;
    mermaid.initialize(baseConfig(wantedTheme, true));
  }
  return mermaid;
}

/** 起動直後に読み込みを始めておく（最初の描画を遅らせないため） */
export function preloadMermaid() {
  // 失敗は、実際に検証・描画するときにエラーとして出す
  loadMermaid().catch(() => {});
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * mermaid は構文解析の前に frontmatter と %% コメント行を取り除くので、
 * エラーの行番号は「取り除いた後」の行を指す。元のテキストの行番号に戻す。
 */
export function toSourceLine(text: string, processedLine: number): number {
  const lines = text.split('\n');
  const kept: number[] = [];
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((l, j) => j > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) if (!/^\s*%%(?!\{)./.test(lines[i])) kept.push(i + 1);
  return kept[processedLine - 1] ?? processedLine;
}

export function toParseError(e: unknown, text: string): ParseError {
  const err = e as { message?: string; hash?: { loc?: { first_line?: number }; line?: number } };
  const message = String(err?.message ?? e).trim();
  let line: number | null = err?.hash?.loc?.first_line ?? (err?.hash?.line != null ? err.hash.line + 1 : null);
  if (line == null) {
    const m = /line[:\s]+(\d+)/i.exec(message);
    if (m) line = Number(m[1]);
  }
  if (line != null) return { message, line: toSourceLine(text, line) };
  const m = /offset[:\s]+(\d+)/i.exec(message);
  if (m) line = lineFromOffset(text, Number(m[1]));
  return { message, line };
}

/** 直前に検証したテキストと結果（図からの操作で検証したテキストを、描画の前にもう一度読まないため） */
let lastValidated: { text: string; result: ValidateResult } | null = null;

export async function validate(text: string): Promise<ValidateResult> {
  if (text.trim() === '') return { ok: true, diagramType: null };
  if (lastValidated?.text === text) return lastValidated.result;
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (e) {
    // 読み込みの失敗は覚えない（次の検証で読み込み直す）
    return { ok: false, error: toParseError(e, text) };
  }
  let result: ValidateResult;
  try {
    const r = await mermaid.parse(text);
    result = { ok: true, diagramType: r ? r.diagramType : null };
  } catch (e) {
    result = { ok: false, error: toParseError(e, text) };
  }
  lastValidated = { text, result };
  return result;
}

// mermaid.render は同時に複数呼ぶと干渉するので直列化する
let queue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

export type RenderResult = { ok: true; svg: string } | { ok: false; error: ParseError };

export interface RenderOptions {
  /**
   * false にすると、ラベルを HTML（foreignObject）ではなく SVG の text で描く。
   * foreignObject を含む SVG は canvas に描くと崩れたり汚染されたりするので、PNG 出力で使う（§9.5）
   */
  htmlLabels?: boolean;
}

export function renderSvg(text: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const id = `mmd-render-${++renderSeq}`;
  const job = queue.then(async (): Promise<RenderResult> => {
    // 失敗しても queue を止めないよう、読み込みの失敗もエラーとして返す
    let mermaid: Mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (e) {
      return { ok: false, error: toParseError(e, text) };
    }
    const theme = appliedTheme;
    const override = opts.htmlLabels === false && theme !== null;
    if (override) mermaid.initialize(baseConfig(theme, false));
    try {
      const { svg } = await mermaid.render(id, text);
      return { ok: true, svg };
    } catch (e) {
      return { ok: false, error: toParseError(e, text) };
    } finally {
      // 描画中にテーマが変わっていれば、変わった後のテーマに戻す
      if (override) mermaid.initialize(baseConfig(appliedTheme!, true));
      // 失敗時に mermaid が残す一時要素を片付ける
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job;
  return job;
}
