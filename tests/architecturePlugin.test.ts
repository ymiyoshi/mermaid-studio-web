// @vitest-environment jsdom
// architecture 図のプラグイン。図からの操作の結果が mermaid.parse を通ること、対象の行以外（コメント・空行）が変わらないことを確かめる
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import { archLayout, architecturePlugin, parseArchitecture } from '../src/plugins/architecture';
import { pluginFor } from '../src/plugins/registry';
import { validate } from '../src/render/mermaid';
import type { DiagramTarget, ElementRef } from '../src/plugins/types';

const all = fixtures as Record<string, { source: string; svg: string }>;
const FULL = all['architecture-full'].source;

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function apply(source: string, change: ChangeSpec | null | undefined) {
  expect(change).toBeTruthy();
  const out = ChangeSet.of(change!, source.length).apply(Text.of(source.split('\n'))).toString();
  const r = await validate(out);
  expect(r.ok, `通らない: ${out}`).toBe(true);
  return out;
}

const run = (id: string, source: string, refs: ElementRef[] = []) => architecturePlugin.actions!.find((a) => a.id === id)!.run(source, refs);
const prop = (source: string, ref: ElementRef | null, field: string, value: string) => architecturePlugin.setProperty!(source, ref, field, value);
const field = (source: string, ref: ElementRef | null, id: string) => architecturePlugin.inspect!(source, ref).find((f) => f.id === id);
const service = (id: string): ElementRef => ({ kind: 'service', id });
const group = (id: string): ElementRef => ({ kind: 'group', id });
const edge = (i: number): ElementRef => ({ kind: 'edge', id: String(i) });

function load(id: string): { source: string; targets: DiagramTarget[] } {
  const f = all[id];
  document.body.innerHTML = `<div>${f.svg}</div>`;
  return { source: f.source, targets: architecturePlugin.mapTargets(document.querySelector('svg')!, f.source) };
}
const refsOf = (targets: DiagramTarget[], kind: string) => targets.filter((x) => x.ref?.kind === kind).map((x) => x.ref!.id);

describe('architecture 図を読む', () => {
  it('宣言・線・align を、ID と範囲つきで読む', () => {
    const p = parseArchitecture(FULL);
    expect(p.nodes.map((n) => `${n.kind}:${n.id}${n.parent ? `<${n.parent.value}` : ''}`)).toEqual([
      'group:cloud',
      'group:inner<cloud',
      'service:web',
      'service:api<cloud',
      'service:db<inner',
      'service:bare<cloud',
      'junction:j1<cloud',
    ]);
    const db = p.nodes.find((n) => n.id === 'db')!;
    // 引用符で囲んだラベルは内側を指す
    expect(FULL.slice(db.label!.range.from, db.label!.range.to)).toBe('データ ベース');
    expect(p.edges.map((e) => `${e.a}:${e.as.value} ${FULL.slice(e.arrow.from, e.arrow.to)} ${e.bs.value}:${e.b}`)).toEqual([
      'web:R --> L:api',
      'api:B -[読み書き]- T:j1',
      'j1:R -- L:db',
      'j1:B <--> T:bare',
    ]);
    expect(p.edges[1].label!.value).toBe('読み書き');
  });

  it('- を含む ID や、: の前後の空白・行末のコメントも読む', () => {
    const p = parseArchitecture('architecture-beta\n  service a-b(server)[A]\n  service c[C]\n  a-b : R -- L : c %% メモ\n  align row a-b c\n');
    expect(p.nodes.map((n) => n.id)).toEqual(['a-b', 'c']);
    expect(p.edges.map((e) => [e.a, e.b])).toEqual([['a-b', 'c']]);
    expect(p.aligns[0].members.map((m) => m.id)).toEqual(['a-b', 'c']);
  });
});

describe('SVG との対応付け', () => {
  it('サービス・junction・グループ・線を ID と両端で対応付ける', () => {
    const { source, targets } = load('architecture-full');
    expect(refsOf(targets, 'service').sort()).toEqual(['api', 'bare', 'db', 'web']);
    expect(refsOf(targets, 'junction')).toEqual(['j1']);
    expect(refsOf(targets, 'group').sort()).toEqual(['cloud', 'inner']);
    expect(refsOf(targets, 'edge')).toEqual(['0', '1', '2', '3']);
    const at = (t: DiagramTarget) => source.slice(t.range!.from, t.range!.to);
    expect(at(targets.find((x) => x.ref?.id === 'api')!)).toBe('API サーバー');
    expect(at(targets.find((x) => x.ref?.id === 'inner')!)).toBe('内側');
    const rw = targets.find((x) => x.ref?.kind === 'edge' && x.ref.id === '1')!;
    expect(rw.label).toBe('読み書き');
    expect(at(rw)).toBe('読み書き');
  });

  it('ラベルの無いサービスと線は、[…] を差し込める', () => {
    const { source, targets } = load('architecture-full');
    const bare = targets.find((x) => x.ref?.id === 'bare')!;
    expect(bare.range).toBeNull();
    expect(source.slice(bare.insertAt!.at - 'bare'.length, bare.insertAt!.at)).toBe('bare');
    const plain = targets.find((x) => x.ref?.kind === 'edge' && x.ref.id === '2')!;
    const at = plain.insertAt!.at;
    // j1:R -- L:db の 2 つの - の間に差し込む
    expect(source.slice(at - 1, at + 1)).toBe('--');
  });

  it('登録した図種で使われる', () => {
    expect(pluginFor('architecture')).toBe(architecturePlugin);
  });
});

describe('図からの操作', () => {
  it('サービス・グループを足す', async () => {
    let res = run('add-service', FULL)!;
    let out = await apply(FULL, res.change);
    expect(out).toContain('    junction j1 in cloud\n    service svc1(server)[新しいサービス]\n    %% コメント');
    expect(res.focus).toEqual(service('svc1'));
    res = run('add-group', FULL)!;
    out = await apply(FULL, res.change);
    expect(out).toContain('    group grp1(cloud)[新しいグループ]\n');
  });

  it('次のサービス（Tab）は、同じグループに入れて線でつなぐ', async () => {
    const out = await apply(FULL, run('add-next', FULL, [service('api')])!.change);
    expect(out).toContain('    service api(server)[API サーバー] in cloud\n    service svc1(server)[新しいサービス] in cloud\n');
    expect(out).toContain('    j1:B <--> T:bare\n    api:R -- L:svc1');
    // 線が無い図では、宣言の次に線も足す
    const src = 'architecture-beta\n    service a(server)[A]\n';
    expect(await apply(src, run('add-next', src, [service('a')])!.change)).toBe('architecture-beta\n    service a(server)[A]\n    service svc1(server)[新しいサービス]\n    a:R -- L:svc1\n');
  });

  it('次のサービスは、mermaid の配置で空いている升目に向かう辺でつなぐ（重ならない）', async () => {
    // server の右（R）には db があるので、右へ足すと db と同じ升目に重なる
    const src = 'architecture-beta\n    group api(cloud)[API]\n    service db(database)[データベース] in api\n    service server(server)[サーバー] in api\n    db:L -- R:server\n';
    const out = await apply(src, run('add-next', src, [service('server')])!.change);
    expect(out).toContain('    server:B -- T:svc1\n');
    const { pos } = archLayout(parseArchitecture(out));
    const cells = [...pos.values()].map((c) => c.join(','));
    expect(new Set(cells).size).toBe(cells.length);
    // 続けて足しても重ならない
    const out2 = await apply(out, run('add-next', out, [service('server')])!.change);
    const cells2 = [...archLayout(parseArchitecture(out2)).pos.values()].map((c) => c.join(','));
    expect(new Set(cells2).size).toBe(cells2.length);
  });

  it('同じつながりの 2 つをつなぐときは、今の位置の向きの辺を使う', async () => {
    const src = 'architecture-beta\n    service a(server)[A]\n    service b(server)[B]\n    service c(server)[C]\n    a:R -- L:b\n    b:B -- T:c\n';
    // c は a の右下。横の差と縦の差が同じなら横（R）でつなぐ
    expect(await apply(src, run('connect', src, [service('a'), service('c')])!.change)).toContain('    a:R -- L:c\n');
    expect(await apply(src, run('connect', src, [service('c'), service('b')])!.change)).toContain('    c:T -- B:b\n');
  });

  it('グループの中にサービスを足す', async () => {
    const out = await apply(FULL, run('add-inside', FULL, [group('inner')])!.change);
    expect(out).toContain('    service db(database)["データ ベース"] in inner\n    service svc1(server)[新しいサービス] in inner\n');
  });

  it('サービスと junction を線でつなぐ（グループどうしはつながない）', async () => {
    const out = await apply(FULL, run('connect', FULL, [service('web'), { kind: 'junction', id: 'j1' }])!.change);
    expect(out.trimEnd().endsWith('    web:R -- L:j1')).toBe(true);
    expect(architecturePlugin.actions!.find((a) => a.id === 'connect')!.appliesTo).not.toContain('group');
  });

  it('サービスを消すと、つながる線も消え、コメントは残る', async () => {
    const out = await apply(FULL, run('delete', FULL, [{ kind: 'junction', id: 'j1' }])!.change);
    expect(out).not.toMatch(/j1/);
    expect(out).toContain('    %% コメント\n    web:R --> L:api{group}');
    expect(out.trimEnd().endsWith('web:R --> L:api{group}')).toBe(true);
  });

  it('ID の前方一致では消さない（a を消しても a-b は残る）・align から外す', async () => {
    const src = 'architecture-beta\n  service a(server)[A]\n  service a-b(server)[AB]\n  service c(server)[C]\n  a-b:R -- L:c\n  c:R -- L:a\n  align row a a-b c\n';
    const out = await apply(src, run('delete', src, [service('a')])!.change);
    expect(out).toBe('architecture-beta\n  service a-b(server)[AB]\n  service c(server)[C]\n  a-b:R -- L:c\n  align row a-b c\n');
    // 2 つ未満になる align は行ごと消す
    const out2 = await apply(out, run('delete', out, [service('c')])!.change);
    expect(out2).toBe('architecture-beta\n  service a-b(server)[AB]\n');
  });

  it('align の行末のコメントの語はメンバーにしない', async () => {
    const src = 'architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  service c(server)[C]\n  align row a b %% c と並べる\n';
    expect(parseArchitecture(src).aligns[0].members.map((m) => m.id)).toEqual(['a', 'b']);
    // 2 つ未満になるので行ごと消える（コメントの語を数えて残したりしない）
    expect(await apply(src, run('delete', src, [service('a')])!.change)).not.toContain('align');
    // ID を変えても、コメントの中の同じ語は変えない
    expect(await apply(src, prop(src, service('c'), 'id', 'd'))).toContain('align row a b %% c と並べる');
  });

  it('宣言の無い図に足すときも、インデントを付ける', async () => {
    const src = 'architecture-beta\n';
    expect(await apply(src, run('add-service', src)!.change)).toBe('architecture-beta\n    service svc1(server)[新しいサービス]\n');
    expect(await apply(src, run('add-group', src)!.change)).toBe('architecture-beta\n    group grp1(cloud)[新しいグループ]\n');
  });

  it('線を消す', async () => {
    const out = await apply(FULL, run('delete', FULL, [edge(1)])!.change);
    expect(out).not.toContain('読み書き');
    expect(out).toContain('    web:R --> L:api{group}\n    j1:R -- L:db');
  });

  it('グループの枠を外すと、中の要素は外側のグループに移る', async () => {
    let out = await apply(FULL, run('unwrap', FULL, [group('inner')])!.change);
    expect(out).not.toContain('group inner');
    expect(out).toContain('service db(database)["データ ベース"] in cloud\n');
    out = await apply(out, run('unwrap', out, [group('cloud')])!.change);
    expect(out).toContain('    service api(server)[API サーバー]\n    service db(database)["データ ベース"]\n    service bare\n    junction j1\n');
  });

  it('グループを中身ごと消す（入れ子のグループ・中の要素・つながる線）', async () => {
    const out = await apply(FULL, run('delete-group', FULL, [group('cloud')])!.change);
    expect(out).toBe('architecture-beta\n    title 構成\n    service web(internet)[ウェブ]\n    %% コメント');
    const inner = await apply(FULL, run('delete-group', FULL, [group('inner')])!.change);
    expect(inner).not.toMatch(/inner|db/);
    expect(inner).toContain('service api(server)[API サーバー] in cloud');
  });
});

describe('プロパティ', () => {
  it('ID を変えると、in・線の両端・align の参照も変わる', async () => {
    const src = `${FULL}\n    align row api bare`;
    const out = await apply(src, prop(src, service('api'), 'id', 'backend'));
    expect(out).toContain('service backend(server)[API サーバー] in cloud');
    expect(out).toContain('web:R --> L:backend{group}');
    expect(out).toContain('backend:B -[読み書き]- T:j1');
    expect(out).toContain('align row backend bare');
    const g = await apply(FULL, prop(FULL, group('cloud'), 'id', 'aws'));
    expect(g).toContain('group inner(server)[内側] in aws');
    expect(g).toContain('junction j1 in aws');
    // 使えない ID（日本語・重複）は反映しない
    expect(prop(FULL, service('api'), 'id', 'サーバー')).toBeNull();
    expect(prop(FULL, service('api'), 'id', 'db')).toBeNull();
    expect(prop(FULL, service('api'), 'id', 'cloud')).toBeNull();
  });

  it('ラベルを変える・空にすると [ ] を外す・無ければ足す', async () => {
    expect(await apply(FULL, prop(FULL, service('db'), 'label', '記録'))).toContain('service db(database)["記録"] in inner');
    expect(await apply(FULL, prop(FULL, service('api'), 'label', 'x [1]'))).toContain('service api(server)[x (1)] in cloud');
    expect(await apply(FULL, prop(FULL, service('api'), 'label', ''))).toContain('    service api(server) in cloud\n');
    expect(await apply(FULL, prop(FULL, service('bare'), 'label', '素'))).toContain('    service bare[素] in cloud\n');
    expect(await apply(FULL, prop(FULL, group('inner'), 'label', '中'))).toContain('group inner(server)[中] in cloud');
  });

  it('アイコンを変える・外す・足す', async () => {
    expect(field(FULL, service('web'), 'icon')!.value).toBe('internet');
    expect(await apply(FULL, prop(FULL, service('web'), 'icon', 'disk'))).toContain('service web(disk)[ウェブ]');
    expect(await apply(FULL, prop(FULL, service('web'), 'icon', ''))).toContain('service web[ウェブ]');
    expect(await apply(FULL, prop(FULL, service('bare'), 'icon', 'server'))).toContain('service bare(server) in cloud');
  });

  it('グループを移す・外す・入れる（自分の中のグループには入れない）', async () => {
    expect(await apply(FULL, prop(FULL, service('api'), 'parent', 'inner'))).toContain('service api(server)[API サーバー] in inner');
    expect(await apply(FULL, prop(FULL, service('api'), 'parent', ''))).toContain('    service api(server)[API サーバー]\n');
    expect(await apply(FULL, prop(FULL, service('web'), 'parent', 'inner'))).toContain('service web(internet)[ウェブ] in inner');
    expect(prop(FULL, group('cloud'), 'parent', 'inner')).toBeNull();
    expect(field(FULL, group('cloud'), 'parent')!.options!.map((o) => o.value)).toEqual(['']);
  });

  it('線の辺・矢印・ラベル', async () => {
    expect(await apply(FULL, prop(FULL, edge(2), 'as', 'B'))).toContain('j1:B -- L:db');
    expect(field(FULL, edge(3), 'arrow')!.value).toBe('both');
    expect(await apply(FULL, prop(FULL, edge(2), 'arrow', 'forward'))).toContain('j1:R --> L:db');
    expect(await apply(FULL, prop(FULL, edge(0), 'arrow', 'back'))).toContain('web:R <-- L:api{group}');
    expect(await apply(FULL, prop(FULL, edge(3), 'arrow', 'none'))).toContain('j1:B -- T:bare');
    expect(await apply(FULL, prop(FULL, edge(1), 'label', ''))).toContain('api:B -- T:j1');
    expect(await apply(FULL, prop(FULL, edge(3), 'label', '監視'))).toContain('j1:B <-[監視]-> T:bare');
  });

  it('図全体の題名', async () => {
    expect(field(FULL, null, 'title')!.value).toBe('構成');
    expect(await apply(FULL, prop(FULL, null, 'title', '全体'))).toContain('    title 全体\n');
    expect(await apply(FULL, prop(FULL, null, 'title', ''))).not.toContain('title');
  });
});
