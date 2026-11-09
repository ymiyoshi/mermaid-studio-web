import { createFromTemplate, flush, showToast, useSession } from '../core/session';
import * as store from '../storage/db';
import { buildBackup } from './backup';
import { download, isAbortError, safeFileName } from './download';
import { t } from '../i18n';

// 描画中の例外で画面が出せなくなったときの立て直し（src/ui/RecoveryBoundary.tsx の復旧画面から使う）。
// どれも図を消さない。壊れた図が IndexedDB に残っていて起動のたびに同じ例外になる場合に備えて、
// 「その図を開かずに起動する」口と、図を外に持ち出す口を用意する。

/** 次の起動で最後の図を開かずに、新しい図で始める印（このタブの 1 回の読み込みだけに効く） */
const SAFE_START_KEY = 'mermaid-studio-safe-start';

/**
 * 開いていた図の本文を .mmd として保存させる。保存したファイル名を返す（図が見つからなければ null）。
 * メモリ上の図（未保存の編集を含む）を優先し、無ければ IndexedDB の最後に開いた図を読む。
 */
export async function exportCurrentDoc(): Promise<string | null> {
  let title: string;
  let text: string;
  const cur = useSession.getState().current;
  if (cur) {
    title = cur.title;
    text = cur.text.toString();
  } else {
    const lastOpened = await store.getSetting<string>('lastOpened');
    const rec = lastOpened ? await store.getDoc(lastOpened) : undefined;
    if (!rec) return null;
    title = rec.title;
    text = rec.text;
  }
  const name = `${safeFileName(title)}.mmd`;
  download(new Blob([text], { type: 'text/plain;charset=utf-8' }), name);
  return name;
}

/**
 * すべての図を履歴つきでバックアップ（JSON）として保存させる。書き出した件数を返す。
 * 「ファイル → すべての図をバックアップ」（exportBackup）と同じ形式だが、復旧画面ではトーストが出ず、
 * 保存（flush）が失敗する状態でもありうるので、保存は試すだけにして IndexedDB にある内容を必ず書き出す。
 */
export async function exportAllDocs(): Promise<number> {
  try {
    await flush();
  } catch {
    // 保存できなくても、IndexedDB に残っている内容は書き出す
  }
  const docs = (await store.listDocs()).filter((d) => d.deletedAt === null);
  const entries = await Promise.all(docs.map(async (doc) => ({ doc, history: await store.loadHistory(doc.id) })));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  download(new Blob([JSON.stringify(buildBackup(entries))], { type: 'application/json' }), `mermaid-studio-backup-${date}.json`);
  return entries.length;
}

/** 次の読み込みで最後の図を開かないようにして、ページを読み込み直す */
export function restartWithoutLastDoc() {
  try {
    sessionStorage.setItem(SAFE_START_KEY, '1');
  } catch {
    // 覚えられない環境では、ふつうに読み込み直すだけになる
  }
  location.reload();
}

/** 起動時に 1 度だけ読む。印があれば消して true（次の読み込みはいつもどおりに戻る） */
export function takeSafeStart(): boolean {
  try {
    if (sessionStorage.getItem(SAFE_START_KEY) !== '1') return false;
    sessionStorage.removeItem(SAFE_START_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 最後の図の代わりに新しい空の図を開く（以後の起動は、この新しい図から始まる） */
export async function startWithNewDoc() {
  await createFromTemplate('blank');
  showToast(t('recovery.safeStarted'));
}

/** 描画の外で起きた例外（イベント処理・Promise）を、トーストで知らせる */
export function installGlobalErrorHandlers(target: Window = window) {
  const report = (reason: unknown) => {
    // 利用者がダイアログを閉じただけ（取り消し）は知らせない
    if (isAbortError(reason)) return;
    const message = reason instanceof Error ? reason.message : String(reason ?? '');
    // ResizeObserver の通知の取りこぼしは、ブラウザが出す無害な警告
    if (/ResizeObserver loop/.test(message)) return;
    showToast(t('error.unexpected', { message: message || '-' }));
  };
  const onError = (e: ErrorEvent) => report(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
