// @vitest-environment jsdom
// フローチャートの図からの操作（サブグラフ・スタイル・新しい形・エッジの付け替え・linkStyle の番号）。
// mermaid.parse を通ることに加えて、mermaid が読み取った中身（所属・形・線のスタイル）も確かめる。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { flowchartPlugin } from '../src/plugins/flowchart';
import { parseFlowchart, subgraphOf } from '../src/plugins/flowchartSyntax';
import { arrowParts, buildArrow, edgeInfo, setShape, shapeValue } from '../src/plugins/flowchartOps';
import { canMoveNode } from '../src/plugins/flowchartSubgraph';

const apply = (source: string, spec: ChangeSpec) => ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();

function run(actionId: string, source: string, refs: { kind: string; id: string }[]) {
  const res = flowchartPlugin.actions!.find((a) => a.id === actionId)!.run(source, refs);
  return res && { ...res, after: apply(source, res.change) };
}

function set(source: string, kind: string | null, id: string, field: string, value: string) {
  const spec = flowchartPlugin.setProperty!(source, kind ? { kind, id } : null, field, value);
  return spec === null ? null : apply(source, spec);
}

const field = (source: string, kind: string | null, id: string, fieldId: string) =>
  flowchartPlugin.inspect!(source, kind ? { kind, id } : null).find((f) => f.id === fieldId)!;

interface FlowDb {
  getSubGraphs(): { id: string; title: string; nodes: string[]; dir?: string }[];
  getVertices(): Map<string, { id: string; text: string; type?: string; styles: string[]; classes: string[] }>;
  getEdges(): { start: string; end: string; style?: string[] }[];
}

/** mermaid が読み取った図の中身 */
async function db(source: string): Promise<FlowDb> {
  await mermaid.parse(source);
  const api = mermaid.mermaidAPI as unknown as { getDiagramFromText(t: string): Promise<{ db: FlowDb }> };
  return (await api.getDiagramFromText(source)).db;
}

const membersOf = async (source: string, sg: string) => (await db(source)).getSubGraphs().find((s) => s.id === sg)?.nodes ?? [];
const edgeStyle = async (source: string, from: string, to: string) =>
  ((await db(source)).getEdges().find((e) => e.start === from && e.end === to)?.style ?? []).join(';');

const SRC = `flowchart LR
    %% コメントは残る
    A[開始] --> B
    B -->|はい| C@{ shape: doc, label: "書類" }
    B --> D
    C & D --> E((終了))
    subgraph S1 [外側]
        F --> G
        H
    end
    E --> F
    classDef hot fill:#f96
    linkStyle 5 stroke:#00f
`;

describe('flowchart: 読み取り', () => {
  it('サブグラフ・@{} のラベル・所属を読む', async () => {
    const doc = parseFlowchart(SRC);
    expect(doc.subgraphs.map((s) => [s.id, SRC.slice(s.title!.from, s.title!.to), s.end?.text.trim()])).toEqual([['S1', '外側', 'end']]);
    const c = doc.statements[1].groups[1][0];
    expect(SRC.slice(c.meta!.label!.from, c.meta!.label!.to)).toBe('書類');
    expect(subgraphOf(doc, 'H')?.id).toBe('S1');
    expect(subgraphOf(doc, 'F')?.id).toBe('S1');
    expect(subgraphOf(doc, 'E')).toBeNull();
    expect(doc.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AB', 'BC', 'BD', 'CE', 'DE', 'FG', 'EF']);
    // 前提: mermaid も同じように読む
    expect(await membersOf(SRC, 'S1')).toEqual(expect.arrayContaining(['F', 'G', 'H']));
    expect(await edgeStyle(SRC, 'F', 'G')).toContain('#00f');
  });

  it('引用符の中の } で @{} を終わらせない', () => {
    const src = 'flowchart LR\n  A@{ shape: doc, label: "a } b" } --> B';
    const a = parseFlowchart(src).statements[0].groups[0][0];
    expect(src.slice(a.meta!.label!.from, a.meta!.label!.to)).toBe('a } b');
    expect(parseFlowchart(src).edges).toHaveLength(1);
  });
});

describe('flowchart: linkStyle の番号を保つ', () => {
  it('エッジを消すと、後ろの番号を詰め、消したエッジだけの行は消す', async () => {
    const src = SRC.replace('linkStyle 5', 'linkStyle 0 stroke:#f00\n    linkStyle 5');
    const r = run('delete', src, [{ kind: 'edge', id: '0' }])!;
    expect(r.after).not.toContain('linkStyle 0 stroke:#f00');
    expect(r.after).toContain('linkStyle 4 stroke:#00f');
    expect(await edgeStyle(r.after, 'F', 'G')).toContain('#00f');
  });

  it('途中にエッジを足すと、後ろの番号を進める（カンマ区切りも default も扱う）', async () => {
    const src = SRC.replace('linkStyle 5 stroke:#00f', 'linkStyle 0,5 stroke:#00f\n    linkStyle default stroke-width:2px');
    const r = run('add-child', src, [{ kind: 'node', id: 'A' }])!;
    expect(r.after).toContain('    A[開始] --> B\n    A --> N1[新しいノード]\n');
    expect(r.after).toContain('linkStyle 0,6 stroke:#00f');
    expect(r.after).toContain('linkStyle default stroke-width:2px');
    expect(await edgeStyle(r.after, 'F', 'G')).toContain('#00f');
  });

  it('ノードを消して範囲外になる番号を残さない', async () => {
    const src = 'flowchart LR\n  A --> B\n  B --> C\n  linkStyle 1 stroke:#f00\n';
    const r = run('delete', src, [{ kind: 'node', id: 'A' }])!;
    expect(r.after).toContain('linkStyle 0 stroke:#f00');
    expect(await edgeStyle(r.after, 'B', 'C')).toContain('#f00');
  });
});

describe('flowchart: エッジ', () => {
  it('先を変える（単純な文は ID だけ。番号は変わらない）', async () => {
    const after = set(SRC, 'edge', '2', 'to', 'A')!;
    expect(after).toContain('    B --> A\n');
    expect(edgeInfo(after, 2)).toMatchObject({ from: 'B', to: 'A' });
    await expect(mermaid.parse(after)).resolves.toBeTruthy();
  });

  it('& でまとめた文の元を変えると、その文を 1 本ずつに書き直す（番号は変わらない）', async () => {
    const after = set(SRC, 'edge', '3', 'from', 'A')!;
    expect(after).toContain('    A --> E((終了))\n    D --> E\n');
    expect(edgeInfo(after, 3)).toMatchObject({ from: 'A', to: 'E' });
    expect(edgeInfo(after, 4)).toMatchObject({ from: 'D', to: 'E' });
    expect(await edgeStyle(after, 'F', 'G')).toContain('#00f');
  });

  it('向きを反転しても、ノードの定義（ラベル）は残る', async () => {
    const r = run('reverse', SRC, [{ kind: 'edge', id: '0' }])!;
    expect(r.after).toContain('    B --> A[開始]\n');
    expect((await db(r.after)).getVertices().get('A')!.text).toBe('開始');
    // 連なった文（A --> B --> C）の途中の反転
    const chain = 'flowchart LR\n  A[a] --> B[b] --> C[c]\n';
    const c = run('reverse', chain, [{ kind: 'edge', id: '1' }])!;
    expect(edgeInfo(c.after, 1)).toMatchObject({ from: 'C', to: 'B' });
    expect([...(await db(c.after)).getVertices().values()].map((v) => v.text).sort()).toEqual(['a', 'b', 'c']);
  });

  it('線の種類と長さ', async () => {
    expect(arrowParts('-->')).toEqual({ kind: '-->', length: 1 });
    expect(arrowParts('---->')).toEqual({ kind: '-->', length: 3 });
    expect(arrowParts('-..->')).toEqual({ kind: '-.->', length: 2 });
    expect(arrowParts('====')).toEqual({ kind: '===', length: 2 });
    expect(arrowParts('<-->')).toEqual({ kind: '<-->', length: 1 });
    expect(buildArrow('-.->', 3)).toBe('-...->');
    expect(buildArrow('~~~', 2)).toBe('~~~~');
    const long = set(SRC, 'edge', '0', 'length', '2')!;
    expect(long).toContain('A[開始] ---> B');
    const dotted = set(long, 'edge', '0', 'arrow', '-.->')!;
    expect(dotted).toContain('A[開始] -..-> B');
    expect(field(dotted, 'edge', '0', 'length').value).toBe('2');
    const hidden = set(SRC, 'edge', '2', 'arrow', '~~~')!;
    for (const s of [long, dotted, hidden]) await expect(mermaid.parse(s)).resolves.toBeTruthy();
  });

  it('間にノードを挟む（ラベルは前のエッジに残る）', async () => {
    const r = run('insert-node', SRC, [{ kind: 'edge', id: '1' }])!;
    expect(r.after).toContain('B -->|はい| N1[新しいノード] --> C@{ shape: doc, label: "書類" }');
    expect(r.focus).toEqual({ kind: 'node', id: 'N1' });
    expect(r.after).toContain('linkStyle 6 stroke:#00f');
    expect(await edgeStyle(r.after, 'F', 'G')).toContain('#00f');
  });

  it('線の色と太さ（linkStyle の行を足す・共有の行から分ける）', async () => {
    const red = set(SRC, 'edge', '0', 'stroke', '#f00')!;
    expect(red).toContain('linkStyle 0 stroke:#f00');
    expect(await edgeStyle(red, 'A', 'B')).toContain('#f00');
    const shared = SRC.replace('linkStyle 5', 'linkStyle 0,5');
    const split = set(shared, 'edge', '0', 'stroke-width', '4px')!;
    expect(split).toContain('linkStyle 5 stroke:#00f');
    expect(split).toContain('linkStyle 0 stroke:#00f,stroke-width:4px');
    expect(field(SRC, 'edge', '5', 'stroke').value).toBe('#00f');
    expect(set(SRC, 'edge', '5', 'stroke', '')).not.toContain('linkStyle');
  });
});

describe('flowchart: ノードの形とラベル', () => {
  it('括弧で書けない形を選ぶと @{} に書き直し、@{} のノードは shape: だけを変える', async () => {
    const doc = apply(SRC, setShape(SRC, 'A', '@doc')!);
    expect(doc).toContain('A@{ shape: doc, label: "開始" } --> B');
    expect((await db(doc)).getVertices().get('A')).toMatchObject({ text: '開始', type: 'doc' });
    const cyl = apply(SRC, setShape(SRC, 'C', 'cylinder')!);
    expect(cyl).toContain('C@{ shape: cyl, label: "書類" }');
    expect(shapeValue(cyl, 'C')).toBe('cylinder');
    expect(shapeValue(SRC, 'C')).toBe('@doc');
    // 既存の括弧の形はこれまでどおり
    expect(apply(SRC, setShape(SRC, 'E', 'rhombus')!)).toContain('E{終了}');
  });

  it('mermaid 12.2 で、選択肢のすべての新しい形を描ける（構文として通る）', async () => {
    const shapes = field(SRC, 'node', 'B', 'shape').options!.filter((o) => o.value.startsWith('@'));
    expect(shapes.length).toBeGreaterThan(30);
    for (const s of shapes) {
      const src = apply(SRC, setShape(SRC, 'B', s.value)!);
      expect((await db(src)).getVertices().get('B')!.type, s.value).toBe(s.value.slice(1));
    }
  });

  it('ラベルの無いノードにラベルを付ける（@{} では label: を足す）', async () => {
    expect(set(SRC, 'node', 'B', 'label', 'ぶ')).toContain('    A[開始] --> B[ぶ]\n');
    const src = 'flowchart LR\n  X@{ shape: cyl }\n';
    const after = set(src, 'node', 'X', 'label', 'DB')!;
    expect(after).toBe('flowchart LR\n  X@{ shape: cyl, label: "DB" }\n');
    expect((await db(after)).getVertices().get('X')).toMatchObject({ text: 'DB', type: 'cyl' });
    expect(set(SRC, 'node', 'C', 'label', '請求書')).toContain('label: "請求書"');
  });
});

describe('flowchart: スタイルとクラス', () => {
  it('塗り・枠線を 1 行の style にまとめ、空にしたら行を消す', async () => {
    const fill = set(SRC, 'node', 'A', 'fill', '#ff0')!;
    expect(fill).toContain('    style A fill:#ff0\n');
    const both = set(fill, 'node', 'A', 'stroke', '#333')!;
    expect(both).toContain('style A fill:#ff0,stroke:#333');
    expect(field(both, 'node', 'A', 'stroke').value).toBe('#333');
    expect((await db(both)).getVertices().get('A')!.styles).toEqual(['fill:#ff0', 'stroke:#333']);
    expect(set(set(both, 'node', 'A', 'fill', '')!, 'node', 'A', 'stroke', '')).toBe(SRC);
    expect(set(SRC, 'node', 'A', 'fill', 'a,b')).toBeNull();
  });

  it('クラスを付け替える（:::name は名前だけ、無ければ class 行を足す）', async () => {
    const added = set(SRC, 'node', 'B', 'class', 'hot')!;
    expect(added).toContain('    class B hot\n');
    expect((await db(added)).getVertices().get('B')!.classes).toContain('hot');
    expect(field(added, 'node', 'B', 'class').value).toBe('hot');
    const inline = 'flowchart LR\n  A:::hot --> B\n  classDef hot fill:#f96\n  classDef cold fill:#69f\n';
    expect(set(inline, 'node', 'A', 'class', 'cold')).toContain('A:::cold --> B');
    expect(set(inline, 'node', 'A', 'class', '')).toContain('  A --> B\n');
  });

  it('クラスの定義は補助の表で編集する（最初に開くタブはプロパティのまま）', () => {
    expect(flowchartPlugin.tables?.[0].secondary).toBe(true);
  });
});

describe('flowchart: サブグラフ', () => {
  it('ID を変えると subgraph の行とエッジ・style も変わる', async () => {
    const src = SRC.replace('    E --> F\n', '    E --> F\n    E --> S1\n    style S1 fill:#eee\n');
    const after = set(src, 'subgraph', 'S1', 'id', 'T1')!;
    expect(after).toContain('subgraph T1 [外側]');
    expect(after).toContain('E --> T1');
    expect(after).toContain('style T1 fill:#eee');
    expect(await membersOf(after, 'T1')).toEqual(expect.arrayContaining(['F', 'G', 'H']));
    expect(set(src, 'subgraph', 'S1', 'id', 'A')).toBeNull();
  });

  it('題名・中の向きを変える', async () => {
    expect(set(SRC, 'subgraph', 'S1', 'title', '中')).toContain('subgraph S1 [中]');
    expect(set(SRC, 'subgraph', 'S1', 'title', '')).toContain('    subgraph S1\n');
    expect(set('flowchart LR\n  subgraph S\n    A\n  end\n', 'subgraph', 'S', 'title', '題')).toContain('subgraph S [題]');
    const dir = set(SRC, 'subgraph', 'S1', 'direction', 'TB')!;
    expect(dir).toContain('    subgraph S1 [外側]\n        direction TB\n        F --> G');
    expect((await db(dir)).getSubGraphs()[0].dir).toBe('TB');
    expect(set(dir, 'subgraph', 'S1', 'direction', '')).toBe(SRC);
  });

  it('枠を外すと中身は残り、中身ごと消すと linkStyle の番号も直す', async () => {
    const unwrap = run('unwrap', SRC, [{ kind: 'subgraph', id: 'S1' }])!;
    expect(unwrap.after).toContain('    C & D --> E((終了))\n        F --> G\n        H\n    E --> F');
    expect((await db(unwrap.after)).getSubGraphs()).toHaveLength(0);
    const all = run('delete-subgraph', SRC, [{ kind: 'subgraph', id: 'S1' }])!;
    expect(all.after).not.toContain('F --> G');
    expect(all.after).not.toContain('linkStyle');
    await expect(mermaid.parse(all.after)).resolves.toBeTruthy();
  });

  it('サブグラフを足す・中にノードを足す', async () => {
    const add = run('add-subgraph', SRC, [])!;
    expect(add.after).toContain('    linkStyle 5 stroke:#00f\n    subgraph G1 [新しいグループ]\n    end\n');
    expect(add.focus).toEqual({ kind: 'subgraph', id: 'G1' });
    const inside = run('add-inside', SRC, [{ kind: 'subgraph', id: 'S1' }])!;
    expect(inside.after).toContain('        H\n        N1[新しいノード]\n    end');
    expect(await membersOf(inside.after, 'S1')).toContain('N1');
    await expect(mermaid.parse(add.after)).resolves.toBeTruthy();
  });

  it('ノードをサブグラフにまとめる（サブグラフの中のノードは、その中に入れ子で作る）', async () => {
    const top = run('group', SRC, [{ kind: 'node', id: 'A' }])!;
    expect(await membersOf(top.after, 'G1')).toEqual(['A']);
    const nested = run('group', SRC, [{ kind: 'node', id: 'H' }])!;
    expect(nested.after).toContain('        H\n        subgraph G1 [新しいグループ]\n            H\n        end\n    end');
    expect(await membersOf(nested.after, 'G1')).toEqual(['H']);
  });

  it('所属を変える（ノードだけの行を移す。エッジの一部なら変えられない）', async () => {
    const out = set(SRC, 'node', 'H', 'subgraph', '')!;
    expect(await membersOf(out, 'S1')).not.toContain('H');
    expect(subgraphOf(parseFlowchart(out), 'H')).toBeNull();
    const into = set(SRC, 'node', 'A', 'subgraph', 'S1')!;
    expect(into).toContain('        H\n        A\n    end');
    expect(await membersOf(into, 'S1')).toContain('A');
    expect(canMoveNode(SRC, 'F')).toBe(false);
    expect(field(SRC, 'node', 'F', 'subgraph').readonly).toBe(true);
    expect(set(SRC, 'node', 'F', 'subgraph', '')).toBeNull();
  });

  it('接続はサブグラフの外に書くので、接続先がサブグラフに入らない', async () => {
    const r = run('connect', SRC, [{ kind: 'node', id: 'F' }, { kind: 'node', id: 'A' }])!;
    // F が最後に出てくるサブグラフの外の行（E --> F）の後ろに書く
    expect(r.after).toContain('    E --> F\n    F --> A\n');
    expect(await membersOf(r.after, 'S1')).not.toContain('A');
    const sg = run('connect', SRC, [{ kind: 'subgraph', id: 'S1' }, { kind: 'node', id: 'A' }])!;
    expect(sg.after).toContain('S1 --> A');
    await expect(mermaid.parse(sg.after)).resolves.toBeTruthy();
  });
});

describe('flowchart: 図全体', () => {
  it('題名を frontmatter に書く（既にあればその中を書き換える）', async () => {
    const titled = set(SRC, null, '', 'title', '受付の流れ')!;
    expect(titled.startsWith('---\ntitle: 受付の流れ\n---\nflowchart LR')).toBe(true);
    expect(field(titled, null, '', 'title').value).toBe('受付の流れ');
    expect(set(titled, null, '', 'title', '変更')).toContain('---\ntitle: 変更\n---\n');
    // 題名だけの frontmatter は、題名を消すと --- ごと消える
    expect(set(titled, null, '', 'title', '')).toBe(SRC);
    const withConfig = '---\nconfig:\n  look: classic\n---\n' + SRC;
    const configTitled = set(withConfig, null, '', 'title', 'T')!;
    expect(configTitled).toContain('---\ntitle: T\nconfig:\n  look: classic\n---\n');
    expect(set(configTitled, null, '', 'title', '')).toBe(withConfig);
    for (const s of [titled, configTitled, withConfig]) await expect(mermaid.parse(s)).resolves.toBeTruthy();
  });
});
