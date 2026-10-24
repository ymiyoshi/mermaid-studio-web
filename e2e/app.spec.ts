import { expect, test } from '@playwright/test';
import { editorText, historyLabels, newFromTemplate, node, openApp, setEditorText } from './helpers';

// 主な使い方を、本番ビルドで通して確かめる。

test('起動すると、エラー無くフローチャートが描かれる', async ({ page }) => {
  const errors = await openApp(page);
  await expect(node(page, '開始')).toBeVisible();
  await expect(page.locator('.history-label')).toHaveText(['作成']);
  expect(errors).toEqual([]);
});

test('テキストの変更が図に反映され、構文エラーの間は最後に正常だった図を残す', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  X[入力] --> Y[出力]');
  await expect(node(page, '出力')).toBeVisible();

  await page.keyboard.insertText(' --> (');
  await expect(page.locator('.error-banner')).toContainText('構文エラー');
  await expect(page.locator('.diagram-viewport')).toHaveClass(/stale/);
  await expect(node(page, '出力')).toBeVisible();

  await page.keyboard.press('Control+Z');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.diagram-viewport')).not.toHaveClass(/stale/);
});

test('構文エラーを日本語で説明し、ボタンで直せる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A[開始 --> B');
  await expect(page.locator('.error-summary')).toHaveText('2 行目の「[」が閉じていません。');
  await page.getByRole('button', { name: '「]」で閉じる' }).click();
  await expect.poll(() => editorText(page)).toContain('A[開始] --> B');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  expect((await historyLabels(page)).at(-1)).toBe('エラーを直す: 「]」で閉じる');
});

test('ラベルをダブルクリックで直し、Tab で次のノードを足す（履歴は操作ごとに 1 ステップ）', async ({ page }) => {
  await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('スタート');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A[スタート]');

  // 描き直しを待たずに、続けて Tab で次のノードを足せる
  await page.keyboard.press('Tab');
  await page.locator('.inline-label-editor input').fill('準備');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A --> N1[準備]');
  expect(await historyLabels(page)).toEqual(['作成', 'ラベル変更「スタート」', 'ノード N1 を A の次に追加', 'ラベル変更「準備」']);
});

test('undo・redo と、再読み込みしても残る履歴', async ({ page }) => {
  await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('変更後');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A[変更後]');

  await page.locator('.diagram-viewport').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Z');
  await expect.poll(() => editorText(page)).toContain('A[開始]');
  await page.keyboard.press('Control+Shift+Z');
  await expect.poll(() => editorText(page)).toContain('A[変更後]');

  // 保存は少し遅れて行われるので、待ってから読み込み直す
  await page.waitForTimeout(600);
  await page.reload();
  await expect(node(page, '変更後')).toBeVisible();
  await page.locator('.diagram-viewport').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Z');
  await expect.poll(() => editorText(page)).toContain('A[開始]');
});

test('プロパティで形を変えた直後でも、Delete で消せる', async ({ page }) => {
  await openApp(page);
  await node(page, '処理を実行').click();
  await expect(page.locator('.panel-heading')).toHaveText('ノード: C');
  await page.getByLabel('形').selectOption('cylinder');
  await expect.poll(() => editorText(page)).toContain('C[(処理を実行)]');

  await node(page, 'スキップ').click();
  await page.keyboard.press('Delete');
  await expect.poll(() => editorText(page)).not.toContain('スキップ');
  await expect(node(page, 'スキップ')).toHaveCount(0);
});

test('履歴の版と今の版を図で比べる（変えた・足した要素を光らせる）', async ({ page }) => {
  const errors = await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('スタート');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.locator('.inline-label-editor input').fill('準備');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('N1[準備]');

  const first = page.locator('.history-row').first();
  await first.hover();
  await first.getByTitle('この版と今の版を図で比べる').click();
  const view = page.getByRole('dialog', { name: '版を比べる' });
  // ラベルを変えたノード A、足したノード N1 とエッジ A→N1
  await expect(view.locator('.compare-summary')).toContainText('足した 2');
  await expect(view.locator('.compare-summary')).toContainText('消した 0');
  await expect(view.locator('.compare-summary')).toContainText('変えた 1');
  await expect(view.locator('.compare-side').first().locator('.mmd-diff-chg')).toHaveCount(1);
  await expect(view.locator('.compare-side').last().locator('.mmd-diff-add')).toHaveCount(2);
  // 左右を入れ替えると、足した要素は「消した」になる
  await view.getByTitle('左右を入れ替える').click();
  await expect(view.locator('.compare-summary')).toContainText('消した 2');
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('右クリックのメニューから接続する', async ({ page }) => {
  await openApp(page);
  await node(page, '終了').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /接続/ }).click();
  await expect(page.locator('.connect-banner')).toBeVisible();
  await node(page, '開始').click();
  await expect.poll(() => editorText(page)).toContain('E --> A');
});

test('フローチャート: ラベルの無いノードにラベルを付け、サブグラフの向きを変える', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A --> B\n  subgraph S1 [グループ]\n    C --> D\n  end\n');
  await expect(node(page, 'D')).toBeVisible();
  await node(page, 'B').dblclick();
  await page.locator('.inline-label-editor input').fill('ビー');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('A --> B[ビー]');

  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await page.locator('.diagram-canvas g.cluster .cluster-label').click();
  await expect(page.locator('.panel-heading')).toHaveText('サブグラフ: S1');
  await page.getByLabel('中の向き').selectOption('TB');
  await expect.poll(() => editorText(page)).toContain('subgraph S1 [グループ]\n    direction TB');
});

test('シーケンス図: 注釈の位置を変え、メッセージを枠で囲んで条件を書く', async ({ page }) => {
  await openApp(page);
  await newFromTemplate(page, 'シーケンス図');
  await page.locator('.diagram-canvas g[data-et="note"]').click();
  await expect(page.locator('.panel-heading')).toHaveText('注釈: 0');
  await page.getByLabel('位置').selectOption('right of');
  await expect.poll(() => editorText(page)).toContain('Note right of U: 通信は暗号化');

  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await page.locator('.diagram-canvas text.messageText', { hasText: 'リクエスト' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '枠で囲む' }).click();
  await page.locator('.inline-label-editor input').fill('毎分');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('loop 毎分');
  await expect(page.locator('.diagram-canvas g[data-et="control-structure"]')).toHaveCount(1);
});

test('シーケンス図: 参加者とメッセージをドラッグで並べ替える', async ({ page }) => {
  await openApp(page);
  await newFromTemplate(page, 'シーケンス図');
  /** from の中心から to の指定の位置までドラッグする */
  const dragTo = async (from: string, to: string, at: 'left' | 'top') => {
    const a = (await page.locator(from).first().boundingBox())!;
    const b = (await page.locator(to).first().boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    const x = at === 'left' ? b.x + 2 : b.x + b.width / 2;
    const y = at === 'left' ? b.y + b.height / 2 : b.y + 1;
    await page.mouse.move(x, y, { steps: 8 });
    await expect(page.locator('.drop-indicator')).toBeVisible();
    await page.mouse.up();
  };

  // サーバーをユーザーの左へ
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await dragTo('.diagram-canvas g[data-et="participant"][data-id="S"]', '.diagram-canvas g[data-et="participant"][data-id="U"]', 'left');
  await expect.poll(() => editorText(page)).toMatch(/participant S as サーバー\s+participant U as ユーザー/);
  await expect(page.locator('.drop-indicator')).toHaveCount(0);

  // レスポンスをリクエストの上へ。選んだ状態でも、操作ボタンが本文を覆わずにドラッグできる
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  await page.locator('.diagram-canvas text.messageText >> text=レスポンス').click();
  await expect(page.locator('.element-toolbar')).toBeVisible();
  await dragTo('.diagram-canvas text.messageText >> text=レスポンス', '.diagram-canvas text.messageText >> text=リクエスト', 'top');
  await expect.poll(() => editorText(page)).toMatch(/S-->>U: レスポンス\s+U->>S: リクエスト/);
  expect((await historyLabels(page)).slice(-2)).toEqual(['参加者 S を移動', 'メッセージを移動']);
});

test('エディタで打つと、図の中の名前を補完できる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  Kensaku[検索] --> B\n  ');
  await page.keyboard.type('Ken');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Kensaku');
  // 候補が出た直後（75ms）の Enter は、誤操作を防ぐため CodeMirror が確定に使わない
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('--> B\n  Kensaku');
});

test('円グラフは表で編集できる', async ({ page }) => {
  await openApp(page);
  await newFromTemplate(page, '円グラフ');
  await page.getByRole('button', { name: '＋ スライス' }).click();
  await expect.poll(() => editorText(page)).toContain('"新しい項目" : 10');
  await page.locator('.table-row').first().getByTitle('削除').click();
  await expect.poll(() => editorText(page)).not.toContain('"Chrome"');
});

test('「共有リンクをコピー」したリンクを別の利用者が開くと、新しい図として取り込む', async ({ page, browser }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  K[共有された] --> L');
  await page.locator('.title-input').fill('E2E の共有');
  await page.getByRole('button', { name: 'ファイル ▾' }).click();
  await page.getByRole('menuitem', { name: '共有リンクをコピー' }).click();
  await expect(page.locator('.toast')).toContainText('共有リンクをコピーしました');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#v1\/[A-Za-z0-9_-]+$/);

  // 別の利用者（保存領域が空の別のコンテキスト）が開く
  const other = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 } });
  const page2 = await other.newPage();
  await page2.goto(link);
  await expect(page2.locator('.title-input')).toHaveValue('E2E の共有');
  await expect(node(page2, '共有された')).toBeVisible();
  expect(new URL(page2.url()).hash).toBe('');
  await other.close();
});

test('画像として書き出す（PNG のダウンロード）', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+Shift+E');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ダウンロード' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('フローチャート.png');
});

test('同じ図を 2 つ目のタブで開くと読み取り専用になる', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('.readonly-banner')).toBeVisible();
  await page.close();
  await expect(second.locator('.readonly-banner')).toHaveCount(0);
});

test('一度開けば、オフラインでも起動して描ける（PWA）', async ({ page, context }) => {
  await openApp(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true), null, {
    timeout: 20_000,
  });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await expect(node(page, '開始')).toBeVisible();
  await newFromTemplate(page, 'マインドマップ');
  await expect(page.locator('.diagram-canvas g.mindmap-node').first()).toBeVisible();
});

test('狭い画面ではタブで切り替える', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.locator('.mobile-tabs')).toBeVisible();
  await page.getByRole('tab', { name: 'テキスト' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.diagram-viewport')).toBeHidden();
});

// ---- 以前の不具合の再発防止 ------------------------------------

test('表のセルに続けて打っても、フォーカスが外れない', async ({ page }) => {
  await openApp(page);
  await newFromTemplate(page, '円グラフ');
  const cell = page.locator('.table-row .row-cell input').first();
  await cell.click();
  await cell.press('Control+A');
  await page.keyboard.type('Edge', { delay: 50 });
  await expect.poll(() => editorText(page)).toContain('"Edge" : 62');
});

test('履歴のプレビューを出したまま図を切り替えても、画面が消えない', async ({ page }) => {
  const errors = await openApp(page);
  await node(page, '開始').dblclick();
  await page.locator('.inline-label-editor input').fill('x');
  await page.keyboard.press('Enter');
  await page.locator('.history-row').first().hover();
  await expect(page.locator('.history-preview')).toBeVisible();
  // マウスを動かさずに（プレビューを出したまま）別の図を作る
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.querySelector('.sidebar .btn.primary') as HTMLElement).click());
  await page.evaluate(() => ([...document.querySelectorAll('.sidebar .menu-item')].find((b) => b.textContent === '円グラフ') as HTMLElement).click());
  await expect(page.locator('.title-input')).toHaveValue('円グラフ');
  await expect(page.locator('.history-preview')).toHaveCount(0);
  expect(errors).toEqual([]);
});
