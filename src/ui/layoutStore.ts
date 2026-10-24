import { create } from 'zustand';
import { getSetting, putSetting } from '../storage/db';

// 画面の配置（§10）: ペインの幅・折りたたみと、狭い画面でのタブ。

export interface Layout {
  sidebar: number;
  editor: number;
  history: number;
  sidebarOpen: boolean;
  historyOpen: boolean;
}

export type MobileTab = 'list' | 'text' | 'diagram' | 'history';

export const DEFAULT_LAYOUT: Layout = { sidebar: 240, editor: 440, history: 280, sidebarOpen: true, historyOpen: true };

export const useLayout = create<Layout & { mobileTab: MobileTab }>(() => ({ ...DEFAULT_LAYOUT, mobileTab: 'diagram' }));

export async function loadLayout() {
  const saved = await getSetting<Partial<Layout>>('layout');
  if (saved) useLayout.setState({ ...DEFAULT_LAYOUT, ...saved });
}

export function saveLayout() {
  const { sidebar, editor, history, sidebarOpen, historyOpen } = useLayout.getState();
  void putSetting('layout', { sidebar, editor, history, sidebarOpen, historyOpen });
}

export function togglePane(pane: 'sidebarOpen' | 'historyOpen') {
  useLayout.setState((s) => ({ [pane]: !s[pane] }));
  saveLayout();
}
