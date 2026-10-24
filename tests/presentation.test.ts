import { describe, expect, it } from 'vitest';
import { slideOrder } from '../src/ui/PresentationView';
import type { DocRecord } from '../src/storage/db';

const doc = (id: string, o: Partial<DocRecord> = {}): DocRecord => ({ id, title: id, text: 'pie\n "a" : 1', headId: '', createdAt: 0, updatedAt: 0, deletedAt: null, tags: [], ...o });

describe('発表モードの並び', () => {
  const docs = [
    doc('う', { updatedAt: 3, createdAt: 1, tags: ['発表'] }),
    doc('あ', { updatedAt: 1, createdAt: 3, tags: ['発表'] }),
    doc('い', { updatedAt: 2, createdAt: 2 }),
    doc('消した', { deletedAt: 5, tags: ['発表'] }),
  ];

  it('ゴミ箱の図は出さず、タグで絞る', () => {
    expect(slideOrder(docs, '', 'updated').map((d) => d.id)).toEqual(['う', 'い', 'あ']);
    expect(slideOrder(docs, '発表', 'updated').map((d) => d.id)).toEqual(['う', 'あ']);
  });

  it('作成した順・名前順に並べ替える', () => {
    expect(slideOrder(docs, '', 'created').map((d) => d.id)).toEqual(['う', 'い', 'あ']);
    expect(slideOrder(docs, '', 'title').map((d) => d.id)).toEqual(['あ', 'い', 'う']);
  });
});
