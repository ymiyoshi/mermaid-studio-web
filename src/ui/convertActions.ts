import { applyDiagramChange, showToast, useSession } from '../core/session';
import { convertTree, type TreeKind } from '../plugins/convertTree';
import { t } from '../i18n';

// 木の図種の変換（設計書 §17.7）を、今の図に当てる。全文を書き直すが、検証してから履歴 1 ステップとして適用する
export async function convertCurrent(from: TreeKind, to: TreeKind) {
  const cur = useSession.getState().current;
  if (!cur || cur.readOnly) return;
  const source = cur.text.toString();
  const out = convertTree(source, from, to);
  if (out === null) return showToast(t('convert.failed'));
  const r = await applyDiagramChange({ from: 0, to: source.length, insert: out }, { label: t('convert.history', { from, to }) });
  if (r === 'invalid') showToast(t('action.invalid'));
}
