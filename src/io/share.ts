import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

// 設計書 §9.4: URL 共有。図のテキストを deflate で圧縮し、base64url にして URL の # 以降に入れる。
// # 以降（fragment）はサーバーに送られないので、図の内容は外部に出ない。
// 共有された内容は信頼できない入力として扱う（描画は常に securityLevel: 'strict'）。

export const SHARE_PREFIX = '#v1/';
/** これより長い URL は、チャットやブラウザによっては切れることがある */
export const SHARE_URL_WARN = 8000;

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

/** 不正な fragment なら null */
export function decodeShare(hash: string): SharedDiagram | null {
  if (!hash.startsWith(SHARE_PREFIX)) return null;
  try {
    const data = JSON.parse(strFromU8(inflateSync(fromBase64Url(hash.slice(SHARE_PREFIX.length)))));
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
