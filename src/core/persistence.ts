import * as store from '../storage/db';
import { broadcast } from '../storage/tabLock';
import { get, set, type CurrentDoc } from './state';
import { refreshStorageInfo, showToast } from './notify';

// 設計書 §8.5: 変更は少し待ってから、文書と履歴を 1 つのトランザクションでまとめて保存する。

/** 入力が止まってから保存するまでの時間 */
const PERSIST_DELAY_MS = 300;
/** 打ち続けていても、最初の未保存の変更からこれより長くは待たない（閉じたときに失うのは最大でこの間の変更。§8.5・§18） */
const PERSIST_MAX_WAIT_MS = 1000;
/** 保存のたびに使用量を問い合わせない（§18。失敗したときは間を空けずに問い合わせる） */
const STORAGE_INFO_INTERVAL_MS = 5000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 待っている保存のきっかけになった、最初の変更の時刻 */
let firstPendingAt = 0;
let docDirty = false;
let storageInfoAt = -Infinity;

export function schedulePersist() {
  docDirty = true;
  const now = Date.now();
  if (persistTimer) clearTimeout(persistTimer);
  else firstPendingAt = now;
  const wait = Math.min(PERSIST_DELAY_MS, firstPendingAt + PERSIST_MAX_WAIT_MS - now);
  persistTimer = setTimeout(() => void flush(), Math.max(0, wait));
}

function refreshStorageInfoSometimes() {
  const now = Date.now();
  if (now - storageInfoAt < STORAGE_INFO_INTERVAL_MS) return;
  storageInfoAt = now;
  void refreshStorageInfo();
}

/** 書き込み中の保存。保存は 1 本ずつ走らせる */
let saving: Promise<boolean> | null = null;

/** 保存できた（または保存するものが無かった）ら true。失敗したら false（変更は dirty のまま残る） */
export async function flush(): Promise<boolean> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  // 書き込み中なら終わるのを待つ。待たずに true を返すと、書き込みが終わる前に図を切り替えてしまい、
  // その書き込みが失敗したときに未保存の変更が切り替え前の図に取り残される
  while (saving) if (!(await saving)) return false;
  const cur = get().current;
  if (!cur || cur.readOnly || (!docDirty && cur.tree.dirty.size === 0)) return true;
  saving = save(cur);
  try {
    return await saving;
  } finally {
    saving = null;
  }
}

async function save(cur: CurrentDoc): Promise<boolean> {
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
    // 別のタブで消された図は作り直さない（ゴミ箱に入れられた図はゴミ箱のまま書く）
    const saved = await store.saveDocAndNodes(record, nodes, { existing: true });
    if (saved) {
      set({ docs: upsertDoc(get().docs, saved) });
      // 書いた文書を載せる（受け取ったタブが文書の一覧を読み直さずに済む）
      broadcast({ type: 'saved', docId: cur.id, doc: saved });
    }
  } catch (e) {
    // 次回の保存で再試行する
    nodes.forEach((n) => cur.tree.dirty.add(n.id));
    docDirty = true;
    showToast(String((e as Error)?.message ?? e));
    storageInfoAt = Date.now();
    void refreshStorageInfo();
    return false;
  }
  refreshStorageInfoSometimes();
  return true;
}

/** 一覧の文書を差し替え（無ければ足し）、更新の新しい順に並べる */
export function upsertDoc(docs: store.DocRecord[], d: store.DocRecord): store.DocRecord[] {
  return [d, ...docs.filter((x) => x.id !== d.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}
