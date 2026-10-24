import { create } from 'zustand';
import { useSession } from '../core/session';
import { listThumbs, putThumb } from '../storage/db';
import { useRender } from './pipeline';

// 図の一覧のサムネイル（§9.2）。正常に描画できた SVG を少し待ってから保存する。

const SAVE_DELAY_MS = 1500;

export const useThumbs = create<{ byDoc: Record<string, string> }>(() => ({ byDoc: {} }));

export async function startThumbnails() {
  const all = await listThumbs();
  useThumbs.setState({ byDoc: Object.fromEntries(all.map((t) => [t.docId, t.svg])) });

  let timer: ReturnType<typeof setTimeout> | null = null;
  useRender.subscribe((r) => {
    const cur = useSession.getState().current;
    if (r.status !== 'ok' || !r.svg || !cur || cur.readOnly || r.svgSource !== cur.text.toString()) return;
    if (useThumbs.getState().byDoc[cur.id] === r.svg) return;
    const docId = cur.id;
    const svg = r.svg;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      useThumbs.setState((s) => ({ byDoc: { ...s.byDoc, [docId]: svg } }));
      void putThumb({ docId, svg, updatedAt: Date.now() });
    }, SAVE_DELAY_MS);
  });
}

export const thumbSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
