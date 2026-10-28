// @vitest-environment jsdom
// 設計書 §5.3: SVG と ソースの対応付け（svgMapper）の回帰テスト。
// fixtures/rendered-svg.json は、固定している mermaid（package.json の版）がブラウザで実際に描いた SVG。
// mermaid の版を上げたら、開発サーバーで tests/fixtures/capture.js の手順（README）を使って作り直し、このテストが通ることを確かめる。
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/rendered-svg.json';
import { pluginFor } from '../src/plugins/registry';
import { parseFlowchart } from '../src/plugins/flowchartSyntax';
import { parseMessages } from '../src/plugins/sequence';
import { parseTransitions } from '../src/plugins/stateDiagram';
import { parseRelationships } from '../src/plugins/erDiagram';
import { matchInOrder, idFromSvg, edgeLabelFor } from '../src/plugins/svg';
import type { DiagramTarget } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;

// 図種の名前（mermaid.parse の diagramType）
const TYPES: Record<string, string> = {
  flowchart: 'flowchart-v2',
  'flowchart-subgraph': 'flowchart-v2',
  'flowchart-full': 'flowchart-v2',
  sequence: 'sequence',
  'sequence-blocks': 'sequence',
  'sequence-full': 'sequence',
  class: 'classDiagram',
  state: 'stateDiagram',
  er: 'er',
  mindmap: 'mindmap',
  kanban: 'kanban',
  gantt: 'gantt',
  pie: 'pie',
  gitgraph: 'gitGraph',
  journey: 'journey',
  timeline: 'timeline',
  quadrant: 'quadrantChart',
  usecase: 'usecase',
  architecture: 'architecture',
  'architecture-full': 'architecture',
  c4: 'c4',
  sankey: 'sankey',
  requirement: 'requirement',
  xychart: 'xychart',
  block: 'block',
  swimlane: 'swimlane',
  agentflow: 'agentflow',
  ishikawa: 'ishikawa',
  'ishikawa-full': 'ishikawa',
  treeview: 'treeView',
  'treeview-full': 'treeView',
  venn: 'venn',
  'venn-full': 'venn',
  cynefin: 'cynefin',
  wardley: 'wardley',
  'wardley-full': 'wardley',
  eventmodeling: 'eventmodeling',
  railroad: 'railroadEbnf',
  'railroad-call': 'railroad',
  'railroad-abnf': 'railroadAbnf',
  'railroad-peg': 'railroadPeg',
  packet: 'packet',
  radar: 'radar',
  treemap: 'treemap',
};

function load(id: string): { svg: SVGSVGElement; source: string; targets: DiagramTarget[] } {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  const svg = document.querySelector('svg')!;
  return { svg, source: f.source, targets: pluginFor(TYPES[id]).mapTargets(svg, f.source) };
}

const refs = (targets: DiagramTarget[], kind: string) => targets.filter((x) => x.ref?.kind === kind).map((x) => x.ref!.id);
const labelAt = (source: string, t: DiagramTarget) => source.slice(t.range!.from, t.range!.to);

describe('すべての図種で共通に成り立つこと', () => {
  for (const id of Object.keys(TYPES)) {
    it(`${id}: 参照は重複せず、ラベルの範囲はソース中の同じ文字列を指す`, () => {
      const { source, targets } = load(id);
      expect(targets.length).toBeGreaterThan(0);
      const keys = targets.filter((x) => x.ref).map((x) => `${x.ref!.kind}:${x.ref!.id}`);
      // どの図種も、図の要素を選んで編集できる（ラベルの書き換えだけの汎用の対応付けで終わっていない）
      expect(keys.length, '図から選べる要素が無い').toBeGreaterThan(0);
      // 同じ要素が上下に 2 回描かれる図（sequence の参加者）は同じ参照を持つ
      if (!id.startsWith('sequence')) expect(new Set(keys).size).toBe(keys.length);
      for (const t of targets) {
        if (!t.range) continue;
        expect(t.range.from).toBeGreaterThanOrEqual(0);
        expect(t.range.to).toBeLessThanOrEqual(source.length);
        // 描画されたラベルと、ソースのラベルが一致する（エッジのラベルが無いものは空）
        if (t.label) expect(t.label.replace(/\s+/g, ' ').trim()).toBe(labelAt(source, t).replace(/\s+/g, ' ').trim());
      }
    });
  }
});

describe('flowchart', () => {
  it('ノードとエッジを ID と番号で対応付ける', () => {
    const { source, targets } = load('flowchart');
    expect(refs(targets, 'node').sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(refs(targets, 'edge')).toEqual(['0', '1', '2', '3', '4']);
    const yes = targets.find((x) => x.ref?.kind === 'edge' && x.ref.id === '1')!;
    expect(labelAt(source, yes)).toBe('はい');
    // エッジには太い当たり判定の線と、ラベルが当たり判定として付く
    expect(yes.hits).toHaveLength(2);
    expect(yes.hits![0].getAttribute('class')).toBe('mmd-hit');
  });

  it('サブグラフの中と外のエッジも、端点でソースのエッジに対応付ける', () => {
    const { source, targets } = load('flowchart-subgraph');
    const doc = parseFlowchart(source);
    const edges = targets.filter((x) => x.ref?.kind === 'edge');
    expect(edges).toHaveLength(doc.edges.length);
    for (const t of edges) {
      const e = doc.edges[Number(t.ref!.id)];
      expect(t.el.getAttribute('data-id')).toMatch(new RegExp(`^L_${e.from}_${e.to}_`));
    }
  });

  it('全部入り: サブグラフ（入れ子・題名だけの書き方）と、@{} のラベルを対応付ける', () => {
    const { source, targets } = load('flowchart-full');
    expect(refs(targets, 'subgraph').sort()).toEqual(['S1', 'S2', '日本語の題']);
    const sg = (id: string) => targets.find((x) => x.ref?.kind === 'subgraph' && x.ref.id === id)!;
    expect(labelAt(source, sg('S1'))).toBe('外側');
    expect(labelAt(source, sg('日本語の題'))).toBe('日本語の題');
    const node = (id: string) => targets.find((x) => x.ref?.kind === 'node' && x.ref.id === id)!;
    expect(labelAt(source, node('C'))).toBe('書類 {1}');
    expect(labelAt(source, node('D'))).toBe('記録');
    // 見えない線（~~~）・サブグラフへの線も含め、すべてのエッジを対応付ける
    expect(refs(targets, 'edge')).toHaveLength(parseFlowchart(source).edges.length);
  });

  it('全部入り: ラベルの無いノード・エッジ・サブグラフは、ラベルを差し込む位置を持つ', () => {
    const { source, targets } = load('flowchart-full');
    const node = targets.find((x) => x.ref?.kind === 'node' && x.ref.id === 'B')!;
    expect(node.range).toBeNull();
    expect(source.slice(node.insertAt!.at - 1, node.insertAt!.at)).toBe('B');
    expect(node.insertAt).toMatchObject({ prefix: '[', suffix: ']' });
    const edge = targets.find((x) => x.ref?.kind === 'edge' && x.ref.id === '0')!;
    expect(source.slice(edge.insertAt!.at - 3, edge.insertAt!.at)).toBe('-->');
    // 見えない線にはラベルを付けない
    const hidden = targets.find((x) => x.ref?.kind === 'edge' && parseFlowchart(source).edges[Number(x.ref.id)].from === 'E')!;
    expect(hidden.insertAt).toBeUndefined();
    const s2 = targets.find((x) => x.ref?.kind === 'subgraph' && x.ref.id === 'S2')!;
    expect(s2.insertAt).toBeUndefined(); // 題名がある
  });
});

describe('sequence', () => {
  it('参加者は上下の箱の両方、メッセージは本文の範囲を持つ', () => {
    const { source, targets } = load('sequence');
    expect(refs(targets, 'participant').sort()).toEqual(['S', 'S', 'U', 'U']);
    const msgs = targets.filter((x) => x.ref?.kind === 'message');
    expect(msgs.map((m) => labelAt(source, m))).toEqual(['リクエスト', 'レスポンス']);
  });

  it('alt / loop / Note / 自分へのメッセージがあっても、端点で正しく対応付ける', () => {
    const { source, targets } = load('sequence-blocks');
    const parsed = parseMessages(source);
    const msgs = targets.filter((x) => x.ref?.kind === 'message');
    expect(msgs).toHaveLength(parsed.length);
    for (const t of msgs) {
      const m = parsed[Number(t.ref!.id)];
      expect(t.el.getAttribute('data-from')).toBe(m.from);
      expect(t.el.getAttribute('data-to')).toBe(m.to);
    }
  });
});

describe('sequence（全部入り）', () => {
  it('参加者は種類（actor・boundary・database・後から作る参加者）によらず対応付ける', () => {
    const { targets } = load('sequence-full');
    expect([...new Set(refs(targets, 'participant'))].sort()).toEqual(['D', 'N', 'U', 'W']);
  });

  it('表示名の無い宣言（@{} つきも）は、「 as 表示名」を差し込む位置を持つ', () => {
    const { source, targets } = load('sequence-full');
    const d = targets.find((x) => x.ref?.kind === 'participant' && x.ref.id === 'D')!;
    expect(d.range).toBeNull();
    expect(source.slice(d.insertAt!.at - 2, d.insertAt!.at)).toBe(' }');
    expect(d.insertAt!.prefix).toBe(' as ');
    const u = targets.find((x) => x.ref?.kind === 'participant' && x.ref.id === 'U')!;
    expect(u.insertAt).toBeUndefined(); // 表示名がある
  });

  it('半分の矢印を含む全メッセージを、端点の合うソースの行に対応付ける', () => {
    const { source, targets } = load('sequence-full');
    const parsed = parseMessages(source);
    const msgs = targets.filter((x) => x.ref?.kind === 'message');
    expect(msgs).toHaveLength(parsed.length);
    expect(msgs.map((m) => labelAt(source, m))).toEqual(parsed.map((m) => source.slice(m.text.from, m.text.to)));
  });

  it('注釈は本文、枠は種類と条件、区切りは枠の中の順で対応付ける', () => {
    const { source, targets } = load('sequence-full');
    const notes = targets.filter((x) => x.ref?.kind === 'note');
    expect(notes.map((n) => labelAt(source, n))).toEqual(['左の注釈', '右の注釈']);
    const blocks = targets.filter((x) => x.ref?.kind === 'block');
    // 内側の枠から順に描かれる
    expect(blocks.map((b) => labelAt(source, b))).toEqual(['在庫あり', '並行1', '決済', '中止', '内側', '外側']);
    const sections = targets.filter((x) => x.ref?.kind === 'section');
    expect(sections.map((s) => labelAt(source, s))).toEqual(['並行2', '失敗']);
  });

  it('通し番号の数字は、どの要素にも対応付けない', () => {
    const { targets } = load('sequence-full');
    expect(targets.some((x) => x.labelEl.classList.contains('sequenceNumber'))).toBe(false);
  });
});

describe('class / state / ER', () => {
  it('class: クラスと関係', () => {
    const { targets } = load('class');
    expect(refs(targets, 'class').sort()).toEqual(['Animal', 'Dog']);
    expect(refs(targets, 'relation')).toEqual(['0']);
  });

  it('state: 状態（開始・終了の黒丸は除く）と遷移', () => {
    const { source, targets } = load('state');
    expect(refs(targets, 'state').sort()).toEqual(['実行中', '待機']);
    expect(refs(targets, 'transition')).toHaveLength(parseTransitions(source).length);
  });

  it('ER: エンティティとリレーション（ラベルの範囲つき）', () => {
    const { source, targets } = load('er');
    expect(refs(targets, 'entity').sort()).toEqual(['CUSTOMER', 'LINE_ITEM', 'ORDER']);
    const rels = targets.filter((x) => x.ref?.kind === 'relationship');
    expect(rels.map((r) => labelAt(source, r))).toEqual(parseRelationships(source).map((r) => r.v.label));
  });
});

describe('mindmap / kanban', () => {
  it('mindmap: すべてのトピックを行の順に対応付ける', () => {
    const { source, targets } = load('mindmap');
    const topics = targets.filter((x) => x.ref?.kind === 'topic');
    expect(topics.map((x) => labelAt(source, x))).toEqual(['Mermaid Studio', '表示', '全図種', '編集', 'テキスト', '図', '履歴', 'ツリー', '永続化']);
  });

  it('kanban: 列とカード', () => {
    const { targets } = load('kanban');
    expect(refs(targets, 'column').sort()).toEqual(['doing', 'done', 'todo']);
    expect(refs(targets, 'card').sort()).toEqual(['t1', 't2', 't3', 't4']);
  });
});

describe('データ系の図種（汎用の対応付け）', () => {
  it('pie: 凡例のラベルをソースのスライスに対応付ける', () => {
    const { source, targets } = load('pie');
    const labels = targets.filter((x) => x.range).map((x) => labelAt(source, x));
    expect(labels).toEqual(expect.arrayContaining(['Chrome', 'Safari', 'Firefox', 'その他']));
  });

  it('gantt: タスク名をソースに対応付ける', () => {
    const { source, targets } = load('gantt');
    const labels = targets.filter((x) => x.range).map((x) => labelAt(source, x));
    expect(labels).toEqual(expect.arrayContaining(['要件定義', '基本設計']));
  });
});

describe('SVG の補助関数', () => {
  it('idFromSvg は連番の前までを ID として取り出す', () => {
    const el = document.createElement('g');
    el.id = 'mmd-render-3-classId-My_Class-12';
    expect(idFromSvg(el, 'classId')).toBe('My_Class');
    expect(idFromSvg(el, 'entity')).toBeNull();
  });

  it('edgeLabelFor は同じ data-id のラベルを返す', () => {
    const { svg } = load('flowchart');
    const path = svg.querySelector('path[data-id="L_B_C_0"]')!;
    expect(edgeLabelFor(svg, path)?.textContent).toBe('はい');
  });

  it('matchInOrder は同じ端点を出てくる順に割り当て、合わないものは -1', () => {
    const els = ['a', 'b', 'a', 'z'].map((x) => {
      const e = document.createElement('i');
      e.dataset.k = x;
      return e;
    });
    expect(matchInOrder(els, ['a', 'a', 'b'], (el, v) => (el as HTMLElement).dataset.k === v)).toEqual([0, 2, 1, -1]);
  });
});
