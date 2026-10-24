// @vitest-environment jsdom
// シーケンス図のドラッグでの並べ替え（参加者は左右、メッセージ・注釈・枠は上下）と、落とし先の決め方。
// mermaid.parse を通ることに加えて、mermaid が読み取った参加者・メッセージの順番も確かめる。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { parseSequence, sequencePlugin } from '../src/plugins/sequence';
import { findDrop } from '../src/ui/reorderDrop';

const apply = (source: string, spec: ChangeSpec) => ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();
const reorder = sequencePlugin.reorder!;

function move(source: string, kind: string, id: string, targetKind: string, targetId: string, before: boolean) {
  const res = reorder.move(source, { kind, id }, { kind: targetKind, id: targetId }, before);
  return res && { ...res, after: apply(source, res.change) };
}

interface SeqDb {
  getActorKeys(): string[];
  getMessages(): { from?: string; to?: string; message: string; type: number }[];
}

async function db(source: string): Promise<SeqDb> {
  await mermaid.parse(source);
  const api = mermaid.mermaidAPI as unknown as { getDiagramFromText(t: string): Promise<{ db: SeqDb }> };
  return (await api.getDiagramFromText(source)).db;
}

/** 本文のあるメッセージ（と注釈）の並び */
const texts = async (source: string) =>
  (await db(source))
    .getMessages()
    .map((m) => m.message)
    .filter((m) => typeof m === 'string' && m !== '');

describe('sequence: 参加者をドラッグで並べ替える', () => {
  it('宣言の行の中で入れ替える（間のコメントは動かさない）', async () => {
    const src = 'sequenceDiagram\n  participant A\n  %% メモ\n  participant B as ビー\n  participant C\n  A->>B: x\n';
    const r = move(src, 'participant', 'C', 'participant', 'A', true)!;
    expect(r.after).toBe('sequenceDiagram\n  participant C\n  %% メモ\n  participant A\n  participant B as ビー\n  A->>B: x\n');
    expect((await db(r.after)).getActorKeys()).toEqual(['C', 'A', 'B']);
    expect(r.select).toEqual({ kind: 'participant', id: 'C' });
  });

  it('宣言の無い参加者は、順番を変える範囲の分だけ宣言を足す', async () => {
    const src = 'sequenceDiagram\n  A->>B: x\n  B->>C: y\n';
    const first = move(src, 'participant', 'C', 'participant', 'A', true)!;
    expect(first.after).toBe('sequenceDiagram\n  participant C\n  participant A\n  participant B\n  A->>B: x\n  B->>C: y\n');
    expect((await db(first.after)).getActorKeys()).toEqual(['C', 'A', 'B']);
    const swap = move(src, 'participant', 'A', 'participant', 'B', false)!;
    expect(swap.after).toBe('sequenceDiagram\n  participant B\n  participant A\n  A->>B: x\n  B->>C: y\n');
    expect((await db(swap.after)).getActorKeys()).toEqual(['B', 'A', 'C']);
  });

  it('宣言のある参加者と無い参加者が混ざっていても、望む順になる', async () => {
    const src = 'sequenceDiagram\n  participant A\n  participant B\n  A->>C: x\n';
    const r = move(src, 'participant', 'C', 'participant', 'B', true)!;
    expect((await db(r.after)).getActorKeys()).toEqual(['A', 'C', 'B']);
    expect(r.after).toContain('  participant A\n  participant C\n  participant B\n');
  });

  it('box の中と外をまたいでは動かさない。同じ box の中なら動かす', async () => {
    const src = 'sequenceDiagram\n  box 店\n    participant A\n    participant B\n  end\n  participant C\n  A->>C: x\n';
    expect(move(src, 'participant', 'A', 'participant', 'C', false)).toBeNull();
    const r = move(src, 'participant', 'B', 'participant', 'A', true)!;
    expect(r.after).toContain('  box 店\n    participant B\n    participant A\n  end\n');
    expect((await db(r.after)).getActorKeys()).toEqual(['B', 'A', 'C']);
  });

  it('← → のボタンもドラッグと同じ規則で動かす（宣言の無い参加者も動かせ、box はまたがない）', async () => {
    const run = (id: string, src: string, ref: string) => {
      const res = sequencePlugin.actions!.find((a) => a.id === id)!.run(src, [{ kind: 'participant', id: ref }]);
      return res && { ...res, after: apply(src, res.change) };
    };
    const implicit = run('move-left', 'sequenceDiagram\n  A->>B: x\n', 'B')!;
    expect(implicit.label).toBe('参加者 B を左へ移動');
    expect((await db(implicit.after)).getActorKeys()).toEqual(['B', 'A']);
    const boxed = 'sequenceDiagram\n  box 店\n    participant A\n  end\n  participant C\n  A->>C: x\n';
    expect(run('move-right', boxed, 'A')).toBeNull();
  });

  it('後から作る参加者（create）は動かせない。位置が変わらない落とし先は何もしない', () => {
    const src = 'sequenceDiagram\n  participant A\n  participant B\n  create participant N\n  A->>N: x\n';
    expect(reorder.axis(src, { kind: 'participant', id: 'N' })).toBeNull();
    expect(reorder.axis(src, { kind: 'participant', id: 'A' })).toBe('x');
    expect(move(src, 'participant', 'A', 'participant', 'B', true)).toBeNull();
  });
});

const SRC = `sequenceDiagram
    participant A
    participant B
    A->>B: 一
    B-->>A: 二
    loop 毎分
        A->>B: 三
        Note over A,B: 注
    end
    B->>A: 四
`;

describe('sequence: メッセージ・注釈・枠をドラッグで並べ替える', () => {
  it('メッセージを枠の中へ入れると、字下げを合わせ、動かした後の番号で選ぶ', async () => {
    const r = move(SRC, 'message', '0', 'message', '2', false)!;
    expect(r.after).toContain('    B-->>A: 二\n    loop 毎分\n        A->>B: 三\n        A->>B: 一\n        Note over A,B: 注\n    end');
    expect(await texts(r.after)).toEqual(['二', '毎分', '三', '一', '注', '四']);
    expect(r.select).toEqual({ kind: 'message', id: '2' });
    expect(parseSequence(r.after).messages[2].line.text.trim()).toBe('A->>B: 一');
  });

  it('注釈を枠の外へ出す', async () => {
    const r = move(SRC, 'note', '0', 'message', '3', false)!;
    expect(r.after).toBe(SRC.replace('        Note over A,B: 注\n', '') + '    Note over A,B: 注\n');
    expect(r.select).toEqual({ kind: 'note', id: '0' });
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('枠は中身ごと動かす', async () => {
    const r = move(SRC, 'block', '0', 'message', '0', true)!;
    expect(r.after).toContain('    participant B\n    loop 毎分\n        A->>B: 三\n        Note over A,B: 注\n    end\n    A->>B: 一\n    B-->>A: 二\n    B->>A: 四');
    expect(await texts(r.after)).toEqual(['毎分', '三', '注', '一', '二', '四']);
    expect(r.select).toEqual({ kind: 'block', id: '0' });
  });

  it('自分の中や、すぐ隣（位置が変わらない）には落とせない', () => {
    expect(move(SRC, 'block', '0', 'message', '2', true)).toBeNull();
    expect(move(SRC, 'message', '0', 'message', '1', true)).toBeNull();
    expect(move(SRC, 'message', '1', 'message', '0', false)).toBeNull();
  });

  it('落とし先にできる要素の種類', () => {
    expect(reorder.accepts({ kind: 'message', id: '0' }, { kind: 'block', id: '0' })).toBe(true);
    expect(reorder.accepts({ kind: 'message', id: '0' }, { kind: 'participant', id: 'A' })).toBe(false);
    expect(reorder.accepts({ kind: 'participant', id: 'A' }, { kind: 'message', id: '0' })).toBe(false);
    expect(reorder.axis(SRC, { kind: 'message', id: '0' })).toBe('y');
    expect(reorder.axis(SRC, { kind: 'section', id: '0:0' })).toBeNull();
  });
});

describe('落とし先の決め方', () => {
  const r = (top: number, height: number, left = 0, width = 100) => ({ left, top, width, height });

  it('上下: 一番近い要素の、中心より上なら前・下なら後ろ', () => {
    const c = [
      { item: 'a', rect: r(0, 20) },
      { item: 'b', rect: r(40, 20) },
    ];
    expect(findDrop('y', { x: 10, y: 5 }, c)).toMatchObject({ item: 'a', before: true });
    expect(findDrop('y', { x: 10, y: 25 }, c)).toMatchObject({ item: 'a', before: false });
    // a と b の間は、b の前（a の後ろと同じ位置）
    expect(findDrop('y', { x: 10, y: 33 }, c)).toMatchObject({ item: 'b', before: true });
    expect(findDrop('y', { x: 10, y: 45 }, c)).toMatchObject({ item: 'b', before: true });
  });

  it('他の要素を含む枠は、中を指しているときに選ばない（端に近いときだけ枠の前後）', () => {
    const c = [
      { item: 'loop', rect: r(0, 100) },
      { item: 'in1', rect: r(20, 20) },
      { item: 'in2', rect: r(60, 20) },
    ];
    expect(findDrop('y', { x: 10, y: 50 }, c)?.item).toMatch(/^in/);
    expect(findDrop('y', { x: 10, y: 2 }, c)).toMatchObject({ item: 'loop', before: true });
    expect(findDrop('y', { x: 10, y: 99 }, c)).toMatchObject({ item: 'loop', before: false });
  });

  it('左右: 中心より左なら前、右なら後ろ（線は縦）', () => {
    const c = [
      { item: 'A', rect: r(0, 40, 0, 80) },
      { item: 'B', rect: r(0, 40, 200, 80) },
    ];
    const spot = findDrop('x', { x: 260, y: 10 }, c)!;
    expect(spot).toMatchObject({ item: 'B', before: false });
    expect(spot.line.width).toBe(2);
    expect(findDrop('x', { x: 10, y: 10 }, [])).toBeNull();
  });
});
