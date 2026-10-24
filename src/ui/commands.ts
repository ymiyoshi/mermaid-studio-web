import { createFromTemplate, openDoc, redo, setTheme, undo, useSession } from '../core/session';
import { TEMPLATES } from '../core/templates';
import { openFile, saveFile } from '../io/files';
import { exportBackup, importBackup } from '../io/backup';
import { useIo } from '../io/ioStore';
import { copyShareLink } from '../io/shareActions';
import type { Theme } from '../render/mermaid';
import { togglePane, useLayout } from './layoutStore';
import { t } from '../i18n';

// コマンドパレット（Ctrl+K）の中身。メニューやボタンにある操作を、キーボードだけで探して実行できるようにする。

export interface Command {
  id: string;
  /** 分類（「図を開く」「ファイル」など） */
  group: string;
  title: string;
  /** 対応するショートカットの表示 */
  keys?: string;
  run(): void;
}

const THEMES: Theme[] = ['default', 'neutral', 'forest', 'dark'];

/** 図ビューに頼む操作（図ビューが受け取る） */
export const DIAGRAM_COMMAND_EVENT = 'mmd-diagram-command';
export type DiagramCommand = 'fit' | 'zoomIn' | 'zoomOut' | 'togglePanel';
const diagram = (cmd: DiagramCommand) => () => dispatchEvent(new CustomEvent(DIAGRAM_COMMAND_EVENT, { detail: cmd }));

export function buildCommands(): Command[] {
  const s = useSession.getState();
  const hasDoc = !!s.current;
  const editable = hasDoc && !s.current!.readOnly;
  const out: Command[] = [];
  const g = (group: string, items: (Omit<Command, 'group'> | false)[]) => {
    for (const x of items) if (x) out.push({ ...x, group });
  };

  g(t('cmd.groupEdit'), [
    editable && { id: 'undo', title: t('toolbar.undo'), keys: 'Ctrl+Z', run: undo },
    editable && { id: 'redo', title: t('toolbar.redo'), keys: 'Ctrl+Shift+Z', run: redo },
  ]);
  g(t('cmd.groupFile'), [
    { id: 'open', title: t('menu.open'), keys: 'Ctrl+O', run: () => void openFile() },
    hasDoc && { id: 'save', title: t('menu.save'), keys: 'Ctrl+S', run: () => void saveFile() },
    hasDoc && { id: 'saveAs', title: t('menu.saveAs'), keys: 'Ctrl+Shift+S', run: () => void saveFile({ saveAs: true }) },
    hasDoc && { id: 'export', title: t('menu.exportImage'), keys: 'Ctrl+Shift+E', run: () => useIo.setState({ exportOpen: true }) },
    hasDoc && { id: 'share', title: t('menu.share'), run: () => void copyShareLink() },
    { id: 'backupExport', title: t('menu.backupExport'), run: () => void exportBackup() },
    { id: 'backupImport', title: t('menu.backupImport'), run: () => void importBackup() },
  ]);
  g(t('cmd.groupView'), [
    { id: 'toggleList', title: t('layout.toggleList'), run: () => togglePane('sidebarOpen') },
    { id: 'toggleHistory', title: t('layout.toggleHistory'), run: () => togglePane('historyOpen') },
    hasDoc && { id: 'fit', title: t('toolbar.fit'), run: diagram('fit') },
    hasDoc && { id: 'zoomIn', title: t('toolbar.zoomIn'), run: diagram('zoomIn') },
    hasDoc && { id: 'zoomOut', title: t('toolbar.zoomOut'), run: diagram('zoomOut') },
    hasDoc && { id: 'togglePanel', title: t('cmd.togglePanel'), run: diagram('togglePanel') },
    { id: 'present', title: t('present.open'), run: () => useLayout.setState({ presentOpen: true }) },
    hasDoc && { id: 'snippets', title: t('snippet.open'), run: () => useLayout.setState({ snippetsOpen: true }) },
    hasDoc && { id: 'timelapse', title: t('timelapse.open'), run: () => useLayout.setState({ timelapseOpen: true }) },
    ...THEMES.map((th) => ({ id: `theme:${th}`, title: t('cmd.theme', { theme: th }), run: () => setTheme(th) })),
  ]);
  g(
    t('cmd.groupNew'),
    TEMPLATES.map((tpl) => ({ id: `new:${tpl.id}`, title: tpl.name, run: () => void createFromTemplate(tpl.id) })),
  );
  g(
    t('cmd.groupOpen'),
    s.docs
      .filter((d) => d.deletedAt === null && d.id !== s.current?.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((d) => ({ id: `doc:${d.id}`, title: d.title || t('doc.untitled'), run: () => void openDoc(d.id) })),
  );
  return out;
}

/** 空白で区切った語をすべて含むコマンド（大文字小文字・全角半角は区別しない）。タイトルの先頭に合うものを先にする */
export function filterCommands(commands: Command[], query: string): Command[] {
  const norm = (x: string) => x.normalize('NFKC').toLowerCase();
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const hits = commands.filter((c) => {
    const hay = norm(`${c.title} ${c.group}`);
    return words.every((w) => hay.includes(w));
  });
  const starts = (c: Command) => (norm(c.title).startsWith(words[0]) ? 0 : 1);
  return hits.map((c, i) => ({ c, i })).sort((a, b) => starts(a.c) - starts(b.c) || a.i - b.i).map((x) => x.c);
}
