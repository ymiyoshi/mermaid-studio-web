import { renderSvg } from '../render/mermaid';
import { prepareSvg } from './exportImage';
import { t } from '../i18n';
import { ColorCounter, GifWriter } from './gif';

// タイムラプスを WebM 動画・GIF にする。各版を描き直して canvas に描き、MediaRecorder で録る（外部のライブラリも通信も使わない）。
// 録画は実時間で進むので、版の数 × 1 枚の時間だけかかる。

export interface VideoFrame {
  text: string;
  /** 画面の下に出す説明（履歴の説明） */
  caption: string;
}

const WIDTH = 1280;
const HEIGHT = 720;
const CAPTION_H = 48;

export function videoSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

async function loadImage(svg: string): Promise<HTMLImageElement | null> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 1 枚分を描く。描けない版（構文エラーの途中など）は、直前の図のまま説明だけ変える。大きさは canvas に合わせる（GIF は小さく描く） */
function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, caption: string, index: number, total: number) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const k0 = W / WIDTH;
  const capH = CAPTION_H * k0;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (img) {
    const areaH = H - capH - 24 * k0;
    const k = Math.min((W - 48 * k0) / img.naturalWidth, areaH / img.naturalHeight, 3 * k0);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, (W - w) / 2, 12 * k0 + (areaH - h) / 2, w, h);
  }
  ctx.fillStyle = '#f2f3f5';
  ctx.fillRect(0, H - capH, W, capH);
  ctx.fillStyle = '#1d232c';
  ctx.font = `${Math.round(20 * k0)}px "BIZ UDGothic", "Yu Gothic", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(caption.slice(0, 60), 20 * k0, H - capH / 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${index + 1} / ${total}`, W - 20 * k0, H - capH / 2);
  ctx.textAlign = 'left';
}

/** 各版を描き直して画像にする（描けない版は直前の画像を使う）。止めたら null */
async function renderFrames(frames: VideoFrame[], signal?: AbortSignal): Promise<(HTMLImageElement | null)[] | null> {
  const images: (HTMLImageElement | null)[] = [];
  let last: HTMLImageElement | null = null;
  for (const f of frames) {
    if (signal?.aborted) return null;
    const r = f.text.trim() === '' ? null : await renderSvg(f.text, { htmlLabels: false });
    const img = r?.ok ? await loadImage(prepareSvg(r.svg, 'white', true).svg) : null;
    last = img ?? last;
    images.push(last);
  }
  return images;
}

const GIF_WIDTH = 800;
const GIF_HEIGHT = 450;

/**
 * 版を順に描いて GIF にする（設計書 §17.8）。録画と違って実時間を待たない。
 * onProgress には描き終えた枚数を渡す。signal で止められる（止めたら null）
 */
export async function recordGif(
  frames: VideoFrame[],
  opts: { frameMs: number; onProgress?(done: number): void; signal?: AbortSignal },
): Promise<Blob | null> {
  const images = await renderFrames(frames, opts.signal);
  if (!images) return null;
  const canvas = document.createElement('canvas');
  canvas.width = GIF_WIDTH;
  canvas.height = GIF_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const pixels = (i: number) => {
    draw(ctx, images[i], frames[i].caption, i, frames.length);
    return ctx.getImageData(0, 0, GIF_WIDTH, GIF_HEIGHT).data;
  };
  // 1 回目: 色を数える。2 回目: 描き直して 1 枚ずつ圧縮する（全フレームの画素を持たない。150 枚で 200MB を超えるため）。
  // 1 枚ごとに手を離して、画面を固めず、止めるボタンを効かせる
  const counter = new ColorCounter();
  for (let i = 0; i < frames.length; i++) {
    if (opts.signal?.aborted) return null;
    counter.add(pixels(i));
    if (i % 10 === 9) await sleep(0);
  }
  const { palette, lookup } = counter.palette();
  const writer = new GifWriter(GIF_WIDTH, GIF_HEIGHT, palette, lookup);
  for (let i = 0; i < frames.length; i++) {
    if (opts.signal?.aborted) return null;
    // 最後の 1 枚は長めに見せる
    const ms = i === frames.length - 1 ? Math.max(opts.frameMs * 3, 1000) : opts.frameMs;
    writer.addFrame(pixels(i), ms / 10);
    opts.onProgress?.(i + 1);
    await sleep(0);
  }
  if (opts.signal?.aborted) return null;
  const bytes = writer.finish();
  return new Blob([bytes as BlobPart], { type: 'image/gif' });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 版を順に描いて WebM にする。onProgress には描き終えた枚数を渡す。signal で止められる（止めたら null）
 */
export async function recordTimelapse(
  frames: VideoFrame[],
  opts: { frameMs: number; onProgress?(done: number): void; signal?: AbortSignal },
): Promise<Blob | null> {
  // 先に全部描き直しておく（録画中に待たないため）
  const images = await renderFrames(frames, opts.signal);
  if (!images) return null;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  // 文書に置いていない canvas からは、ブラウザによってはフレームが届かないので、見えない形で置く
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(canvas);
  try {
    const ctx = canvas.getContext('2d')!;
    draw(ctx, images[0] ?? null, frames[0]?.caption ?? '', 0, frames.length);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.start(250);
    try {
      for (let i = 0; i < frames.length; i++) {
        if (opts.signal?.aborted) break;
        opts.onProgress?.(i + 1);
        // 最初と最後の 1 枚は長めに見せる（録画が短すぎると、エンコーダーが何も出さないまま止まることがある）。
        // 変わらない canvas からはフレームが出ないので、見せている間も描き直し続ける
        const hold = i === frames.length - 1 ? Math.max(opts.frameMs * 3, 1000) : i === 0 ? Math.max(opts.frameMs, 500) : opts.frameMs;
        const until = performance.now() + hold;
        do {
          draw(ctx, images[i], frames[i].caption, i, frames.length);
          await sleep(Math.min(100, Math.max(0, until - performance.now())));
        } while (performance.now() < until && !opts.signal?.aborted);
      }
    } finally {
      recorder.stop();
      stream.getTracks().forEach((tr) => tr.stop());
    }
    await stopped;
    if (opts.signal?.aborted) return null;
    // 動画のエンコーダーを使えなかったときは、空の動画になる
    if (chunks.length === 0) throw new Error(t('timelapse.videoFailed'));
    return new Blob(chunks, { type: 'video/webm' });
  } finally {
    canvas.remove();
  }
}