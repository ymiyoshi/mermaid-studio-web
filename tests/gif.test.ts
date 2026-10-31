import { describe, expect, it } from 'vitest';
import { encodeGif } from '../src/io/gif';

// 設計書 §17.8: GIF の書き出し。書いた GIF を、ここで書いた最小の復号器で読み戻して確かめる

interface Decoded {
  width: number;
  height: number;
  palette: Uint8Array;
  frames: { delay: number; indices: Uint8Array }[];
  loop: boolean;
}

function lzwDecode(min: number, data: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const clear = 1 << min;
  const eoi = clear + 1;
  let codeSize = min + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    codeSize = min + 1;
  };
  reset();
  let pos = 0;
  let bit = 0;
  let prev: number[] | null = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const b = (data[(bit >> 3)] >> (bit & 7)) & 1;
      code |= b << i;
      bit++;
    }
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('不正な符号');
    for (const x of entry) out[pos++] = x;
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  expect(pos).toBe(size);
  return out;
}

function decode(gif: Uint8Array): Decoded {
  const text = String.fromCharCode(...gif.slice(0, 6));
  expect(text).toBe('GIF89a');
  const u16 = (i: number) => gif[i] | (gif[i + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  expect(gif[10] & 0x80).toBe(0x80);
  const tableSize = 2 << (gif[10] & 7);
  const palette = gif.slice(13, 13 + tableSize * 3);
  let p = 13 + tableSize * 3;
  const frames: Decoded['frames'] = [];
  let delay = 0;
  let loop = false;
  const blocks = () => {
    const parts: number[] = [];
    while (gif[p] !== 0) {
      const n = gif[p];
      parts.push(...gif.slice(p + 1, p + 1 + n));
      p += n + 1;
    }
    p++;
    return new Uint8Array(parts);
  };
  for (;;) {
    const b = gif[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = gif[p++];
      if (label === 0xf9) delay = u16(p + 2);
      if (label === 0xff) loop = String.fromCharCode(...gif.slice(p + 1, p + 12)) === 'NETSCAPE2.0';
      blocks();
    } else if (b === 0x2c) {
      p += 9;
      const min = gif[p++];
      frames.push({ delay, indices: lzwDecode(min, blocks(), width * height) });
    } else throw new Error(`知らないブロック ${b}`);
  }
  return { width, height, palette, frames, loop };
}

function frame(w: number, h: number, color: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y);
      rgba.set([r, g, b, 255], (y * w + x) * 4);
    }
  return rgba;
}

describe('GIF の書き出し', () => {
  it('読み戻すと、大きさ・枚数・表示時間・繰り返しが合い、色は色表の近い色になる', () => {
    const w = 37;
    const h = 23;
    const a = frame(w, h, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [224, 54, 107]));
    const b = frame(w, h, (x) => (x < 10 ? [29, 35, 44] : [255, 255, 255]));
    const gif = encodeGif(w, h, [
      { rgba: a, delayCs: 50 },
      { rgba: b, delayCs: 120 },
    ]);
    const d = decode(gif);
    expect([d.width, d.height, d.frames.length, d.loop]).toEqual([w, h, 2, true]);
    expect(d.frames.map((f) => f.delay)).toEqual([50, 120]);
    const colorAt = (f: number, x: number, y: number) => {
      const i = d.frames[f].indices[y * w + x];
      return [...d.palette.slice(i * 3, i * 3 + 3)];
    };
    expect(colorAt(0, 0, 0)).toEqual([224, 54, 107]);
    expect(colorAt(0, 1, 0)).toEqual([255, 255, 255]);
    expect(colorAt(1, 3, 5)).toEqual([29, 35, 44]);
    expect(colorAt(1, 30, 5)).toEqual([255, 255, 255]);
  });

  it('色の多い大きな画像でも、辞書を作り直しながら正しく読み戻せる（色は近い色に寄る）', () => {
    const w = 200;
    const h = 120;
    const px = frame(w, h, (x, y) => [(x * 7) & 255, (y * 13) & 255, (x * y) & 255]);
    const d = decode(encodeGif(w, h, [{ rgba: px, delayCs: 10 }]));
    let err = 0;
    for (let i = 0; i < w * h; i++) {
      const k = d.frames[0].indices[i];
      for (let c = 0; c < 3; c++) err += Math.abs(d.palette[k * 3 + c] - px[i * 4 + c]);
    }
    // 1 画素・1 チャンネルあたりの誤差の平均が小さい
    expect(err / (w * h * 3)).toBeLessThan(40);
  });
});
