import mermaid from 'mermaid';

// 設計書 §5: mermaid.js による検証と描画。
// securityLevel は常に 'strict'。mermaid の既定の `secure` 設定により、
// frontmatter や %%{init}%% から securityLevel を上書きすることはできない（§9.4）。

export type Theme = 'default' | 'dark' | 'forest' | 'neutral';

export interface ParseError {
  message: string;
  /** 1 始まり */
  line: number | null;
}

export type ValidateResult = { ok: true; diagramType: string | null } | { ok: false; error: ParseError };

let currentTheme: Theme | null = null;

export function configureMermaid(theme: Theme) {
  if (theme === currentTheme) return;
  currentTheme = theme;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    suppressErrorRendering: true,
  });
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

export async function validate(text: string): Promise<ValidateResult> {
  if (text.trim() === '') return { ok: true, diagramType: null };
  try {
    const r = await mermaid.parse(text);
    return { ok: true, diagramType: r ? r.diagramType : null };
  } catch (e) {
    return { ok: false, error: toParseError(e, text) };
  }
}

// mermaid.render は同時に複数呼ぶと干渉するので直列化する
let queue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

export type RenderResult = { ok: true; svg: string } | { ok: false; error: ParseError };

export function renderSvg(text: string): Promise<RenderResult> {
  const id = `mmd-render-${++renderSeq}`;
  const job = queue.then(async (): Promise<RenderResult> => {
    try {
      const { svg } = await mermaid.render(id, text);
      return { ok: true, svg };
    } catch (e) {
      return { ok: false, error: toParseError(e, text) };
    } finally {
      // 失敗時に mermaid が残す一時要素を片付ける
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job;
  return job;
}
