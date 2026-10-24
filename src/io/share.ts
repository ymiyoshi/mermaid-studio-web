import { deflateSync, Inflate, strFromU8, strToU8 } from 'fflate';

// 設計書 §9.4: URL 共有。図のテキストを deflate で圧縮し、base64url にして URL の # 以降に入れる。
// # 以降（fragment）はサーバーに送られないので、図の内容は外部に出ない。
// 共有された内容は信頼できない入力として扱う（描画は常に securityLevel: 'strict'）。

export const SHARE_PREFIX = '#v1/';
/** これより長い URL は、チャットやブラウザによっては切れることがある */
export const SHARE_URL_WARN = 8000;
/**
 * 展開後の大きさの上限（バイト）。数百 KB の URL が数百 MB に展開される「展開爆弾」で、
 * 巨大な図が保存されて起動できなくなるのを防ぐ。mermaid が描ける大きさ（maxTextSize 既定 5 万文字）より十分大きい
 */
export const SHARE_MAX_BYTES = 512 * 1024;
/** 一度に展開する入力の大きさ。deflate の最大圧縮率は約 1000 倍なので、出力は 1 回あたり 1MB 程度に収まる */
const INFLATE_STEP = 1024;

export interface SharedDiagram {
  title: string;
  text: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function encodeShare(d: SharedDiagram): string {
  return SHARE_PREFIX + toBase64Url(deflateSync(strToU8(JSON.stringify({ t: d.title, s: d.text })), { level: 9 }));
}

/** 少しずつ展開し、maxBytes を超えたら途中でやめて Error を投げる */
function inflateLimited(data: Uint8Array, maxBytes: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > maxBytes) throw new Error('share data too large');
    chunks.push(chunk);
    if (final) done = true;
  });
  for (let i = 0; i < data.length; i += INFLATE_STEP) {
    inflater.push(data.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= data.length);
  }
  if (!done) throw new Error('truncated share data');
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** 不正な fragment・大きすぎる図なら null */
export function decodeShare(hash: string): SharedDiagram | null {
  if (!hash.startsWith(SHARE_PREFIX)) return null;
  try {
    const bytes = inflateLimited(fromBase64Url(hash.slice(SHARE_PREFIX.length)), SHARE_MAX_BYTES);
    const data = JSON.parse(strFromU8(bytes));
    if (typeof data?.s !== 'string') return null;
    return { title: typeof data.t === 'string' ? data.t.slice(0, 200) : '', text: data.s };
  } catch {
    return null;
  }
}

export function shareUrl(d: SharedDiagram, base = location.href): string {
  const u = new URL(base);
  u.hash = '';
  return u.toString().replace(/#$/, '') + encodeShare(d);
}
