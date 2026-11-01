import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicPublicationSchema } from '@trustwork/contracts/client';
import { runWithLocaleScope, setLocaleStore } from '../../../packages/i18n-runtime/src/server.js';
import { authorCredit, contentData, publicationView, publicSourceUrl } from '../../../apps/web/app/_lib/data/http/content.js';
import { serializeFeed } from '../../../apps/web/components/public/magazine/feeds.js';
import { layersFor } from '../i18n/helpers.js';
const id = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222';
const date = '2026-11-01T00:00:00.000Z';
const publication = () => PublicPublicationSchema.parse({ projection: 'public', id, format: 'article', articleFormat: 'practice', status: 'corrected', originalLanguage: 'en', licence: 'cc_by', firstPublishedAt: date,
  owner: { kind: 'person', id: person }, authorship: [{ kind: 'person', id: person, credit: 'Synthetic Author', assistantAssisted: true }], topics: [], entityLinks: [],
  current: { version: 2, title: 'Synthetic corrected title', body: '<script>unsafe()</script>', language: 'en', sourceRefs: [], treatment: 'original_reporting', eventTime: null, publishedAt: date, correctionOf: 1, correctionNote: 'Synthetic correction', contentDigest: 'a'.repeat(64), assistantAssisted: true },
  versions: [{ version: 1, publishedAt: date, correctionOf: null, correctionNote: null }, { version: 2, publishedAt: date, correctionOf: 1, correctionNote: 'Synthetic correction' }],
  corrections: [{ fromVersion: 1, toVersion: 2, reason: 'Synthetic correction', correctedAt: date }], retraction: null, editions: [] });
const scoped = <T,>(locale: string, f: () => T) => runWithLocaleScope(() => { setLocaleStore({ locale, country: 'UZ', layers: layersFor(locale) }); return f(); });

test('URL references never become executable schemes or credential-bearing URLs', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pass@example.invalid', 'not a URL']) assert.equal(publicSourceUrl(value), null);
  assert.equal(publicSourceUrl('https://example.invalid/source'), 'https://example.invalid/source');
});
test('redacted credits and AI names never become reader authors', () => {
  const p = publication();
  p.authorship.push({ kind: 'person', id: null, credit: 'Private Person Marker', assistantAssisted: false });
  for (const credit of ['AI', 'ChatGPT', 'Claude', 'Codex', 'Artificial intelligence']) p.authorship.push({ kind: 'person', id: person, credit, assistantAssisted: true });
  assert.equal(authorCredit(p), 'Synthetic Author');
});
test('correction, original language and assistance render in all seven dictionaries without invented editor claims', () => {
  for (const locale of ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) scoped(locale, () => {
    const item = publicationView(publication()); assert.equal(item.version, 2); assert.equal(item.correction?.note, 'Synthetic correction');
    assert.ok(item.content?.notices.length); assert.equal(item.authorLabel, 'Synthetic Author'); assert.equal(item.authorHref, null);
    assert.equal('editor' in item, false); assert.equal(item.body, '<script>unsafe()</script>');
    const p = publication(); p.status = 'retracted'; p.current.body = null; p.retraction = { note: 'Synthetic retraction', retractedAt: date };
    assert.equal(publicationView(p).body, '');
  });
});
test('public reads are anonymous, unknown IDs and missing projections never fall back to fixtures', async () => scoped('en', async () => {
  const calls: object[] = [];
  const port = contentData({ hasSession: async () => true, get: async (path, options) => { calls.push({ path, options }); return null; } });
  assert.equal(await port.getPublication('fixture-slug', 'article'), null); assert.equal(calls.length, 0);
  assert.deepEqual(await port.listNews(), []); assert.equal(await port.getPublication(id, 'article'), null);
  assert.deepEqual(await port.getMagazine(), { current: null, archive: [] });
  assert.ok(calls.every(c => (c as { options: { anonymous: boolean } }).options.anonymous));
}));
test('pinned versions retain their own assistance disclosure instead of borrowing the current version', async () => scoped('en', async () => {
  const p = publication(); p.authorship[0]!.assistantAssisted = false; p.current.assistantAssisted = false;
  const pinned = { ...p.current, version: 1, assistantAssisted: true, correctionOf: null, correctionNote: null };
  const item = { position: 1, section: 'practice', publicationId: id, publicationVersion: 1 };
  const port = contentData({ hasSession: async () => false, get: async path => {
    if (path === '/v1/magazine/issues') return { issues: [{ id: person, number: 1, date: '2026-11-01', theme: 'Synthetic issue', status: 'released', currentEdition: 1, coverAssetId: null, items: 1 }] };
    if (path.startsWith('/v1/magazine/issues/1')) return { projection: 'public', issue: { id: person, number: 1, date: '2026-11-01', status: 'released', edition: 1, items: [item], renderArtifacts: [], revision: 1 },
      theme: 'Synthetic issue', coverAssetId: null, editorLetterPublicationId: null, currentEdition: 1, digest: { algorithm: 'trustwork-digest-1', value: 'b'.repeat(64) }, releasedAt: date, correctionNote: null,
      items: [{ ...item, withheld: false, title: pinned.title, format: 'article', articleFormat: 'practice', currentVersion: 2, corrected: true, retracted: false }], corrections: [] };
    if (path.endsWith('/versions/1')) return { ...pinned, projection: 'public', publicationId: id };
    if (path === `/v1/publications/${id}`) return p;
    throw new Error(`Unexpected synthetic route: ${path}`);
  } });
  assert.match((await port.getIssue(1))!.issue.items[0]!.body, /assistant/);
  p.current.assistantAssisted = true; pinned.assistantAssisted = false;
  assert.doesNotMatch((await port.getIssue(1))!.issue.items[0]!.body, /assistant/);
}));
test('RSS, Atom and JSON Feed carry correction/disclosure as inert text and real credits only', () => {
  const feed = { title: 'Synthetic feed', url: 'https://example.invalid/news', feedUrl: 'https://example.invalid/news/feed.xml', language: 'en', entries: [{ id, url: 'https://example.invalid/item', title: '<script>title</script>', text: 'Correction: revised. AI-assisted. <img src="http://127.0.0.1/private">', published: date, modified: date, language: 'en', authors: ['Synthetic Author'] }] };
  for (const format of ['rss', 'atom', 'json'] as const) {
    const { body } = serializeFeed(feed, format); assert.match(body, /Correction: revised/); assert.match(body, /AI-assisted/);
    if (format === 'json') { const parsed = JSON.parse(body); assert.equal(parsed.version, 'https://jsonfeed.org/version/1.1'); assert.ok(parsed.items[0].content_text.includes('<img')); }
    else { assert.ok(!body.includes('<script>')); assert.ok(!body.includes('<img ')); }
  }
  const atom = serializeFeed(feed, 'atom').body; assert.match(atom, /<author><name>Synthetic Author<\/name><\/author>/);
  feed.entries[0]!.authors = []; assert.ok(!serializeFeed(feed, 'atom').body.includes('<entry>'));
});
