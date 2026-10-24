// @vitest-environment jsdom
// 設計書 §13: 性質ベースのテスト（fast-check）。ランダムな図に操作を当てて、いつも成り立つべき性質を確かめる。
// - 操作の結果は mermaid.parse を通る
// - コメント行は、内容も順番も変わらない
// - 操作の対象に触れない行は変わらない
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import mermaid from 'mermaid';
import { parseFlowchart } from '../src/plugins/flowchartSyntax';
import { deleteEdge, deleteNode, renameNode, setArrow, setEdgeLabel, setShape } from '../src/plugins/flowchartOps';
import { ARROWS, SHAPE_CHOICES } from '../src/plugins/flowchartSyntax';
import { tokenRegex } from '../src/plugins/source';
import { piePlugin } from '../src/plugins/dataPlugins';
import { deleteRow, moveRow, setCell, tableRows } from '../src/plugins/table';
import { findMermaidBlocks, replaceMermaidBlock } from '../src/io/markdown';
import { BLOCK_SHAPES, blockPlugin } from '../src/plugins/block';

const RUNS = 100;

const apply = (source: string, spec: ChangeSpec | readonly ChangeSpec[]) =>
  ChangeSet.of(spec, source.length).apply(Text.of(source.split('\n'))).toString();

const parses = async (s: string) => {
  try {
    await mermaid.parse(s);
    return true;
  } catch {
    return false;
  }
};

const comments = (s: string) => s.split('\n').filter((l) => /^\s*%%/.test(l));

// ---- ランダムな flowchart ----------------------------------------------------

const IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const SAFE_SHAPES = SHAPE_CHOICES.filter((s) => !['asymmetric', 'lean-l', 'trapezoid-alt'].includes(s.name));

const nodeRef = fc.record({
  id: fc.constantFrom(...IDS),
  shape: fc.option(fc.constantFrom(...SAFE_SHAPES), { nil: null }),
  label: fc.constantFrom('処理', 'Step 1', 'はい/いいえ', 'x'),
});

const statement = fc.oneof(
  // ノードの定義だけ
  nodeRef.map((n) => ({ kind: 'node' as const, nodes: [n] })),
  // チェーン A --> B --> C（ラベル付きのリンクも混ぜる）
  fc.record({
    nodes: fc.array(nodeRef, { minLength: 2, maxLength: 4 }),
    arrows: fc.array(fc.constantFrom('-->', '---', '-.->', '==>', '--o', '--x'), { minLength: 3, maxLength: 3 }),
    labels: fc.array(fc.option(fc.constantFrom('はい', 'no', 'ok'), { nil: null }), { minLength: 3, maxLength: 3 }),
  }).map((r) => ({ kind: 'chain' as const, ...r })),
  // & でまとめたリンク
  fc.record({ a: nodeRef, b: nodeRef, c: nodeRef }).map((r) => ({ kind: 'fan' as const, ...r })),
  // コメント
  fc.constantFrom('%% メモ', '%% TODO: 見直す').map((c) => ({ kind: 'comment' as const, c })),
);

function refText(n: { id: string; shape: { open: string; close: string } | null; label: string }) {
  return n.shape ? `${n.id}${n.shape.open}${n.label}${n.shape.close}` : n.id;
}

const flowchart = fc
  .record({ dir: fc.constantFrom('TD', 'LR'), statements: fc.array(statement, { minLength: 2, maxLength: 8 }) })
  .map(({ dir, statements }) => {
    const lines = statements.map((st) => {
      if (st.kind === 'node') return refText(st.nodes[0]);
      if (st.kind === 'comment') return st.c;
      if (st.kind === 'fan') return `${refText(st.a)} --> ${refText(st.b)} & ${refText(st.c)}`;
      let s = refText(st.nodes[0]);
      st.nodes.slice(1).forEach((n, i) => {
        s += ` ${st.arrows[i]}${st.labels[i] ? `|${st.labels[i]}|` : ''} ${refText(n)}`;
      });
      return s;
    });
    return `flowchart ${dir}\n${lines.map((l) => `    ${l}`).join('\n')}\n`;
  });

/** 操作の種類と引数 */
type Op =
  | { t: 'deleteNode'; id: string }
  | { t: 'deleteEdge'; i: number }
  | { t: 'setShape'; id: string; shape: string }
  | { t: 'setArrow'; i: number; arrow: string }
  | { t: 'setEdgeLabel'; i: number; label: string }
  | { t: 'rename'; id: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant('deleteNode' as const), id: fc.constantFrom(...IDS) }),
  fc.record({ t: fc.constant('deleteEdge' as const), i: fc.nat(12) }),
  fc.record({ t: fc.constant('setShape' as const), id: fc.constantFrom(...IDS), shape: fc.constantFrom(...SAFE_SHAPES.map((s) => s.name)) }),
  fc.record({ t: fc.constant('setArrow' as const), i: fc.nat(12), arrow: fc.constantFrom(...ARROWS.map((a) => a.value)) }),
  fc.record({ t: fc.constant('setEdgeLabel' as const), i: fc.nat(12), label: fc.constantFrom('', '新しい', 'yes') }),
  fc.record({ t: fc.constant('rename' as const), id: fc.constantFrom(...IDS) }),
);

function run(source: string, o: Op): ChangeSpec | readonly ChangeSpec[] | null {
  const edges = parseFlowchart(source).edges.length;
  switch (o.t) {
    case 'deleteNode':
      return deleteNode(source, o.id);
    case 'deleteEdge':
      return edges ? deleteEdge(source, o.i % edges) : null;
    case 'setShape':
      return setShape(source, o.id, o.shape);
    case 'setArrow':
      return edges ? setArrow(source, o.i % edges, o.arrow) : null;
    case 'setEdgeLabel':
      return edges ? setEdgeLabel(source, o.i % edges, o.label) : null;
    case 'rename':
      return renameNode(source, o.id, `${o.id}_renamed`);
  }
}

/** 操作の対象（ノード ID）に触れていない行 */
function untouchedLines(source: string, o: Op): string[] {
  if (!('id' in o)) return [];
  return source.split('\n').filter((l) => !tokenRegex(o.id).test(l));
}

describe('flowchart の操作の性質', () => {
  it('どの操作の結果も mermaid の構文として正しく、コメント行と対象外の行は変わらない', async () => {
    await fc.assert(
      fc.asyncProperty(flowchart, op, async (source, o) => {
        fc.pre(await parses(source));
        const spec = run(source, o);
        if (!spec) return;
        const out = apply(source, spec);
        expect(await parses(out)).toBe(true);
        expect(comments(out)).toEqual(comments(source));
        const outLines = out.split('\n');
        for (const l of untouchedLines(source, o)) expect(outLines).toContain(l);
      }),
      { numRuns: RUNS },
    );
  });

  it('読み取ったエッジは、どの文にも欠けや重複なく割り当てられる', () => {
    fc.assert(
      fc.property(flowchart, (source) => {
        const doc = parseFlowchart(source);
        expect(doc.edges.map((e) => e.index)).toEqual(doc.edges.map((_, i) => i));
        for (const e of doc.edges) {
          const st = e.statement;
          expect(st.groups[e.link].some((n) => n.id === e.from)).toBe(true);
          expect(st.groups[e.link + 1].some((n) => n.id === e.to)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('表の操作の性質', () => {
  const pie = fc
    .array(fc.record({ label: fc.constantFrom('A', 'B', 'C', 'D', 'その他'), value: fc.integer({ min: 1, max: 99 }) }), {
      minLength: 1,
      maxLength: 6,
    })
    .map((xs) => `pie title T\n${xs.map((x) => `    "${x.label}" : ${x.value}`).join('\n')}\n`);
  const table = piePlugin.tables![0];

  it('行を下へ動かしてから上へ戻すと元に戻る', () => {
    fc.assert(
      fc.property(pie, fc.nat(5), (source, k) => {
        const rows = tableRows(source, table);
        const i = k % rows.length;
        if (i === rows.length - 1) return;
        const once = apply(source, moveRow(rows, i, 1)!);
        const back = apply(once, moveRow(tableRows(once, table), i + 1, -1)!);
        expect(back).toBe(source);
      }),
    );
  });

  it('行を消すと行がちょうど 1 つ減り、値を変えると読み直した値が一致する', async () => {
    await fc.assert(
      fc.asyncProperty(pie, fc.nat(5), fc.integer({ min: 1, max: 999 }), async (source, k, v) => {
        const rows = tableRows(source, table);
        const row = rows[k % rows.length];
        expect(tableRows(apply(source, deleteRow(source, row)), table)).toHaveLength(rows.length - 1);
        const out = apply(source, setCell(row, 'value', String(v)));
        expect(tableRows(out, table)[k % rows.length].values.value).toBe(String(v));
        expect(await parses(out)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('Markdown のブロックの性質', () => {
  const md = fc
    .array(
      fc.oneof(
        fc.constantFrom('# 見出し', '本文の行', '- 箇条書き', ''),
        fc.constantFrom('flowchart LR\n  A --> B', 'pie\n  "x" : 1').map((s) => '```mermaid\n' + s + '\n```'),
        fc.constant('```js\nconsole.log(1)\n```'),
      ),
      { maxLength: 8 },
    )
    .map((parts) => parts.join('\n') + '\n');

  it('ブロックを自分自身の中身で差し替えても、Markdown は変わらない', () => {
    fc.assert(
      fc.property(md, (source) => {
        findMermaidBlocks(source).forEach((b) => {
          expect(replaceMermaidBlock(source, b.index, b.text)).toBe(source);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('1 つのブロックを差し替えても、他のブロックとブロックの外は変わらない', () => {
    fc.assert(
      fc.property(md, (source) => {
        const blocks = findMermaidBlocks(source);
        if (blocks.length === 0) return;
        const out = replaceMermaidBlock(source, 0, 'graph TD\n  Z\n')!;
        const after = findMermaidBlocks(out);
        expect(after[0].text).toBe('graph TD\n  Z\n');
        expect(after.slice(1).map((b) => b.text)).toEqual(blocks.slice(1).map((b) => b.text));
        expect(out.slice(after[0].to)).toBe(source.slice(blocks[0].to));
        expect(out.slice(0, after[0].from)).toBe(source.slice(0, blocks[0].from));
      }),
      { numRuns: 200 },
    );
  });
});

describe('block 図の操作の性質', () => {
  const BIDS = ['a', 'b', 'c', 'd', 'e'];
  const item = fc.record({
    id: fc.constantFrom(...BIDS),
    shape: fc.option(fc.constantFrom(...BLOCK_SHAPES.filter((s) => s.name !== 'asymmetric')), { nil: null }),
    width: fc.option(fc.integer({ min: 2, max: 3 }), { nil: null }),
  });
  const itemText = (x: { id: string; shape: { open: string; close: string } | null; width: number | null }) =>
    `${x.id}${x.shape ? `${x.shape.open}"${x.id.toUpperCase()}"${x.shape.close}` : ''}${x.width ? `:${x.width}` : ''}`;
  const blockDiagram = fc
    .record({
      cols: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
      rows: fc.array(fc.array(item, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 3 }),
      group: fc.option(fc.array(item, { minLength: 1, maxLength: 2 }), { nil: null }),
      edges: fc.array(fc.tuple(fc.constantFrom(...BIDS), fc.constantFrom(...BIDS)), { maxLength: 3 }),
      comment: fc.boolean(),
    })
    .map(({ cols, rows, group, edges, comment }) => {
      // 同じ ID を 2 回書かない（mermaid は同じ ID のブロックを 1 つにまとめる）
      const used = new Set<string>();
      const uniq = (xs: { id: string; shape: { open: string; close: string } | null; width: number | null }[]) =>
        xs.filter((x) => !used.has(x.id) && used.add(x.id));
      const lines = ['block-beta'];
      if (cols) lines.push(`  columns ${cols}`);
      if (comment) lines.push('  %% メモ');
      for (const r of rows) {
        const xs = uniq(r);
        if (xs.length) lines.push(`  ${xs.map(itemText).join(' ')}`);
      }
      if (group) {
        const xs = uniq(group);
        if (xs.length) lines.push('  block:g', `    ${xs.map(itemText).join(' ')}`, '  end');
      }
      for (const [x, y] of edges) if (used.has(x) && used.has(y) && x !== y) lines.push(`  ${x} --> ${y}`);
      return lines.join('\n') + '\n';
    });

  const blockOp = fc.oneof(
    fc.record({ t: fc.constant('delete'), id: fc.constantFrom(...BIDS, 'g') }),
    fc.record({ t: fc.constant('add-next'), id: fc.constantFrom(...BIDS, 'g') }),
    fc.record({ t: fc.constant('shape'), id: fc.constantFrom(...BIDS), v: fc.constantFrom(...BLOCK_SHAPES.map((s) => s.name)) }),
    fc.record({ t: fc.constant('width'), id: fc.constantFrom(...BIDS, 'g'), v: fc.constantFrom('', '1', '2', '3') }),
    fc.record({ t: fc.constant('label'), id: fc.constantFrom(...BIDS), v: fc.constantFrom('ラベル', 'x (y)', '') }),
  );

  it('どの操作の結果も mermaid の構文として正しく、コメント行は変わらない', async () => {
    await fc.assert(
      fc.asyncProperty(blockDiagram, blockOp, async (source, o) => {
        fc.pre(await parses(source));
        const ref = { kind: 'block-item', id: o.id };
        const spec =
          o.t === 'delete' || o.t === 'add-next'
            ? (blockPlugin.actions!.find((a) => a.id === o.t)!.run(source, [ref])?.change ?? null)
            : blockPlugin.setProperty!(source, ref, o.t, (o as { v: string }).v);
        if (!spec) return;
        const out = apply(source, spec);
        expect(await parses(out), out).toBe(true);
        expect(comments(out)).toEqual(comments(source));
      }),
      { numRuns: RUNS },
    );
  });
});
