import { expect, test, type Page } from '@playwright/test';
import { editorText, menu, node, openApp } from './helpers';

// 設計書 §17.9: フォルダを開く。フォルダの選択画面は自動では操作できないので、
// ブラウザの中のファイル領域（OPFS）に作ったフォルダを、選んだフォルダとして返す（本物のハンドルなので IndexedDB に保存できる）。

async function stubPicker(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('docs', { create: true });
      const write = async (d: FileSystemDirectoryHandle, name: string, text: string) => {
        const f = await d.getFileHandle(name, { create: true });
        if ((await f.getFile()).size > 0) return;
        const w = await f.createWritable();
        await w.write(text);
        await w.close();
      };
      await write(dir, 'flow.mmd', 'flowchart TD\n  A[フォルダの図] --> B[次]\n');
      await write(dir, 'memo.md', '# メモ\n図は無い\n');
      const sub = await dir.getDirectoryHandle('sub', { create: true });
      await write(sub, 'seq.md', '# 説明\n\n```mermaid\nsequenceDiagram\n  A->>B: やあ\n```\n');
      return dir;
    };
  });
}

const readOpfs = (page: Page, path: string[]) =>
  page.evaluate(async (p) => {
    let d = await navigator.storage.getDirectory();
    for (const name of p.slice(0, -1)) d = await d.getDirectoryHandle(name);
    return (await (await d.getFileHandle(p.at(-1)!)).getFile()).text();
  }, path);

test('フォルダを開いて中の図を開き、上書き保存すると元のファイルに書く。読み込み直しても一覧に残る', async ({ page }) => {
  await stubPicker(page);
  const errors = await openApp(page);
  await menu(page, 'ファイル', 'フォルダを開く…');
  const folder = page.getByRole('region', { name: 'フォルダ docs' });
  await expect(folder.getByRole('button', { name: 'flow.mmd' })).toBeVisible();
  await expect(folder.getByRole('button', { name: 'sub/seq.md' })).toBeVisible();
  // mermaid のブロックが無い .md は出さない
  await expect(folder.getByRole('button', { name: 'memo.md' })).toHaveCount(0);

  await folder.getByRole('button', { name: 'flow.mmd' }).click();
  await expect(node(page, 'フォルダの図')).toBeVisible();
  await node(page, 'フォルダの図').dblclick();
  await page.locator('.inline-label-editor input').fill('書き換えた');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A[書き換えた]');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readOpfs(page, ['docs', 'flow.mmd'])).toContain('A[書き換えた]');

  await page.reload();
  await expect(page.locator('.diagram-canvas svg')).toBeVisible();
  await expect(page.getByRole('region', { name: 'フォルダ docs' }).getByRole('button', { name: 'flow.mmd' })).toBeVisible();
  expect(errors).toEqual([]);
});
