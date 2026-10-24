// @vitest-environment jsdom
// mermaid.parse は flowchart などで DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import mermaid from 'mermaid';
import { findNodeLabel, flowchartPlugin, nodeIdFromSvg } from '../src/plugins/flowchart';
import { findParticipantLabel, sequencePlugin } from '../src/plugins/sequence';
import { uniqueId } from '../src/plugins/source';
import type { DiagramPlugin } from '../src/plugins/types';

function run(plugin: DiagramPlugin, actionId: string, source: string, args: string[] = [], kind = 'node') {
  const action = plugin.actions!.find((a) => a.id === actionId)!;
  const res = action.run(source, args.map((id) => ({ kind, id })))!;
  const after = ChangeSet.of(res.change, source.length).apply(Text.of(source.split('\n'))).toString();
  return { ...res, after };
}

const FLOW = `flowchart TD
    %% コメントは残る
    A[開始] --> B{条件?}
    B -->|はい| C(処理)

    subgraph S1
        D[[サブ]]
    end
`;

describe('flowchart: ラベルの位置', () => {
  it('形ごとにラベルの範囲を特定する', () => {
    for (const [id, label] of [
      ['A', '開始'],
      ['B', '条件?'],
      ['C', '処理'],
      ['D', 'サブ'],
    ]) {
      const r = findNodeLabel(FLOW, id)!;
      expect(FLOW.slice(r.from, r.to)).toBe(label);
    }
  });

  it('引用符で囲んだラベルは引用符の内側', () => {
    const src = 'flowchart LR\n  A["a (b)"] --> B';
    const r = findNodeLabel(src, 'A')!;
    expect(src.slice(r.from, r.to)).toBe('a (b)');
  });

  it('ラベルの無いノードは null', () => {
    expect(findNodeLabel('flowchart LR\n  A --> B', 'B')).toBeNull();
  });

  it('SVG の id からノード ID を取り出す', () => {
    const el = { id: 'mmd-render-3-flowchart-my-node-12' } as Element;
    expect(nodeIdFromSvg(el)).toBe('my-node');
  });
});

describe('flowchart: 追加と接続', () => {
  it('ノードを追加すると、既存の行を変えずに 1 行増える', async () => {
    const r = run(flowchartPlugin, 'add-node', FLOW);
    expect(r.after).toBe(FLOW.replace(/end\n$/, 'end\n    N1[新しいノード]\n'));
    expect(r.focus).toEqual({ kind: 'node', id: 'N1' });
    expect(r.after.slice(r.selAfter!.anchor, r.selAfter!.head)).toBe('新しいノード');
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('次のノードは、元のノードが最後に出てくる行の後ろに同じインデントで入る', async () => {
    const r = run(flowchartPlugin, 'add-child', FLOW, ['D']);
    expect(r.after).toContain('        D[[サブ]]\n        D --> N1[新しいノード]\n    end');
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('接続すると矢印の行が入る', async () => {
    const r = run(flowchartPlugin, 'connect', FLOW, ['C', 'A']);
    expect(r.after).toContain('    B -->|はい| C(処理)\n    C --> A\n');
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('既に使われている ID を避ける', () => {
    expect(uniqueId('flowchart TD\n  N1 --> N2', 'N')).toBe('N3');
    expect(uniqueId('flowchart TD\n  N10 --> X', 'N')).toBe('N1');
  });

  it('末尾に改行が無い文書にも追加できる', async () => {
    const src = 'flowchart LR\n  A --> B';
    const r = run(flowchartPlugin, 'add-node', src);
    expect(r.after).toBe('flowchart LR\n  A --> B\n  N1[新しいノード]');
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });
});

const SEQ = `sequenceDiagram
    participant U as ユーザー
    participant S
    U->>S: リクエスト
    loop 毎分
        S-->>U: 通知
    end
`;

describe('sequence: 追加', () => {
  it('参加者は最後の宣言の後ろに追加する', async () => {
    const r = run(sequencePlugin, 'add-participant', SEQ);
    expect(r.after).toContain('    participant S\n    participant P1 as 新しい参加者\n    U->>S');
    expect(r.focus).toEqual({ kind: 'participant', id: 'P1' });
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('メッセージは末尾（ブロックの外）に追加し、本文を選択する', async () => {
    const r = run(sequencePlugin, 'add-message', SEQ, ['S', 'U'], 'participant');
    expect(r.after).toBe(SEQ + '    S->>U: メッセージ\n');
    expect(r.after.slice(r.selAfter!.anchor, r.selAfter!.head)).toBe('メッセージ');
    expect(r.focusAt).toBe(r.selAfter!.anchor);
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('別名のある参加者だけラベルを特定できる', () => {
    const r = findParticipantLabel(SEQ, 'U')!;
    expect(SEQ.slice(r.from, r.to)).toBe('ユーザー');
    expect(findParticipantLabel(SEQ, 'S')).toBeNull();
  });
});
