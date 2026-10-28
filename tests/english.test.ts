// @vitest-environment jsdom
// 英語の UI。言語はモジュールを読み込むときに決まるので、localStorage に英語を入れてから読み込み直す。
// 各図種の見本に、図からの操作をすべて当て、結果が mermaid.parse を通ること・差し込む文言が英語であることを確かめる。
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import fixtures from './fixtures/rendered-svg.json';
import type { DiagramPlugin, ElementRef } from '../src/plugins/types';

type Fixture = { source: string; svg: string };
const all = fixtures as Record<string, Fixture>;

const TYPES: Record<string, string> = {
  flowchart: 'flowchart-v2',
  'flowchart-full': 'flowchart-v2',
  sequence: 'sequence',
  'sequence-full': 'sequence',
  class: 'classDiagram',
  state: 'stateDiagram',
  er: 'er',
  mindmap: 'mindmap',
  kanban: 'kanban',
  block: 'block',
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
};

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

let pluginFor: (t: string | null) => DiagramPlugin;
let validate: (s: string) => Promise<{ ok: boolean }>;
let t: (k: never) => string;
let TEMPLATES: { id: string; name: string }[];

beforeAll(async () => {
  localStorage.setItem('mermaid-studio-lang', 'en');
  vi.resetModules();
  ({ pluginFor } = await import('../src/plugins/registry'));
  ({ validate } = await import('../src/render/mermaid'));
  ({ t } = (await import('../src/i18n')) as never);
  ({ TEMPLATES } = await import('../src/core/templates'));
});

const apply = (source: string, change: Parameters<typeof ChangeSet.of>[0]) => ChangeSet.of(change, source.length).apply(Text.of(source.split('\n'))).toString();

/** 結果に出てくる日本語のうち、元のソースに無いもの（＝操作が差し込んだ日本語）。並べ替えや削除で動いただけの文言は数えない */
function newJapanese(before: string, after: string): string[] {
  return [...after.matchAll(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+/gu)].map((m) => m[0]).filter((w) => !before.includes(w));
}

describe('英語の UI', () => {
  it('画面の文言とテンプレートの名前が英語になる', () => {
    expect((t as (k: string) => string)('doc.new')).toBe('New');
    expect(TEMPLATES.find((x) => x.id === 'flowchart')!.name).toBe('Flowchart');
    for (const x of TEMPLATES) expect(x.name, x.id).not.toMatch(JAPANESE);
  });

  it('プラグインの操作名・プロパティ名に日本語が残っていない', () => {
    for (const type of new Set(Object.values(TYPES))) {
      const p = pluginFor(type);
      for (const a of p.actions ?? []) {
        expect(a.title, `${type}:${a.id}`).not.toMatch(JAPANESE);
        if (a.prompt) expect(a.prompt, `${type}:${a.id}`).not.toMatch(JAPANESE);
      }
      for (const tb of p.tables ?? []) {
        expect(tb.title).not.toMatch(JAPANESE);
        for (const s of tb.schemas) for (const f of s.fields) expect(`${s.title} ${f.label}`, type).not.toMatch(JAPANESE);
      }
    }
  });

  for (const [id, type] of Object.entries(TYPES)) {
    it(`${id}: すべての操作の結果が mermaid の構文として正しく、差し込む文言は英語`, async () => {
      const f = all[id];
      document.body.innerHTML = `<div>${f.svg}</div>`;
      const svg = document.querySelector('svg')!;
      const plugin = pluginFor(type);
      const refs = plugin
        .mapTargets(svg, f.source)
        .map((x) => x.ref)
        .filter((r): r is ElementRef => !!r);
      for (const a of plugin.actions ?? []) {
        const targets = a.arity === 0 ? [[]] : refs.filter((r) => (a.appliesTo ?? ['node']).includes(r.kind)).slice(0, 2).map((r) => (a.arity === 2 ? [r, refs.find((x) => x !== r && (a.targetKinds ?? a.appliesTo ?? ['node']).includes(x.kind)) ?? r] : [r]));
        for (const args of targets) {
          const res = a.run(f.source, args as ElementRef[]);
          if (!res) continue;
          const out = apply(f.source, res.change);
          // 図の構文が壊れる操作は、アプリでは反映しない（日本語でも同じ）。ここでは英語の既定の文言が原因でないことを見る
          const r = await validate(out);
          // シーケンス図で、活性化（+ / -）や create / destroy の付いたメッセージを動かすと構文が壊れることがある。
          // 日本語でも同じで、アプリは検証で弾いて反映しない（文言を差し込まない操作なので、英語の確認には関係しない）
          if (!r.ok && /^move-/.test(a.id)) continue;
          expect(r.ok, `${id} ${a.id}: ${out}`).toBe(true);
          expect(newJapanese(f.source, out), `${id} ${a.id}`).toEqual([]);
          expect(newJapanese(f.source, res.label), `${id} ${a.id}`).toEqual([]);
        }
      }
    });
  }
});
