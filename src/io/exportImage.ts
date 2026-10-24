import { renderSvg } from '../render/mermaid';
import { showToast, useSession } from '../core/session';
import { download, safeFileName } from './download';
import { t } from '../i18n';

// 設計書 §9.5: 画像として書き出す。
// 画面の SVG（選択の強調などが付いている）ではなく、現在のテキストから描き直したものを使う。

export type ImageFormat = 'svg' | 'png';
export type Background = 'white' | 'transparent';

export interface ImageOptions {
  format: ImageFormat;
  scale: number;
  background: Background;
}

/** canvas の一辺の上限（ブラウザの制限より少し小さく） */
const MAX_CANVAS = 16000;

export interface PreparedSvg {
  svg: string;
  width: number;
  height: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * htmlLabels: false でも foreignObject を使う図種（journey など）のために、
 * 残った foreignObject を中央寄せの SVG text に置き換える。見た目は簡略になるが canvas に描ける
 */
function replaceForeignObjects(doc: Document) {
  doc.querySelectorAll('foreignObject').forEach((fo) => {
    const x = Number(fo.getAttribute('x') ?? 0);
    const y = Number(fo.getAttribute('y') ?? 0);
    const w = Number(fo.getAttribute('width') ?? 0);
    const h = Number(fo.getAttribute('height') ?? 0);
    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(x + w / 2));
    text.setAttribute('y', String(y + h / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', '14');
    text.setAttribute('fill', '#333');
    text.textContent = (fo.textContent ?? '').replace(/\s+/g, ' ').trim();
    fo.replaceWith(text);
  });
}

/** 幅・高さを固定し、背景を付けた単体の SVG 文字列にする。forCanvas なら foreignObject も取り除く */
export function prepareSvg(svgText: string, background: Background, forCanvas = false): PreparedSvg {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (forCanvas) replaceForeignObjects(doc);
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const [x, y, w, h] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, 800, 600];
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.style.removeProperty('max-width');
  if (background === 'white') {
    const rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('fill', '#ffffff');
    svg.insertBefore(rect, svg.firstChild);
  }
  return { svg: new XMLSerializer().serializeToString(svg), width: w, height: h };
}

export async function svgToPng(p: PreparedSvg, scale: number): Promise<Blob> {
  const k = Math.min(scale, MAX_CANVAS / p.width, MAX_CANVAS / p.height);
  const url = URL.createObjectURL(new Blob([p.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(p.width * k);
    canvas.height = Math.ceil(p.height * k);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // foreignObject を含む SVG では canvas が汚染されて toBlob が SecurityError になる
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderCurrent(format: ImageFormat): Promise<string | null> {
  const text = useSession.getState().current?.text.toString() ?? '';
  if (text.trim() === '') return null;
  // PNG はラベルを SVG の text で描き直す（foreignObject を canvas に描かないため）
  const r = await renderSvg(text, { htmlLabels: format === 'svg' });
  if (!r.ok) {
    showToast(t('export.renderError'));
    return null;
  }
  return r.svg;
}

export async function exportImage(opts: ImageOptions, action: 'download' | 'copy'): Promise<boolean> {
  const svgText = await renderCurrent(opts.format);
  if (!svgText) return false;
  const prepared = prepareSvg(svgText, opts.background, opts.format === 'png');
  const name = safeFileName(useSession.getState().current?.title ?? 'diagram');
  try {
    if (opts.format === 'svg') {
      if (action === 'copy') {
        await navigator.clipboard.writeText(prepared.svg);
        showToast(t('export.copiedSvg'));
      } else {
        download(new Blob([prepared.svg], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`);
      }
      return true;
    }
    const png = await svgToPng(prepared, opts.scale);
    if (action === 'copy') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showToast(t('export.copiedPng'));
    } else {
      download(png, `${name}.png`);
    }
    return true;
  } catch (e) {
    showToast(
      e instanceof DOMException && e.name === 'SecurityError'
        ? t('export.pngTainted')
        : t('file.error', { message: String((e as Error)?.message ?? e) }),
    );
    return false;
  }
}
