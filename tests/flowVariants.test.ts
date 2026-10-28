// @vitest-environment jsdom
// フローチャートと同じ書き方の図種（swimlane・agentflow）を、フローチャートのプラグインで編集できること。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { pluginFor } from '../src/plugins/registry';
import { flowchartPlugin } from '../src/plugins/flowchart';
import { agentflowPlugin } from '../src/plugins/agentflow';
import { parseFlowchart } from '../src/plugins/flowchartSyntax';
import { validate } from '../src/render/mermaid';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;

async function apply(source: string, change: ChangeSpec) {
  const out = ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

function targetsOf(id: string, plugin: DiagramPlugin) {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  return plugin.mapTargets(document.querySelector('svg')!, f.source);
}

const refsOf = (id: string, plugin: DiagramPlugin, kind: string) =>
  targetsOf(id, plugin)
    .filter((x) => x.ref?.kind === kind)
    .map((x) => x.ref!.id)
    .sort();
const run = (plugin: DiagramPlugin, id: string, source: string, refs: ElementRef[], shape?: string) => plugin.actions!.find((a) => a.id === id)!.run(source, refs, shape);

describe('swimlane', () => {
  const SRC = all.swimlane.source;

  it('mermaid は swimlane として読み、フローチャートのプラグインを使う', async () => {
    const r = await validate(SRC);
    expect(r.ok && r.diagramType).toBe('swimlane');
    expect(pluginFor('swimlane')).toBe(flowchartPlugin);
  });

  it('ノード・エッジ・レーン（最上位のサブグラフ）を対応付ける', () => {
    expect(refsOf('swimlane', flowchartPlugin, 'node')).toEqual(['a1', 'a2', 's1', 's2']);
    expect(refsOf('swimlane', flowchartPlugin, 'edge')).toEqual(['0', '1', '2']);
    expect(refsOf('swimlane', flowchartPlugin, 'subgraph')).toEqual(['shop', 'user']);
  });

  it('レーンにノードを足し、向きを変える', async () => {
    let out = await apply(SRC, run(flowchartPlugin, 'add-child', SRC, [{ kind: 'node', id: 's2' }])!.change);
    expect(out).toContain('s2 --> N1[');
    out = await apply(SRC, flowchartPlugin.setProperty!(SRC, null, 'direction', 'TB')!);
    expect(out.startsWith('swimlane-beta TB\n')).toBe(true);
  });
});

describe('agentflow', () => {
  const SRC = all.agentflow.source;

  it('mermaid は agentflow として読み、専用の選択肢のプラグインを使う', async () => {
    const r = await validate(SRC);
    expect(r.ok && r.diagramType).toBe('agentflow');
    expect(pluginFor('agentflow')).toBe(agentflowPlugin);
  });

  it('flow を枠として読み、global・connector の行を文として読まない', () => {
    const doc = parseFlowchart(SRC);
    expect(doc.container).toBe('flow');
    expect(doc.subgraphs.map((s) => s.id)).toEqual(['triage']);
    expect(doc.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['msg>intent', 'intent>refund', 'intent>answer', 'refund>crm', 'refund>fail']);
    const g = parseFlowchart('agentflow-beta\n  global\n    a[A]\n  end\n  flow f["F"]@{ view: collapsed }\n    b[B]\n  end');
    expect(g.subgraphs.map((s) => [s.id, s.end?.index])).toEqual([['f', 6]]);
    expect(doc.connectors.map((c) => [c.id, c.label && SRC.slice(c.label.from, c.label.to)])).toEqual([['crm', '顧客管理']]);
  });

  it('flow の題名を消しても、後ろの @{ … } は残す', async () => {
    const src = 'agentflow-beta\n  flow f["F"]@{ view: collapsed }\n    b[B]\n  end';
    const out = await apply(src, agentflowPlugin.setProperty!(src, { kind: 'subgraph', id: 'f' }, 'title', '')!);
    expect(out).toBe('agentflow-beta\n  flow f@{ view: collapsed }\n    b[B]\n  end');
    // 題名を足すときは ID のすぐ後ろに ["…"]
    expect(await apply(out, agentflowPlugin.setProperty!(out, { kind: 'subgraph', id: 'f' }, 'title', 'G')!)).toBe(src.replace('"F"', '"G"'));
  });

  it('connector は宣言の行で、ID の変更・題名・削除をする', async () => {
    const ref = { kind: 'node', id: 'crm' };
    expect(agentflowPlugin.inspect!(SRC, ref).map((f) => [f.id, f.value])).toEqual([
      ['id', 'crm'],
      ['label', '顧客管理'],
    ]);
    // ID を変えると、宣言の行と線の両方が変わる
    let out = await apply(SRC, agentflowPlugin.setProperty!(SRC, ref, 'id', 'crm2')!);
    expect(out).toContain('connector crm2["顧客管理"]');
    expect(out).toContain('refund -.- crm2');
    // 題名は宣言の行で変える（線の行に [ ] を付けると、ふつうのノードになる）
    out = await apply(SRC, agentflowPlugin.setProperty!(SRC, ref, 'label', 'CRM')!);
    expect(out).toContain('connector crm["CRM"]');
    expect(out).toContain('refund -.- crm\n');
    // 形・所属は変えられない
    expect(agentflowPlugin.setProperty!(SRC, ref, 'shape', 'rhombus')).toBeNull();
    // 消すと、宣言の行も消える
    out = await apply(SRC, run(agentflowPlugin, 'delete', SRC, [ref])!.change);
    expect(out).not.toContain('crm');
    // 題名の無い connector には、宣言の行に題名を付ける
    const bare = 'agentflow-beta\n  connector mail\n  a[A] -.- mail';
    out = await apply(bare, agentflowPlugin.setProperty!(bare, { kind: 'node', id: 'mail' }, 'label', 'メール')!);
    expect(out).toBe('agentflow-beta\n  connector mail["メール"]\n  a[A] -.- mail');
  });

  it('ノード（-agentflow- の id）・エッジ・flow を対応付ける', () => {
    expect(refsOf('agentflow', agentflowPlugin, 'node')).toEqual(['answer', 'crm', 'fail', 'intent', 'msg', 'refund']);
    expect(refsOf('agentflow', agentflowPlugin, 'edge')).toEqual(['0', '1', '2', '3', '4']);
    expect(refsOf('agentflow', agentflowPlugin, 'subgraph')).toEqual(['triage']);
  });

  it('形と矢印は agentflow が描けるものだけを選べる', () => {
    const node = agentflowPlugin.inspect!(SRC, { kind: 'node', id: 'refund' });
    expect(node.find((f) => f.id === 'shape')!.options!.map((o) => o.value)).toEqual(['rect', 'subroutine', 'rhombus', 'hexagon', 'lean', '@lin-doc']);
    const edge = agentflowPlugin.inspect!(SRC, { kind: 'edge', id: '0' });
    expect(edge.find((f) => f.id === 'arrow')!.options!.map((o) => o.value).sort()).toEqual(['-->', '--x', '-.-']);
    expect(agentflowPlugin.actions!.find((a) => a.id === 'add-node')!.shapes!.length).toBe(6);
  });

  it('枠を足すと flow で書く', async () => {
    const res = run(agentflowPlugin, 'group', SRC, [{ kind: 'node', id: 'fail' }])!;
    const out = await apply(SRC, res.change);
    expect(out).toMatch(/\n {4}flow G1\["[^"]+"\]\n {8}fail\n {4}end/);
  });

  it('形を変える', async () => {
    const out = await apply(SRC, agentflowPlugin.setProperty!(SRC, { kind: 'node', id: 'refund' }, 'shape', 'subroutine')!);
    expect(out).toContain('refund[[返金の手続き]]');
  });
});
