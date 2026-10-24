import { describe, expect, it } from 'vitest';
import { t } from '../src/i18n';

describe('文言の差し込み', () => {
  it('差し込む文字列の $& や $$ を、置き換えの記法として読まない', () => {
    expect(t('snippet.inserted', { name: "a$&b$'c$$d" })).toBe("部品「a$&b$'c$$d」を差し込む");
  });
});
