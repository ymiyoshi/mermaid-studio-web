import { createDoc, showToast, useSession } from '../core/session';
import { decodeShare, shareUrl, SHARE_PREFIX, SHARE_URL_WARN } from './share';
import { t } from '../i18n';

// 共有リンクの作成と、開いたときの取り込み（§9.4）。

export async function copyShareLink() {
  const cur = useSession.getState().current;
  if (!cur) return;
  const url = shareUrl({ title: cur.title, text: cur.text.toString() });
  try {
    await navigator.clipboard.writeText(url);
    showToast(url.length > SHARE_URL_WARN ? t('share.tooLong', { n: String(url.length) }) : t('share.copied'));
  } catch {
    showToast(t('share.copyFailed'));
  }
}

/** URL の # に共有された図があれば、新しい図として取り込む（既存の図は上書きしない） */
export async function importFromLocationHash() {
  if (!location.hash.startsWith(SHARE_PREFIX)) return;
  const shared = decodeShare(location.hash);
  // 取り込んだら # を消す（再読み込みで二重に取り込まないように）
  history.replaceState(null, '', location.pathname + location.search);
  if (!shared) {
    showToast(t('share.invalid'));
    return;
  }
  await createDoc(shared.text, shared.title || t('share.untitled'), t('history.shareLoad'));
  showToast(t('share.imported'));
}

export function watchShareLinks() {
  addEventListener('hashchange', () => void importFromLocationHash());
}
