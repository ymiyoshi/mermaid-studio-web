import { expect, test, type Page } from '@playwright/test';
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

/** target が無いものは §11 の目標の外で、改善の前後を比べるために測る（unit は既定で ms） */
const results: { name: string; target?: number; ms: number; unit?: string }[] = [];

test.afterAll(() => {
  console.log('\n| 項目 | 目標 | 中央値 | 判定 |\n|---|---|---|---|');
  for (const r of results) {
    const unit = r.unit ?? 'ms';
    const goal = r.target === undefined ? '-' : `${r.target}${unit}`;
    const verdict = r.target === undefined ? '-' : r.ms <= r.target ? 'OK' : '超過';
    console.log(`| ${r.name} | ${goal} | ${r.ms.toFixed(0)}${unit} | ${verdict} |`);
  }
});

/** 末尾に一行足してから、図にその行が描かれるまで待つ */
async function appendAndWaitDrawn(page: Page, line: string, marker: string) {
  await page.keyboard.press('Control+End');
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
  await page.keyboard.insertText(line);
  await page.waitForFunction(() => (window as unknown as { __t1: number | null }).__t1 !== null, null, { timeout: 20_000 });
  return page.evaluate(() => {
    const w = window as unknown as { __t0: number; __t1: number };
    return { t0: w.__t0, t1: w.__t1 };
  });
}

/** 長いタスク（50ms 超）を集め始める。集めたものは window.__long に入る */
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __long: { start: number; duration: number }[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask' });
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

// ---- 改善の前後を比べるための計測（§18） ----------------------------------------

test('テキスト入力から再描画まで（200 ノード、間を空けた単発の入力）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, bigFlowchart());
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    // 前の描画から十分に間を空ける（描き終えてからの待ちが入らない入力）
    await page.waitForTimeout(1000);
    const { t0, t1 } = await appendAndWaitDrawn(page, `\n  N199 --> M${i}[目印${i}]`, `目印${i}`);
    times.push(t1 - t0);
  }
  results.push({ name: 'テキスト入力 → 再描画（200 ノード、間を空けた単発）', ms: median(times) });
});

/** Event Timing で、打鍵（interaction）ごとの「押してから次に画面が描かれるまで」を集める。16ms 未満は記録されないので 16ms とみなす */
async function keyLatencies(page: Page, type: () => Promise<void>, keys: number) {
  await page.evaluate(() => {
    const w = window as unknown as { __ev: Map<number, number> };
    w.__ev = new Map();
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (!e.interactionId) continue;
        w.__ev.set(e.interactionId, Math.max(w.__ev.get(e.interactionId) ?? 0, e.duration));
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  });
  await type();
  await page.waitForTimeout(2000);
  const got = await page.evaluate(() => [...(window as unknown as { __ev: Map<number, number> }).__ev.values()]);
  return [...got, ...Array<number>(Math.max(0, keys - got.length)).fill(16)];
}

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

test('打鍵から文字が画面に出るまで（200 ノード）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, `${bigFlowchart()}\n%% `);
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+End');
  // 1 打ずつ、描き直しが終わるまで間を空けて打つ
  const spaced = await keyLatencies(
    page,
    async () => {
      for (let i = 0; i < RUNS; i++) {
        await page.keyboard.press('x');
        await page.waitForTimeout(1500);
      }
    },
    RUNS,
  );
  results.push({ name: '打鍵 → 文字の表示（200 ノード、間を空けた打鍵）', ms: median(spaced) });
  // 続けて打つ（80ms おき）
  const burst = await keyLatencies(page, () => page.keyboard.type('abcdefghijklmnopqrstuvwxyz'.repeat(2), { delay: 80 }), 52);
  results.push({ name: '打鍵 → 文字の表示（200 ノード、続けて打つ、中央値）', ms: median(burst) });
  results.push({ name: '打鍵 → 文字の表示（200 ノード、続けて打つ、90%）', ms: percentile(burst, 0.9) });
});

test('入力が止まった後の警告の処理で主スレッドが塞がる時間（200 ノード、直し方の案 8 つ）', async ({ page }) => {
  await openApp(page);
  const unused = Array.from({ length: 8 }, (_, k) => `  classDef unused${k} fill:#f9f`).join('\n');
  await setEditorText(page, `${bigFlowchart()}\n${unused}`);
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  await watchLongTasks(page);
  const sums: number[] = [];
  const maxes: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate(() => ((window as unknown as { __long: unknown[] }).__long.length = 0));
    const { t1 } = await appendAndWaitDrawn(page, `\n  N199 --> L${i}[警告${i}]`, `警告${i}`);
    // 描き終えた後（警告を出す処理）に始まった長いタスク
    await page.waitForTimeout(3000);
    const after = await page.evaluate(
      (from) => (window as unknown as { __long: { start: number; duration: number }[] }).__long.filter((x) => x.start >= from).map((x) => x.duration),
      t1,
    );
    sums.push(after.reduce((a, b) => a + b, 0));
    maxes.push(after.length ? Math.max(...after) : 0);
  }
  results.push({ name: '描画後の長いタスクの合計（警告の確かめ）', ms: median(sums) });
  results.push({ name: '描画後の長いタスクの最長（警告の確かめ）', ms: median(maxes) });
});

test('続けて打つ間の保存の回数と、別のタブの読み直し（5 秒）', async ({ browser }) => {
  const context = await browser.newContext();
  // IndexedDB の書き込み・一覧の読み込みと、使用量の問い合わせを数える
  await context.addInitScript(() => {
    const w = window as unknown as { __io: Record<string, number> };
    w.__io = {};
    const bump = (k: string) => (w.__io[k] = (w.__io[k] ?? 0) + 1);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      bump(`put:${this.name}`);
      return put.apply(this, args);
    };
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<typeof getAll>) {
      bump(`getAll:${this.name}`);
      return getAll.apply(this, args);
    };
    const est = navigator.storage?.estimate?.bind(navigator.storage);
    if (est) navigator.storage.estimate = () => (bump('estimate'), est());
  });
  const page = await context.newPage();
  await openApp(page);
  const other = await context.newPage();
  await openApp(other);
  await page.bringToFront();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(1500);
  const io = (p: Page) => p.evaluate(() => ({ ...(window as unknown as { __io: Record<string, number> }).__io }));
  const [a0, b0] = [await io(page), await io(other)];
  // 80ms おきに 60 字（約 5 秒）
  await page.keyboard.type(' %%'.padEnd(60, 'x'), { delay: 80 });
  await page.waitForTimeout(1500);
  const [a1, b1] = [await io(page), await io(other)];
  const d = (x: Record<string, number>, y: Record<string, number>, k: string) => (x[k] ?? 0) - (y[k] ?? 0);
  results.push({ name: '保存（文書の書き込み）の回数', ms: d(a1, a0, 'put:documents'), unit: '回' });
  results.push({ name: '使用量の問い合わせ（storage.estimate）の回数', ms: d(a1, a0, 'estimate'), unit: '回' });
  results.push({ name: '別のタブの文書一覧の読み直しの回数', ms: d(b1, b0, 'getAll:documents'), unit: '回' });
  await context.close();
});

/** 画面のフレームの間隔を集め始める。止めると集めた間隔を返す */
const watchFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean };
    w.__frames = [];
    w.__framesOn = true;
    let prev = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - prev);
      prev = t;
      if (w.__framesOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
const stopFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __framesOn: boolean };
    w.__framesOn = false;
    return w.__frames.slice(1);
  });

test('拡大縮小とドラッグでの移動のフレームの間隔（200 ノード、要素を選んだ状態）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, bigFlowchart());
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  // 選んだ要素の操作ボタンも、拡大縮小のたびに位置を測り直す
  await node(page, 'ノード 0').first().click();
  const box = (await page.locator('.diagram-viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await watchFrames(page);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, i < 30 ? -40 : 40);
    await page.waitForTimeout(16);
  }
  const wheel = await stopFrames(page);
  results.push({ name: 'ホイールで拡大縮小中のフレームの間隔（90%）', ms: percentile(wheel, 0.9) });
  results.push({ name: 'ホイールで拡大縮小中のフレームの間隔（最長）', ms: Math.max(...wheel) });
  // 何も無い所からドラッグして動かす
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await page.mouse.down();
  await watchFrames(page);
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(box.x + 8 + i * 4, box.y + box.height - 8 - i * 2);
    await page.waitForTimeout(16);
  }
  const drag = await stopFrames(page);
  await page.mouse.up();
  results.push({ name: 'ドラッグで移動中のフレームの間隔（90%）', ms: percentile(drag, 0.9) });
  results.push({ name: 'ドラッグで移動中のフレームの間隔（最長）', ms: Math.max(...drag) });
});

test('ラベルの文字を打ってから図に出るまで（200 ノード、間を空けた単発）', async ({ page }) => {
  await openApp(page);
  await setEditorText(page, bigFlowchart());
  await expect(node(page, 'ノード 199')).toBeVisible({ timeout: 20_000 });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.waitForTimeout(1000);
    // 最後の行の「N199[ノード 199…]」の ] の手前に打つ
    await page.keyboard.press('Control+End');
    await page.keyboard.press('ArrowLeft');
    const marker = `印${i}`;
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
    await page.keyboard.insertText(marker);
    await page.waitForFunction(() => (window as unknown as { __t1: number | null }).__t1 !== null, null, { timeout: 20_000 });
    times.push(await page.evaluate(() => {
      const w = window as unknown as { __t0: number; __t1: number };
      return w.__t1 - w.__t0;
    }));
  }
  results.push({ name: 'ラベルの文字を打つ → 図に出る（200 ノード）', ms: median(times) });
});
