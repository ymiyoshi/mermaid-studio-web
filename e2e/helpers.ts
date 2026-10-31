import { expect, type Page } from '@playwright/test';

/** アプリを開き、最初の図（フローチャートのテンプレート）が描かれるまで待つ */
export async function openApp(page: Page, path = '/') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(path);
  await expect(page.locator('.diagram-canvas svg')).toBeVisible();
  return errors;
}

export const editorText = (page: Page) => page.locator('.cm-content').innerText();

/** 図の中の、ラベルが text のノード */
export const node = (page: Page, text: string) => page.locator('.diagram-canvas g.node', { hasText: text });

export const historyLabels = (page: Page) => page.locator('.history-label').allInnerTexts();

/** 新しい図をテンプレートから作る */
export async function newFromTemplate(page: Page, name: string) {
  await page.getByRole('button', { name: '＋ 新規' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await expect(page.locator('.title-input')).toHaveValue(name === '空の図' ? '無題の図' : name);
}

/** ヘッダーのメニュー（ファイル・編集・表示）を開いて、項目を選ぶ */
export async function menu(page: Page, group: string, item: string) {
  await page.getByRole('navigation', { name: 'メニュー' }).getByRole('button', { name: group, exact: true }).click();
  const list = page.getByRole('menu', { name: group });
  await list.getByRole('menuitem', { name: item }).or(list.getByRole('menuitemcheckbox', { name: item })).click();
}

/** ヘッダーの設定（⚙）を開く。言語を変えたあとは name に英語の名前を渡す */
export async function openSettings(page: Page, name = '設定') {
  await page.getByRole('button', { name, exact: true }).click();
}

/** エディタの全文を置き換える */
export async function setEditorText(page: Page, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}
