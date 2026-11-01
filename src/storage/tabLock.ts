// 設計書 §8.5: 同じ図を複数のタブで開いたとき、書き込めるのは 1 タブだけにする。
// Web Locks で書き込み権を取り、取れなかったタブは読み取り専用で BroadcastChannel の更新に追従する。

import type { DocRecord } from './db';

export interface DocLock {
  acquired: boolean;
  release(): void;
  /** 読み取り専用のタブで、書き込み権が空いたときに解決される */
  whenAcquired: Promise<void>;
}

const lockName = (docId: string) => `mermaid-studio:doc:${docId}`;

export function acquireDocLock(docId: string): Promise<DocLock> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    return Promise.resolve({ acquired: true, release() {}, whenAcquired: Promise.resolve() });
  }

  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let cancelled = false;

    const hold = () => held;

    locks.request(lockName(docId), { ifAvailable: true }, async (lock) => {
      if (lock) {
        resolve({ acquired: true, release, whenAcquired: Promise.resolve() });
        return hold();
      }
      // 取れなかった: 空くのを待つ
      let onAcquired!: () => void;
      const whenAcquired = new Promise<void>((r) => (onAcquired = r));
      resolve({
        acquired: false,
        release() {
          cancelled = true;
          release();
        },
        whenAcquired,
      });
      void locks.request(lockName(docId), async () => {
        if (cancelled) return;
        onAcquired();
        return hold();
      });
    });
  });
}

/** saved の doc は書いた文書（古い版のタブから来たものには無い） */
type Message = { type: 'saved'; docId: string; doc?: DocRecord } | { type: 'docs-changed' };

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mermaid-studio') : null;

export function broadcast(msg: Message) {
  channel?.postMessage(msg);
}

export function onBroadcast(fn: (msg: Message) => void): () => void {
  if (!channel) return () => {};
  const h = (e: MessageEvent<Message>) => fn(e.data);
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}
