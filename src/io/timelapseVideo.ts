import { renderSvg } from '../render/mermaid';
import { prepareSvg } from './exportImage';
import { t } from '../i18n';

// タイムラプスを WebM 動画にする。各版を描き直して canvas に描き、MediaRecorder で録る（外部のライブラリも通信も使わない）。
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

/** 1 枚分を描く。描けない版（構文エラーの途中など）は、直前の図のまま説明だけ変える */
function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, caption: string, index: number, total: number) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  if (img) {
    const areaH = HEIGHT - CAPTION_H - 24;
    const k = Math.min((WIDTH - 48) / img.naturalWidth, areaH / img.naturalHeight, 3);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.drawImage(img, (WIDTH - w) / 2, 12 + (areaH - h) / 2, w, h);
  }
  ctx.fillStyle = '#f2f3f5';
  ctx.fillRect(0, HEIGHT - CAPTION_H, WIDTH, CAPTION_H);
  ctx.fillStyle = '#1d232c';
  ctx.font = '20px "BIZ UDGothic", "Yu Gothic", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption.slice(0, 60), 20, HEIGHT - CAPTION_H / 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${index + 1} / ${total}`, WIDTH - 20, HEIGHT - CAPTION_H / 2);
  ctx.textAlign = 'left';
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
  const images: (HTMLImageElement | null)[] = [];
  let last: HTMLImageElement | null = null;
  for (const f of frames) {
    if (opts.signal?.aborted) return null;
    const r = f.text.trim() === '' ? null : await renderSvg(f.text, { htmlLabels: false });
    const img = r?.ok ? await loadImage(prepareSvg(r.svg, 'white', true).svg) : null;
    last = img ?? last;
    images.push(last);
  }

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