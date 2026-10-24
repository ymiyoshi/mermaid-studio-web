// @vitest-environment jsdom
// 画面の部品のテスト（React Testing Library）。本物の session（fake-indexeddb）につないで、テキストと履歴が変わることを確かめる。
import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createDoc, setTags, useSession } from '../src/core/session';
import { configureMermaid, validate } from '../src/render/mermaid';
import * as db from '../src/storage/db';
import { FieldInput } from '../src/ui/FieldInput';
import { TagEditor } from '../src/ui/TagEditor';
import { PropertyPanel } from '../src/ui/PropertyPanel';
import { HistoryPane } from '../src/ui/HistoryPane';
import { Sidebar } from '../src/ui/Sidebar';
import { InlineLabelEditor } from '../src/ui/InlineLabelEditor';
import { piePlugin } from '../src/plugins/dataPlugins';
import { flowchartPlugin } from '../src/plugins/flowchart';

const text = () => useSession.getState().current!.text.toString();
const labels = () => [...useSession.getState().current!.tree.nodes.values()].sort((a, b) => a.depth - b.depth).map((n) => n.label);

beforeAll(async () => {
  await db.resetDbConnection();
  indexedDB.deleteDatabase('mermaid-studio');
  configureMermaid('default');
  // mermaid は最初の検証のときに読み込まれる。重いときに waitFor の待ち時間（1 秒）を超えないよう、先に読み込んでおく
  await validate('flowchart LR\n  A');
});

afterEach(() => cleanup());

describe('FieldInput', () => {
  const SRC = 'flowchart LR\n  A[開始] --> B\n';
  /** A のラベルを書き換える変更（いまのソースから毎回作る） */
  const build = (source: string, v: string) => {
    const from = source.indexOf('[') + 1;
    return { from, to: source.indexOf(']'), insert: v };
  };
  const field = { type: 'text' as const, value: '開始', label: 'ラベル' };

  beforeEach(async () => {
    await createDoc(SRC, 'f');
  });

  it('打つたびに反映し、フォーカス中の変更は履歴 1 ステップにまとめる', async () => {
    render(<FieldInput field={field} disabled={false} build={build} historyLabel="ラベルを変更" />);
    const input = screen.getByLabelText('ラベル');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '開' } });
    fireEvent.change(input, { target: { value: '開く' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A[開く] --> B\n'));
    expect(labels()).toEqual(['作成', 'ラベルを変更']);
  });

  it('構文が壊れる値は反映せず、入力欄を赤くする', async () => {
    render(<FieldInput field={field} disabled={false} build={build} historyLabel="x" />);
    const input = screen.getByLabelText('ラベル');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'a]b[' } });
    await waitFor(() => expect(input.className).toContain('invalid'));
    expect(text()).toBe(SRC);
  });

  it('IME の変換中は反映せず、確定したら反映する', async () => {
    render(<FieldInput field={field} disabled={false} build={build} historyLabel="x" />);
    const input = screen.getByLabelText('ラベル');
    fireEvent.focus(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'かいし' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(text()).toBe(SRC);
    fireEvent.compositionEnd(input, { target: { value: '開始点' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A[開始点] --> B\n'));
  });

  it('commitOnBlur の欄は、フォーカスを外したときにだけ反映する', async () => {
    render(<FieldInput field={{ ...field, commitOnBlur: true }} disabled={false} build={build} historyLabel="x" />);
    const input = screen.getByLabelText('ラベル');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '確定前' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(text()).toBe(SRC);
    fireEvent.blur(input);
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A[確定前] --> B\n'));
  });

  it('選択肢は選んだときにすぐ反映する', async () => {
    const shape = flowchartPlugin.inspect!(SRC, { kind: 'node', id: 'A' }).find((f) => f.id === 'shape')!;
    render(
      <FieldInput
        field={shape}
        disabled={false}
        build={(src, v) => flowchartPlugin.setProperty!(src, { kind: 'node', id: 'A' }, 'shape', v)}
        historyLabel="形を変更"
      />,
    );
    fireEvent.change(screen.getByLabelText('形'), { target: { value: 'circle' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A((開始)) --> B\n'));
  });

  describe('色の欄', () => {
    const renderFill = () => {
      const fill = flowchartPlugin.inspect!(SRC, { kind: 'node', id: 'A' }).find((f) => f.id === 'fill')!;
      expect(fill.type).toBe('color');
      render(
        <FieldInput
          field={fill}
          disabled={false}
          build={(src, v) => flowchartPlugin.setProperty!(src, { kind: 'node', id: 'A' }, 'fill', v)}
          historyLabel="塗りを変更"
        />,
      );
    };
    const openPalette = () => fireEvent.click(screen.getByRole('button', { name: 'カラーパレット' }));

    it('パレットの色を選ぶと反映し、1 回選ぶごとに履歴 1 ステップにする', async () => {
      renderFill();
      openPalette();
      fireEvent.click(screen.getByRole('button', { name: '#dc2626' }));
      await waitFor(() => expect(text()).toContain('style A fill:#dc2626'));
      // 選んだら閉じる
      expect(screen.queryByRole('group', { name: 'カラーパレット' })).toBeNull();
      openPalette();
      fireEvent.click(screen.getByRole('button', { name: '#2563eb' }));
      await waitFor(() => expect(text()).toContain('style A fill:#2563eb'));
      expect(text()).not.toContain('#dc2626');
      expect(labels()).toEqual(['作成', '塗りを変更', '塗りを変更']);
    });

    it('その他の色からも選べる', async () => {
      renderFill();
      openPalette();
      const custom = screen.getByLabelText('その他の色');
      fireEvent.focus(custom);
      fireEvent.change(custom, { target: { value: '#123456' } });
      await waitFor(() => expect(text()).toContain('style A fill:#123456'));
    });

    it('文字でも打てる（red のような色の名前も）', async () => {
      renderFill();
      const input = screen.getByLabelText('塗りの色');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'red' } });
      await waitFor(() => expect(text()).toContain('style A fill:red'));
    });

    it('Escape で閉じる', () => {
      renderFill();
      openPalette();
      fireEvent.keyDown(screen.getByRole('button', { name: '#dc2626' }), { key: 'Escape' });
      expect(screen.queryByRole('group', { name: 'カラーパレット' })).toBeNull();
    });
  });
});

describe('TagEditor', () => {
  it('Enter で足し、× と Backspace で外す', async () => {
    await createDoc('graph TD\n  A\n', 't');
    render(<TagEditor />);
    const input = screen.getByLabelText('＋ タグ');
    fireEvent.change(input, { target: { value: '設計 #資料' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSession.getState().current!.tags).toEqual(['設計', '資料']);
    fireEvent.click(screen.getByLabelText('タグ「設計」を外す'));
    expect(useSession.getState().current!.tags).toEqual(['資料']);
    fireEvent.keyDown(screen.getByLabelText('＋ タグ'), { key: 'Backspace' });
    expect(useSession.getState().current!.tags).toEqual([]);
  });
});

describe('PropertyPanel（表）', () => {
  const PIE = 'pie title 内訳\n    "A" : 1\n    "B" : 2\n';

  it('表の行を追加・移動・削除し、図全体の設定を変える', async () => {
    await createDoc(PIE, 'p');
    render(<PropertyPanel plugin={piePlugin} selected={null} selectedFrom={null} editable />);
    // 表のタブが最初に開く
    expect(screen.getByRole('tab', { name: 'スライス' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '＋ スライス' }));
    await waitFor(() => expect(text()).toBe(PIE + '    "新しい項目" : 10\n'));

    const rows = () => document.querySelectorAll('.table-row');
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(rows()[0] as HTMLElement).getByTitle('下へ'));
    await waitFor(() => expect(text()).toBe('pie title 内訳\n    "B" : 2\n    "A" : 1\n    "新しい項目" : 10\n'));
    fireEvent.click(within(rows()[2] as HTMLElement).getByTitle('削除'));
    await waitFor(() => expect(text()).toBe('pie title 内訳\n    "B" : 2\n    "A" : 1\n'));

    fireEvent.click(screen.getByRole('tab', { name: 'プロパティ' }));
    const title = screen.getByLabelText('タイトル');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: '割合' } });
    await waitFor(() => expect(text().startsWith('pie title 割合\n')).toBe(true));
  });

  it('編集できないときは入力欄も無効', async () => {
    await createDoc(PIE, 'p2');
    render(<PropertyPanel plugin={piePlugin} selected={null} selectedFrom={null} editable={false} />);
    expect((screen.getByRole('button', { name: '＋ スライス' }) as HTMLButtonElement).disabled).toBe(true);
    for (const input of document.querySelectorAll('.table-row input')) expect((input as HTMLInputElement).disabled).toBe(true);
  });
});

describe('HistoryPane', () => {
  it('行のクリックでその版に戻り、名前を付けられる', async () => {
    await createDoc('graph TD\n  A\n', 'h');
    const { applyChanges } = await import('../src/core/session');
    const { ChangeSet } = await import('@codemirror/state');
    act(() => {
      applyChanges(ChangeSet.of({ from: 13, insert: '  B\n' }, 13), { origin: 'paste' });
    });
    render(<HistoryPane />);
    expect(screen.getByText('1 ステップ')).toBeTruthy();
    fireEvent.click(screen.getByText('作成'));
    expect(text()).toBe('graph TD\n  A\n');

    const row = screen.getByText('貼り付け').closest('.history-row') as HTMLElement;
    fireEvent.click(within(row).getByTitle('名前を付ける（チェックポイント）'));
    const input = screen.getByPlaceholderText('チェックポイントの名前');
    fireEvent.change(input, { target: { value: '初版' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('初版')).toBeTruthy();
    const pasted = [...useSession.getState().current!.tree.nodes.values()].find((n) => n.label === '貼り付け')!;
    expect(pasted.name).toBe('初版');
    // 分岐が無いので整理のボタンは押せない
    expect((screen.getByTitle('古い分岐を整理') as HTMLButtonElement).disabled).toBe(true);
  });

  it('長い履歴では見えている付近の行だけを描く', async () => {
    await createDoc('graph TD\n  A\n', 'h2');
    const { applyChanges, undo } = await import('../src/core/session');
    const { ChangeSet } = await import('@codemirror/state');
    // 根から 100 本の分岐を作る（一本道ではないので折りたたまれない）
    act(() => {
      for (let i = 0; i < 100; i++) {
        applyChanges(ChangeSet.of({ from: 13, insert: `  N${i}\n` }, 13), { origin: 'paste' });
        undo();
      }
    });
    render(<HistoryPane />);
    const rows = document.querySelectorAll('.history-row').length;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(60);
    // 行が無くてもスクロールできる高さは全体分ある
    const inner = document.querySelector('.history-inner') as HTMLElement;
    expect(parseInt(inner.style.height)).toBe(101 * 30);
  });
});

describe('Sidebar', () => {
  it('検索・タグでの絞り込み・並べ替え', async () => {
    await createDoc('pie\n  "x" : 1\n', 'りんご');
    setTags(['果物']);
    await (await import('../src/core/session')).flush();
    await createDoc('graph TD\n  A\n', 'ばなな');
    render(<Sidebar />);
    const titles = () => [...document.querySelectorAll('.doc-title')].map((e) => e.textContent);
    expect(titles()).toContain('りんご');

    fireEvent.change(screen.getByLabelText('図を検索'), { target: { value: 'りんご' } });
    expect(titles()).toEqual(['りんご']);
    fireEvent.change(screen.getByLabelText('図を検索'), { target: { value: '#果物' } });
    expect(titles()).toEqual(['りんご']);
    fireEvent.change(screen.getByLabelText('図を検索'), { target: { value: '' } });

    fireEvent.click(screen.getAllByRole('button', { name: '#果物' })[0]);
    expect(titles()).toEqual(['りんご']);
    fireEvent.click(screen.getAllByRole('button', { name: '#果物' })[0]);

    fireEvent.change(screen.getByLabelText('並べ替え'), { target: { value: 'title' } });
    const sorted = titles();
    expect(sorted).toEqual([...sorted].sort((a, b) => a!.localeCompare(b!, 'ja')));
  });
});

describe('InlineLabelEditor', () => {
  it('打つたびにラベルの範囲を書き換え、変換確定の Enter では閉じない', async () => {
    await createDoc('flowchart LR\n  A[開始] --> B\n', 'l');
    const onClose = vi.fn();
    const onRangeChange = vi.fn();
    render(
      <InlineLabelEditor
        session={{ key: 's1', targetKey: 'e:node:A', range: { from: 17, to: 19 }, original: '開始' }}
        anchor={null}
        container={null}
        renderTick={0}
        viewTick={null}
        onRangeChange={onRangeChange}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'スタート' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A[スタート] --> B\n'));
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: 17, to: 21 });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ラベルの無い要素では、最初の入力で括弧ごと差し込み、空にしたら括弧ごと消す（履歴は 1 ステップ）', async () => {
    await createDoc('flowchart LR\n  A --> B\n', 'l2');
    const onRangeChange = vi.fn();
    // B の直後に [ラベル] を差し込む
    render(
      <InlineLabelEditor
        session={{ key: 's2', targetKey: 'e:node:B', range: { from: 22, to: 22 }, original: 'B', insert: { prefix: '[', suffix: ']' } }}
        anchor={null}
        container={null}
        renderTick={0}
        viewTick={null}
        onRangeChange={onRangeChange}
        onClose={() => {}}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('B');
    fireEvent.change(input, { target: { value: '終わり' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A --> B[終わり]\n'));
    expect(onRangeChange).toHaveBeenLastCalledWith({ from: 23, to: 26 });
    fireEvent.change(input, { target: { value: '完了' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A --> B[完了]\n'));
    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A --> B\n'));
    fireEvent.change(input, { target: { value: 'また' } });
    await waitFor(() => expect(text()).toBe('flowchart LR\n  A --> B[また]\n'));
    expect(labels()).toEqual(['作成', 'ラベル変更「また」']);
  });
});
