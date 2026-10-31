import type { ChangeSet, Text } from '@codemirror/state';
import type { HistoryNode, Origin, Sel } from './history';
import { t } from '../i18n';

// 設計書 §8.3: 1 文字ごとに履歴を作らず、意味のある単位にまとめる。

export type EditKind = 'insert' | 'delete' | 'newline' | 'replace';

/** 入力がこれ以上止まったら新しいステップにする */
export const TYPING_PAUSE_MS = 1000;

export function editKind(changes: ChangeSet): EditKind {
  let count = 0;
  let kind: EditKind = 'replace';
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    count++;
    if (toA > fromA && inserted.length === 0) kind = 'delete';
    else if (toA === fromA && inserted.length > 0) kind = inserted.toString().includes('\n') ? 'newline' : 'insert';
    else kind = 'replace';
  });
  return count === 1 ? kind : 'replace';
}

/** vi のエディタの編集単位（挿入から Esc まで・ノーマルモードの 1 コマンド）の groupKey の接頭辞（§8.3） */
export const VIM_GROUP_PREFIX = 'vim:';

/** 入力の groupKey。まとめられない編集は null */
export function typingGroupKey(changes: ChangeSet): string | null {
  const kind = editKind(changes);
  return kind === 'insert' || kind === 'delete' ? `typing:${kind}` : null;
}

export interface NextEdit {
  origin: Origin;
  groupKey: string | null;
  changes: ChangeSet;
  docBefore: Text;
  selBefore: Sel;
  ts: number;
}

export function shouldCoalesce(head: HistoryNode, next: NextEdit): boolean {
  if (head.parentId === null || head.children.length > 0) return false;
  if (next.groupKey === null || next.groupKey !== head.groupKey) return false;
  // ラベル編集などのセッションは、時間に関係なく 1 ステップにまとめる
  if (next.origin !== 'typing') return true;
  // vi の編集単位は、時間・カーソル・単語の切れ目では区切らない（§8.3）
  if (next.groupKey.startsWith(VIM_GROUP_PREFIX)) return true;

  if (next.ts - head.ts > TYPING_PAUSE_MS) return false;
  // カーソルが前回の入力位置から離れていたら区切る
  if (next.selBefore.head !== head.selAfter.head) return false;
  // 単語の切れ目（単語の後に空白を打った）で区切る
  if (editKind(next.changes) === 'insert') {
    let breaks = false;
    next.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
      const before = fromA > 0 ? next.docBefore.sliceString(fromA - 1, fromA) : '';
      if (/^\s/.test(inserted.toString()) && before !== '' && !/\s/.test(before)) breaks = true;
    });
    if (breaks) return false;
  }
  return true;
}

/** 入力・削除の履歴ラベル。forward はノード全体（まとめた後）の変更 */
export function describeTyping(forward: ChangeSet): string {
  let inserted = '';
  let deleted = 0;
  forward.iterChanges((fromA, toA, _fromB, _toB, ins) => {
    inserted += ins.toString();
    deleted += toA - fromA;
  });
  if (inserted.length > 0) {
    const s = inserted.replace(/\n/g, '⏎');
    return t('history.typing', { text: s.length > 24 ? s.slice(0, 24) + '…' : s });
  }
  return t('history.delete', { n: String(deleted) });
}
