import { expect, test } from '@playwright/test';
import { editorText, node, openApp } from './helpers';

// 動画の書き出しを同時にいくつも走らせると、録画が空になる（このテストを 8 並列で走らせると 8 本とも空になった）ので、
// ほかの E2E が終わってから単独で走らせる（playwright.config.ts の video プロジェクト）。

test('作った過程を再生し、WebM の動画に書き出す', async ({ page }) => {
  const errors = await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('スタート');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A[スタート]');

  await page.getByTitle('作った過程を再生（タイムラプス）').click();
  const view = page.getByRole('dialog', { name: '作った過程を再生' });
  // 自動で再生が始まり、最後の版で止まる
  await expect(view.locator('.timelapse-step')).toContainText('2 / 2');
  await expect(view.locator('.compare-canvas')).toContainText('スタート');
  await view.getByLabel('再生位置').fill('0');
  await expect(view.locator('.timelapse-step')).toContainText('1 / 2');
  await expect(view.locator('.compare-canvas')).toContainText('開始');

  await view.getByLabel('速さ').selectOption({ label: '4x' });
  const download = page.waitForEvent('download');
  await view.getByRole('button', { name: '動画（WebM）で書き出す' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('フローチャート-作った過程.webm');
  const size = (await import('node:fs')).statSync((await file.path())!).size;
  expect(size, `動画の大きさ ${size} バイト`).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('動画の書き出し中に別の図に切り替えると、書き出しをやめてダウンロードしない', async ({ page }) => {
  await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('スタート');
  await page.keyboard.press('Enter');
  await page.getByTitle('作った過程を再生（タイムラプス）').click();
  const view = page.getByRole('dialog', { name: '作った過程を再生' });
  await view.getByLabel('速さ').selectOption({ label: '0.5x' });
  let downloaded = false;
  page.on('download', () => (downloaded = true));
  await view.getByRole('button', { name: '動画（WebM）で書き出す' }).click();
  await expect(view.getByRole('button', { name: /書き出しをやめる/ })).toBeVisible();
  // 書き出しの途中で、コマンドパレットから別の図を作る
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'コマンド' }).getByRole('combobox').fill('円グラフ');
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-input')).toHaveValue('円グラフ');
  await expect(view).toHaveCount(0);
  await page.waitForTimeout(4000);
  expect(downloaded).toBe(false);
});
