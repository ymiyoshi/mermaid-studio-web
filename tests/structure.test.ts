// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { flowchartPlugin } from '../src/plugins/flowchart';
import { sequencePlugin } from '../src/plugins/sequence';
import { architecturePlugin } from '../src/plugins/architecture';
import { mindmapPlugin } from '../src/plugins/mindmap';
import { kanbanPlugin } from '../src/plugins/kanban';
import { ishikawaPlugin } from '../src/plugins/ishikawa';
import { treeViewPlugin } from '../src/plugins/treeView';
import { statePlugin } from '../src/plugins/stateDiagram';
import { classPlugin } from '../src/plugins/classDiagram';
import { erPlugin } from '../src/plugins/erDiagram';
import { ancestors, followLinks, linksOf } from '../src/plugins/structure';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';
import { outlineRows } from '../src/ui/OutlinePanel';

// 設計書 §17.2（構造をたどる）・§17.3（複製）・§17.4（要素の一覧）

const apply = (source: string, spec: ChangeSpec | null | undefined) => {
  expect(spec).toBeTruthy();
  return ChangeSet.of(spec!, source.length).apply(Text.of(source.split('\n'))).toString();
};
const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
const node = (id: string): ElementRef => ({ kind: 'node', id });
const sg = (id: string): ElementRef => ({ kind: 'subgraph', id });

/** 元の行がすべて、同じ順で残っているか（複製は行を足すだけ） */
function keepsLines(before: string, after: string) {
  const out = after.split('\n');
  let j = 0;
  for (const line of before.split('\n')) {
    while (j < out.length && out[j] !== line) j++;
    expect(j, `行が消えた: ${line}`).toBeLessThan(out.length);
    j++;
  }
}

function dup(plugin: DiagramPlugin, source: string, refs: ElementRef[]) {
  const res = plugin.duplicate!.run(source, refs);
  expect(res).toBeTruthy();
  return { out: apply(source, res!.change), res: res! };
}

const FLOW = `flowchart TD
    %% コメント
    A[開始] --> B{判定}
    subgraph G1 [処理]
        direction LR
        C(手順 1) -->|次| D[[手順 2]]
        subgraph G2 [内側]
            E
        end
    end
    B --> C
    D --> F[終了]
    style C fill:#f96
    class D hot
    classDef hot fill:#f00
`;

describe('フローチャートの構造', () => {
  const st = flowchartPlugin.structure!;

  it('ノードとサブグラフの親（入れ子のサブグラフも）', () => {
    expect(st.parent(FLOW, node('A'))).toBeNull();
    expect(st.parent(FLOW, node('C'))).toEqual(sg('G1'));
    expect(st.parent(FLOW, node('E'))).toEqual(sg('G2'));
    expect(st.parent(FLOW, sg('G2'))).toEqual(sg('G1'));
    expect(st.parent(FLOW, sg('G1'))).toBeNull();
    expect(ancestors(st, FLOW, node('E'))).toEqual([sg('G2'), sg('G1')]);
  });

  it('サブグラフの子は、中のノードと、すぐ内側のサブグラフ', () => {
    expect(st.children(FLOW, sg('G1'))).toEqual([node('C'), node('D'), sg('G2')]);
    expect(st.children(FLOW, sg('G2'))).toEqual([node('E')]);
    expect(st.children(FLOW, node('A'))).toEqual([]);
  });

  it('サブグラフの子はソースの順に並ぶ（内側のサブグラフが先に書かれていれば先）', () => {
    const src = 'flowchart TD\n    subgraph S\n        subgraph T\n            X\n        end\n        Y\n    end\n';
    expect(st.children(src, sg('S'))).toEqual([sg('T'), node('Y')]);
  });

  it('線をたどる（出ていく先・入ってくる元・線の端）', () => {
    expect(followLinks(st, FLOW, node('B'), true)).toEqual([node('C')]);
    expect(followLinks(st, FLOW, node('C'), false)).toEqual([node('B')]);
    expect(followLinks(st, FLOW, { kind: 'edge', id: '1' }, true)).toEqual([node('D')]);
    expect(followLinks(st, FLOW, { kind: 'edge', id: '1' }, false)).toEqual([node('C')]);
    expect(linksOf(st, FLOW, node('D'))).toHaveLength(2);
  });
});

describe('フローチャートの複製', () => {
  it('ノードを複製すると、形とラベルを写して新しい ID を振り、元の行は変えない', async () => {
    const { out, res } = dup(flowchartPlugin, FLOW, [node('A')]);
    expect(out).toContain('    A1[開始]\n');
    expect(res.select).toEqual(node('A1'));
    keepsLines(FLOW, out);
    await valid(out);
  });

  it('同じサブグラフの中のノードは、そのサブグラフの中に写す。選んだノードどうしの線と style・class も写す', async () => {
    const { out } = dup(flowchartPlugin, FLOW, [node('C'), node('D')]);
    const lines = out.split('\n');
    const end = lines.indexOf('    end');
    expect(lines.slice(0, end)).toContain('        C1(手順 1)');
    expect(lines.slice(0, end)).toContain('        D1[[手順 2]]');
    expect(lines.slice(0, end)).toContain('        C1 -->|次| D1');
    expect(lines.slice(0, end)).toContain('        style C1 fill:#f96');
    expect(lines.slice(0, end)).toContain('        class D1 hot');
    keepsLines(FLOW, out);
    await valid(out);
  });

  it('サブグラフは中身（入れ子のサブグラフも）ごと写す。ラベルの無いノードは元の ID をラベルにし、外へつながる線は写さない', async () => {
    const { out, res } = dup(flowchartPlugin, FLOW, [sg('G1')]);
    expect(out).toContain('    subgraph G3 [処理]\n        direction LR\n        C1(手順 1)\n        D1[[手順 2]]\n        subgraph G4 [内側]\n            E1["E"]\n        end\n    end\n');
    expect(out).toContain('    C1 -->|次| D1\n');
    expect(out).not.toContain('B --> C1');
    expect(res.select).toEqual(sg('G3'));
    keepsLines(FLOW, out);
    await valid(out);
  });

  it('linkStyle の番号は、足したエッジの分ずれない', async () => {
    const src = 'flowchart LR\n    subgraph S\n        A --> B\n    end\n    B --> C\n    linkStyle 1 stroke:red\n';
    const { out } = dup(flowchartPlugin, src, [node('A'), node('B')]);
    // 新しいエッジ A1 --> B1 はサブグラフの中（B --> C より前）に入るので、B --> C は 2 番になる
    expect(out).toContain('linkStyle 2 stroke:red');
    await valid(out);
  });
});

const SEQ = `sequenceDiagram
    participant A as アリス
    participant B as ボブ
    A->>B: こんにちは
    loop 毎日
        B->>A: 元気？
        Note over A: 考える
    end
`;

describe('シーケンス図', () => {
  const st = sequencePlugin.structure!;

  it('枠の中のメッセージ・注釈の親は枠、線はメッセージ', () => {
    expect(st.parent(SEQ, { kind: 'message', id: '1' })).toEqual({ kind: 'block', id: '0' });
    expect(st.parent(SEQ, { kind: 'message', id: '0' })).toBeNull();
    expect(st.children(SEQ, { kind: 'block', id: '0' })).toEqual([
      { kind: 'message', id: '1' },
      { kind: 'note', id: '0' },
    ]);
    expect(followLinks(st, SEQ, { kind: 'participant', id: 'A' }, true)).toEqual([{ kind: 'participant', id: 'B' }]);
  });

  it('メッセージと枠を複製すると、すぐ後ろに写す', async () => {
    let r = dup(sequencePlugin, SEQ, [{ kind: 'message', id: '0' }]);
    expect(r.out).toContain('    A->>B: こんにちは\n    A->>B: こんにちは\n');
    expect(r.res.select).toEqual({ kind: 'message', id: '1' });
    await valid(r.out);
    r = dup(sequencePlugin, SEQ, [{ kind: 'block', id: '0' }, { kind: 'message', id: '1' }]);
    expect(r.out.match(/loop 毎日/g)).toHaveLength(2);
    expect(r.out.match(/元気？/g)).toHaveLength(2);
    expect(r.res.select).toEqual({ kind: 'block', id: '1' });
    keepsLines(SEQ, r.out);
    await valid(r.out);
  });
});

describe('architecture', () => {
  const SRC = `architecture-beta
    group api(cloud)[API]
    service db(database)[DB] in api
    service web(server)[Web]
    web:R --> L:db
`;
  it('親は in のグループ、線は両端', () => {
    const st = architecturePlugin.structure!;
    expect(st.parent(SRC, { kind: 'service', id: 'db' })).toEqual({ kind: 'group', id: 'api' });
    expect(st.children(SRC, { kind: 'group', id: 'api' })).toEqual([{ kind: 'service', id: 'db' }]);
    expect(followLinks(st, SRC, { kind: 'service', id: 'web' }, true)).toEqual([{ kind: 'service', id: 'db' }]);
  });
});

describe('木の図種', () => {
  const MM = `mindmap
  root((中心))
    A
      A1
    B
`;
  it('mindmap: 親子と、部分木の複製（根は複製しない）', async () => {
    const st = mindmapPlugin.structure!;
    expect(st.parent(MM, { kind: 'topic', id: '2' })).toEqual({ kind: 'topic', id: '1' });
    expect(st.children(MM, { kind: 'topic', id: '0' })).toEqual([
      { kind: 'topic', id: '1' },
      { kind: 'topic', id: '3' },
    ]);
    const { out, res } = dup(mindmapPlugin, MM, [{ kind: 'topic', id: '1' }]);
    expect(out).toBe('mindmap\n  root((中心))\n    A\n      A1\n    A\n      A1\n    B\n');
    expect(res.select).toEqual({ kind: 'topic', id: '3' });
    await valid(out);
    expect(mindmapPlugin.duplicate!.run(MM, [{ kind: 'topic', id: '0' }])).toBeNull();
  });

  it('kanban: 列はカードごと写し、ID を振り直す', async () => {
    const KB = 'kanban\n  todo[やること]\n    t1[買い物]\n  done[済み]\n';
    const { out, res } = dup(kanbanPlugin, KB, [{ kind: 'column', id: 'todo' }]);
    expect(out).toBe('kanban\n  todo[やること]\n    t1[買い物]\n  todo1[やること]\n    t2[買い物]\n  done[済み]\n');
    expect(res.select).toEqual({ kind: 'column', id: 'todo1' });
    await valid(out);
  });

  it('ishikawa・treeView も親子をたどれる', () => {
    const IK = 'ishikawa-beta\n    結果\n    人\n        疲れ\n';
    expect(ishikawaPlugin.structure!.parent(IK, { kind: 'cause', id: '2' })).toEqual({ kind: 'cause', id: '1' });
    expect(ishikawaPlugin.duplicate!.run(IK, [{ kind: 'effect', id: '0' }])).toBeNull();
    const TV = 'treeView-beta\n    src/\n        main.ts\n';
    expect(treeViewPlugin.structure!.children(TV, { kind: 'entry', id: '0' })).toEqual([{ kind: 'entry', id: '1' }]);
  });
});

describe('線だけの図種', () => {
  it('state・class・ER の線', () => {
    const ST = 'stateDiagram-v2\n    [*] --> A\n    A --> B : 進む\n';
    expect(followLinks(statePlugin.structure!, ST, { kind: 'state', id: 'A' }, true)).toEqual([{ kind: 'state', id: 'B' }]);
    expect(followLinks(statePlugin.structure!, ST, { kind: 'state', id: 'A' }, false)).toEqual([]);
    const CL = 'classDiagram\n    Animal <|-- Dog\n';
    expect(followLinks(classPlugin.structure!, CL, { kind: 'class', id: 'Animal' }, true)).toEqual([{ kind: 'class', id: 'Dog' }]);
    const ER = 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n';
    expect(followLinks(erPlugin.structure!, ER, { kind: 'entity', id: 'ORDER' }, false)).toEqual([{ kind: 'entity', id: 'CUSTOMER' }]);
  });
});

describe('要素の一覧（outlineRows）', () => {
  const el = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const target = (ref: ElementRef, label: string, from: number) => ({
    id: `${ref.kind}-${ref.id}`,
    el: el(),
    labelEl: el(),
    label,
    range: { from, to: from + label.length },
    ref,
  });
  const src = 'flowchart TD\n    subgraph G [枠]\n        A[開始] --> B[終了]\n    end\n';
  const targets = [
    target(sg('G'), '枠', src.indexOf('枠')),
    target(node('A'), '開始', src.indexOf('開始')),
    target(node('B'), '終了', src.indexOf('終了')),
    { ...target({ kind: 'edge', id: '0' }, '', src.indexOf('-->')), range: null },
  ];
  const keyOf = (x: { ref?: ElementRef; id: string }) => (x.ref ? `${x.ref.kind}:${x.ref.id}` : x.id);

  it('親子で字下げし、線は「元 → 先」と書く', () => {
    const rows = outlineRows(targets, flowchartPlugin, src, keyOf, '');
    expect(rows.map((r) => [r.depth, r.text])).toEqual([
      [0, '枠'],
      [1, '開始'],
      [1, '終了'],
      [0, '開始 → 終了'],
    ]);
  });

  it('絞り込むと、合った行とその親だけを出す', () => {
    const rows = outlineRows(targets, flowchartPlugin, src, keyOf, '終了');
    expect(rows.map((r) => [r.text, r.hit])).toEqual([
      ['枠', false],
      ['終了', true],
      ['開始 → 終了', true],
    ]);
  });
});
