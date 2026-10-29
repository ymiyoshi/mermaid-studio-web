// @vitest-environment jsdom
// 保存に失敗したとき（IndexedDB の容量超過など）に、未保存の変更を失わないこと（§8.5）。
// 別のタブで図が消されたときと、書き込み権（§8.5）の受け渡しも確かめる。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const failSave = { on: false, gate: null as Promise<void> | null };
/** gate: 図 gateId の履歴の読み込みを、開くまで止める */
const failLoad = { on: false, gate: null as Promise<void> | null, gateId: '' };
/** acquireDocLock で渡した書き込み権（図の id と、手放したか） */
const locks: { id: string; released: boolean }[] = [];
/** 次に取る書き込み権を、別のタブが持っている（取れずに読み取り専用になる）ことにする */
const busy = { next: null as Promise<void> | null };

vi.mock('../src/storage/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/db')>();
  return {
    ...real,
    saveDocAndNodes: async (...args: Parameters<typeof real.saveDocAndNodes>) => {
      if (failSave.gate) await failSave.gate;
      if (failSave.on) throw new Error('QuotaExceededError');
      return real.saveDocAndNodes(...args);
    },
    loadHistory: async (...args: Parameters<typeof real.loadHistory>) => {
      if (failLoad.gate && args[0] === failLoad.gateId) await failLoad.gate;
      if (failLoad.on) throw new Error('history has no root');
      return real.loadHistory(...args);
    },
  };
});

vi.mock('../src/storage/tabLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/tabLock')>();
  return {
    ...real,
    acquireDocLock: async (id: string) => {
      const l = { id, released: false };
      locks.push(l);
      const whenAcquired = busy.next;
      busy.next = null;
      return { acquired: !whenAcquired, whenAcquired: whenAcquired ?? Promise.resolve(), release: () => void (l.released = true) };
    },
  };
});

import { ChangeSet } from '@codemirror/state';
import { applyChanges, createDoc, flush, openDoc, trashDoc, useSession } from '../src/core/session';
import * as db from '../src/storage/db';

const cur = () => useSession.getState().current!;
const type = (s: string) => {
  const len = cur().text.length;
  applyChanges(ChangeSet.of({ from: len, insert: s }, len), { origin: 'typing', fromEditor: true });
};
const lockOf = (id: string) => locks.filter((l) => l.id === id).at(-1)!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

describe('保存の失敗', () => {
  it('保存に失敗したら別の図を開かず、未保存の変更を残す。直れば保存してから開く', async () => {
    const b = await createDoc('graph TD\n  B\n', 'B');
    const a = await createDoc('graph TD\n  A\n', 'A');
    type('  C\n');

    failSave.on = true;
    await openDoc(b);
    expect(cur().id).toBe(a);
    expect(cur().text.toString()).toBe('graph TD\n  A\n  C\n');

    failSave.on = false;
    await openDoc(b);
    expect(cur().id).toBe(b);
    expect((await db.getDoc(a))!.text).toBe('graph TD\n  A\n  C\n');
  });

  it('書き込み中の保存が終わるのを待ってから図を切り替える（失敗したら切り替えない）', async () => {
    const b = await createDoc('graph TD\n  B\n', 'B');
    const a = await createDoc('graph TD\n  A\n', 'A');
    type('  C\n');

    let open!: () => void;
    failSave.gate = new Promise((r) => (open = r));
    failSave.on = true;
    const saving = flush();
    const opening = openDoc(b);
    open();
    expect(await saving).toBe(false);
    await opening;
    expect(cur().id).toBe(a);

    failSave.gate = null;
    failSave.on = false;
    await openDoc(b);
    expect(cur().id).toBe(b);
    expect((await db.getDoc(a))!.text).toBe('graph TD\n  A\n  C\n');
  });

  it('保存に失敗したら、開いている図をゴミ箱に入れない', async () => {
    const a = await createDoc('graph TD\n  A\n', 'A');
    type('  C\n');
    failSave.on = true;
    await trashDoc(a);
    failSave.on = false;
    expect(cur().id).toBe(a);
    expect((await db.getDoc(a))!.deletedAt).toBeNull();
    expect(await flush()).toBe(true);
    expect((await db.getDoc(a))!.text).toBe('graph TD\n  A\n  C\n');
  });
});

describe('別のタブで消された図', () => {
  it('ゴミ箱に入れられた図は、保存してもゴミ箱のまま', async () => {
    const a = await createDoc('graph TD\n  A\n', 'A');
    await db.updateDocMeta(a, { deletedAt: 1 });
    type('  C\n');
    expect(await flush()).toBe(true);
    expect(await db.getDoc(a)).toMatchObject({ deletedAt: 1, text: 'graph TD\n  A\n  C\n' });
  });

  it('完全に消された図は、保存で作り直さない', async () => {
    const a = await createDoc('graph TD\n  A\n', 'A');
    await db.purgeDoc(a);
    type('  C\n');
    expect(await flush()).toBe(true);
    expect(await db.getDoc(a)).toBeUndefined();
    expect(await db.loadHistory(a)).toEqual([]);
  });
});

describe('書き込み権', () => {
  it('開けなかった図があっても、今の図の書き込み権は手放さず、開けなかった図の書き込み権は手放す', async () => {
    const a = await createDoc('graph TD\n  A\n', 'A');
    const b = await createDoc('graph TD\n  B\n', 'B');
    await openDoc(a);

    await openDoc('missing');
    expect(cur().id).toBe(a);
    expect(lockOf(a).released).toBe(false);
    expect(lockOf('missing').released).toBe(true);

    failLoad.on = true;
    await expect(openDoc(b)).rejects.toThrow();
    failLoad.on = false;
    expect(cur().id).toBe(a);
    expect(lockOf(a).released).toBe(false);
    expect(lockOf(b).released).toBe(true);

    await openDoc(b);
    expect(lockOf(a).released).toBe(true);
    expect(lockOf(b).released).toBe(false);
  });

  it('書き込み権が空いて読み直している間に別の図を開いたら、読み直した図で上書きしない', async () => {
    const a = await createDoc('graph TD\n  A\n', 'A');
    const b = await createDoc('graph TD\n  B\n', 'B');
    let free!: () => void;
    busy.next = new Promise((r) => (free = r));
    await openDoc(a);
    expect(cur()).toMatchObject({ id: a, readOnly: true });

    // 書き込み権が空いて a を読み直し始める。その読み込みが終わる前に b を開き、b の後で a の読み込みを終わらせる
    let loaded!: () => void;
    failLoad.gate = new Promise((r) => (loaded = r));
    failLoad.gateId = a;
    free();
    await wait(20);
    const opening = openDoc(b);
    await wait(20);
    loaded();
    failLoad.gate = null;
    await opening;
    await wait(20);
    expect(cur()).toMatchObject({ id: b, readOnly: false });
    expect(lockOf(b).released).toBe(false);
  });
});
