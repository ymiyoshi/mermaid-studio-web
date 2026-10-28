// 図種プラグインの文言（beta: mermaid の -beta の図種）。キーは「分野.名前」。en は ja と同じキーをすべて持つ（型で確かめる）。

export const ja = {
  // agentflow（エージェントの流れ）の形
  'af.shape.task': 'タスク',
  'af.shape.tool': 'ツール',
  'af.shape.input': '入力',
  'af.shape.decision': '判断',
  'af.shape.refdoc': '参照資料',
  'af.shape.action': '操作',

  // ishikawa（特性要因図）
  'ik.newCause': '新しい要因',
  'ik.field.text': '文言',
  'ik.field.level': '階層',
  'ik.action.addChild': '＋ 中に要因',
  'ik.action.addSibling': '＋ 次の要因',
  'ik.history.add': '要因を追加',
  'ik.history.delete': '要因を削除',
  'ik.history.move': '要因を移動',

  // treeView（ファイルの木）
  'tv.newFile': '新しいファイル',
  'tv.field.name': '名前',
  'tv.field.kind': '種類',
  'tv.kind.file': 'ファイル',
  'tv.kind.dir': 'フォルダ',
  'tv.field.desc': '説明',
  'tv.field.icon': 'アイコン',
  'tv.field.class': 'クラス',
  'tv.action.addChild': '＋ 中に追加',
  'tv.action.addSibling': '＋ 次に追加',
  'tv.history.add': '項目を追加',
  'tv.history.delete': '項目を削除',
  'tv.history.move': '項目を移動',
};

export const en: Record<keyof typeof ja, string> = {
  'af.shape.task': 'Task',
  'af.shape.tool': 'Tool',
  'af.shape.input': 'Input',
  'af.shape.decision': 'Decision',
  'af.shape.refdoc': 'Reference doc',
  'af.shape.action': 'Action',

  'ik.newCause': 'New cause',
  'ik.field.text': 'Text',
  'ik.field.level': 'Level',
  'ik.action.addChild': '+ Sub-cause',
  'ik.action.addSibling': '+ Next cause',
  'ik.history.add': 'Add cause',
  'ik.history.delete': 'Delete cause',
  'ik.history.move': 'Move cause',

  'tv.newFile': 'new file',
  'tv.field.name': 'Name',
  'tv.field.kind': 'Kind',
  'tv.kind.file': 'File',
  'tv.kind.dir': 'Folder',
  'tv.field.desc': 'Description',
  'tv.field.icon': 'Icon',
  'tv.field.class': 'Class',
  'tv.action.addChild': '+ Inside',
  'tv.action.addSibling': '+ Next',
  'tv.history.add': 'Add item',
  'tv.history.delete': 'Delete item',
  'tv.history.move': 'Move item',
};
