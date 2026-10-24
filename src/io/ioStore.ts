import { create } from 'zustand';
import type { MermaidBlock } from './markdown';

// 入出力まわりのダイアログやバナーの状態。

export interface IoState {
  /** Markdown に mermaid ブロックが複数あるとき、どれを開くか選んでもらう */
  blockPicker: { name: string; blocks: MermaidBlock[]; resolve(index: number | null): void } | null;
  /** 結び付いたファイルが外部で変更された（§9.3） */
  conflict: { docId: string; name: string; localChanges: boolean } | null;
  exportOpen: boolean;
}

export const useIo = create<IoState>(() => ({
  blockPicker: null,
  conflict: null,
  exportOpen: false,
}));
