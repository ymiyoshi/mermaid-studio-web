// 最小限の i18n。現在は日本語のみ（設計書 §10）。英語は辞書を追加するだけで対応できる。

const ja = {
  'app.title': 'Mermaid Studio',
  'doc.untitled': '無題の図',
  'doc.new': '新規',
  'doc.search': '図を検索',
  'doc.duplicate': '複製',
  'doc.delete': 'ゴミ箱へ移動',
  'doc.restore': '元に戻す',
  'doc.purge': '完全に削除',
  'doc.trash': 'ゴミ箱',
  'doc.list': '図の一覧',
  'doc.emptyTrash': 'ゴミ箱は空です',
  'doc.noMatch': '該当する図がありません',
  'doc.copySuffix': '（コピー）',
  'toolbar.undo': '元に戻す (Ctrl+Z)',
  'toolbar.redo': 'やり直す (Ctrl+Shift+Z)',
  'toolbar.theme': 'テーマ',
  'toolbar.fit': '全体を表示',
  'toolbar.zoomIn': '拡大',
  'toolbar.zoomOut': '縮小',
  'readonly.badge': '読み取り専用',
  'readonly.otherTab': 'この図は別のタブで編集中です。そのタブを閉じると編集できるようになります。',
  'error.banner': '構文エラー: 最後に正常だった図を表示しています。図からは編集できません。',
  'error.bannerNoSvg': '構文エラー: 正常に描画できる版がまだありません。テキストを直すと図が表示されます。',
  'error.line': '{line} 行目',
  'diagram.empty': 'テキストを入力すると、ここに図が表示されます',
  'diagram.hint': 'ダブルクリックでラベルを編集 ・ ドラッグで移動 ・ ホイールで拡大縮小',
  'diagram.hintActions': 'クリックで選択 ・ Tab で次の要素を追加 ・ ダブルクリック / Enter でラベルを編集 ・ ドラッグで移動',
  'diagram.hintSelect': 'クリックで選択して追加・接続 ・ ダブルクリック / Enter でラベルを編集 ・ ドラッグで移動',
  'action.invalid': 'この操作では図の構文が壊れるため、反映しませんでした',
  'label.notUnique': 'このラベルはテキスト中で一意に特定できないため、図から編集できません',
  'label.invalid': 'この内容では図の構文が壊れるため、まだ反映していません',
  'history.title': '履歴',
  'history.create': '作成',
  'history.typing': '入力「{text}」',
  'history.delete': '削除（{n} 文字）',
  'history.paste': '貼り付け',
  'history.label': 'ラベル変更「{text}」',
  'history.edit': '編集',
  'history.folded': '… {n} ステップ',
  'history.duplicate': 'この版を新しい図として複製',
  'history.steps': '{n} ステップ',
  'storage.usage': '保存領域 {used} / {quota}',
  'storage.warn': '保存領域の使用率が {pct}% です。古い図や履歴を整理してください。',
  'storage.notPersisted': '永続ストレージが許可されていません。ブラウザがデータを消去する可能性があります。',
} as const;

export type MessageKey = keyof typeof ja;

export function t(key: MessageKey, params?: Record<string, string>): string {
  let s: string = ja[key];
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
  return s;
}
