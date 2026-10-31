// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { lintDiagram } from '../src/render/lint';
import { applySpec } from '../src/plugins/source';

// 設計書 §17.5: 構文は正しいが怪しいところの警告

const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
const at = (src: string, w: { from: number; to: number }) => src.slice(w.from, w.to);

describe('フローチャート', () => {
  it('1 回しか出てこない ID が、定義のある ID と 1 文字違いなら打ち間違いとして直す案を出す', async () => {
    const src = 'flowchart TD\n    Start[開始] --> Next[次]\n    Next --> Strat\n';
    await valid(src);
    const ws = lintDiagram(src, 'flowchart-v2');
    const typo = ws.find((w) => w.message.includes('Strat'))!;
    expect(at(src, typo)).toBe('Strat');
    expect(typo.severity).toBe('warning');
    const fixed = applySpec(src, typo.fixes[0].spec);
    expect(fixed).toBe('flowchart TD\n    Start[開始] --> Next[次]\n    Next --> Start\n');
    await valid(fixed);
  });

  it('使っていない classDef と、無いノードへの style を見つけ、行を消す案を出す', async () => {
    const src = 'flowchart TD\n    A --> B:::hot\n    classDef hot fill:#f00\n    classDef cold fill:#00f\n    style Z fill:#ff0\n';
    await valid(src);
    const ws = lintDiagram(src, 'flowchart-v2');
    expect(ws.map((w) => w.message)).toEqual(['クラス「cold」はどのノードにも使われていません', '「Z」というノードはありません（指定は効きません）']);
    const fixed = applySpec(src, ws[0].fixes[0].spec);
    expect(fixed).toBe('flowchart TD\n    A --> B:::hot\n    classDef hot fill:#f00\n    style Z fill:#ff0\n');
    await valid(fixed);
  });

  it('class で使った classDef と default は警告しない。つながっていないノードは info', () => {
    const src = 'flowchart TD\n    A --> B\n    C[ひとり]\n    class A warm\n    classDef warm fill:#f90\n    classDef default fill:#fff\n';
    const ws = lintDiagram(src, 'flowchart-v2');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ severity: 'info', message: '「C」はどこにもつながっていません' });
  });

  it('サブグラフの中のノードは、つながっていなくても警告しない', () => {
    const src = 'flowchart TD\n    A --> B\n    subgraph S\n        C\n    end\n';
    expect(lintDiagram(src, 'flowchart-v2')).toEqual([]);
  });
});

describe('シーケンス図', () => {
  it('閉じていない活性化に、最後に deactivate を足す案を出す', async () => {
    const src = 'sequenceDiagram\n    A->>+B: 頼む\n    B->>A: 返す\n';
    await valid(src);
    const ws = lintDiagram(src, 'sequence');
    expect(ws).toHaveLength(1);
    expect(ws[0].message).toContain('「B」の活性化が 1 個');
    const fixed = applySpec(src, ws[0].fixes[0].spec);
    expect(fixed).toBe('sequenceDiagram\n    A->>+B: 頼む\n    B->>A: 返す\n    deactivate B\n');
    await valid(fixed);
    expect(lintDiagram(fixed, 'sequence')).toEqual([]);
  });

  it('使っていない参加者は info で、宣言の行を消す案を出す', async () => {
    const src = 'sequenceDiagram\n    participant A\n    participant C as 使わない\n    A->>A: ひとりごと\n';
    const ws = lintDiagram(src, 'sequence');
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ severity: 'info' });
    expect(at(src, ws[0])).toBe('C');
    await valid(applySpec(src, ws[0].fixes[0].spec));
  });
});

describe('gantt', () => {
  it('after の先のタスクが無ければ警告する', () => {
    const src = 'gantt\n    dateFormat YYYY-MM-DD\n    section 作業\n    設計 :a1, 2026-01-01, 3d\n    実装 :after a2, 5d\n    試験 :after a1, 2d\n';
    const ws = lintDiagram(src, 'gantt');
    expect(ws).toHaveLength(1);
    expect(at(src, ws[0])).toBe('a2');
  });
});

it('ほかの図種では何も出さない', () => {
  expect(lintDiagram('pie\n    "a" : 1\n', 'pie')).toEqual([]);
  expect(lintDiagram('', null)).toEqual([]);
});

describe('誤検知', () => {
  it('「classDef a, b」（区切りの後ろに空白）は、どれを定義したか確かでないので、使っていない警告と行を消す案を出さない', async () => {
    const src = 'flowchart TD\n    A --> B\n    class A cool\n    classDef hot, cool fill:#f00\n';
    await valid(src);
    expect(lintDiagram(src, 'flowchart-v2')).toEqual([]);
  });

  it('数字だけが違う ID は打ち間違いとしない', () => {
    const src = 'flowchart TD\n    Step1[開始] --> Step2\n';
    expect(lintDiagram(src, 'flowchart-v2')).toEqual([]);
  });

  it('テンプレートには warning を出さない', async () => {
    const { TEMPLATES } = await import('../src/core/templates');
    for (const tpl of TEMPLATES) {
      if (!tpl.text) continue;
      const r = await mermaid.parse(tpl.text);
      const ws = lintDiagram(tpl.text, r ? r.diagramType : null);
      expect(ws.filter((w) => w.severity === 'warning'), tpl.id).toEqual([]);
    }
  });
});
