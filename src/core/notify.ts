import { get, set } from './state';
import { t } from '../i18n';

// 利用者への通知（トースト）と、保存領域の使用量の表示。

const TOAST_MS = 4000;
let toastSeq = 0;

export function showToast(message: string) {
  const id = ++toastSeq;
  set({ toast: { id, message } });
  setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, TOAST_MS);
}

const STORAGE_WARN_RATIO = 0.8;
let storageWarned = false;

export async function refreshStorageInfo() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
  const info = { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  set({ storage: info });
  if (!storageWarned && info.quota > 0 && info.usage / info.quota > STORAGE_WARN_RATIO) {
    storageWarned = true;
    showToast(t('storage.warn', { pct: String(Math.round((info.usage / info.quota) * 100)) }));
  }
}
