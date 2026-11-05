import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { drift, outputs, slug } from '../../scripts/book.mjs';

test('the Trustwork Book builds, and its committed editions match the sources', () => {
  assert.deepEqual(drift(), []);
});

test('the book has one designed edition and one text file per chapter with a contents page', () => {
  const files = [...outputs().keys()];
  assert.ok(files.includes('docs/book/trustwork-book.html'));
  assert.ok(files.includes('docs/book/text/README.md'));
  const chapters = files.filter((f) => /^docs\/book\/text\/\d{2}-[a-z0-9-]+\.md$/.test(f));
  assert.ok(chapters.length >= 20, `${chapters.length} chapter files`);
});

test('the designed edition loads nothing from the network', () => {
  const html = outputs().get('docs/book/trustwork-book.html');
  assert.doesNotMatch(html, /<(script|link|img|iframe)\b[^>]*\b(src|href)=["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /[Ѐ-ӿ]/);
});

test('slugs are plain, short and stable', () => {
  assert.equal(slug('Residents decide: participatory and initiative budgets', 48), 'residents-decide-participatory-and-initiative');
  assert.equal(slug('Medellín & São Paulo'), 'medellin-sao-paulo');
});

test('news reads the history and reports work packages as JSON', () => {
  const out = execFileSync('node', ['scripts/news.mjs', '--ref', 'HEAD', '--since', '30 days ago', '--json'], { encoding: 'utf8' });
  const news = JSON.parse(out);
  assert.equal(news.ref, 'HEAD');
  assert.ok(Number.isInteger(news.commits));
  assert.ok(Object.values(news.workPackages.counts).reduce((a, b) => a + b, 0) > 0);
  assert.ok(Array.isArray(news.byPackage) && Array.isArray(news.decisions));
});
