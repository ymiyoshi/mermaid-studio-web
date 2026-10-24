import { create } from 'zustand';
import type { Text } from '@codemirror/state';
import type { HistoryTree, Sel } from './history';
import type { Theme } from '../render/mermaid';
import type { DocRecord, FileBinding } from '../storage/db';

// アプリ全体の状態（zustand のストア）。読み書きは core の各モジュールが行い、UI は購読するだけ。

export interface CurrentDoc {
  id: string;
  title: string;
  text: Text;
  tree: HistoryTree;
  readOnly: boolean;
  createdAt: number;
  tags: string[];
  /** 結び付いたローカルファイル（§9.3） */
  file: FileBinding | null;
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface State {
  ready: boolean;
  docs: DocRecord[];
  current: CurrentDoc | null;
  /** 文書か履歴が変わるたびに増える（履歴ビューの再描画用） */
  rev: number;
  selection: Sel;
  theme: Theme;
  storage: StorageInfo | null;
  toast: { id: number; message: string } | null;
}

export const useSession = create<State>(() => ({
  ready: false,
  docs: [],
  current: null,
  rev: 0,
  selection: { anchor: 0, head: 0 },
  theme: 'default',
  storage: null,
  toast: null,
}));

export const get = useSession.getState;
export const set = useSession.setState;
