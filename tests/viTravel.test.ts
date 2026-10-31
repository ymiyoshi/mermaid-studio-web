// @vitest-environment jsdom
// 履歴を作った順にたどる（vi の g- / g+・:earlier / :later。設計書 §16）と、Ex コマンド。
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { applyChanges, createDoc, travel, travelTime, undo, useSession } from '../src/core/session';
import { runEx } from '../src/ui/viDispatch';
import { configureMermaid } from '../src/render/mermaid';
import * as db from '../src/storage/db';

const text = () => useSession.getState().current!.text.toString();
const tree = () => useSession.getState().current!.tree;
/** 末尾に s を足す（毎回別のステップになるよう、時刻を離す） */
const append = (s: string, ts: number) => {
  const len = useSession.getState().current!.text.length;
  applyChanges(ChangeSet.of({ from: len, insert: s }, len), { origin: 'diagram-op', label: s, ts });
};

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
  configureMermaid('default');
});

describe('作った順にたどる', () => {
  it('g- / g+ は分岐をまたいで、作った順の前後の版へ移る', async () => {
    await createDoc('A', 'travel');
    const t0 = tree().head.ts;
    append('1', t0 + 1000);
    append('2', t0 + 2000);
    undo();
    // 「1」から別の分岐を作る
    append('3', t0 + 3000);
    expect(text()).toBe('A13');

    travel(-1);
    expect(text()).toBe('A12');
    travel(-1);
    expect(text()).toBe('A1');
    travel(2);
    expect(text()).toBe('A13');
    // 端を越えたら端で止まる
    travel(10);
    expect(text()).toBe('A13');
    travel(-10);
    expect(text()).toBe('A');
  });

  it(':earlier 10m / :later は時間で前後の版へ移る', async () => {
    await createDoc('B', 'time');
    const t0 = tree().head.ts;
    append('1', t0 + 60_000);
    append('2', t0 + 10 * 60_000);
    append('3', t0 + 11 * 60_000);
    // 11 分の版から 2 分前（9 分）の時点では、まだ「1」の版
    travelTime(-2 * 60_000);
    expect(text()).toBe('B1');
    travelTime(9 * 60_000 + 30_000);
    expect(text()).toBe('B12');
    travelTime(-60 * 60_000);
    expect(text()).toBe('B');
    travelTime(11 * 60_000);
    expect(text()).toBe('B123');
  });
});

describe('runEx', () => {
  it(':earlier / :later と :checkpoint を実行し、知らないコマンドは false', async () => {
    await createDoc('C', 'ex');
    const t0 = tree().head.ts;
    append('1', t0 + 1000);
    append('2', t0 + 2000);
    expect(runEx(':earlier 2')).toBe(true);
    expect(text()).toBe('C');
    expect(runEx('later')).toBe(true);
    expect(text()).toBe('C1');
    expect(runEx(':checkpoint 下書き')).toBe(true);
    expect(tree().head.name).toBe('下書き');
    expect(runEx(':earlier abc')).toBe(false);
    expect(runEx(':nosuch')).toBe(false);
  });
});
