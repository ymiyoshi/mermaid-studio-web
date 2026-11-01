import { expect, test } from '@playwright/test';
import { editorText, node, openApp, setEditorText } from './helpers';

// 設計書 §18.6: ラベルの文字だけを変えた編集は、描き直しを待たずに図に出す。
// 200 ノードの図は描き直しに 500ms ほどかかるので、その間に図に出ていて、薄くなっていないことを確かめる
test('ラベルに打った文字は描き直しを待たずに図に出て、描き直した後も残る', async ({ page }) => {
  await openApp(page);
  const lines = ['flowchart TD'];
  for (let i = 1; i < 200; i++) lines.push(`  N${i - 1}[ノード ${i - 1}] --> N${i}[ノード ${i}]`);
  await setEditorText(page, lines.join('\n'));
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1000);

  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.insertText('済');
  // 描き直しを待つ間（stale）に、もう書き換わっている
  const state = await page.evaluate(() => ({
    stale: document.querySelector('.diagram-viewport')!.classList.contains('stale'),
    previewed: document.querySelector('.diagram-canvas')!.classList.contains('previewed'),
    shown: document.querySelector('.diagram-canvas')!.textContent!.includes('ノード 199済'),
  }));
  expect(state).toEqual({ stale: true, previewed: true, shown: true });
  // 描き直した後も同じ文字で、先取りの印は外れる
  await expect(page.locator('.diagram-viewport')).not.toHaveClass(/stale/);
  await expect(node(page, 'ノード 199済')).toBeVisible();
  await expect(page.locator('.diagram-canvas')).not.toHaveClass(/previewed/);
  expect(await editorText(page)).toContain('N199[ノード 199済]');

  // ラベルの外（新しい行）を打ったときは先取りしない
  await page.waitForTimeout(500);
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n  N199 --> X[追加]');
  const after = await page.evaluate(() => ({
    previewed: document.querySelector('.diagram-canvas')!.classList.contains('previewed'),
    shown: document.querySelector('.diagram-canvas')!.textContent!.includes('追加'),
  }));
  expect(after).toEqual({ previewed: false, shown: false });
  await expect(node(page, '追加')).toBeVisible();
});

test('先取りで新しく見えている間に押したラベルの編集は、描き直した後に始める（黙って捨てない）', async ({ page }) => {
  await openApp(page);
  const lines = ['flowchart TD'];
  for (let i = 1; i < 200; i++) lines.push(`  N${i - 1}[ノード ${i - 1}] --> N${i}[ノード ${i}]`);
  await setEditorText(page, lines.join('\n'));
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await node(page, 'ノード 199').first().click();

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.insertText('改');
  // まだ描き直しを待っている間に（先取りで図には出ている）、図で Enter を押す
  const pressed = await page.evaluate(() => {
    const vp = document.querySelector('.diagram-viewport') as HTMLElement;
    const state = {
      stale: vp.classList.contains('stale'),
      shown: document.querySelector('.diagram-canvas')!.textContent!.includes('ノード 199改'),
    };
    vp.focus();
    vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return state;
  });
  expect(pressed).toEqual({ stale: true, shown: true });
  const input = page.locator('.inline-label-editor input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('ノード 199改');
});
