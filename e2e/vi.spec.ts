import { expect, test, type Page } from '@playwright/test';
import { editorText, node, openApp, setEditorText } from './helpers';

// vi のキーバインド（設計書 §16）を、本番ビルドで通して確かめる。

const selectedText = (page: Page) => page.locator('.diagram-canvas .mmd-selected').first();

async function useVi(page: Page) {
  await page.getByLabel('キー').selectOption('vi');
}

test('図のペイン: 移動・追加・ラベル・削除・undo を vi のキーで行う', async ({ page }) => {
  const errors = await openApp(page);
  await setEditorText(page, 'flowchart TD\n  A[一] --> B[二]\n  B --> C[三]');
  await expect(node(page, '三')).toBeVisible();
  await useVi(page);
  await page.locator('.diagram-viewport').focus();
  await expect(page.locator('.vi-mode')).toHaveText('ノーマル');

  // gg / G はソースの順で最初・最後の要素へ。j は下の要素へ
  await page.keyboard.press('g');
  await expect(page.locator('.vi-status kbd')).toHaveText('g');
  await page.keyboard.press('g');
  await expect(selectedText(page)).toContainText('一');
  await page.keyboard.press('G');
  await expect(selectedText(page)).toContainText('三');
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  // 縦に並んだ図: 2j で線を 1 本越えて「二」へ
  await page.keyboard.press('2');
  await page.keyboard.press('j');
  await expect(selectedText(page)).toContainText('二');

  // o で次のノードを足し、そのままラベルを打つ。Esc で確定
  await page.keyboard.press('o');
  const input = page.locator('.inline-label-editor input');
  await expect(input).toBeFocused();
  await page.keyboard.insertText('四');
  await page.keyboard.press('Escape');
  await expect(node(page, '四')).toBeVisible();

  // a でラベルの末尾から書き足す
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('a');
  await expect(input).toBeFocused();
  await page.keyboard.insertText('！');
  await page.keyboard.press('Enter');
  await expect(node(page, '四！')).toBeVisible();

  // dd で消し、u で戻す
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await expect(node(page, '四！')).toHaveCount(0);
  await page.keyboard.press('u');
  await expect(node(page, '四！')).toBeVisible();
  await page.keyboard.press('Control+r');
  await expect(node(page, '四！')).toHaveCount(0);

  // / で検索して選ぶ
  await page.keyboard.press('/');
  await page.keyboard.insertText('一');
  await page.keyboard.press('Enter');
  await expect(selectedText(page)).toContainText('一');

  // m で操作のメニューを開き、キーボードで最初の項目（次のノード）を実行する
  const nodes = await page.locator('.diagram-canvas g.node').count();
  await page.keyboard.press('m');
  await expect(page.locator('.context-menu .menu-item').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.context-menu')).toHaveCount(0);
  await expect(page.locator('.diagram-canvas g.node')).toHaveCount(nodes + 1);
  expect(errors).toEqual([]);
});

test('図のペイン: ビジュアルモードでまとめて消す・ce で接続する', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A[一]\n  B[二]\n  C[三]');
  await expect(node(page, '三')).toBeVisible();
  await useVi(page);
  await page.locator('.diagram-viewport').focus();

  // ce: 「一」から、選んだ「三」へ線を引く
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.keyboard.press('e');
  await expect(page.locator('.vi-mode')).toHaveText('接続');
  await page.keyboard.press('G');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toMatch(/A\s*-->\s*C/);

  // v で選び始め、w で足して d でまとめて消す
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('v');
  await expect(page.locator('.vi-mode')).toHaveText('ビジュアル');
  await page.keyboard.press('w');
  await expect(page.locator('.diagram-canvas .mmd-selected')).toHaveCount(2);
  await page.keyboard.press('d');
  await expect(page.locator('.vi-mode')).toHaveText('ノーマル');
  await expect(node(page, '一')).toHaveCount(0);
});

test('図のペイン: 回数つきの o・dd と、cc でラベルを空にして始める', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart TD\n  A[一] --> B[二]\n  B --> C[三]');
  await expect(node(page, '三')).toBeVisible();
  await useVi(page);
  const viewport = page.locator('.diagram-viewport');
  const nodes = page.locator('.diagram-canvas g.node');
  await viewport.focus();

  // cc: 入力欄を空にして編集を始める
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.keyboard.press('c');
  const input = page.locator('.inline-label-editor input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await page.keyboard.insertText('壱');
  await page.keyboard.press('Escape');
  await expect(node(page, '壱')).toBeVisible();

  // 2o: 次のノードを 2 つ足す
  await viewport.focus();
  await page.keyboard.press('2');
  await page.keyboard.press('o');
  await expect(nodes).toHaveCount(5);
  await page.keyboard.press('Escape');

  // 3dd: 選んだ要素からソースの順で 3 つを、履歴 1 ステップで消す
  await viewport.focus();
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  const steps = await page.locator('.history-row:not(.fold)').count();
  await page.keyboard.press('3');
  await page.keyboard.press('d');
  await page.keyboard.press('d');
  await expect(node(page, '壱')).toHaveCount(0);
  await expect(page.locator('.history-row:not(.fold)')).toHaveCount(steps + 1);
});

test('エディタの vim:挿入から Esc までを u で丸ごと戻し、Space d で図へ、gd で戻る', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A[一] --> B[二]');
  await expect(node(page, '二')).toBeVisible();
  await useVi(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-vim-panel')).toBeVisible();

  await page.keyboard.press('G');
  await page.keyboard.press('o');
  await page.keyboard.type('B --> C[三]');
  await page.keyboard.press('Escape');
  await expect(node(page, '三')).toBeVisible();
  await page.keyboard.press('u');
  await expect(node(page, '三')).toHaveCount(0);
  expect(await editorText(page)).toBe('flowchart LR\n  A[一] --> B[二]');
  // Ctrl-r はページを読み込み直さず、アプリの redo になる
  await page.keyboard.press('Control+r');
  await expect(node(page, '三')).toBeVisible();
  await page.keyboard.press('u');
  await expect(node(page, '三')).toHaveCount(0);

  // Space d で図へ移り、gd でカーソルの行の要素を選ぶ／図の gd でエディタへ戻る
  await page.keyboard.press(' ');
  await page.keyboard.press('d');
  await expect(page.locator('.diagram-viewport')).toBeFocused();
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await expect(page.locator('.cm-content')).toBeFocused();
  // 図で選んだ要素の範囲はカーソルだけにするので、ビジュアルモードには入らない
  await expect(page.locator('.cm-vim-panel')).not.toContainText('VISUAL');
});

test(': で Ex コマンド、? でキーの一覧、標準に戻すと文字のキーは効かない', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A[一]');
  await expect(node(page, '一')).toBeVisible();
  await setEditorText(page, 'flowchart LR\n  A[一] --> B[二]');
  await expect(node(page, '二')).toBeVisible();
  await useVi(page);
  await page.locator('.diagram-viewport').focus();

  await page.keyboard.press(':');
  const palette = page.locator('.palette-input');
  await expect(palette).toHaveValue(':');
  await page.keyboard.insertText('earlier 1');
  await page.keyboard.press('Enter');
  await expect(node(page, '二')).toHaveCount(0);

  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'キーの一覧（vi）' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('キー').selectOption('standard');
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.vi-mode')).toHaveCount(0);
});
