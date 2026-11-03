import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PublicPublicationSchema } from '@trustwork/contracts/client';
import { runWithLocaleScope, setLocaleStore } from '../../../packages/i18n-runtime/src/server.js';
import { publicationView } from '../../../apps/web/app/_lib/data/http/content.js';
import { publicationFeedText } from '../../../apps/web/components/public/magazine/feeds.js';
import { publicationJsonLd } from '../../../apps/web/components/public/magazine/PublicationProvenance.js';
import { renderIssueHtml, RenderSnapshotSchema } from '../../../apps/worker/src/content/render.js';
import { layersFor } from '../i18n/helpers.js';

const LOCALES = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const id = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
const date = '2026-11-01T00:00:00.000Z', digest = 'a'.repeat(64);
const scoped = <T,>(locale: string, f: () => T) => runWithLocaleScope(() => { setLocaleStore({ locale, country: 'UZ', layers: layersFor(locale) }); return f(); });
const corrected = (language: string, credit = 'Synthetic Author') => PublicPublicationSchema.parse({ projection: 'public', id, format: 'article', articleFormat: 'practice', status: 'corrected', originalLanguage: language, licence: 'cc_by', firstPublishedAt: date,
  owner: { kind: 'person', id: person }, authorship: [{ kind: 'person', id: person, credit, assistantAssisted: false }], topics: [], entityLinks: [],
  current: { version: 2, title: 'Synthetic title', body: 'Synthetic body.', language, sourceRefs: [], treatment: 'original_reporting', eventTime: null, publishedAt: date, correctionOf: 1, correctionNote: 'Synthetic correction note', contentDigest: digest, assistantAssisted: false },
  versions: [{ version: 1, publishedAt: date, correctionOf: null, correctionNote: null }, { version: 2, publishedAt: date, correctionOf: 1, correctionNote: 'Synthetic correction note' }],
  corrections: [{ fromVersion: 1, toVersion: 2, reason: 'Synthetic reason', correctedAt: date }], retraction: null, editions: [] });
const printed = (p: ReturnType<typeof corrected>, pinned: unknown = p.current) => renderIssueHtml(RenderSnapshotSchema.parse({ revisionId: person, issue: { number: 1, edition: 2, date: '2026-11-01', theme: 'Synthetic issue', digest, corrections: [] },
  items: [{ position: 1, section: 'practice', version: pinned, publication: { current: { version: 2, correctionNote: 'Synthetic correction note' }, authorship: p.authorship, corrections: [], editions: [] } }] }));

test('CNT-003: a correction note reaches the page, structured data, the feed and the printed issue, in every language', async () => {
  for (const locale of LOCALES) await scoped(locale, async () => {
    const p = corrected(locale);
    const item = publicationView(p);
    assert.equal(item.correction?.note, 'Synthetic correction note');
    assert.deepEqual((publicationJsonLd(item, 'https://example.invalid/a') as { correction: { text: string } }).correction.text, 'Synthetic correction note');
    assert.ok(publicationFeedText(item, path => `https://example.invalid${path}`).includes('Synthetic correction note'));
    assert.ok((await printed(p)).includes('Synthetic correction note'));
    // An issue pinned to the earlier version still tells the reader that the piece was corrected.
    assert.ok((await printed(p, { ...p.current, version: 1, correctionOf: null, correctionNote: null })).includes('Synthetic correction note'));
  });
});

test('CNT-003: the printed byline never names a tool and the printed issue holds no image', async () => {
  for (const credit of ['AI', 'ChatGPT', 'Claude', 'Codex', 'Artificial intelligence']) {
    const html = await printed(corrected('en', credit));
    assert.ok(!html.includes(`<p class="credit">${credit}</p>`), credit);
    assert.ok(!/<img\b/i.test(html));
  }
  assert.ok((await printed(corrected('en'))).includes('<p class="credit">Synthetic Author</p>'));
});

test('CNT-003: every artwork has alt text in the shared list and in every maintained language', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../packages/ui/media/artworks/manifest.json', import.meta.url), 'utf8')) as { artworks: { id: string; alt: string }[] };
  assert.ok(manifest.artworks.length > 0);
  for (const artwork of manifest.artworks) assert.ok(artwork.alt.trim(), artwork.id);
  for (const locale of LOCALES) {
    const dictionary = JSON.parse(readFileSync(new URL(`../../../packages/ui/locales/${locale}.json`, import.meta.url), 'utf8')) as { media: { artworks: Record<string, string> } };
    for (const artwork of manifest.artworks) assert.ok(dictionary.media.artworks[artwork.id]?.trim(), `${locale} ${artwork.id}`);
  }
});

test('CNT-003: every img in the reader code states its alt, empty only for decoration', () => {
  const roots = ['apps/web/components/public', 'apps/web/app/(public)/[lang]/news', 'apps/web/app/(public)/[lang]/articles', 'apps/web/app/(public)/[lang]/magazine'];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []);
  let seen = 0;
  for (const file of roots.flatMap(walk)) for (const tag of readFileSync(file, 'utf8').match(/<img\b[^>]*?\/>/gs) ?? []) {
    seen += 1;
    assert.match(tag, /\balt=/, `${file}: ${tag.slice(0, 80)}`);
  }
  assert.ok(seen > 0);
});
