// @vitest-environment jsdom
// mermaid.parse は DOMPurify（DOM）を使うため jsdom で動かす
import { describe, expect, it } from 'vitest';
import mermaid from 'mermaid';
import { TEMPLATES } from '../src/core/templates';

describe('テンプレート', () => {
  for (const tpl of TEMPLATES.filter((x) => x.text)) {
    it(`${tpl.name} は mermaid の構文として正しい`, async () => {
      await expect(mermaid.parse(tpl.text)).resolves.toBeTruthy();
    });
  }
});
