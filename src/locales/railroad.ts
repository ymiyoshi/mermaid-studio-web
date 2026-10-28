// 図種プラグインの文言（railroad）。キーは「分野.名前」。en は ja と同じキーをすべて持つ（型で確かめる）。

export const ja = {
  'rr.field.title': 'タイトル（図には出ない）',
  'rr.field.name': '規則の名前',
  'rr.field.definition': '定義',
  'rr.field.kind': '種類',
  'rr.field.terminal': '文字列',
  'rr.field.nonterminal': '参照する規則',
  'rr.field.special': '説明',
  'rr.kind.terminal': '終端記号',
  'rr.kind.nonterminal': '非終端記号（規則の参照）',
  'rr.kind.special': '特殊',
  'rr.action.addRule': '＋ 規則',
  'rr.action.addNext': '＋ 次の規則',
  'rr.history.add': '規則 {name} を追加',
  'rr.history.delete': '規則 {name} を削除',
  'rr.history.move': '規則 {name} を移動',
};

export const en: Record<keyof typeof ja, string> = {
  'rr.field.title': 'Title (not drawn)',
  'rr.field.name': 'Rule name',
  'rr.field.definition': 'Definition',
  'rr.field.kind': 'Kind',
  'rr.field.terminal': 'Text',
  'rr.field.nonterminal': 'Referenced rule',
  'rr.field.special': 'Description',
  'rr.kind.terminal': 'Terminal',
  'rr.kind.nonterminal': 'Nonterminal (rule reference)',
  'rr.kind.special': 'Special',
  'rr.action.addRule': '+ Rule',
  'rr.action.addNext': '+ Next rule',
  'rr.history.add': 'Add rule {name}',
  'rr.history.delete': 'Delete rule {name}',
  'rr.history.move': 'Move rule {name}',
};
