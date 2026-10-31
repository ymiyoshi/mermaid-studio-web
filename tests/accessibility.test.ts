// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { readAcc, setAcc } from '../src/plugins/accessibility';
import { applySpec } from '../src/plugins/source';

// 設計書 §17.6: 読み上げ用の題名と説明（accTitle / accDescr）

const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
const set = (src: string, key: 'accTitle' | 'accDescr', v: string) => applySpec(src, setAcc(src, key, v)!);

describe('accTitle / accDescr', () => {
  const SRC = 'flowchart TD\n    %% メモ\n    A --> B\n';

  it('無ければ宣言行のすぐ後ろに足し、accDescr は accTitle の後ろに置く', async () => {
    let out = set(SRC, 'accTitle', '流れ');
    expect(out).toBe('flowchart TD\n    accTitle: 流れ\n    %% メモ\n    A --> B\n');
    out = set(out, 'accDescr', 'A から B へ');
    expect(out).toBe('flowchart TD\n    accTitle: 流れ\n    accDescr: A から B へ\n    %% メモ\n    A --> B\n');
    await valid(out);
    expect(readAcc(out, 'accTitle')?.text).toBe('流れ');
  });

  it('あれば値の範囲だけを書き換え、空にすると行を消す', async () => {
    const src = 'sequenceDiagram\n    accTitle: 古い\n    A->>B: やあ\n';
    expect(set(src, 'accTitle', '新しい')).toBe('sequenceDiagram\n    accTitle: 新しい\n    A->>B: やあ\n');
    expect(set(src, 'accTitle', '')).toBe('sequenceDiagram\n    A->>B: やあ\n');
    expect(setAcc(SRC, 'accTitle', '')).toBeNull();
    await valid(set(src, 'accTitle', '新しい'));
  });

  it('複数行の accDescr { … } は読めて、変えると 1 行の書き方にする。改行は空白にする', async () => {
    const src = 'pie\n    accDescr {\n        果物の\n        割合\n    }\n    "りんご" : 3\n';
    expect(readAcc(src, 'accDescr')?.text).toBe('果物の 割合');
    const out = set(src, 'accDescr', '果物\nの割合');
    expect(out).toBe('pie\n    accDescr: 果物 の割合\n    "りんご" : 3\n');
    await valid(out);
  });
});

describe('ほかの読み取りを狂わせない', () => {
  it('どのテンプレートに足しても mermaid.parse を通り、表の行の数は変わらない（timeline の「期間 : 出来事」と読まない）', async () => {
    const { TEMPLATES } = await import('../src/core/templates');
    const { NO_ACC_TYPES } = await import('../src/plugins/accessibility');
    const { pluginFor } = await import('../src/plugins/registry');
    const { tableRows } = await import('../src/plugins/table');
    const extra = [
      'packet-beta\n    0-15: "Source"\n    16-31: "Dest"\n',
      'radar-beta\n    axis a, b, c\n    curve x{1, 2, 3}\n',
      'treemap-beta\n"A"\n    "B": 10\n    "C": 20\n',
    ];
    for (const src of [...TEMPLATES.map((x) => x.text), ...extra]) {
      if (!src) continue;
      const r = await mermaid.parse(src);
      const type = r ? r.diagramType : '';
      if (NO_ACC_TYPES.has(type)) continue;
      const out = set(set(src, 'accTitle', '題'), 'accDescr', '説明');
      await valid(out);
      for (const tb of pluginFor(type).tables ?? []) expect(tableRows(out, tb).length, `${type} ${tb.id}`).toBe(tableRows(src, tb).length);
    }
  });
});
