// @vitest-environment jsdom
// 小さな補助関数の単体テスト（書き出し・エラーの行番号・行の操作・木構造・設定行・i18n・タブの書き込み権）。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import { prepareSvg } from '../src/io/exportImage';
import { safeFileName } from '../src/io/download';
import { toParseError, validate } from '../src/render/mermaid';
import { blockFrom, findBlock, headOf, insertIntoBlock, maskQuotes, mentions, removeLine, renameToken, topLevelEnd } from '../src/plugins/lineOps';
import { bodyLines, insertLineAfter, rangeInInserted, splitLines, tokenRegex, uniqueId } from '../src/plugins/source';
import { addChild, addSibling, deleteSubtree, moveSibling, parseOutline, subtreeEnd } from '../src/plugins/outline';
import { findKeyword, setKeyword } from '../src/plugins/keywordLine';
import { t } from '../src/i18n';
import { acquireDocLock } from '../src/storage/tabLock';
import { lineDiff } from '../src/ui/HistoryPane';

const apply = (source: string, spec: ChangeSpec | readonly ChangeSpec[]) =>
  ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();

describe('画像の書き出しの下準備', () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 300 200" style="max-width: 300px;" width="100%"><g><foreignObject x="5" y="6" width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">ラベル <b>太字</b></div></foreignObject></g></svg>';

  it('viewBox の大きさに固定し、白い背景を足す', () => {
    const p = prepareSvg(SVG, 'white');
    expect([p.width, p.height]).toEqual([300, 200]);
    const doc = new DOMParser().parseFromString(p.svg, 'image/svg+xml');
    const svg = doc.documentElement;
    expect(svg.getAttribute('width')).toBe('300');
    expect(svg.getAttribute('style') ?? '').not.toContain('max-width');
    const rect = svg.firstElementChild!;
    expect(rect.tagName).toBe('rect');
    expect([rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('fill')]).toEqual(['10', '20', '#ffffff']);
  });

  it('透明なら背景を足さず、canvas 用には foreignObject を中央寄せの text に置き換える', () => {
    const p = prepareSvg(SVG, 'transparent', true);
    const doc = new DOMParser().parseFromString(p.svg, 'image/svg+xml');
    expect(doc.querySelector('rect')).toBeNull();
    expect(doc.querySelector('foreignObject')).toBeNull();
    const text = doc.querySelector('text')!;
    expect(text.textContent).toBe('ラベル 太字');
    expect([text.getAttribute('x'), text.getAttribute('y'), text.getAttribute('text-anchor')]).toEqual(['25', '16', 'middle']);
  });

  it('ファイル名に使えない文字を置き換える', () => {
    expect(safeFileName('a/b:c*?"<>|d')).toBe('a_b_c______d');
    expect(safeFileName('   ')).toBe('diagram');
    expect(safeFileName('x'.repeat(300))).toHaveLength(120);
  });
});

describe('構文エラーの行番号', () => {
  it('jison の行（コメントを除いた後の行）を元の行に戻す', () => {
    const src = 'flowchart TD\n  %% c\n  A --> (';
    expect(toParseError({ message: 'Parse error on line 2:', hash: { loc: { first_line: 2 } } }, src).line).toBe(3);
    expect(toParseError({ message: 'x', hash: { line: 0 } }, src).line).toBe(1);
  });

  it('メッセージ中の line や offset からも行を読む', () => {
    expect(toParseError(new Error('Lexical error on line 1. Unrecognized'), 'pie\n x').line).toBe(1);
    expect(toParseError(new Error('unexpected character at offset: 6'), 'pie\n "a" x').line).toBe(2);
    expect(toParseError('文字列のエラー', 'x')).toEqual({ message: '文字列のエラー', line: null });
  });

  it('空のテキストは正しいとみなし、壊れたテキストはエラーと行を返す', async () => {
    expect(await validate('   ')).toEqual({ ok: true, diagramType: null });
    const r = await validate('flowchart TD\n  A --> (');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.line).toBe(2);
  });
});

describe('ソースの行の操作', () => {
  const SRC = '---\ntitle: x\n---\n%% c\nflowchart TD\n  A --> B\n\n  %% d\n  B --> C';

  it('frontmatter・コメント・空行を除いて、宣言行と本体の行に分ける', () => {
    const { header, body } = bodyLines(SRC);
    expect(header?.text).toBe('flowchart TD');
    expect(body.map((l) => l.text)).toEqual(['  A --> B', '  B --> C']);
    expect(splitLines('a\nb').map((l) => [l.from, l.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('ID のトークンは単語の一部と区別し、まだ無い ID を作る', () => {
    expect(tokenRegex('A').test('AB --> C')).toBe(false);
    expect(tokenRegex('A').test('x --> A')).toBe(true);
    expect(tokenRegex('日本').test('日本語')).toBe(false);
    expect(uniqueId('N1 N2 N4', 'N')).toBe('N3');
  });

  it('行の差し込みと、差し込んだ文字列の位置', () => {
    const c = insertLineAfter('a\nb', splitLines('a\nb')[0], 'X');
    expect(apply('a\nb', c)).toBe('a\nX\nb');
    expect(rangeInInserted(c, 'X')).toEqual({ anchor: 2, head: 3 });
    expect(apply('a', insertLineAfter('a', null, 'X'))).toBe('a\nX\n');
    expect(apply('', insertLineAfter('', null, 'X'))).toBe('X\n');
  });

  it('行を消すとき、最後の行なら前の改行を消す', () => {
    const lines = splitLines('a\nb\nc');
    expect(apply('a\nb\nc', removeLine('a\nb\nc', lines[1]))).toBe('a\nc');
    expect(apply('a\nb\nc', removeLine('a\nb\nc', lines[2]))).toBe('a\nb');
  });

  it('文の頭（: の前、引用符の外）だけを ID の対象にする', () => {
    expect(headOf('A --> B : "x:y" z')).toBe('A --> B ');
    expect(headOf('"a:b" --> C')).toBe('"a:b" --> C');
    expect(maskQuotes('x "ab" y')).toBe('x "  " y');
    const line = splitLines('  Dog : +A')[0];
    expect(mentions(line, 'Dog')).toBe(true);
    expect(mentions(line, 'A')).toBe(false);
  });

  it('ID の書き換えはラベルや引用符の中を変えない', () => {
    const src = 'classDiagram\n  A <|-- B : A から\n  note for A "A です"\n  %% A\n';
    expect(apply(src, renameToken(src, 'A', 'Z'))).toBe('classDiagram\n  Z <|-- B : A から\n  note for Z "A です"\n  %% A\n');
  });

  it('入れ子のブロックを数え、閉じ括弧の前に行を足す', () => {
    const src = 'stateDiagram-v2\n  state X {\n    state Y {\n      a\n    }\n    b\n  }\n  c';
    const block = findBlock(src, (l) => l.includes('state X'))!;
    expect(block.map((l) => l.text.trim())).toEqual(['state X {', 'state Y {', 'a', '}', 'b', '}']);
    expect(apply(src, insertIntoBlock(block, 'new'))).toContain('    b\n    new\n  }');
    const one = 'classDiagram\n  class A {}\n';
    const b1 = blockFrom(bodyLines(one).body, 0)!;
    expect(apply(one, insertIntoBlock(b1, '+x'))).toBe('classDiagram\n  class A {\n      +x\n  }\n');
    expect(topLevelEnd('x\n').indent).toBe('    ');
  });
});

describe('インデントの木構造', () => {
  const SRC = 'mindmap\n  root\n    a\n      a1\n    b\n\tc';

  it('親子と兄弟を読み、部分木の終わりを求める', () => {
    const nodes = parseOutline(SRC);
    expect(nodes.map((n) => `${n.line.text.trim()}:${n.depth}`)).toEqual(['root:0', 'a:1', 'a1:2', 'b:1', 'c:1']);
    expect(subtreeEnd(nodes[1]).text.trim()).toBe('a1');
    expect(nodes[1].siblings.map((n) => n.line.text.trim())).toEqual(['a', 'b', 'c']);
  });

  it('子・兄弟の追加、部分木の削除、端での移動', () => {
    const nodes = parseOutline(SRC);
    expect(apply(SRC, addChild(nodes[3], 'b1'))).toContain('    b\n      b1\n');
    expect(apply(SRC, addSibling(nodes[1], 'x'))).toContain('      a1\n    x\n    b');
    expect(apply(SRC, deleteSubtree(SRC, nodes[1]))).toBe('mindmap\n  root\n    b\n\tc');
    expect(moveSibling(SRC, nodes[1], -1)).toBeNull();
    expect(moveSibling(SRC, nodes[4], 1)).toBeNull();
  });
});

describe('キーワードの設定行', () => {
  const spec = { id: 'title', label: 'タイトル', keyword: 'title' };
  it('読む・変える・空にして消す・無ければ宣言行の後ろに足す', () => {
    const src = 'gantt\n    title 計画\n    section A\n';
    expect(findKeyword(src, spec)?.value).toBe('計画');
    expect(apply(src, setKeyword(src, spec, '新計画')!)).toBe('gantt\n    title 新計画\n    section A\n');
    expect(apply(src, setKeyword(src, spec, '')!)).toBe('gantt\n    section A\n');
    const none = 'gantt\n    section A\n';
    expect(apply(none, setKeyword(none, spec, 'X')!)).toBe('gantt\n    title X\n    section A\n');
    expect(setKeyword(none, spec, '')).toBeNull();
  });

  it('引用符で書く値は、引用符の内側を読み書きする', () => {
    const q = { ...spec, quoted: true };
    const src = 'xychart\n  title "売上"\n';
    expect(findKeyword(src, q)?.value).toBe('売上');
    expect(apply(src, setKeyword(src, q, '利益')!)).toBe('xychart\n  title "利益"\n');
  });
});

describe('その他', () => {
  it('i18n は {名前} を置き換える', () => {
    expect(t('history.steps', { n: '3' })).toBe('3 ステップ');
    expect(t('doc.untitled')).toBe('無題の図');
  });

  it('Web Locks の無い環境では、常に書き込み権が取れる', async () => {
    const lock = await acquireDocLock('x');
    expect(lock.acquired).toBe(true);
    await expect(lock.whenAcquired).resolves.toBeUndefined();
    lock.release();
  });

  it('履歴のプレビューの行の差分（順番は見ない）', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd\nd')).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('x', 'x')).toEqual({ added: 0, removed: 0 });
  });
});
