import { expect, test } from '@playwright/test';
import { editorText, node, openApp, setEditorText } from './helpers';

// 設計書 §17.5: 構文は正しいが怪しいところの警告と、ボタンで直す案

test('打ち間違いらしい ID に波線を出し、案のボタンで直すと履歴 1 ステップになる', async ({ page }) => {
  const errors = await openApp(page);
  await setEditorText(page, 'flowchart TD\n  Start[開始] --> Next[次]\n  Next --> Strat');
  await expect(node(page, 'Strat')).toBeVisible();
  const range = page.locator('.cm-lintRange-warning', { hasText: 'Strat' });
  await expect(range).toBeVisible();
  await range.hover();
  const tooltip = page.locator('.cm-tooltip-lint');
  await expect(tooltip).toContainText('「Start」の打ち間違いではありませんか？');
  await tooltip.getByRole('button', { name: '「Start」に直す' }).click();
  await expect.poll(() => editorText(page)).toContain('Next --> Start');
  await expect(page.locator('.cm-lintRange-warning')).toHaveCount(0);
  await expect(node(page, 'Strat')).toHaveCount(0);
  // 直したことは履歴 1 ステップで戻せる
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editorText(page)).toContain('Next --> Strat');
  expect(errors).toEqual([]);
});
