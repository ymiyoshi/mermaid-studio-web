// @vitest-environment jsdom
// 復旧画面（描画中の例外・起動処理の失敗）と、そこから使う立て直しの操作のテスト。
// どの操作も図を消さないこと、壊れた図を開かずに起動できることを確かめる。
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDoc, flush, useSession } from '../src/core/session';
import * as db from '../src/storage/db';
import { t } from '../src/i18n';

const downloads: { name: string; text: Promise<string> }[] = [];
vi.mock('../src/io/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/io/download')>();
  return {
    ...actual,
    // jsdom には URL.createObjectURL が無いので、書き出した中身を覚えるだけにする
    download: (blob: Blob, name: string) => {
      downloads.push({ name, text: blob.text() });
    },
  };
});

const { RecoveryBoundary, showRecovery } = await import('../src/ui/RecoveryBoundary');
const { parseBackup } = await import('../src/io/backup');
const { exportCurrentDoc, installGlobalErrorHandlers, startWithNewDoc, takeSafeStart } = await import('../src/io/recovery');

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
});

beforeEach(() => {
  downloads.length = 0;
  sessionStorage.clear();
});

afterEach(() => cleanup());

function Boom(): never {
  throw new Error('壊れた図');
}

describe('RecoveryBoundary', () => {
  it('例外が無ければ中身をそのまま出す', () => {
    render(
      <RecoveryBoundary>
        <p>本体</p>
      </RecoveryBoundary>,
    );
    expect(screen.getByText('本体')).toBeTruthy();
  });

  it('描画中の例外で白い画面にせず、復旧画面とエラーの内容を出す', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RecoveryBoundary>
        <Boom />
      </RecoveryBoundary>,
    );
    spy.mockRestore();
    expect(screen.getByText(t('recovery.title'))).toBeTruthy();
    expect(screen.getByText(/Error: 壊れた図/)).toBeTruthy();
    for (const key of ['recovery.reload', 'recovery.exportCurrent', 'recovery.exportAll', 'recovery.safeStart'] as const) {
      expect(screen.getByRole('button', { name: t(key) })).toBeTruthy();
    }
  });

  it('起動処理の失敗（描画の外の例外）でも復旧画面に切り替える', () => {
    render(
      <RecoveryBoundary>
        <p>読み込み中</p>
      </RecoveryBoundary>,
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => showRecovery(new Error('init に失敗')));
    spy.mockRestore();
    expect(screen.queryByText('読み込み中')).toBeNull();
    expect(screen.getByText(/init に失敗/)).toBeTruthy();
  });

  it('復旧画面から、開いていた図を .mmd として保存できる', async () => {
    await createDoc('flowchart LR\n  A --> B\n', '保存する図');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RecoveryBoundary>
        <Boom />
      </RecoveryBoundary>,
    );
    spy.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: t('recovery.exportCurrent') }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t('recovery.exported', { name: '保存する図.mmd' })));
    expect(downloads.map((d) => d.name)).toEqual(['保存する図.mmd']);
    expect(await downloads[0].text).toBe('flowchart LR\n  A --> B\n');
  });
});

describe('復旧画面からのバックアップ', () => {
  it('すべての図を書き出し、件数を画面に出す（トーストは出ないため）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <RecoveryBoundary>
        <Boom />
      </RecoveryBoundary>,
    );
    spy.mockRestore();
    const alive = (await db.listDocs()).filter((d) => d.deletedAt === null).length;
    expect(alive).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: t('recovery.exportAll') }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t('backup.exported', { n: String(alive) })));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^mermaid-studio-backup-\d{8}\.json$/);
    const parsed = parseBackup(await downloads[0].text);
    expect(parsed.docs).toHaveLength(alive);
  });
});

describe('exportCurrentDoc', () => {
  it('メモリ上の図が無ければ、最後に開いた図を IndexedDB から読む', async () => {
    const id = await createDoc('sequenceDiagram\n  A->>B: hi\n', '最後の図');
    await flush();
    expect(await db.getSetting('lastOpened')).toBe(id);
    useSession.setState({ current: null });

    expect(await exportCurrentDoc()).toBe('最後の図.mmd');
    expect(await downloads[0].text).toBe('sequenceDiagram\n  A->>B: hi\n');
  });
});

describe('安全な起動（開いていた図を開かない）', () => {
  it('印は 1 回の起動にだけ効く', () => {
    expect(takeSafeStart()).toBe(false);
    sessionStorage.setItem('mermaid-studio-safe-start', '1');
    expect(takeSafeStart()).toBe(true);
    expect(takeSafeStart()).toBe(false);
  });

  it('新しい図を開き、前の図は消さない', async () => {
    const before = useSession.getState().docs.filter((d) => d.deletedAt === null).map((d) => d.id);
    expect(before.length).toBeGreaterThan(0);

    await startWithNewDoc();

    const cur = useSession.getState().current!;
    expect(before).not.toContain(cur.id);
    expect(cur.text.toString()).toBe('');
    const alive = (await db.listDocs()).filter((d) => d.deletedAt === null).map((d) => d.id);
    for (const id of before) expect(alive).toContain(id);
    expect(await db.getSetting('lastOpened')).toBe(cur.id);
    expect(useSession.getState().toast?.message).toBe(t('recovery.safeStarted'));
  });
});

describe('installGlobalErrorHandlers', () => {
  it('描画の外の例外をトーストで知らせ、無害なものは知らせない', () => {
    const target = new EventTarget() as unknown as Window;
    const dispose = installGlobalErrorHandlers(target);
    useSession.setState({ toast: null });

    target.dispatchEvent(new ErrorEvent('error', { error: new Error('ResizeObserver loop completed with undelivered notifications.') }));
    expect(useSession.getState().toast).toBeNull();

    const aborted = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(aborted, 'reason', { value: new DOMException('cancel', 'AbortError') });
    target.dispatchEvent(aborted);
    expect(useSession.getState().toast).toBeNull();

    target.dispatchEvent(new ErrorEvent('error', { error: new Error('押したら落ちた') }));
    expect(useSession.getState().toast?.message).toBe(t('error.unexpected', { message: '押したら落ちた' }));

    const rejected = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejected, 'reason', { value: new Error('保存に失敗') });
    target.dispatchEvent(rejected);
    expect(useSession.getState().toast?.message).toBe(t('error.unexpected', { message: '保存に失敗' }));

    dispose();
    useSession.setState({ toast: null });
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('外したあと') }));
    expect(useSession.getState().toast).toBeNull();
  });
});
