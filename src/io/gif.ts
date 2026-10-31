// GIF（GIF89a・アニメーション）の書き出し（設計書 §17.8）。外部のライブラリを使わず、同梱する。
// 図は使う色が少ないので、全フレームで 1 つの色表（256 色）を使う。色は各チャンネル 5 ビットにまとめて数え、
// 多い順に 256 色を選び、残りは一番近い色に寄せる（図の線や文字の色はほぼそのまま残る）。

export interface GifFrame {
  /** RGBA（canvas の getImageData の data） */
  rgba: Uint8ClampedArray;
  /** 表示する時間（1/100 秒） */
  delayCs: number;
}

const bucketOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** フレームの色を数える（全フレームを持っておかなくてよいように、1 枚ずつ足す） */
export class ColorCounter {
  private count = new Uint32Array(32768);
  // 平均の色を出すための和
  private sum = new Float64Array(32768 * 3);

  add(rgba: Uint8ClampedArray) {
    // 全画素を数えると遅いので、間引いて数える（色の多い・少ないが分かればよい）
    for (let i = 0; i < rgba.length; i += 4 * 3) {
      const k = bucketOf(rgba[i], rgba[i + 1], rgba[i + 2]);
      this.count[k]++;
      this.sum[k * 3] += rgba[i];
      this.sum[k * 3 + 1] += rgba[i + 1];
      this.sum[k * 3 + 2] += rgba[i + 2];
    }
  }

  /** 多い順に 256 色の色表と、5 ビットの色 → 色表の番号の対応 */
  palette(): { palette: Uint8Array; lookup: Uint8Array } {
    const { count, sum } = this;
    const used: number[] = [];
    for (let k = 0; k < 32768; k++) if (count[k] > 0) used.push(k);
    used.sort((a, b) => count[b] - count[a]);
    const chosen = used.slice(0, 256);
    const palette = new Uint8Array(256 * 3);
    chosen.forEach((k, i) => {
      palette[i * 3] = Math.round(sum[k * 3] / count[k]);
      palette[i * 3 + 1] = Math.round(sum[k * 3 + 1] / count[k]);
      palette[i * 3 + 2] = Math.round(sum[k * 3 + 2] / count[k]);
    });
    const n = Math.max(1, chosen.length);
    const lookup = new Uint8Array(32768);
    for (let k = 0; k < 32768; k++) {
      const r = ((k >> 10) << 3) + 4;
      const g = (((k >> 5) & 31) << 3) + 4;
      const b = ((k & 31) << 3) + 4;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const dr = palette[i * 3] - r;
        const dg = palette[i * 3 + 1] - g;
        const db = palette[i * 3 + 2] - b;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bestD) {
          bestD = d;
          best = i;
          if (d === 0) break;
        }
      }
      lookup[k] = best;
    }
    return { palette, lookup };
  }
}

/** バイト列を少しずつ足していく入れ物 */
class Bytes {
  private buf = new Uint8Array(1 << 16);
  length = 0;
  push(...xs: number[]) {
    for (const x of xs) this.byte(x);
  }
  byte(x: number) {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = x;
  }
  u16(x: number) {
    this.byte(x & 255);
    this.byte((x >> 8) & 255);
  }
  text(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  result() {
    return this.buf.slice(0, this.length);
  }
}

/** 色の番号の列を LZW で圧縮し、255 バイトずつのブロックにして書く（最小の符号の長さは 8） */
function writeLzw(out: Bytes, indices: Uint8Array) {
  const MIN = 8;
  const CLEAR = 1 << MIN;
  const EOI = CLEAR + 1;
  out.byte(MIN);
  let block: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number, size: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      block.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) {
        out.byte(255);
        out.push(...block);
        block = [];
      }
    }
  };
  // 辞書: (前の符号 << 8 | 次の色) → 符号
  const dict = new Map<number, number>();
  let next = EOI + 1;
  let size = MIN + 1;
  emit(CLEAR, size);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      // 辞書がいっぱいになったら作り直す
      emit(CLEAR, size);
      dict.clear();
      next = EOI + 1;
      size = MIN + 1;
    }
    prefix = c;
  }
  emit(prefix, size);
  emit(EOI, size);
  if (bits > 0) block.push(acc & 255);
  if (block.length) {
    out.byte(block.length);
    out.push(...block);
  }
  out.byte(0);
}

/**
 * GIF を 1 枚ずつ書く。色表は先に（ColorCounter で）決めておく。
 * 書いたフレームは圧縮して持つだけなので、元の画素を全部持っておかなくてよい
 */
export class GifWriter {
  private out = new Bytes();
  private indices: Uint8Array;

  constructor(
    private width: number,
    private height: number,
    palette: Uint8Array,
    private lookup: Uint8Array,
  ) {
    const out = this.out;
    this.indices = new Uint8Array(width * height);
    out.text('GIF89a');
    out.u16(width);
    out.u16(height);
    // 全体の色表あり・色の深さ 8 ビット・色表は 256 色
    out.push(0xf7, 0, 0);
    out.push(...palette);
    // 繰り返し（NETSCAPE2.0、0 は無限）
    out.push(0x21, 0xff, 11);
    out.text('NETSCAPE2.0');
    out.push(3, 1, 0, 0, 0);
  }

  /** delayCs: 表示する時間（1/100 秒） */
  addFrame(rgba: Uint8ClampedArray, delayCs: number) {
    const { out, indices, lookup } = this;
    // 表示の時間（前のフレームは残さず描き直す）
    out.push(0x21, 0xf9, 4, 0x04);
    out.u16(Math.max(2, Math.round(delayCs)));
    out.push(0, 0);
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(this.width);
    out.u16(this.height);
    out.byte(0);
    for (let i = 0, j = 0; j < indices.length; i += 4, j++) indices[j] = lookup[bucketOf(rgba[i], rgba[i + 1], rgba[i + 2])];
    writeLzw(out, indices);
  }

  finish(): Uint8Array {
    this.out.byte(0x3b);
    return this.out.result();
  }
}

/** フレームをまとめて GIF にする（繰り返し再生する） */
export function encodeGif(width: number, height: number, frames: readonly GifFrame[]): Uint8Array {
  const counter = new ColorCounter();
  for (const f of frames) counter.add(f.rgba);
  const { palette, lookup } = counter.palette();
  const w = new GifWriter(width, height, palette, lookup);
  for (const f of frames) w.addFrame(f.rgba, f.delayCs);
  return w.finish();
}
