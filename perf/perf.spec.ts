import { expect, test } from '@playwright/test';
import { node, openApp, setEditorText } from '../e2e/helpers';

// 設計書 §11 の応答時間を、本番ビルドで測る（npm run perf）。
// 測る PC によって値が大きく変わるので、目標を超えても失敗にはせず、結果を表で出す。
// 時刻はページの中（performance.now）で測る。Playwright からの打鍵の往復にかかる数 ms が含まれる。

const RUNS = 7;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** 200 ノードのフローチャート（§11 の「200 ノード規模」） */
function bigFlowchart(n = 200) {
  const lines = ['flowchart TD'];
  for (let i = 1; i < n; i++) lines.push(`  N${i - 1}[ノード ${i - 1}] --> N${i}[ノード ${i}]`);
  return lines.join('\n');
}

const results: { name: string; target: number; ms: number }[] = [];

test.afterAll(() => {
  console.log('\n| 項目 | 目標 | 中央値 | 判定 |\n|---|---|---|---|');
  for (const r of results) console.log(`| ${r.name} | ${r.target}ms | ${r.ms.toFixed(0)}ms | ${r.ms <= r.target ? 'OK' : '超過'} |`);
});

test('起動: 開いてから最初の図が描かれるまで（目標 3 秒）', async ({ page }) => {
  // 描かれた瞬間をページの中で記録する
  await page.addInitScript(() => {
    new MutationObserver((_, ob) => {
      if (document.querySelector('.diagram-canvas svg')) {
        (window as unknown as { __firstSvg: number }).__firstSvg = performance.now();
        ob.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await openApp(page);
    times.push(await page.evaluate(() => (window as unknown as { __firstSvg: number }).__firstSvg));
    await page.reload();
  }
  results.push({ name: '起動（2 回目以降の読み込み）', target: 3000, ms: median(times) });
});

test('テキスト入力から再描画まで（200 ノード、目標 300ms）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, bigFlowchart());
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const marker = `目印${i}`;
    await page.keyboard.press('Control+End');
    // 描かれたら時刻を記録する見張りを置いてから打つ
    await page.evaluate((m) => {
      const w = window as unknown as { __t0: number; __t1: number | null };
      w.__t1 = null;
      const canvas = document.querySelector('.diagram-canvas')!;
      new MutationObserver((_, ob) => {
        if (canvas.textContent?.includes(m)) {
          w.__t1 = performance.now();
          ob.disconnect();
        }
      }).observe(canvas, { childList: true, subtree: true, characterData: true });
      w.__t0 = performance.now();
    }, marker);
    await page.keyboard.insertText(`\n  N199 --> M${i}[${marker}]`);
    await page.waitForFunction(() => (window as unknown as { __t1: number | null }).__t1 !== null, null, { timeout: 20_000 });
    times.push(await page.evaluate(() => {
      const w = window as unknown as { __t0: number; __t1: number };
      return w.__t1 - w.__t0;
    }));
  }
  results.push({ name: 'テキスト入力 → 再描画（200 ノード）', target: 300, ms: median(times) });
});

test('図の操作からテキストへの反映まで（目標 50ms）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, bigFlowchart(60));
  await expect(node(page, 'ノード 59')).toBeVisible();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const label = `ノード ${59 - i}`;
    await expect(page.locator('.diagram-viewport')).toHaveClass(/editable/);
    await node(page, label).first().click();
    // Delete を押してから、エディタの本文からそのノードが消えるまで
    const ms = await page.evaluate(async (l) => {
      const content = document.querySelector('.cm-content')!;
      const vp = document.querySelector('.diagram-viewport') as HTMLElement;
      const t0 = performance.now();
      const done = new Promise<number>((resolve) => {
        new MutationObserver((_, ob) => {
          if (!content.textContent?.includes(`[${l}]`)) {
            ob.disconnect();
            resolve(performance.now());
          }
        }).observe(content, { childList: true, subtree: true, characterData: true });
      });
      vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      return (await done) - t0;
    }, label);
    times.push(ms);
  }
  results.push({ name: '図の操作（Delete）→ テキスト反映', target: 50, ms: median(times) });
});
