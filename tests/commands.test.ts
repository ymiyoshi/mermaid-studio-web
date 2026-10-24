import { describe, expect, it } from 'vitest';
import { filterCommands, type Command } from '../src/ui/commands';

const cmd = (group: string, title: string): Command => ({ id: `${group}:${title}`, group, title, run: () => {} });
const all = [cmd('ファイル', '開く…'), cmd('ファイル', '画像として書き出す…'), cmd('新しい図', 'フローチャート'), cmd('図を開く', '設計メモ Flow'), cmd('表示', '全体を表示')];

describe('コマンドパレットの絞り込み', () => {
  it('空なら全部、語をすべて含むものだけに絞る（分類の名前でも探せる）', () => {
    expect(filterCommands(all, '')).toHaveLength(5);
    expect(filterCommands(all, '書き出').map((c) => c.title)).toEqual(['画像として書き出す…']);
    expect(filterCommands(all, 'ファイル 開').map((c) => c.title)).toEqual(['開く…']);
  });

  it('大文字小文字と全角半角を区別せず、タイトルの先頭に合うものを先にする', () => {
    expect(filterCommands(all, 'ｆｌｏｗ').map((c) => c.title)).toEqual(['設計メモ Flow']);
    expect(filterCommands(all, '表示').map((c) => c.title)).toEqual(['全体を表示']);
    expect(filterCommands([cmd('a', '図を表示'), cmd('b', '表示を切り替え')], '表示').map((c) => c.title)).toEqual(['表示を切り替え', '図を表示']);
  });
});
