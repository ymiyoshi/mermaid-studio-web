import * as store from '../storage/db';
import { broadcast } from '../storage/tabLock';
import { get, set } from './state';
import { refreshStorageInfo, showToast } from './notify';

// 設計書 §8.5: 変更は少し待ってから、文書と履歴を 1 つのトランザクションでまとめて保存する。

const PERSIST_DELAY_MS = 300;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let docDirty = false;

export function schedulePersist() {
  docDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => void flush(), PERSIST_DELAY_MS);
}

export async function flush(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const cur = get().current;
  if (!cur || cur.readOnly || (!docDirty && cur.tree.dirty.size === 0)) return;
  docDirty = false;
  const nodes = cur.tree.takeDirty();
  const record: store.DocRecord = {
    id: cur.id,
    title: cur.title,
    text: cur.text.toString(),
    headId: cur.tree.headId,
    createdAt: cur.createdAt,
    updatedAt: Date.now(),
    deletedAt: null,
    tags: cur.tags,
  };
  try {
    await store.saveDocAndNodes(record, nodes);
    set({ docs: upsertDoc(get().docs, record) });
    broadcast({ type: 'saved', docId: cur.id });
  } catch (e) {
    // 次回の保存で再試行する
    nodes.forEach((n) => cur.tree.dirty.add(n.id));
    docDirty = true;
    showToast(String((e as Error)?.message ?? e));
  }
  void refreshStorageInfo();
}

/** 一覧の文書を差し替え（無ければ足し）、更新の新しい順に並べる */
export function upsertDoc(docs: store.DocRecord[], d: store.DocRecord): store.DocRecord[] {
  return [d, ...docs.filter((x) => x.id !== d.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}
