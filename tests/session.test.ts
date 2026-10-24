// @vitest-environment jsdom
// session の振る舞いを固定するテスト（分割のリファクタリングで変わらないことを確かめる）。
// applyDiagramChange は mermaid.parse を使うため jsdom で動かす
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import {
  applyChanges,
  applyDiagramChange,
  createDoc,
  editorBus,
  flush,
  jumpTo,
  nameCheckpoint,
  openDoc,
  redo,
  setTags,
  undo,
  useSession,
  type EditorEvent,
} from '../src/core/session';
import { configureMermaid } from '../src/render/mermaid';
import * as db from '../src/storage/db';

const text = () => useSession.getState().current!.text.toString();
const tree = () => useSession.getState().current!.tree;
const insert = (at: number, s: string, ts: number) => {
  const len = useSession.getState().current!.text.length;
  return applyChanges(ChangeSet.of({ from: at, insert: s }, len), {
    origin: 'typing',
    selBefore: { anchor: at, head: at },
    selAfter: { anchor: at + s.length, head: at + s.length },
    fromEditor: true,
    ts,
  });
};

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
  configureMermaid('default');
});

describe('session', () => {
  let docId = '';

  it('図を作ると、その図が開き、履歴はルートだけ', async () => {
    docId = await createDoc('flowchart LR\n  A --> B\n', 'テスト');
    const cur = useSession.getState().current!;
    expect(cur.id).toBe(docId);
    expect(cur.title).toBe('テスト');
    expect(text()).toBe('flowchart LR\n  A --> B\n');
    expect(tree().nodes.size).toBe(1);
    expect(useSession.getState().docs.some((d) => d.id === docId)).toBe(true);
  });

  it('続けて打った文字は 1 ステップにまとまり、間が空くと分かれる', () => {
    const end = 'flowchart LR\n  A --> B'.length;
    insert(end, 'C', 10_000);
    insert(end + 1, 'D', 10_200);
    expect(tree().nodes.size).toBe(2);
    insert(end + 2, 'E', 20_000);
    expect(tree().nodes.size).toBe(3);
    expect(text()).toBe('flowchart LR\n  A --> BCDE\n');
  });

  it('エディタ以外からの変更はエディタに通知され、undo / redo / jumpTo で戻る', () => {
    const events: EditorEvent[] = [];
    const off = editorBus.on((e) => events.push(e));
    undo();
    expect(text()).toBe('flowchart LR\n  A --> BCD\n');
    undo();
    expect(text()).toBe('flowchart LR\n  A --> B\n');
    redo();
    expect(text()).toBe('flowchart LR\n  A --> BCD\n');
    jumpTo(tree().rootId);
    expect(text()).toBe('flowchart LR\n  A --> B\n');
    expect(events.map((e) => e.type)).toEqual(['apply', 'apply', 'apply', 'apply']);
    off();
  });

  it('図からの変更は検証してから適用し、壊れる変更は履歴に残さない', async () => {
    const before = tree().nodes.size;
    const ok = await applyDiagramChange({ from: text().indexOf('B'), to: text().indexOf('B') + 1, insert: 'X[新しい]' }, { label: 'ラベル' });
    expect(ok).toBe('ok');
    expect(text()).toBe('flowchart LR\n  A --> X[新しい]\n');
    expect(tree().nodes.size).toBe(before + 1);
    expect(tree().head.origin).toBe('diagram-op');
    const bad = await applyDiagramChange({ from: 0, to: 9, insert: 'nonsense' }, { label: '壊す' });
    expect(bad).toBe('invalid');
    expect(text()).toBe('flowchart LR\n  A --> X[新しい]\n');
    expect(tree().nodes.size).toBe(before + 1);
  });

  it('保存して開き直すと、テキスト・履歴・名前・タグが戻る', async () => {
    nameCheckpoint(tree().headId, '完成');
    setTags(['設計', '#図']);
    await flush();
    const headId = tree().headId;
    const size = tree().nodes.size;
    await openDoc(docId);
    expect(text()).toBe('flowchart LR\n  A --> X[新しい]\n');
    expect(tree().headId).toBe(headId);
    expect(tree().nodes.size).toBe(size);
    expect(tree().head.name).toBe('完成');
    expect(useSession.getState().current!.tags).toEqual(['設計', '図']);
    undo();
    expect(text()).toBe('flowchart LR\n  A --> B\n');
  });
});

describe('図の管理', () => {
  it('テンプレートから作る・複製する・履歴の版から複製する', async () => {
    const { createFromTemplate, duplicateDoc, duplicateFromHistory } = await import('../src/core/session');
    await createFromTemplate('pie');
    const pie = useSession.getState().current!;
    expect(pie.title).toBe('円グラフ');
    await duplicateDoc(pie.id);
    expect(useSession.getState().current!.title).toBe('円グラフ（コピー）');
    expect(text()).toBe(pie.text.toString());

    insert(text().length, '%% 追記\n', 50_000);
    const edited = useSession.getState().current!;
    await duplicateFromHistory(edited.tree.rootId);
    expect(text()).toBe(pie.text.toString());
    expect(useSession.getState().current!.id).not.toBe(edited.id);
  });

  it('ゴミ箱へ移すと別の図が開き、元に戻す・完全に消すができる', async () => {
    const { trashDoc, restoreDoc, purgeDoc } = await import('../src/core/session');
    const id = useSession.getState().current!.id;
    await trashDoc(id);
    expect(useSession.getState().current!.id).not.toBe(id);
    expect(useSession.getState().docs.find((d) => d.id === id)!.deletedAt).not.toBeNull();
    await restoreDoc(id);
    expect(useSession.getState().docs.find((d) => d.id === id)!.deletedAt).toBeNull();
    await purgeDoc(id);
    expect(useSession.getState().docs.some((d) => d.id === id)).toBe(false);
    expect(await db.getDoc(id)).toBeUndefined();
    expect(await db.loadHistory(id)).toHaveLength(0);
  });

  it('名前の変更とテーマは保存される', async () => {
    const { renameCurrent, setTheme } = await import('../src/core/session');
    await renameCurrent('新しい名前');
    await flush();
    expect((await db.getDoc(useSession.getState().current!.id))!.title).toBe('新しい名前');
    setTheme('dark');
    expect(useSession.getState().theme).toBe('dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(await db.getSetting('theme')).toBe('dark');
  });

  it('読み取り専用の図は変更も undo もできない', async () => {
    const before = text();
    useSession.setState({ current: { ...useSession.getState().current!, readOnly: true } });
    expect(insert(0, 'x', 90_000)).toBe(false);
    undo();
    expect(text()).toBe(before);
    expect(await applyDiagramChange({ from: 0, insert: '%%\n' }, { label: 'x' })).toBe('stale');
    useSession.setState({ current: { ...useSession.getState().current!, readOnly: false } });
  });
});

describe('複数タブの書き込み権（Web Locks）', () => {
  it('2 つ目のタブは読み取り専用になり、1 つ目が閉じると書き込める', async () => {
    const { acquireDocLock } = await import('../src/storage/tabLock');
    // 最小限の LockManager: 同じ名前のロックは 1 つだけ。ifAvailable なら待たずに null を渡す
    const held = new Map<string, Promise<unknown>>();
    const waiting = new Map<string, (() => void)[]>();
    const locks = {
      request(name: string, a: unknown, b?: unknown) {
        const opts = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
        const cb = (typeof a === 'function' ? a : b) as (l: unknown) => Promise<unknown>;
        const run = () => {
          const p = cb({ name }).finally(() => {
            held.delete(name);
            waiting.get(name)?.shift()?.();
          });
          held.set(name, p);
          return p;
        };
        if (!held.has(name)) return run();
        if (opts.ifAvailable) return cb(null);
        return new Promise((resolve) => {
          const q = waiting.get(name) ?? [];
          q.push(() => resolve(run()));
          waiting.set(name, q);
        });
      },
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    try {
      const first = await acquireDocLock('doc');
      const second = await acquireDocLock('doc');
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      let got = false;
      void second.whenAcquired.then(() => (got = true));
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toBe(false);
      first.release();
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toBe(true);
      second.release();
    } finally {
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    }
  });
});
