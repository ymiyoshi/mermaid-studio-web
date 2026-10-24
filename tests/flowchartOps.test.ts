// @vitest-environment jsdom
// mermaid.parse は flowchart で DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { parseFlowchart, nodeDefinition } from '../src/plugins/flowchartSyntax';
import { deleteEdge, deleteNode, edgeInfo, getDirection, renameNode, setArrow, setDirection, setEdgeLabel, setShape } from '../src/plugins/flowchartOps';

const apply = (source: string, spec: ChangeSpec | null) => {
  expect(spec).not.toBeNull();
  return ChangeSet.of(spec!, source.length).apply(Text.of(source.split('\n'))).toString();
};

const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();

const SRC = `flowchart TD
    %% コメント
    A[開始] --> B{条件?}
    B -->|はい| C(処理) --> D[終了]
    B -- いいえ --> D
    A --> E & F
    class B,C hot
    style C fill:#f9f
`;

describe('flowchart の文を読む', () => {
  it('エッジを mermaid と同じ順に数える', () => {
    const doc = parseFlowchart(SRC);
    expect(doc.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['A-B', 'B-C', 'C-D', 'B-D', 'A-E', 'A-F']);
    expect(doc.unknown).toHaveLength(0);
  });

  it('ラベル・矢印・形を位置つきで読む', () => {
    const doc = parseFlowchart(SRC);
    const c = nodeDefinition(doc, 'C')!;
    expect(SRC.slice(c.shape!.labelFrom, c.shape!.labelTo)).toBe('処理');
    expect(c.shape!.open).toBe('(');
    expect(edgeInfo(SRC, 1)!.label).toBe('はい');
    expect(edgeInfo(SRC, 3)).toMatchObject({ arrow: '-->', label: 'いいえ' });
  });

  it('ID の途中のハイフンと矢印を区別する', () => {
    const doc = parseFlowchart('flowchart LR\n  my-node-->other\n  a-.->b');
    expect(doc.edges.map((e) => `${e.from}|${e.to}`)).toEqual(['my-node|other', 'a|b']);
    expect(doc.edges.map((e) => edgeInfo('flowchart LR\n  my-node-->other\n  a-.->b', e.index)!.arrow)).toEqual(['-->', '-.->']);
  });
});

describe('ノードの削除', () => {
  it('エッジの途中のノードを消すと、文が分かれ、定義のあるノードは残る', async () => {
    const out = apply(SRC, deleteNode(SRC, 'C') as ChangeSpec);
    expect(out).not.toMatch(/\bC\b/);
    expect(out).toContain('    D[終了]\n');
    expect(out).toContain('    class B hot\n');
    expect(out).not.toContain('style C');
    expect(out).toContain('    %% コメント\n');
    await valid(out);
  });

  it('& でまとめたノードからも取り除く', async () => {
    const out = apply(SRC, deleteNode(SRC, 'E') as ChangeSpec);
    expect(out).toContain('    A --> F\n');
    await valid(out);
  });

  it('定義が無く他にも出てこないノードは、消すとつながっていた先がひとりで残る', async () => {
    const src = 'flowchart LR\n  X --> Y\n';
    const out = apply(src, deleteNode(src, 'X') as ChangeSpec);
    expect(out).toBe('flowchart LR\n  Y\n');
    await valid(out);
  });
});

describe('エッジの削除', () => {
  it('チェーンの途中のエッジを消すと 2 つの文に分かれる', async () => {
    const out = apply(SRC, deleteEdge(SRC, 1));
    expect(out).toContain('    C(処理) --> D[終了]\n');
    expect(out).not.toContain('はい');
    await valid(out);
  });

  it('& のエッジは 1 本ずつに書き直して消す', async () => {
    const out = apply(SRC, deleteEdge(SRC, 4));
    expect(out).toContain('    A --> F\n');
    expect(out).not.toMatch(/A --> E/);
    expect(out).toContain('E');
    await valid(out);
  });

  it('1 本だけの行は行ごと消える（他に出てこないノードはひとりで残る）', async () => {
    const src = 'flowchart LR\n  A[a] --> B[b]\n  B --> C\n  A --> D[d]\n  D --> B\n';
    let out = apply(src, deleteEdge(src, 3));
    expect(out).toBe('flowchart LR\n  A[a] --> B[b]\n  B --> C\n  A --> D[d]\n');
    out = apply(src, deleteEdge(src, 1));
    expect(out).toBe('flowchart LR\n  A[a] --> B[b]\n  C\n  A --> D[d]\n  D --> B\n');
    await valid(out);
  });
});

describe('形・矢印・ラベル・向き', () => {
  it('形を変えてもラベルは残る', async () => {
    const out = apply(SRC, setShape(SRC, 'C', 'cylinder') as ChangeSpec);
    expect(out).toContain('C[(処理)]');
    await valid(out);
  });

  it('ラベルの無いノードに形を付けると ID がラベルになる', async () => {
    const src = 'flowchart LR\n  A --> B\n';
    const out = apply(src, setShape(src, 'B', 'circle') as ChangeSpec);
    expect(out).toBe('flowchart LR\n  A --> B((B))\n');
    await valid(out);
  });

  it('矢印の種類を変える（ラベルが矢印の中にある形も）', async () => {
    let out = apply(SRC, setArrow(SRC, 1, '-.->'));
    expect(out).toContain('B -.->|はい| C(処理)');
    out = apply(SRC, setArrow(SRC, 3, '==>'));
    expect(out).toContain('B ==>|いいえ| D');
    await valid(out);
  });

  it('エッジのラベルを付ける・変える・消す', async () => {
    let out = apply(SRC, setEdgeLabel(SRC, 0, 'スタート'));
    expect(out).toContain('A[開始] -->|スタート| B{条件?}');
    out = apply(SRC, setEdgeLabel(SRC, 1, ''));
    expect(out).toContain('B --> C(処理)');
    out = apply(SRC, setEdgeLabel(SRC, 3, ''));
    expect(out).toContain('B --> D');
    await valid(out);
  });

  it('向きを変える', async () => {
    expect(getDirection(SRC)).toBe('TD');
    expect(apply(SRC, setDirection(SRC, 'LR')).startsWith('flowchart LR\n')).toBe(true);
    const out = apply('graph\n  A --> B', setDirection('graph\n  A --> B', 'RL'));
    expect(out.startsWith('graph RL\n')).toBe(true);
    await valid(out);
  });
});

describe('ID の変更', () => {
  it('参照と class / style の行をすべて書き換える', async () => {
    const out = apply(SRC, renameNode(SRC, 'C', 'Work') as ChangeSpec);
    expect(out).toContain('B -->|はい| Work(処理) --> D[終了]');
    expect(out).toContain('class B,Work hot');
    expect(out).toContain('style Work fill:#f9f');
    await valid(out);
  });

  it('既にある ID や不正な ID には変えない', () => {
    expect(renameNode(SRC, 'C', 'D')).toBeNull();
    expect(renameNode(SRC, 'C', 'a b')).toBeNull();
  });
});
