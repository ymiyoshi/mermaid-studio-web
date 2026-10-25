// @vitest-environment jsdom
// 保存に失敗したとき（IndexedDB の容量超過など）に、未保存の変更を失わないこと（§8.5）。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const failSave = { on: false };

vi.mock('../src/storage/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/db')>();
  return {
    ...real,
    saveDocAndNodes: async (...args: Parameters<typeof real.saveDocAndNodes>) => {
      if (failSave.on) throw new Error('QuotaExceededError');
      return real.saveDocAndNodes(...args);
    },
  };
});

import { ChangeSet } from '@codemirror/state';
import { applyChanges, createDoc, openDoc, useSession } from '../src/core/session';
import * as db from '../src/storage/db';

const cur = () => useSession.getState().current!;

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

describe('保存の失敗', () => {
  it('保存に失敗したら別の図を開かず、未保存の変更を残す。直れば保存してから開く', async () => {
    const b = await createDoc('graph TD\n  B\n', 'B');
    const a = await createDoc('graph TD\n  A\n', 'A');
    const len = cur().text.length;
    applyChanges(ChangeSet.of({ from: len, insert: '  C\n' }, len), { origin: 'typing', fromEditor: true });

    failSave.on = true;
    await openDoc(b);
    expect(cur().id).toBe(a);
    expect(cur().text.toString()).toBe('graph TD\n  A\n  C\n');

    failSave.on = false;
    await openDoc(b);
    expect(cur().id).toBe(b);
    expect((await db.getDoc(a))!.text).toBe('graph TD\n  A\n  C\n');
  });
});
