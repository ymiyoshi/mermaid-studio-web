import { create } from 'zustand';
import { getSetting, putSetting } from '../storage/db';

// キーバインドの設定（設計書 §16）。標準と vi。切り替えは読み込み直さずに効く。

export type Keymap = 'standard' | 'vi';

interface KeymapState {
  keymap: Keymap;
  /** 打ちかけのキー（画面の下の表示用） */
  pendingKeys: string;
  /** 図の一覧に今見えている図の並び（gt / gT と、一覧の j / k で使う） */
  docOrder: string[];
  helpOpen: boolean;
}

export const useKeymap = create<KeymapState>(() => ({
  keymap: 'standard',
  pendingKeys: '',
  docOrder: [],
  helpOpen: false,
}));

export const isVi = () => useKeymap.getState().keymap === 'vi';

export async function loadKeymap() {
  const v = await getSetting<Keymap>('keymap');
  if (v === 'vi' || v === 'standard') useKeymap.setState({ keymap: v });
}

export function setKeymap(keymap: Keymap) {
  useKeymap.setState({ keymap, pendingKeys: '' });
  void putSetting('keymap', keymap);
}
