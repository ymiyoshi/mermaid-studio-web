import { expect, test, type Page } from '@playwright/test';
import { editorText, node, openApp, openSettings, setEditorText } from './helpers';

// 構造をたどる vi のキー（設計書 §17.2）・複製（§17.3）・要素の一覧（§17.4）を、本番ビルドで確かめる。

const selected = (page: Page) => page.locator('.diagram-canvas .mmd-selected').first();

const FLOW = 'flowchart TD\n  A[一] --> B[二]\n  subgraph G [枠]\n    C[三]\n  end\n  B --> C';

async function useVi(page: Page) {
  await openSettings(page);
  await page.getByLabel('キー').selectOption('vi');
  await page.keyboard.press('Escape');
}

test('vi: ]e / [e で線をたどり、]g / [g で枠の外・中へ、>> / << で枠に出し入れする', async ({ page }) => {
  const errors = await openApp(page);
  await setEditorText(page, FLOW);
  await expect(node(page, '三')).toBeVisible();
  await useVi(page);
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await expect(selected(page)).toContainText('一');

  // ]e を 2 回（回数つき）で 一 → 二 → 三
  await page.keyboard.press('2');
  await page.keyboard.press(']');
  await page.keyboard.press('e');
  await expect(selected(page)).toContainText('三');
  await page.keyboard.press('[');
  await page.keyboard.press('e');
  await expect(selected(page)).toContainText('二');

  // ]e で 三 に戻り、]g で囲む枠へ、[g で中の最初の要素へ
  await page.keyboard.press(']');
  await page.keyboard.press('e');
  await page.keyboard.press(']');
  await page.keyboard.press('g');
  await expect(page.locator('.diagram-canvas g.cluster.mmd-selected')).toContainText('枠');
  await page.keyboard.press('[');
  await page.keyboard.press('g');
  await expect(selected(page)).toContainText('三');

  // << で 三 を枠の外へ出し、選んだまま >> で前の枠（G）の中へ戻す
  await page.keyboard.press('<');
  await page.keyboard.press('<');
  await expect.poll(() => editorText(page)).not.toMatch(/subgraph G \[枠\]\n\s+C\[三\]/);
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('>');
  await page.keyboard.press('>');
  await expect.poll(() => editorText(page)).toMatch(/subgraph G \[枠\][\s\S]*C[\s\S]*end/);
  expect(errors).toEqual([]);
});

test('vi: yy でコピーして p で複製する。標準のキーでは Ctrl+C / Ctrl+V / Ctrl+D', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart TD\n  A[一] --> B[二]');
  await expect(node(page, '二')).toBeVisible();

  // 標準: Ctrl+D で選んだノードを複製
  await node(page, '一').click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect(node(page, '一')).toHaveCount(2);
  await expect.poll(() => editorText(page)).toContain('A1[一]');
  // Ctrl+C → Ctrl+V
  await node(page, '二').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(node(page, '二')).toHaveCount(2);

  // vi: yy → p
  await useVi(page);
  await node(page, '二').first().click();
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('y');
  await page.keyboard.press('y');
  await page.keyboard.press('p');
  await expect(node(page, '二')).toHaveCount(3);
  // 1 回の複製は履歴 1 ステップ
  await page.keyboard.press('u');
  await expect(node(page, '二')).toHaveCount(2);
});

test('要素の一覧: 枠の中を字下げして並べ、絞り込んで選ぶと図でも選ばれる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, FLOW);
  await expect(node(page, '三')).toBeVisible();
  await page.getByRole('button', { name: '一覧', exact: true }).click();
  const tree = page.getByRole('tree', { name: '図の要素' });
  await expect(tree.getByRole('treeitem', { name: 'ノード 三', exact: true })).toHaveAttribute('aria-level', '2');
  await expect(tree.getByRole('treeitem', { name: /一 → 二/ })).toBeVisible();

  // 打った文字で絞り込み、Enter で最初に合った要素を選ぶ
  await page.getByRole('searchbox', { name: '要素を絞り込む' }).fill('三');
  await expect(tree.getByRole('treeitem')).toHaveCount(3); // 枠（親）・三・二 → 三
  await page.keyboard.press('Enter');
  await expect(selected(page)).toContainText('三');
  // 読み上げ: 選んだ要素の名前と、囲む枠・線の数
  await expect(page.locator('.diagram-pane [role="status"].sr-only')).toHaveText('選択: 三 （枠 の中） 出る線 0・入る線 1');

  // ↓ / Enter でも選べる
  await page.getByRole('searchbox', { name: '要素を絞り込む' }).fill('');
  // 並びはソースの順（一 → 線 → 二）
  await tree.getByRole('treeitem').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(selected(page)).toContainText('二');
  // 図の要素には名前が付く
  await expect(page.locator('.diagram-canvas g.node[aria-label="二"]')).toHaveCount(1);
});
