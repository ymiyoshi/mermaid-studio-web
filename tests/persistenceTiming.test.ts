// @vitest-environment jsdom
// 保存の時機（設計書 §8.5・§18）: 入力が止まってから保存する。打ち続けていても、最初の未保存の変更から 1 秒を超えては待たない。
// 保存の知らせには書いた文書を載せる（受け取ったタブが一覧を読み直さずに済む）。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const saves: number[] = [];
const sent: unknown[] = [];

vi.mock('../src/storage/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/db')>();
  return {
    ...real,
    saveDocAndNodes: async (...args: Parameters<typeof real.saveDocAndNodes>) => {
      saves.push(performance.now());
      return real.saveDocAndNodes(...args);
    },
  };
});

vi.mock('../src/storage/tabLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/tabLock')>();
  return { ...real, broadcast: (msg: unknown) => void sent.push(msg) };
});

import { ChangeSet } from '@codemirror/state';
import { applyChanges, createDoc, useSession } from '../src/core/session';
import * as db from '../src/storage/db';

const cur = () => useSession.getState().current!;
const type = (s: string) => {
  const len = cur().text.length;
  applyChanges(ChangeSet.of({ from: len, insert: s }, len), { origin: 'typing', fromEditor: true });
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

describe('保存の時機', () => {
  it('打ち続けている間は 1 秒ほどに 1 回だけ保存し、止まったら 300ms ほどで保存する', async () => {
    const id = await createDoc('graph TD\n  A\n', 'A');
    await wait(500);
    saves.length = 0;
    sent.length = 0;
    // 100ms おきに 16 回（約 1.6 秒）打つ。前は 300ms おきに保存していた（5 回ほど）
    const start = performance.now();
    for (let i = 0; i < 16; i++) {
      type('x');
      await wait(100);
    }
    const typedFor = performance.now() - start;
    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(saves.length).toBeLessThanOrEqual(Math.ceil(typedFor / 1000));
    // 最初の保存は、打ち始めから 1 秒を大きく超えない
    expect(saves[0] - start).toBeLessThan(1300);
    const during = saves.length;
    await wait(500);
    expect(saves.length).toBe(during + 1);
    expect((await db.getDoc(id))!.text).toBe(`graph TD\n  A\n${'x'.repeat(16)}`);
    // 保存の知らせに、書いた文書が載っている
    const msg = sent.at(-1) as { type: string; docId: string; doc?: db.DocRecord };
    expect(msg).toMatchObject({ type: 'saved', docId: id });
    expect(msg.doc?.text).toBe(`graph TD\n  A\n${'x'.repeat(16)}`);
  });
});
