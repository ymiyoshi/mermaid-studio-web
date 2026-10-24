// Markdown 中の ```mermaid ブロックの抽出と差し替え（設計書 §9.3）。
// 保存するときは該当ブロックの中身だけを差し替え、Markdown の他の部分には触れない。

export interface MermaidBlock {
  index: number;
  /** 中身の開始位置（開きフェンスの次の行頭） */
  from: number;
  /** 中身の終了位置（閉じフェンスの行頭） */
  to: number;
  text: string;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b.*$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ANY_OPEN = /^ {0,3}(`{3,}|~{3,})/;

export function findMermaidBlocks(md: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  const lines = md.split('\n');
  let pos = 0;
  let open: { fence: string; from: number; mermaid: boolean } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const next = pos + raw.length + 1;
    if (!open) {
      const m = OPEN.exec(line) ?? ANY_OPEN.exec(line);
      if (m) open = { fence: m[1], from: Math.min(next, md.length), mermaid: OPEN.test(line) };
    } else {
      const m = CLOSE.exec(line);
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        if (open.mermaid) blocks.push({ index: blocks.length, from: open.from, to: pos, text: md.slice(open.from, pos) });
        open = null;
      }
    }
    pos = next;
  }
  return blocks;
}

/** index 番目の mermaid ブロックの中身を text に差し替える。ブロックが無ければ null */
export function replaceMermaidBlock(md: string, index: number, text: string): string | null {
  const block = findMermaidBlocks(md)[index];
  if (!block) return null;
  let body = text === '' || text.endsWith('\n') ? text : text + '\n';
  // 元の Markdown が CRLF なら改行をそろえる
  if (md.includes('\r\n')) body = body.replace(/\r?\n/g, '\r\n');
  return md.slice(0, block.from) + body + md.slice(block.to);
}

/** 新しく .md として保存するときの中身 */
export function wrapAsMarkdown(text: string): string {
  return '```mermaid\n' + (text.endsWith('\n') || text === '' ? text : text + '\n') + '```\n';
}
