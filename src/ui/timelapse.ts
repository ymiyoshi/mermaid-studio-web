import type { HistoryTree } from '../core/history';

// タイムラプス（作った過程の再生）で使う版の並び。

/** 最初の版から今の版までの道のり（履歴ツリーの根から head への版の ID） */
export function pathToHead(tree: HistoryTree): string[] {
  const ids: string[] = [];
  for (let id: string | null = tree.headId; id !== null; id = tree.nodes.get(id)?.parentId ?? null) ids.push(id);
  return ids.reverse();
}

/** 長い道のりは、最初と最後を含めて max 枚に間引く */
export function sampleFrames<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return out;
}
