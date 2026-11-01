import test from 'node:test';
import assert from 'node:assert/strict';
import { homePublications } from '../../../apps/web/components/home/publication-feed.js';
import type { PublicationCard } from '../../../apps/web/app/_lib/data/types.js';

test('unavailable public content leaves the home available without inventing an empty successful feed', async () => {
  const unavailable = async (): Promise<PublicationCard[]> => { throw new Error('Synthetic unavailable upstream'); };
  assert.deepEqual(await homePublications({ listArticles: unavailable, listNews: unavailable }), { articles: [], news: [], unavailable: true });
  assert.deepEqual(await homePublications({ listArticles: async () => [], listNews: async () => [] }), { articles: [], news: [], unavailable: false });
});

test('a failed content section preserves the other authorized result and retries the current source', async () => {
  // The loader preserves references without interpreting or fabricating a publication projection.
  const cards: PublicationCard[] = [];
  let fail = true;
  let reads = 0;
  const source = {
    listArticles: async () => cards,
    listNews: async () => { reads++; if (fail) throw new Error('Synthetic outage'); return cards; },
  };
  const first = await homePublications(source);
  assert.equal(first.articles, cards);
  assert.equal(first.unavailable, true);
  fail = false;
  const next = await homePublications(source);
  assert.equal(next.news, cards);
  assert.equal(next.unavailable, false);
  assert.equal(reads, 2, 'an unavailable read is never cached as authorized data');
});
