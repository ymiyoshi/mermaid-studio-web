// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { applySpec } from '../src/plugins/source';
import { mindmapPlugin } from '../src/plugins/mindmap';
import { kanbanPlugin } from '../src/plugins/kanban';
import { ishikawaPlugin } from '../src/plugins/ishikawa';
import { treeViewPlugin } from '../src/plugins/treeView';
import { ganttPlugin, gitGraphPlugin, packetPlugin, quadrantPlugin, timelinePlugin, treemapPlugin } from '../src/plugins/dataPlugins';
import { flowchartPlugin } from '../src/plugins/flowchart';
import { architecturePlugin } from '../src/plugins/architecture';
import { blockPlugin } from '../src/plugins/block';
import { cynefinPlugin } from '../src/plugins/cynefin';
import { wardleyPlugin } from '../src/plugins/wardley';
import { vennPlugin } from '../src/plugins/venn';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import fixtures from './fixtures/rendered-svg.json';
import { resolveDrop, markContainers, type DragCandidate } from '../src/ui/reorderDrop';
import type { ActionResult, DiagramPlugin, ElementRef } from '../src/plugins/types';

// ドラッグでの移動（設計書 §6.3）: 前後への並べ替え・枠や子への移動・座標での配置

const valid = async (s: string) => expect(mermaid.parse(s)).resolves.toBeTruthy();
/** mermaid.parse では読めない新しい図種（beta）も確かめる */
const checked = async (s: string) => expect((await validate(s)).ok, `通らない: ${s}`).toBe(true);
const ref = (kind: string, id: string): ElementRef => ({ kind, id });
const done = (source: string, res: ActionResult | null | undefined) => {
  expect(res).toBeTruthy();
  return applySpec(source, res!.change);
};
const move = (p: DiagramPlugin, source: string, a: ElementRef, b: ElementRef, before: boolean) => p.reorder!.move!(source, a, b, before);
const into = (p: DiagramPlugin, source: string, a: ElementRef, b: ElementRef | null) => p.reorder!.into!(source, a, b);

describe('落とし先の決め方（中へ落とせる図種）', () => {
  const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
  const c = (item: string, rect: ReturnType<typeof r>, sibling: boolean, into: boolean): DragCandidate<string> => ({ item, rect, sibling, into });

  it('枠の中で、同じ枠の要素があればその前後、無ければ枠の中', () => {
    const list = markContainers([
      c('colA', r(0, 0, 100, 300), false, true),
      c('a1', r(10, 20, 80, 30), true, false),
      c('a2', r(10, 60, 80, 30), true, false),
      c('colB', r(120, 0, 100, 300), false, true),
    ]);
    expect(resolveDrop('y', { x: 50, y: 25 }, list, false)).toMatchObject({ kind: 'move', item: 'a1', before: true });
    expect(resolveDrop('y', { x: 50, y: 250 }, list, false)).toMatchObject({ kind: 'move', item: 'a2', before: false });
    // 別の枠（中に要素が無い）を指したら、その枠の中。a1・a2 は選ばない
    expect(resolveDrop('y', { x: 150, y: 25 }, list, false)).toMatchObject({ kind: 'into', item: 'colB' });
    // どの枠の外でも、root なら図の一番外
    expect(resolveDrop('y', { x: 500, y: 25 }, list, true)).toMatchObject({ kind: 'into', item: null });
    expect(resolveDrop('y', { x: 500, y: 25 }, list, false)).toBeNull();
  });

  it('前後にも中にも落とせる要素は、真ん中の半分で中、端で前後', () => {
    const list = markContainers([c('a', r(0, 0, 100, 40), true, true), c('b', r(0, 60, 100, 40), true, true)]);
    expect(resolveDrop('y', { x: 50, y: 20 }, list, false)).toMatchObject({ kind: 'into', item: 'a' });
    expect(resolveDrop('y', { x: 50, y: 3 }, list, false)).toMatchObject({ kind: 'move', item: 'a', before: true });
    expect(resolveDrop('y', { x: 50, y: 38 }, list, false)).toMatchObject({ kind: 'move', item: 'a', before: false });
  });

  it('xy: 一番近い要素の、中心より左なら前・右なら後ろ（線は縦）', () => {
    const list = markContainers([c('a', r(0, 0, 50, 50), true, false), c('b', r(60, 0, 50, 50), true, false), c('c', r(0, 60, 50, 50), true, false)]);
    const s = resolveDrop('xy', { x: 100, y: 20 }, list, false);
    expect(s).toMatchObject({ kind: 'move', item: 'b', before: false });
    expect(s?.kind === 'move' && s.line.width).toBe(2);
    expect(resolveDrop('xy', { x: 5, y: 90 }, list, false)).toMatchObject({ kind: 'move', item: 'c', before: true });
  });
});

describe('mindmap: トピックをドラッグで動かす', () => {
  const MM = 'mindmap\n  root((Studio))\n    表示\n      ::icon(fa fa-eye)\n      全図種\n    編集\n      テキスト\n      図\n';

  it('別のトピックの子にすると、部分木ごと字下げを付け替える', async () => {
    const res = into(mindmapPlugin, MM, ref('topic', '1'), ref('topic', '3'));
    const out = done(MM, res);
    expect(out).toBe('mindmap\n  root((Studio))\n    編集\n      テキスト\n      図\n      表示\n        ::icon(fa fa-eye)\n        全図種\n');
    expect(res!.select).toEqual(ref('topic', '4'));
    await valid(out);
  });

  it('兄弟の前へ動かす。根の兄弟にはしない・自分の子孫には入れない', async () => {
    const out = done(MM, move(mindmapPlugin, MM, ref('topic', '4'), ref('topic', '2'), true));
    expect(out).toBe('mindmap\n  root((Studio))\n    表示\n      ::icon(fa fa-eye)\n      テキスト\n      全図種\n    編集\n      図\n');
    await valid(out);
    expect(move(mindmapPlugin, MM, ref('topic', '1'), ref('topic', '0'), true)).toBeNull();
    expect(mindmapPlugin.reorder!.accepts!(ref('topic', '1'), ref('topic', '0'), MM)).toBe(false);
    expect(into(mindmapPlugin, MM, ref('topic', '1'), ref('topic', '2'))).toBeNull();
    expect(mindmapPlugin.reorder!.axis(MM, ref('topic', '0'))).toBeNull();
    // 動かしても変わらない（すぐ後ろの兄弟の前）
    expect(move(mindmapPlugin, MM, ref('topic', '1'), ref('topic', '3'), true)).toBeNull();
  });
});

describe('kanban: カードを別の列へ、列を左右に', () => {
  const KB = 'kanban\n  todo[やる]\n    c1[設計]\n    c2[実装]\n  %% 進行中\n  doing[やっている]\n  done[済み]\n    c3[調査]\n';

  it('空の列の中へ落とすと、その列の最後のカードにする', async () => {
    expect(kanbanPlugin.reorder!.acceptsInto!(KB, ref('card', 'c1'), ref('column', 'doing'))).toBe(true);
    expect(kanbanPlugin.reorder!.acceptsInto!(KB, ref('column', 'todo'), ref('column', 'doing'))).toBe(false);
    const out = done(KB, into(kanbanPlugin, KB, ref('card', 'c1'), ref('column', 'doing')));
    expect(out).toBe('kanban\n  todo[やる]\n    c2[実装]\n  %% 進行中\n  doing[やっている]\n    c1[設計]\n  done[済み]\n    c3[調査]\n');
    await valid(out);
  });

  it('別の列のカードの前へ落とす・列を並べ替える（コメントは残す）', async () => {
    const out = done(KB, move(kanbanPlugin, KB, ref('card', 'c3'), ref('card', 'c2'), true));
    expect(out).toBe('kanban\n  todo[やる]\n    c1[設計]\n    c3[調査]\n    c2[実装]\n  %% 進行中\n  doing[やっている]\n  done[済み]\n');
    await valid(out);
    const cols = done(KB, move(kanbanPlugin, KB, ref('column', 'done'), ref('column', 'todo'), true));
    expect(cols).toBe('kanban\n  done[済み]\n    c3[調査]\n  todo[やる]\n    c1[設計]\n    c2[実装]\n  %% 進行中\n  doing[やっている]\n');
    await valid(cols);
    expect(kanbanPlugin.reorder!.axis(KB, ref('column', 'todo'))).toBe('x');
    expect(kanbanPlugin.reorder!.axis(KB, ref('card', 'c1'))).toBe('y');
  });
});

describe('ishikawa・treeView: 部分木を動かす', () => {
  it('ishikawa: 要因を別の要因の下へ', async () => {
    const SRC = 'ishikawa-beta\n    結果\n        人\n            教育\n        方法\n';
    const out = done(SRC, into(ishikawaPlugin, SRC, ref('cause', '2'), ref('cause', '3')));
    expect(out).toBe('ishikawa-beta\n    結果\n        人\n        方法\n            教育\n');
    await valid(out);
    expect(ishikawaPlugin.reorder!.axis(SRC, ref('effect', '0'))).toBeNull();
  });

  it('treeView: フォルダの中へは入れ、ファイルの中へは入れない', async () => {
    const SRC = 'treeView-beta\n    src/\n        main.ts\n    docs/\n    README.md\n';
    const out = done(SRC, into(treeViewPlugin, SRC, ref('entry', '3'), ref('entry', '2')));
    // 子の無いフォルダの中は、addChild と同じく 2 つ深くする
    expect(out).toBe('treeView-beta\n    src/\n        main.ts\n    docs/\n      README.md\n');
    await valid(out);
    expect(treeViewPlugin.reorder!.acceptsInto!(SRC, ref('entry', '2'), ref('entry', '1'))).toBe(false);
  });
});

describe('表で編集する図種: 行をドラッグで動かす', () => {
  const row = (line: number) => ref('row', String(line));

  it('gantt: タスクを別の section の最初へ。section はタスクごと動かす', async () => {
    const SRC = 'gantt\n    dateFormat YYYY-MM-DD\n    section 設計\n    要件 :a1, 2026-01-01, 3d\n    画面 :a2, after a1, 2d\n    section 実装\n    API :b1, 2026-01-10, 5d\n';
    // 4 行目（要件）を、section 実装（6 行目）の後ろ = 実装の最初のタスクにする
    const res = move(ganttPlugin, SRC, row(4), row(6), false);
    const out = done(SRC, res);
    expect(out).toBe('gantt\n    dateFormat YYYY-MM-DD\n    section 設計\n    画面 :a2, after a1, 2d\n    section 実装\n    要件 :a1, 2026-01-01, 3d\n    API :b1, 2026-01-10, 5d\n');
    expect(res!.select).toEqual(row(6));
    await valid(out);
    // section 実装を、section 設計の前へ（中のタスクも一緒に）
    const sec = done(SRC, move(ganttPlugin, SRC, row(6), row(3), true));
    expect(sec).toBe('gantt\n    dateFormat YYYY-MM-DD\n    section 実装\n    API :b1, 2026-01-10, 5d\n    section 設計\n    要件 :a1, 2026-01-01, 3d\n    画面 :a2, after a1, 2d\n');
    await valid(sec);
    // section をタスクの間には入れない
    expect(move(ganttPlugin, SRC, row(6), row(4), false)).toBeNull();
    expect(ganttPlugin.reorder!.axis(SRC, row(4))).toBe('y');
  });

  it('向き: timeline の期間は左右。packet の欄・gitGraph の branch は動かさない', () => {
    expect(timelinePlugin.reorder!.axis('timeline\n    2024 : 設計\n    2025 : 公開\n', row(2))).toBe('x');
    expect(packetPlugin.reorder!.axis('packet-beta\n    0-15: "Source"\n    16-31: "Dest"\n', row(2))).toBeNull();
    const git = 'gitGraph\n    commit\n    branch dev\n    commit\n';
    expect(gitGraphPlugin.reorder!.axis(git, row(3))).toBeNull();
    expect(gitGraphPlugin.reorder!.axis(git, row(4))).toBe('x');
    // branch の前のただ 1 つのコミットは、動かすと branch が読めなくなる
    expect(gitGraphPlugin.reorder!.axis(git, row(2))).toBeNull();
  });

  it('quadrantChart: 点をドラッグした分だけ x・y を変える（0〜1 に収める）', async () => {
    const SRC = 'quadrantChart\n    x-axis 低 --> 高\n    y-axis 低 --> 高\n    機能A: [0.3, 0.8]\n';
    document.body.innerHTML =
      '<svg><g class="quadrants"><g class="quadrant"><rect x="0" y="0" width="100" height="100"></rect></g><g class="quadrant"><rect x="100" y="0" width="100" height="100"></rect></g>' +
      '<g class="quadrant"><rect x="0" y="100" width="100" height="100"></rect></g><g class="quadrant"><rect x="100" y="100" width="100" height="100"></rect></g></g></svg>';
    const svg = document.querySelector('svg')!;
    expect(quadrantPlugin.reorder!.axis(SRC, row(4))).toBe('free');
    const out = done(SRC, quadrantPlugin.reorder!.place!(SRC, row(4), svg, { x: 40, y: 20 }));
    expect(out).toBe('quadrantChart\n    x-axis 低 --> 高\n    y-axis 低 --> 高\n    機能A: [0.5, 0.7]\n');
    await valid(out);
    const edge = done(SRC, quadrantPlugin.reorder!.place!(SRC, row(4), svg, { x: 500, y: -500 }));
    expect(edge).toContain('機能A: [1, 1]');
    await valid(edge);
  });

  it('treemap: 項目を別の項目の中へ入れると、字下げを合わせる', async () => {
    const SRC = 'treemap-beta\n"製品"\n    "アプリ": 30\n    "サーバー": 20\n"サービス"\n    "保守": 15\n';
    const res = into(treemapPlugin, SRC, row(4), row(5));
    const out = done(SRC, res);
    expect(out).toBe('treemap-beta\n"製品"\n    "アプリ": 30\n"サービス"\n    "保守": 15\n    "サーバー": 20\n');
    expect(res!.select).toEqual(row(6));
    await checked(out);
    expect(treemapPlugin.reorder!.acceptsInto!(SRC, row(5), row(2))).toBe(true);
  });
});

describe('グラフの図種: 枠の中へ・外へ', () => {
  it('flowchart: ノードをサブグラフへ入れる・外へ出す（swimlane・agentflow も同じ）', async () => {
    const SRC = 'flowchart TD\n    A[開始] --> B\n    subgraph S1 [処理]\n        C[計算]\n    end\n    B --> C\n';
    const out = done(SRC, into(flowchartPlugin, SRC, ref('node', 'C'), null));
    expect(out).not.toMatch(/subgraph S1 \[処理\]\n\s+C\[計算\]/);
    await valid(out);
    const back = done(out, into(flowchartPlugin, out, ref('node', 'C'), ref('subgraph', 'S1')));
    await valid(back);
    // もう中にあるサブグラフ・接続を兼ねる行のノードは動かさない
    expect(into(flowchartPlugin, SRC, ref('node', 'C'), ref('subgraph', 'S1'))).toBeNull();
    expect(flowchartPlugin.reorder!.axis(SRC, ref('node', 'C'))).toBe('xy');
    expect(pluginFor('swimlane').reorder).toBe(flowchartPlugin.reorder);
    expect(pluginFor('agentflow').reorder?.into).toBeTruthy();
  });

  it('architecture: サービスをグループへ・グループの外へ（in を書き換える）', async () => {
    const SRC = 'architecture-beta\n    group api(cloud)[API]\n    group web(cloud)[Web]\n    service db(database)[DB] in api\n    service app(server)[App]\n    db:L -- R:app\n';
    const out = done(SRC, into(architecturePlugin, SRC, ref('service', 'app'), ref('group', 'web')));
    expect(out).toContain('service app(server)[App] in web\n');
    await checked(out);
    const outside = done(SRC, into(architecturePlugin, SRC, ref('service', 'db'), null));
    expect(outside).toContain('service db(database)[DB]\n');
    await checked(outside);
    expect(into(architecturePlugin, SRC, ref('service', 'db'), ref('group', 'api'))).toBeNull();
  });

  it('block: 格子の並び順を変える・入れ子のブロックへ入れる', async () => {
    const SRC = 'block-beta\n    columns 3\n    front["フロント"] api["API"]:2\n    block:back:3\n        db[("DB")] cache["キャッシュ"]\n    end\n    front --> api\n';
    const swapped = done(SRC, move(blockPlugin, SRC, ref('block-item', 'front'), ref('block-item', 'api'), false));
    expect(swapped).toContain('    api["API"]:2 front["フロント"]\n');
    await valid(swapped);
    const inside = done(SRC, into(blockPlugin, SRC, ref('block-item', 'front'), ref('block-item', 'back')));
    expect(inside).toBe('block-beta\n    columns 3\n    api["API"]:2\n    block:back:3\n        db[("DB")] cache["キャッシュ"]\n        front["フロント"]\n    end\n    front --> api\n');
    await valid(inside);
    const out = done(SRC, move(blockPlugin, SRC, ref('block-item', 'cache'), ref('block-item', 'front'), true));
    expect(out).toContain('    cache["キャッシュ"] front["フロント"] api["API"]:2\n');
    await valid(out);
    // 入れ子のブロックを自分の中へは入れない
    expect(blockPlugin.reorder!.acceptsInto!(SRC, ref('block-item', 'back'), ref('block-item', 'back'))).toBe(false);
  });

  it('cynefin: 項目を別の領域の項目の前へ・領域の中へ', async () => {
    const SRC = 'cynefin-beta\ncomplex\n    "新しい市場"\ncomplicated\n    "性能の改善" "監査"\nclear\n    "再発行"\n';
    const out = done(SRC, move(cynefinPlugin, SRC, ref('item', '2'), ref('item', '0'), true));
    expect(out).toBe('cynefin-beta\ncomplex\n    "監査" "新しい市場"\ncomplicated\n    "性能の改善"\nclear\n    "再発行"\n');
    await checked(out);
    const res = into(cynefinPlugin, SRC, ref('item', '0'), ref('domain', 'clear'));
    const moved = done(SRC, res);
    expect(moved).toContain('clear\n    "再発行"\n    "新しい市場"\n');
    await checked(moved);
    expect(res!.select).toEqual(ref('item', '3'));
  });

  it('wardley: 部品をドラッグした分だけ座標を変える（軸の線から割合を求める）', async () => {
    const SRC = 'wardley-beta\ncomponent "茶葉" [0.63, 0.81]\nanchor "客" [95.0, 63.0]\n';
    document.body.innerHTML = '<svg><g class="wardley-axes"><line x1="48" x2="852" y1="552" y2="552"></line><line x1="48" x2="48" y1="48" y2="552"></line></g></svg>';
    const svg = document.querySelector('svg')!;
    expect(wardleyPlugin.reorder!.axis(SRC, ref('component', '茶葉'))).toBe('free');
    // 右へ 80.4（進化 +0.1）、上へ 50.4（見える度合い +0.1）
    const out = done(SRC, wardleyPlugin.reorder!.place!(SRC, ref('component', '茶葉'), svg, { x: 80.4, y: -50.4 }));
    expect(out).toContain('component "茶葉" [0.73, 0.91]');
    await checked(out);
    // 0〜100 で書いた座標は 100 倍で動かし、範囲の外に出さない
    const pct = done(SRC, wardleyPlugin.reorder!.place!(SRC, ref('anchor', '客'), svg, { x: -1000, y: 0 }));
    expect(pct).toContain('anchor "客" [95.0, 0.0]');
    await checked(pct);
  });

  it('venn: 項目を別の集合・重なりの領域へ', async () => {
    const SRC = 'venn-beta\n  set A\n    text t1["一"]\n  set B\n  union A,B\n';
    const res = into(vennPlugin, SRC, ref('vtext', '0'), ref('union', 'A,B'));
    const out = done(SRC, res);
    expect(out).toBe('venn-beta\n  set A\n  set B\n  union A,B\n      text t1["一"]\n');
    await checked(out);
    expect(res!.select).toEqual(ref('vtext', '0'));
    expect(into(vennPlugin, SRC, ref('vtext', '0'), ref('set', 'A'))).toBeNull();
  });
});

describe('ドラッグの性質（描いた図の要素のすべての組で試す）', () => {
  const all = fixtures as Record<string, { source: string; svg: string }>;
  const comments = (s: string) => s.split('\n').filter((l) => /^\s*%%/.test(l));

  it('どの前後・中への移動の結果も構文として正しく、コメント行は変わらない', { timeout: 120_000 }, async () => {
    let tried = 0;
    for (const [name, { source, svg }] of Object.entries(all)) {
      const v = await validate(source);
      const type = v.ok ? v.diagramType : null;
      const spec = pluginFor(type).reorder;
      // sequence・eventmodeling・railroad の並べ替えは、それぞれのテストで確かめる
      // （sequence は活性化の +/- の順が崩れる移動もあり、それは applyDiagramChange の検証で弾く）
      if (!spec || ['sequence', 'eventmodeling'].includes(type ?? '') || type?.startsWith('railroad')) continue;
      document.body.innerHTML = `<div>${svg}</div>`;
      const refs = pluginFor(type)
        .mapTargets(document.querySelector('svg')!, source)
        .flatMap((x) => (x.ref ? [x.ref] : []));
      for (const a of refs) {
        const axis = spec.axis(source, a);
        if (!axis || axis === 'free') continue;
        for (const b of [...refs, null]) {
          const results = [
            b && spec.accepts?.(a, b, source) ? spec.move!(source, a, b, true) : null,
            b && spec.accepts?.(a, b, source) ? spec.move!(source, a, b, false) : null,
            spec.acceptsInto?.(source, a, b) ? spec.into!(source, a, b) : null,
          ];
          for (const res of results) {
            if (!res) continue;
            const out = applySpec(source, res.change);
            const r = await validate(out);
            expect(r.ok, `${name}: ${a.kind}:${a.id} → ${b ? `${b.kind}:${b.id}` : '外'}\n${out}`).toBe(true);
            expect(comments(out).sort()).toEqual(comments(source).sort());
            tried++;
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(50);
  });
});

describe('ドラッグで動かせない図種', () => {
  it('state・class・ER は自動レイアウトで、動かしても位置が決まらないので、ドラッグはパンになる', () => {
    for (const type of ['stateDiagram', 'classDiagram', 'er']) expect(pluginFor(type).reorder).toBeUndefined();
  });
});

describe('ドラッグの落とし先と変更の細かい決まり', () => {
  const row = (line: number) => ref('row', String(line));
  const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
  const c = (item: string, rect: ReturnType<typeof r>, sibling: boolean, into: boolean): DragCandidate<string> => ({ item, rect, sibling, into });

  it('上下の並びでも、横に離れた要素（mindmap の根の反対側・timeline の別の列）は遠いとみなす', () => {
    // U は右側（中心 y=100）、V は左側（中心 y=90）。右側で U の上の端を指したら U の前
    const list = markContainers([c('V', r(0, 80, 60, 20), true, false), c('U', r(300, 90, 60, 20), true, false)]);
    expect(resolveDrop('y', { x: 330, y: 88 }, list, false)).toMatchObject({ kind: 'move', item: 'U', before: true });
    // 同じ高さの 2 つの列: 指している列の要素
    const cols = markContainers([c('b', r(0, 40, 60, 20), true, false), c('d', r(200, 40, 60, 20), true, false)]);
    expect(resolveDrop('y', { x: 230, y: 52 }, cols, false)).toMatchObject({ kind: 'move', item: 'd' });
  });

  it('xy の並びでは、左右の端は前後、真ん中だけ中。重なっていれば一番内側の要素の中', () => {
    const list = markContainers([c('a', r(0, 0, 100, 100), true, true), c('b', r(120, 0, 100, 100), true, true)]);
    expect(resolveDrop('xy', { x: 50, y: 50 }, list, false)).toMatchObject({ kind: 'into', item: 'a' });
    expect(resolveDrop('xy', { x: 5, y: 50 }, list, false)).toMatchObject({ kind: 'move', item: 'a', before: true });
    expect(resolveDrop('xy', { x: 95, y: 50 }, list, false)).toMatchObject({ kind: 'move', item: 'a', before: false });
    // 前後に落とせない、重なった 2 つの領域（venn の集合と重なり）: 小さいほう
    const venn = [c('A', r(0, 0, 200, 200), false, true), c('AB', r(150, 50, 100, 100), false, true)].map((x) => ({ ...x, container: false }));
    expect(resolveDrop('y', { x: 180, y: 100 }, venn, false)).toMatchObject({ kind: 'into', item: 'AB' });
  });

  it('treemap: 入れ子の項目を、親のすぐ後ろ（次の項目の前）へ出せる', async () => {
    const SRC = 'treemap-beta\n"A"\n    "a1": 10\n    "a2": 20\n"B"\n    "b1": 5\n';
    const out = done(SRC, move(treemapPlugin, SRC, row(4), row(5), true));
    expect(out).toBe('treemap-beta\n"A"\n    "a1": 10\n"a2": 20\n"B"\n    "b1": 5\n');
    await checked(out);
    // 親の後ろへ落としても同じ
    expect(done(SRC, move(treemapPlugin, SRC, row(4), row(2), false))).toBe(out);
  });

  it('間にコメントがあっても、並びの変わらないドロップは何もしない（コメントだけを動かさない）', () => {
    const SRC = 'gantt\n    dateFormat YYYY-MM-DD\n    section 設計\n    要件 :a1, 2026-01-01, 3d\n    %% 注記\n    画面 :a2, after a1, 2d\n';
    expect(move(ganttPlugin, SRC, row(4), row(6), true)).toBeNull();
    expect(move(ganttPlugin, SRC, row(6), row(4), false)).toBeNull();
    const KB = 'kanban\n  todo[やる]\n    c1[設計]\n    %% 注記\n    c2[実装]\n';
    expect(move(kanbanPlugin, KB, ref('card', 'c1'), ref('card', 'c2'), true)).toBeNull();
  });

  it('表の行: section はタスクを、timeline の期間はイベントを落とし先の候補にしない', () => {
    const SRC = 'gantt\n    dateFormat YYYY-MM-DD\n    section 設計\n    要件 :a1, 2026-01-01, 3d\n    section 実装\n    API :b1, 2026-01-10, 5d\n';
    const spec = ganttPlugin.reorder!;
    expect(spec.accepts!(row(5), row(4), SRC)).toBe(false);
    expect(spec.accepts!(row(5), row(3), SRC)).toBe(true);
    expect(spec.accepts!(row(4), row(5), SRC)).toBe(true);
    const TL = 'timeline\n    2024 : 設計\n         : 試作\n    2025 : 公開\n';
    expect(timelinePlugin.reorder!.accepts!(row(2), row(3), TL)).toBe(false);
    expect(timelinePlugin.reorder!.accepts!(row(2), row(4), TL)).toBe(true);
  });

  it('gitGraph: 縦向き（TB・BT）ではコミットを上下に並べ替える。BT は下が前', async () => {
    const LR = 'gitGraph\n    commit id: "a"\n    commit id: "b"\n';
    expect(gitGraphPlugin.reorder!.axis(LR, row(2))).toBe('x');
    const TB = 'gitGraph TB:\n    commit id: "a"\n    commit id: "b"\n';
    expect(gitGraphPlugin.reorder!.axis(TB, row(2))).toBe('y');
    const BT = 'gitGraph BT:\n    commit id: "a"\n    commit id: "b"\n';
    // BT で a を b の上（画面の前 = before）へ落とすと、ソースでは b の後ろ
    const out = done(BT, move(gitGraphPlugin, BT, row(2), row(3), true));
    expect(out).toBe('gitGraph BT:\n    commit id: "b"\n    commit id: "a"\n');
    await valid(out);
  });

  it('quadrantChart: 動かしていない座標の書き方は変えず、変わらなければ何もしない', () => {
    const SRC = 'quadrantChart\n    x-axis 低 --> 高\n    y-axis 低 --> 高\n    機能A: [0.30, 0.80]\n';
    document.body.innerHTML = '<svg><g class="quadrants"><g class="quadrant"><rect x="0" y="0" width="200" height="200"></rect></g></g></svg>';
    const svg = document.querySelector('svg')!;
    expect(done(SRC, quadrantPlugin.reorder!.place!(SRC, row(4), svg, { x: 40, y: 0 }))).toContain('機能A: [0.5, 0.80]');
    expect(quadrantPlugin.reorder!.place!(SRC, row(4), svg, { x: 0.3, y: -0.3 })).toBeNull();
  });

  it('wardley: 0〜100 で書いた座標が 1 以下になったら割合で書く（1 以下は割合として読まれる）', async () => {
    const SRC = 'wardley-beta\nanchor "客" [95.0, 63.0]\n';
    document.body.innerHTML = '<svg><g class="wardley-axes"><line x1="0" x2="1000" y1="500" y2="500"></line><line x1="0" x2="0" y1="0" y2="500"></line></g></svg>';
    const svg = document.querySelector('svg')!;
    const out = done(SRC, wardleyPlugin.reorder!.place!(SRC, ref('anchor', '客'), svg, { x: -625, y: 0 }));
    expect(out).toContain('anchor "客" [95.0, 0.005]');
    await checked(out);
    // 動かさなければ何もしない
    expect(wardleyPlugin.reorder!.place!(SRC, ref('anchor', '客'), svg, { x: 0, y: 0 })).toBeNull();
  });

  it('block: 1 行に並んだブロックの間へ入れ子のブロックを動かすと、行をそこで分ける', async () => {
    const SRC = 'block-beta\n    columns 3\n    a b c\n    block:g\n        x\n    end\n';
    const out = done(SRC, move(blockPlugin, SRC, ref('block-item', 'g'), ref('block-item', 'a'), false));
    expect(out).toBe('block-beta\n    columns 3\n    a\n    block:g\n        x\n    end\n    b c\n');
    await valid(out);
    const before = done(SRC, move(blockPlugin, SRC, ref('block-item', 'g'), ref('block-item', 'c'), true));
    expect(before).toBe('block-beta\n    columns 3\n    a b\n    block:g\n        x\n    end\n    c\n');
    await valid(before);
  });

  it('flowchart・architecture: 枠の外にある要素は、図の一番外を落とし先にしない（動かす先が無ければパンになる）', () => {
    const FC = 'flowchart LR\n    A --> B\n    subgraph S\n        C\n    end\n';
    expect(flowchartPlugin.reorder!.acceptsInto!(FC, ref('node', 'A'), null)).toBe(false);
    expect(flowchartPlugin.reorder!.acceptsInto!(FC, ref('node', 'C'), null)).toBe(true);
    const AR = 'architecture-beta\n    group api(cloud)[API]\n    service db(database)[DB] in api\n    service app(server)[App]\n';
    expect(architecturePlugin.reorder!.acceptsInto!(AR, ref('service', 'app'), null)).toBe(false);
    expect(architecturePlugin.reorder!.acceptsInto!(AR, ref('service', 'db'), null)).toBe(true);
  });

  it('形で当たりを決める領域（venn の円）は、外接矩形にかかっていても、形の外なら選ばない', () => {
    // A（中心 100,100・半径 100 の円）・B（中心 250,100・半径 100）と、その重なり
    const circle = (cx: number, cy: number) => (p: { x: number; y: number }) => Math.hypot(p.x - cx, p.y - cy) <= 100;
    const venn = markContainers([
      { ...c('A', r(0, 0, 200, 200), false, true), hit: circle(100, 100) },
      { ...c('B', r(150, 0, 200, 200), false, true), hit: circle(250, 100) },
      { ...c('AB', r(150, 15, 50, 170), false, true), hit: (p) => circle(100, 100)(p) && circle(250, 100)(p) },
    ]);
    // B と重なりの外接矩形の中でも、A の円にしか入っていなければ A
    expect(resolveDrop('xy', { x: 160, y: 30 }, venn, false)).toMatchObject({ kind: 'into', item: 'A' });
    expect(resolveDrop('xy', { x: 175, y: 100 }, venn, false)).toMatchObject({ kind: 'into', item: 'AB' });
    expect(resolveDrop('xy', { x: 300, y: 100 }, venn, false)).toMatchObject({ kind: 'into', item: 'B' });
  });

  it('インデントの木: 自分の子孫の前後は、落とし先の候補にしない（動かせないので線を出さない）', () => {
    const MM = 'mindmap\n  root((Studio))\n    表示\n      ::icon(fa fa-eye)\n      全図種\n    編集\n      テキスト\n';
    expect(mindmapPlugin.reorder!.accepts!(ref('topic', '1'), ref('topic', '2'), MM)).toBe(false);
    expect(move(mindmapPlugin, MM, ref('topic', '1'), ref('topic', '2'), true)).toBeNull();
    expect(mindmapPlugin.reorder!.accepts!(ref('topic', '1'), ref('topic', '4'), MM)).toBe(true);
    expect(mindmapPlugin.reorder!.accepts!(ref('topic', '2'), ref('topic', '1'), MM)).toBe(true);
  });

  it('quadrantChart: 同じ名前の点は、位置の順で行に対応付ける（ドラッグした点の行を書き換える）', () => {
    const SRC = 'quadrantChart\n    A: [0.1, 0.1]\n    A: [0.9, 0.9]\n';
    // 描く順はソースの逆のことがある
    const point = (cx: number, cy: number) => `<g class="data-point"><circle cx="${cx}" cy="${cy}" r="5"></circle><text>A</text></g>`;
    document.body.innerHTML = `<div><svg><g class="data-points">${point(180, 20)}${point(20, 180)}</g></svg></div>`;
    const svg = document.querySelector('svg')!;
    const targets = pluginFor('quadrantChart').mapTargets(svg, SRC);
    const at = (cx: string) => targets.find((x) => x.el.querySelector('circle')?.getAttribute('cx') === cx)?.ref;
    expect(at('20')).toEqual(row(2));
    expect(at('180')).toEqual(row(3));
  });
});
