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

test('Ctrl を押しながら複数のノードを選び、形をまとめて変えてから、まとめて消す', async ({ page }) => {
  await openApp(page);
  await node(page, '開始').click();
  await node(page, '処理を実行').click({ modifiers: ['Control'] });
  await node(page, '終了').click({ modifiers: ['Control'] });
  await expect(page.locator('.panel-heading')).toHaveText('3 個のノード');
  await expect(page.locator('.diagram-canvas .mmd-selected')).toHaveCount(3);
  await page.getByLabel('形').selectOption('cylinder');
  await expect.poll(() => editorText(page)).toContain('A[(開始)]');
  const text = await editorText(page);
  expect(text).toContain('C[(処理を実行)]');
  expect(text).toContain('E[(終了)]');
  expect(text).toContain('D[スキップ]');
  expect((await historyLabels(page)).at(-1)).toBe('3 個の形を変更');

  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => editorText(page)).not.toContain('開始');
  expect(await editorText(page)).not.toContain('終了');
  expect((await historyLabels(page)).at(-1)).toBe('3 個の要素を削除');
});

test('テーマのタブで、図の先頭の設定（テーマと色）を変える', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('tab', { name: 'テーマ' }).click();
  await page.locator('.property-panel').getByRole('combobox', { name: 'テーマ' }).selectOption('base');
  await expect.poll(() => editorText(page)).toContain('---\nconfig:\n  theme: base\n---\nflowchart TD');
  await page.getByLabel('基本の塗り').fill('#ffcc00');
  await expect.poll(() => editorText(page)).toContain('  themeVariables:\n    primaryColor: "#ffcc00"');
  // 描いた図に色が付く
  await expect.poll(() => page.locator('.diagram-canvas g.node rect').first().evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(255, 204, 0)');
  await page.getByTitle('設定を外す').click();
  await expect.poll(() => editorText(page)).not.toContain('themeVariables');
  expect(errors).toEqual([]);
});

test('部品集: 選んだ範囲を登録し、再読み込みしてもカーソルの行の下に差し込める', async ({ page }) => {
  await openApp(page);
  await page.locator('.cm-line', { hasText: 'C --> E[終了]' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByTitle('部品集（よく使う図の一部を登録・差し込み）').click();
  const dialog = page.getByRole('dialog', { name: '部品集' });
  await dialog.getByLabel('部品の名前').fill('終了へ');
  await dialog.getByRole('button', { name: '選んだ範囲を登録' }).click();
  await expect(dialog.locator('.snippet-item')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // 保存は IndexedDB の設定なので、読み込み直しても残る
  await page.reload();
  await expect(node(page, '開始')).toBeVisible();
  await page.locator('.cm-line', { hasText: 'A[開始]' }).click();
  await page.keyboard.press('End');
  await page.getByTitle('部品集（よく使う図の一部を登録・差し込み）').click();
  await dialog.getByRole('button', { name: '差し込む' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => editorText(page)).toContain('A[開始] --> B{条件を満たす?}\n    C --> E[終了]\n');
  expect((await historyLabels(page)).at(-1)).toBe('部品「終了へ」を差し込む');
});

test('発表モードで、図を全画面で順に見せる', async ({ page }) => {
  const errors = await openApp(page);
  await newFromTemplate(page, '円グラフ');
  await page.getByTitle('発表モード（図を全画面で順に見せる）').click();
  const setup = page.getByRole('dialog', { name: '発表モード' });
  await setup.getByLabel('並び順').selectOption({ label: '名前順' });
  // 日本語の並び（カタカナが漢字より先）
  await expect(setup.locator('.present-list li')).toHaveText(['フローチャート', '円グラフ']);
  await setup.getByRole('button', { name: '2 枚で始める' }).click();
  const show = page.locator('.presentation');
  await expect(show.getByRole('status')).toHaveText('1 / 2');
  await expect(show.locator('.presentation-title')).toHaveText('フローチャート');
  await expect(show.locator('.presentation-svg')).toContainText('処理を実行');
  await page.keyboard.press('ArrowRight');
  await expect(show.getByRole('status')).toHaveText('2 / 2');
  await expect(show.locator('.presentation-title')).toHaveText('円グラフ');
  await page.keyboard.press('Escape');
  await expect(show).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('まとめて消すとき、番号で指すエッジは元の図の番号のまま消す', async ({ page }) => {
  await openApp(page);
  // はい（B→C）と、C→E のエッジを選ぶ
  await page.locator('.diagram-canvas g.edgeLabel', { hasText: 'はい' }).click();
  await page.locator('.diagram-canvas path[data-id="L_C_E_0"] + .mmd-hit').click({ modifiers: ['Control'], force: true });
  await expect(page.locator('.panel-heading')).toHaveText('2 個のエッジ');
  await page.locator('.diagram-viewport').focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => editorText(page)).not.toContain('C --> E');
  const text = await editorText(page);
  expect(text).not.toContain('|はい|');
  expect(text).toContain('D --> E');
});

test('まとめて編集: 名前は出さず、「（なし）」を選べる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'flowchart LR\n  A:::hot --> B:::hot\n  classDef hot fill:#f96');
  await expect(node(page, 'B')).toBeVisible();
  await node(page, 'A').click();
  await node(page, 'B').click({ modifiers: ['Control'] });
  await expect(page.locator('.panel-heading')).toHaveText('2 個のノード');
  await expect(page.getByLabel('ID')).toHaveCount(0);
  await page.locator('.property-panel').getByLabel('クラス').selectOption({ label: '（なし）' });
  await expect.poll(() => editorText(page)).toContain('A --> B');

  await newFromTemplate(page, '状態遷移図');
  await page.locator('.diagram-canvas g.node', { hasText: '待機' }).click();
  await page.locator('.diagram-canvas g.node', { hasText: '実行中' }).click({ modifiers: ['Control'] });
  await expect(page.locator('.panel-heading')).toHaveText('2 個の状態');
  await expect(page.getByLabel('状態の名前（ID）')).toHaveCount(0);
});

test('宣言行で向きを打って Enter を押すと、補完ではなく改行になる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, '');
  await page.keyboard.type('flowchart TD');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.keyboard.type('A');
  await expect.poll(() => editorText(page)).toContain('flowchart TD\nA');
});

test('履歴のペインを閉じていても、コマンドパレットからタイムラプスを開ける', async ({ page }) => {
  await openApp(page);
  await page.getByTitle('履歴を表示・隠す').click();
  await expect(page.locator('.history-pane')).toHaveCount(0);
  await page.keyboard.press('Control+K');
  await page.getByRole('dialog', { name: 'コマンド' }).getByRole('combobox').fill('タイムラプス');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '作った過程を再生' })).toBeVisible();
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

test('Ctrl+K のコマンドパレットで、テンプレートから図を作り、前の図に戻る', async ({ page }) => {
  await openApp(page);
  // エディタにフォーカスがあっても開く
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'コマンド' });
  await palette.getByRole('combobox').fill('シーケンス');
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-input')).toHaveValue('シーケンス図');
  await expect(palette).toHaveCount(0);

  await page.keyboard.press('Control+K');
  await palette.getByRole('combobox').fill('開く フローチャート');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.title-input')).toHaveValue('フローチャート');
});

test('ブロック図: 次のブロックを足してラベルを付け、ブロックを消すと矢印も消える', async ({ page }) => {
  await openApp(page);
  await newFromTemplate(page, 'ブロック図');
  const blockNode = (text: string) => page.locator('.diagram-canvas g.node', { hasText: text });
  await blockNode('キャッシュ').click();
  await expect(page.locator('.panel-heading')).toHaveText('ブロック: cache');
  await page.keyboard.press('Tab');
  await page.locator('.inline-label-editor input').fill('ログ');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('cache["キャッシュ"] b1["ログ"] queue');

  await blockNode('API').click();
  await page.keyboard.press('Delete');
  await expect.poll(() => editorText(page)).not.toContain('api');
  await expect(blockNode('API')).toHaveCount(0);
});

test('メッセージの本文を打って Enter を押すと、補完ではなく改行になる', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, 'sequenceDiagram\n  U->>S: リクエスト\n  S->>U: ');
  await page.keyboard.type('リク');
  await page.waitForTimeout(300);
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => editorText(page)).toContain('S->>U: リク\n');
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

test('アプリとして .mmd を開いたとき（launchQueue）、そのファイルを図として開く', async ({ page }) => {
  // OS の関連付けは試せないので、ページを読み込む前に launchQueue の代わりを置き、受け取る関数にファイルを渡す
  await page.addInitScript(() => {
    class Handle {
      kind = 'file';
      name = '関連付け.mmd';
      async getFile() {
        return new File(['flowchart LR\n  P[渡された] --> Q'], this.name, { lastModified: 1 });
      }
      async isSameEntry(other: unknown) {
        return other === this;
      }
    }
    const w = window as unknown as { __launch?: (p: unknown) => void };
    // Chrome には本物の launchQueue があり、代入では置き換わらないので、プロパティごと定義し直す
    Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer: (c: (p: unknown) => void) => (w.__launch = c) } });
    (window as unknown as { __handle: unknown }).__handle = new Handle();
  });
  await openApp(page);
  await page.waitForFunction(() => typeof (window as unknown as { __launch?: unknown }).__launch === 'function');
  await page.evaluate(() => {
    const w = window as unknown as { __launch: (p: unknown) => void; __handle: unknown };
    w.__launch({ files: [w.__handle] });
  });
  await expect(page.locator('.title-input')).toHaveValue('関連付け');
  await expect(node(page, '渡された')).toBeVisible();
});

test('ファイルを渡されて起動したとき、見本の図を作らずにそのファイルだけを開く', async ({ page }) => {
  // Chrome は、起動時のファイルを setConsumer の直後に渡す
  await page.addInitScript(() => {
    class Handle {
      kind = 'file';
      name = '起動.mmd';
      async getFile() {
        return new File(['flowchart LR\n  S[起動で渡された] --> T'], this.name, { lastModified: 1 });
      }
      async isSameEntry(other: unknown) {
        return other === this;
      }
    }
    const handle = new Handle();
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer: (c: (p: unknown) => void) => queueMicrotask(() => c({ files: [handle] })) },
    });
  });
  await page.goto('/');
  await expect(node(page, '起動で渡された')).toBeVisible();
  await expect(page.locator('.title-input')).toHaveValue('起動');
  await expect(page.locator('.sidebar .doc-open')).toHaveCount(1);
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

test('タッチのピンチで図を拡大する', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  await openApp(page);
  const label = page.locator('.zoom-label');
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  const before = parseInt((await label.innerText()).replace('%', ''), 10);
  // 図ビューの中央で、2 本の指の間を 100px から 300px に開く（Chrome の DevTools Protocol でタッチを送る）
  const box = (await page.locator('.diagram-viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cdp = await context.newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', d: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }],
    });
  await touch('touchStart', 100);
  for (const d of [150, 200, 250, 300]) await touch('touchMove', d);
  await touch('touchEnd', 0);
  await expect.poll(async () => parseInt((await label.innerText()).replace('%', ''), 10)).toBeGreaterThan(before * 2.5);
  await context.close();
});

test('英語の UI に切り替えると、画面と図からの操作が英語になる', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByLabel('言語').selectOption('en');
  // 言語を変えると読み込み直す
  await expect(page.getByRole('button', { name: '＋ New' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await node(page, '開始').click();
  await expect(page.locator('.panel-heading')).toHaveText('Node: A');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect.poll(() => editorText(page)).toContain('A --> N1[New node]');
  expect((await historyLabels(page)).at(-1)).toMatch(/^Add node N1/);
  await page.getByLabel('Language').selectOption('ja');
  await expect(page.getByRole('button', { name: '＋ 新規' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('ピンチの前に指 1 本で並べ替えを始めていても、ピンチの後に要素を動かさない', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  await openApp(page);
  await newFromTemplate(page, 'シーケンス図');
  await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
  const before = await editorText(page);
  const msg = (await page.locator('.diagram-canvas text.messageText', { hasText: 'リクエスト' }).boundingBox())!;
  const x = msg.x + msg.width / 2;
  const y = msg.y + msg.height / 2;
  const cdp = await context.newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  // 1 本目でメッセージを下へ動かし始める
  await send('touchStart', [{ x, y, id: 1 }]);
  for (const dy of [10, 30, 60]) await send('touchMove', [{ x, y: y + dy, id: 1 }]);
  // 2 本目を置いてピンチし、離す
  await send('touchStart', [{ x, y: y + 60, id: 1 }, { x: x + 100, y: y + 60, id: 2 }]);
  await send('touchMove', [{ x: x - 50, y: y + 60, id: 1 }, { x: x + 150, y: y + 60, id: 2 }]);
  await send('touchEnd', []);
  await page.waitForTimeout(500);
  expect(await editorText(page)).toBe(before);
  await context.close();
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
