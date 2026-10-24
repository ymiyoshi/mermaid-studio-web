// @vitest-environment jsdom
// シーケンス図の図からの操作。どの操作も mermaid.parse を通り、対象の行以外を変えないことを確かめる。
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { deleteParticipant, parseSequence, sequencePlugin } from '../src/plugins/sequence';

const apply = (source: string, spec: ChangeSpec) => ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();

function run(actionId: string, source: string, kind: string, id: string) {
  const action = sequencePlugin.actions!.find((a) => a.id === actionId)!;
  const res = action.run(source, [{ kind, id }]);
  return res && { ...res, after: apply(source, res.change) };
}

function set(source: string, kind: string | null, id: string, field: string, value: string) {
  const spec = sequencePlugin.setProperty!(source, kind ? { kind, id } : null, field, value);
  return spec === null ? null : apply(source, spec);
}

const field = (source: string, kind: string | null, id: string, fieldId: string) =>
  sequencePlugin.inspect!(source, kind ? { kind, id } : null).find((f) => f.id === fieldId)!;

const SRC = `sequenceDiagram
    %% コメントは残る
    box Aqua 店
        participant A as 窓口 A
    end
    participant B@{ "type": "database" }
    A->>+B: 問い合わせ
    B-->>-A: 応答

    loop A を待つ
        A->>B: 再送
        Note over A,B: 待機中
    end
    activate B
    A-|\\B: 半分
    alt 成功
        B->>A: OK
    else 失敗
        B-xA: NG
    end
`;

describe('sequence: 文の読み取り', () => {
  it('box … end の後の loop も、正しい end と組にする', () => {
    const seq = parseSequence(SRC);
    expect(seq.blocks.map((b) => [b.keyword.value, b.end?.text.trim()])).toEqual([
      ['box', 'end'],
      ['loop', 'end'],
      ['alt', 'end'],
    ]);
    expect(seq.blocks[1].end!.index).toBe(12);
    expect(seq.blocks[2].sections.map((s) => s.keyword)).toEqual(['else']);
  });

  it('@{} つきの宣言・半分の矢印・活性化を読む', () => {
    const seq = parseSequence(SRC);
    expect(seq.decls.map((d) => [d.id, d.type])).toEqual([
      ['A', 'participant'],
      ['B', 'database'],
    ]);
    expect(seq.messages.map((m) => `${m.from}${m.arrow.value}${m.act.value}${m.to}`)).toEqual(['A->>+B', 'B-->>-A', 'A->>B', 'A-|\\B', 'B->>A', 'B-xA']);
    expect(seq.notes).toHaveLength(1);
    expect(seq.refs.map((r) => r.id)).toEqual(['B']);
  });

  it('いま描ける文はすべて mermaid.parse を通る（前提の確認）', async () => {
    await expect(mermaid.parse(SRC)).resolves.toBeTruthy();
  });
});

describe('sequence: 参加者', () => {
  it('ID を変えると、宣言・メッセージ・注釈・activate だけが変わる（loop の条件や表示名は変えない）', async () => {
    const after = set(SRC, 'participant', 'A', 'id', 'C')!;
    expect(after).toContain('participant C as 窓口 A');
    expect(after).toContain('loop A を待つ');
    expect(after).toContain('C->>+B: 問い合わせ');
    expect(after).toContain('Note over C,B: 待機中');
    expect(after).toContain('C-|\\B: 半分');
    expect(after).not.toMatch(/(?<![\p{L}])A->>/u);
    await expect(mermaid.parse(after)).resolves.toBeTruthy();
  });

  it('既にある ID や使えない名前には変えない', () => {
    expect(set(SRC, 'participant', 'A', 'id', 'B')).toBeNull();
    expect(set(SRC, 'participant', 'A', 'id', 'a b')).toBeNull();
    // - を含む ID はメッセージの矢印と見分けられない
    expect(set(SRC, 'participant', 'A', 'id', 'a-b')).toBeNull();
  });

  it('種類を変える（@{} の付け外し）', async () => {
    const actor = set(SRC, 'participant', 'B', 'type', 'actor')!;
    expect(actor).toContain('    actor B\n');
    const queue = set(SRC, 'participant', 'A', 'type', 'queue')!;
    expect(queue).toContain('participant A@{ "type": "queue" } as 窓口 A');
    expect(field(SRC, 'participant', 'B', 'type').value).toBe('database');
    for (const s of [actor, queue]) await expect(mermaid.parse(s)).resolves.toBeTruthy();
  });

  it('表示名を足す・消す', async () => {
    const added = set(SRC, 'participant', 'B', 'alias', 'DB')!;
    expect(added).toContain('participant B@{ "type": "database" } as DB\n');
    expect(set(SRC, 'participant', 'A', 'alias', '')).toContain('        participant A\n');
    await expect(mermaid.parse(added)).resolves.toBeTruthy();
  });

  it('@{} の中の表示名も編集できる', () => {
    const src = 'sequenceDiagram\n  participant D@{ "type": "database", "alias": "DB" }\n  D->>D: x\n';
    expect(field(src, 'participant', 'D', 'alias').value).toBe('DB');
    expect(set(src, 'participant', 'D', 'alias', '記録')).toContain('"alias": "記録"');
    expect(set(src, 'participant', 'D', 'type', 'queue')).toContain('participant D@{ "type": "queue", "alias": "DB" }');
  });

  it('削除すると、@{} の宣言・activate の行も消える', async () => {
    const after = apply(SRC, deleteParticipant(SRC, 'B'));
    expect(after).not.toMatch(/\bB\b/);
    expect(after).toContain('box Aqua 店');
    await expect(mermaid.parse(after)).resolves.toBeTruthy();
  });
});

describe('sequence: メッセージ', () => {
  it('送り手・受け手・活性化を変える', async () => {
    expect(set(SRC, 'message', '2', 'from', 'B')).toContain('        B->>B: 再送');
    expect(set(SRC, 'message', '2', 'to', 'A')).toContain('        A->>A: 再送');
    expect(set(SRC, 'message', '0', 'act', '')).toContain('    A->>B: 問い合わせ');
    const plus = set(SRC, 'message', '2', 'act', '+')!;
    expect(plus).toContain('A->>+B: 再送');
    expect(field(SRC, 'message', '0', 'from').options!.map((o) => o.value)).toEqual(['A', 'B']);
    await expect(mermaid.parse(set(SRC, 'message', '2', 'from', 'B')!)).resolves.toBeTruthy();
  });

  it('Tab で、返事のメッセージを後ろに足す（同じ字下げ）', async () => {
    const r = run('add-next-message', SRC, 'message', '2')!;
    expect(r.after).toContain('        A->>B: 再送\n        B-->>A: メッセージ\n        Note over');
    expect(r.after.slice(r.selAfter!.anchor, r.selAfter!.head)).toBe('メッセージ');
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('同じ区切りの中で上下に動かす（端では動かない）', async () => {
    const down = run('move-down', SRC, 'message', '2')!;
    expect(down.after).toContain('        Note over A,B: 待機中\n        A->>B: 再送\n    end');
    expect(run('move-up', SRC, 'message', '2')).toBeNull();
    expect(run('move-down', SRC, 'message', '4')).toBeNull(); // alt の最初の区切りの最後
    await expect(mermaid.parse(down.after)).resolves.toBeTruthy();
  });

  it('動かした後も、動かしたメッセージを選び続ける（続けて押すと同じ向きに進む）', () => {
    const src = 'sequenceDiagram\n  A->>B: 1\n  A->>B: 2\n  A->>B: 3\n';
    const once = run('move-down', src, 'message', '0')!;
    expect(once.select).toEqual({ kind: 'message', id: '1' });
    const twice = run('move-down', once.after, 'message', once.select!.id)!;
    expect(twice.after).toBe('sequenceDiagram\n  A->>B: 2\n  A->>B: 3\n  A->>B: 1\n');
    expect(twice.select).toEqual({ kind: 'message', id: '2' });
    // 枠を飛び越えると、枠の中のメッセージの数だけ番号が進む
    const over = run('move-down', SRC, 'message', '1')!;
    expect(over.select).toEqual({ kind: 'message', id: '2' });
  });

  it('枠をまたいで動かすと、枠全体を飛び越える', async () => {
    const up = run('move-up', SRC, 'message', '3')!; // 半分の矢印 → activate B の上
    expect(up.after).toContain('    A-|\\B: 半分\n    activate B\n');
    const over = run('move-up', up.after, 'message', '3')!; // さらに loop の上へ
    expect(over.after).toContain('    B-->>-A: 応答\n\n    A-|\\B: 半分\n    loop A を待つ');
    await expect(mermaid.parse(over.after)).resolves.toBeTruthy();
  });

  it('枠で囲む', async () => {
    const r = run('wrap', SRC, 'message', '0')!;
    expect(r.after).toContain('    loop 条件\n        A->>+B: 問い合わせ\n    end\n    B-->>-A: 応答');
    expect(r.after.slice(r.selAfter!.anchor, r.selAfter!.head)).toBe('条件');
    expect(r.focusAt).toBe(r.selAfter!.anchor);
    await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });
});

describe('sequence: 注釈', () => {
  it('参加者から右に、メッセージから両端の上に足す', async () => {
    const p = run('add-note', SRC, 'participant', 'B')!;
    expect(p.after).toBe(SRC + '    Note right of B: メモ\n');
    const m = run('add-note', SRC, 'message', '0')!;
    expect(m.after).toContain('    A->>+B: 問い合わせ\n    Note over A,B: メモ\n');
    for (const r of [p, m]) await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('本文・位置・参加者を変え、削除する', async () => {
    expect(set(SRC, 'note', '0', 'text', '休み')).toContain('Note over A,B: 休み');
    const pos = set(SRC, 'note', '0', 'pos', 'right of')!;
    // 左右に置く注釈は参加者 1 人だけ
    expect(pos).toContain('Note right of A: 待機中');
    expect(set(pos, 'note', '0', 'parts', 'A,B')).toBeNull();
    expect(set(SRC, 'note', '0', 'parts', 'B')).toContain('Note over B: 待機中');
    expect(set(SRC, 'note', '0', 'parts', 'A,B,C')).toBeNull();
    const del = run('delete', SRC, 'note', '0')!;
    expect(del.after).not.toContain('Note');
    await expect(mermaid.parse(pos)).resolves.toBeTruthy();
    await expect(mermaid.parse(set(SRC, 'note', '0', 'parts', 'B')!)).resolves.toBeTruthy();
    await expect(mermaid.parse(del.after)).resolves.toBeTruthy();
  });
});

describe('sequence: 枠', () => {
  it('種類と条件を変える', async () => {
    const opt = set(SRC, 'block', '1', 'kind', 'opt')!;
    expect(opt).toContain('    opt A を待つ\n');
    expect(set(SRC, 'block', '1', 'cond', '毎秒')).toContain('    loop 毎秒\n');
    expect(set(SRC, 'section', '2:0', 'cond', 'だめ')).toContain('    else だめ\n');
    await expect(mermaid.parse(opt)).resolves.toBeTruthy();
  });

  it('条件の無い枠に条件を足すときは空白を入れる', () => {
    const src = 'sequenceDiagram\n  loop\n    A->>B: x\n  end\n';
    expect(set(src, 'block', '0', 'cond', '毎分')).toBe('sequenceDiagram\n  loop 毎分\n    A->>B: x\n  end\n');
  });

  it('区切りを足す・消す', async () => {
    const add = run('add-section', SRC, 'block', '2')!;
    expect(add.after).toContain('        B-xA: NG\n    else 条件\n    end\n');
    expect(add.after.slice(add.selAfter!.anchor, add.selAfter!.head)).toBe('条件');
    expect(run('add-section', SRC, 'block', '1')).toBeNull(); // loop に区切りは無い
    const del = run('delete', SRC, 'section', '2:0')!;
    expect(del.after).toContain('        B->>A: OK\n        B-xA: NG\n    end\n');
    for (const r of [add, del]) await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('枠を外すと中身は残り、中身ごと削除すると全部消える', async () => {
    const unwrap = run('unwrap', SRC, 'block', '1')!;
    expect(unwrap.after).toContain('    B-->>-A: 応答\n\n        A->>B: 再送\n        Note over A,B: 待機中\n    activate B');
    const all = run('delete-block', SRC, 'block', '1')!;
    expect(all.after).toContain('    B-->>-A: 応答\n\n    activate B');
    for (const r of [unwrap, all]) await expect(mermaid.parse(r.after)).resolves.toBeTruthy();
  });

  it('Delete に割り当てた操作は、要素の種類ごとに 1 つだけ', () => {
    for (const kind of ['participant', 'message', 'note', 'block', 'section']) {
      const bound = sequencePlugin.actions!.filter((a) => a.key === 'Delete' && (a.appliesTo ?? ['node']).includes(kind));
      expect(bound, kind).toHaveLength(1);
    }
  });
});

describe('sequence: 図全体', () => {
  it('題名と通し番号を付け外しする', async () => {
    const titled = set(SRC, null, '', 'title', '問い合わせ')!;
    expect(titled.startsWith('sequenceDiagram\n    title 問い合わせ\n    %% コメントは残る')).toBe(true);
    expect(field(titled, null, '', 'title').value).toBe('問い合わせ');
    expect(set(titled, null, '', 'title', '')).toBe(SRC);
    const numbered = set(titled, null, '', 'autonumber', 'on')!;
    expect(numbered).toContain('    title 問い合わせ\n    autonumber\n');
    expect(set(numbered, null, '', 'autonumber', 'on')).toBeNull();
    expect(set(numbered, null, '', 'autonumber', 'off')).toBe(titled);
    for (const s of [titled, numbered]) await expect(mermaid.parse(s)).resolves.toBeTruthy();
  });
});
