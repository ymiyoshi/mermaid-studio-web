// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { convertTree, readTree, TREE_KINDS } from '../src/plugins/convertTree';
import { TEMPLATES } from '../src/core/templates';

// 設計書 §17.7: 木の図種（mindmap・treeView・ishikawa）の相互変換

const tpl = (id: string) => TEMPLATES.find((x) => x.id === id)!.text;
const SOURCES = { mindmap: tpl('mindmap'), treeView: tpl('treeview'), ishikawa: tpl('ishikawa') } as const;

describe('木の図種の変換', () => {
  for (const from of TREE_KINDS) {
    for (const to of TREE_KINDS) {
      if (from === to) continue;
      it(`${from} → ${to} は mermaid.parse を通り、ラベルの木が変わらない（根が 1 つになる分を除く）`, async () => {
        const out = convertTree(SOURCES[from], from, to)!;
        expect(out).toBeTruthy();
        const r = await mermaid.parse(out);
        expect(r && r.diagramType).toBe(to);
        const before = readTree(SOURCES[from], from)!;
        const after = readTree(out, to)!;
        const labels = (ts: ReturnType<typeof readTree>): string[] => (ts ?? []).flatMap((n) => [n.label, ...labels(n.children)]);
        // treeView は根が複数でもよいので、根をまとめた分だけラベルが 1 つ増えることがある
        const a = labels(after);
        const b = labels(before);
        expect(a.slice(a.length - b.length)).toEqual(b.map((l) => l.replace(/\/$/, '')));
      });
    }
  }

  it('mindmap の形の括弧と読まれる文字を含むラベルは ["…"] で囲み、frontmatter は残す', async () => {
    const src = '---\nconfig:\n  theme: forest\n---\ntreeView-beta\n    "a (b)"/\n        c[1]\n';
    const out = convertTree(src, 'treeView', 'mindmap')!;
    expect(out).toBe('---\nconfig:\n  theme: forest\n---\nmindmap\n  ["a (b)"]\n    ["c[1]"]\n');
    await expect(mermaid.parse(out)).resolves.toBeTruthy();
  });

  it('根が複数の treeView を mindmap・ishikawa にすると、1 つの根にまとめる', async () => {
    const src = 'treeView-beta\n    a\n    b\n';
    const mm = convertTree(src, 'treeView', 'mindmap')!;
    expect(mm).toBe('mindmap\n  ルート\n    a\n    b\n');
    await expect(mermaid.parse(mm)).resolves.toBeTruthy();
    const ik = convertTree(src, 'treeView', 'ishikawa')!;
    expect(ik).toBe('ishikawa-beta\nルート\n    a\n    b\n');
    await expect(mermaid.parse(ik)).resolves.toBeTruthy();
  });

  it('罫線で書いた treeView は変換しない', () => {
    expect(convertTree('treeView-beta\n├── a\n└── b\n', 'treeView', 'mindmap')).toBeNull();
  });
});
