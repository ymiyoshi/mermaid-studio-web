// @vitest-environment jsdom
// 描き直しの時機（設計書 §17.1・§18）: 描いている間に入力が無ければ待たずに描き、
// 描いている間に入力があったときだけ、描き終えてから RENDER_GAP_MS 空けて最新を描く。描き始めは打鍵を画面に出した後にする。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Text } from '@codemirror/state';

/** renderSvg の呼び出し（テキストと、終わらせる関数） */
const calls: { text: string; at: number; done(): void }[] = [];

vi.mock('../src/render/mermaid', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/render/mermaid')>();
  return {
    ...real,
    configureMermaid: () => {},
    peekValidated: () => null,
    renderSvg: (text: string) =>
      new Promise((resolve) => {
        calls.push({ text, at: performance.now(), done: () => resolve({ ok: true, svg: `<svg>${text}</svg>`, diagramType: 'flowchart-v2' }) });
      }),
  };
});

import { RENDER_GAP_MS, startRenderPipeline, useRender } from '../src/render/pipeline';
import { useSession } from '../src/core/session';
import type { CurrentDoc } from '../src/core/state';

const setText = (s: string) => useSession.setState({ current: { ...useSession.getState().current!, text: Text.of(s.split('\n')) } });
const last = () => calls[calls.length - 1];

let stop: () => void;
beforeAll(() => {
  vi.useFakeTimers();
  useSession.setState({ current: { id: 'd1', text: Text.of(['flowchart TD', '  A']) } as CurrentDoc, theme: 'default' });
  stop = startRenderPipeline();
});
afterAll(() => {
  stop();
  vi.useRealTimers();
});

describe('描き直しの時機', () => {
  it('最初のテキストは、次の画面の描画の後すぐに描く（打鍵と同じタスクでは描き始めない）', async () => {
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toHaveLength(1);
    last().done();
    await vi.advanceTimersByTimeAsync(0);
    expect(useRender.getState().svgSource).toBe('flowchart TD\n  A');
  });

  it('描き終えた直後の入力でも、描いている間に入力が無かったなら待たずに描く', async () => {
    setText('flowchart TD\n  A --> B');
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toHaveLength(2);
    expect(last().text).toBe('flowchart TD\n  A --> B');
  });

  it('描いている間に入力があったら、描き終えてから RENDER_GAP_MS 空けて最新だけを描く', async () => {
    setText('flowchart TD\n  A --> B --> C');
    setText('flowchart TD\n  A --> B --> C --> D');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    const before = performance.now();
    last().done();
    await vi.advanceTimersByTimeAsync(RENDER_GAP_MS - 20);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toHaveLength(3);
    expect(last().text).toBe('flowchart TD\n  A --> B --> C --> D');
    expect(last().at - before).toBeGreaterThanOrEqual(RENDER_GAP_MS);
    // 途中のテキスト（C まで）の結果は捨て、図は最新を描いたものになる
    last().done();
    await vi.advanceTimersByTimeAsync(0);
    expect(useRender.getState().svgSource).toBe('flowchart TD\n  A --> B --> C --> D');
  });

  it('空にしたら、待っている描画を取り消す', async () => {
    setText('flowchart TD\n  X');
    setText('');
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(3);
    expect(useRender.getState().status).toBe('empty');
  });
});
