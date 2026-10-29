// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getFrontmatterValue, parseFrontmatter, setFrontmatterValue } from '../src/plugins/frontmatter';
import { applySpec } from '../src/plugins/source';
import { validate } from '../src/render/mermaid';

const BODY = 'flowchart LR\n  %% メモ\n  A --> B\n';
const THEME = ['config', 'theme'];
const PRIMARY = ['config', 'themeVariables', 'primaryColor'];

/** 変更を当て、mermaid.parse を通ることを確かめる */
async function set(source: string, path: string[], value: string) {
  const spec = setFrontmatterValue(source, path, value);
  const out = spec ? applySpec(source, spec) : source;
  expect((await validate(out)).ok, out).toBe(true);
  return out;
}

describe('図の先頭の設定（frontmatter）', () => {
  it('無ければ frontmatter ごと足し、図の本文は変えない', async () => {
    const out = await set(BODY, THEME, 'forest');
    expect(out).toBe(`---\nconfig:\n  theme: forest\n---\n${BODY}`);
    expect(getFrontmatterValue(out, THEME)).toBe('forest');
  });

  it('色は # を含むので引用符で囲み、入れ子のキーを足す', async () => {
    const withTheme = await set(BODY, THEME, 'base');
    const out = await set(withTheme, PRIMARY, '#ffcc00');
    expect(out).toBe(`---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ffcc00"\n---\n${BODY}`);
    expect(getFrontmatterValue(out, PRIMARY)).toBe('#ffcc00');
    // 書き換えは値の範囲だけ
    const changed = await set(out, PRIMARY, '#00aaff');
    expect(changed).toBe(out.replace('#ffcc00', '#00aaff'));
  });

  it('ほかのキー（title など）とその順番は残す', async () => {
    const src = `---\ntitle: 構成図\nconfig:\n  look: handDrawn\n---\n${BODY}`;
    const out = await set(src, THEME, 'dark');
    expect(out).toBe(`---\ntitle: 構成図\nconfig:\n  look: handDrawn\n  theme: dark\n---\n${BODY}`);
    expect(parseFrontmatter(out)!.entries.map((e) => e.key)).toEqual(['title', 'config']);
  });

  it('値が空の葉（theme:）には、コロンの直後に値を書く。後ろのコメントは残し、子を持つキーには書かない', async () => {
    expect(await set(`---\nconfig:\n  theme:\n---\n${BODY}`, THEME, 'base')).toBe(`---\nconfig:\n  theme: base\n---\n${BODY}`);
    expect(await set(`---\nconfig:\n  theme: # 後で決める\n---\n${BODY}`, THEME, 'base')).toBe(
      `---\nconfig:\n  theme: base # 後で決める\n---\n${BODY}`,
    );
    expect(setFrontmatterValue(`---\nconfig:\n  theme: base\n---\n${BODY}`, ['config'], 'x')).toBeNull();
  });

  it('空にすると行を消し、子が無くなった親と、空になった frontmatter も消す', async () => {
    const full = `---\nconfig:\n  themeVariables:\n    primaryColor: "#ffcc00"\n---\n${BODY}`;
    expect(await set(full, PRIMARY, '')).toBe(BODY);
    const two = `---\ntitle: T\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ffcc00"\n---\n${BODY}`;
    expect(await set(two, PRIMARY, '')).toBe(`---\ntitle: T\nconfig:\n  theme: base\n---\n${BODY}`);
    expect(setFrontmatterValue(BODY, THEME, '')).toBeNull();
  });

  it('frontmatter の読まない行（# のコメントなど）は、空になっても消さない', async () => {
    const src = `---\n# メモ\nconfig:\n  theme: dark\n---\n${BODY}`;
    expect(await set(src, THEME, '')).toBe(`---\n# メモ\n---\n${BODY}`);
  });
});