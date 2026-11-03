import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVENANCE_LABEL_KEYS, PublicPublicationSchema, type PublicProvenance } from '@trustwork/contracts/client';
import { runWithLocaleScope, setLocaleStore } from '../../../packages/i18n-runtime/src/server.js';
import { contentData, publicationView } from '../../../apps/web/app/_lib/data/http/content.js';
import { publicationFeedText } from '../../../apps/web/components/public/magazine/feeds.js';
import { publicationJsonLd } from '../../../apps/web/components/public/magazine/PublicationProvenance.js';
import { renderIssueHtml, RenderSnapshotSchema } from '../../../apps/worker/src/content/render.js';
import { t } from '../../../apps/web/app/_lib/i18n.js';
import { layersFor } from '../i18n/helpers.js';

const id = '11111111-1111-4111-8111-111111111111', person = '22222222-2222-4222-8222-222222222222', original = '33333333-3333-4333-8333-333333333333';
const date = '2026-11-01T00:00:00.000Z';
const digest = 'a'.repeat(64);
const LOCALES = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const KINDS = Object.keys(PROVENANCE_LABEL_KEYS) as (keyof typeof PROVENANCE_LABEL_KEYS)[];
const scoped = <T,>(locale: string, f: () => T) => runWithLocaleScope(() => { setLocaleStore({ locale, country: 'UZ', layers: layersFor(locale) }); return f(); });

function recorded(kind: PublicProvenance & { availability: 'recorded' } extends infer R ? R extends { kind: infer K } ? K : never : never): PublicProvenance {
  return { availability: 'recorded', binding: { publicationId: id, version: 1, digest: { algorithm: 'trustwork-digest-1', value: digest } }, revision: 1, kind, roles: kind === 'none' ? [] : ['editorial_writer'],
    evidence: 'human_declaration', machineAssisted: kind !== 'none', credits: kind === 'none' ? {} : { responsible_editor: 'Synthetic Editor' },
    ...(kind === 'machine_translation' ? { translation: { reviewed: true as const, originalPublicationId: original, originalVersion: 1, originalDigest: digest, originalLanguage: 'es', originalFormat: 'article' as const, currentOriginalVersion: 1, stale: false } } : {}) };
}
/** Every older flag off: the only trace of assistance is the provenance under test. */
const publication = (provenance: PublicProvenance | undefined, language: string, flag = false) => PublicPublicationSchema.parse({ projection: 'public', id, format: 'article', articleFormat: 'practice', status: 'published', originalLanguage: language, licence: 'cc_by', firstPublishedAt: date,
  owner: { kind: 'person', id: person }, authorship: [{ kind: 'person', id: person, credit: 'Synthetic Author', assistantAssisted: false }], topics: [], entityLinks: [],
  current: { version: 1, title: 'Synthetic title', body: 'Synthetic body.', language, sourceRefs: [], treatment: 'original_reporting', eventTime: null, publishedAt: date, correctionOf: null, correctionNote: null, contentDigest: digest, assistantAssisted: flag, ...(provenance ? { provenance } : {}) },
  versions: [{ version: 1, publishedAt: date, correctionOf: null, correctionNote: null }], corrections: [], retraction: null, editions: [] });
const issueItem = { position: 1, section: 'practice', publicationId: id, publicationVersion: 1 };
const issuePort = (p: ReturnType<typeof publication>) => contentData({ hasSession: async () => false, get: async path => {
  if (path === '/v1/magazine/issues') return { issues: [{ id: person, number: 1, date: '2026-11-01', theme: 'Synthetic issue', status: 'released', currentEdition: 1, coverAssetId: null, items: 1 }] };
  if (path.startsWith('/v1/magazine/issues/1')) return { projection: 'public', issue: { id: person, number: 1, date: '2026-11-01', status: 'released', edition: 1, items: [issueItem], renderArtifacts: [], revision: 1 },
    theme: 'Synthetic issue', coverAssetId: null, editorLetterPublicationId: null, currentEdition: 1, digest: { algorithm: 'trustwork-digest-1', value: digest }, releasedAt: date, correctionNote: null,
    items: [{ ...issueItem, withheld: false, title: p.current.title, format: 'article', articleFormat: 'practice', currentVersion: 1, corrected: false, retracted: false }], corrections: [] };
  if (path.endsWith('/versions/1')) return { ...p.current, projection: 'public', publicationId: id };
  if (path === `/v1/publications/${id}`) return p;
  throw new Error(`Unexpected synthetic route: ${path}`);
} });
const printed = (p: ReturnType<typeof publication>) => renderIssueHtml(RenderSnapshotSchema.parse({ revisionId: person, issue: { number: 1, edition: 1, date: '2026-11-01', theme: 'Synthetic issue', digest, corrections: [] },
  items: [{ position: 1, section: 'practice', version: p.current, publication: { current: { version: 1, correctionNote: null }, authorship: p.authorship, corrections: [], editions: [] } }] }));
const unescaped = (html: string) => html.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

test('every disclosed kind has a reader label on the card, page, structured data, feed, issue reader and PDF, in every language', async () => {
  for (const locale of LOCALES) for (const kind of KINDS) await scoped(locale, async () => {
    const label = t(`publicationProvenance.${PROVENANCE_LABEL_KEYS[kind]}`);
    assert.ok(label && !label.startsWith('publicationProvenance.'), `${locale} ${kind}`);
    const p = publication(recorded(kind), locale);
    const item = publicationView(p);
    assert.equal(item.assistantAssisted, true, 'list cards are labelled from the record, not only from the draft flag');
    assert.ok(item.content?.notices.includes(label), `${locale} ${kind} page`);
    assert.ok(String(publicationJsonLd(item, 'https://example.invalid/a').description).includes(label), `${locale} ${kind} structured data`);
    assert.ok(publicationFeedText(item, path => `https://example.invalid${path}`).includes(label), `${locale} ${kind} feed`);
    assert.ok((await issuePort(p).getIssue(1))!.issue.items[0]!.body.includes(label), `${locale} ${kind} issue reader`);
    assert.ok(unescaped(await printed(p)).includes(label), `${locale} ${kind} PDF`);
    assert.equal(item.content?.notices.filter(n => n === label).length, 1, 'shown once');
    assert.ok(item.content?.notices.includes(`${t('publicationProvenance.responsibleEditor')}: Synthetic Editor`), `${locale} ${kind} names the person`);
  });
});

test('the card meta row prints the label from the same field', () => {
  // parts.tsx imports client design-system components, which this server-condition process cannot load.
  const source = readFileSync(new URL('../../../apps/web/components/public/parts.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(card\.assistantAssisted\) items\.push\(t\('articles\.assistantAssisted'\)\);/);
});

test('an image gets its label, alt text and IPTC URI; a piece that only edited an image says so too', async () => {
  for (const locale of LOCALES) await scoped(locale, async () => {
    const provenance = recorded('ai_assisted');
    if (provenance.availability === 'recorded') provenance.images = [{ id: original, digitalSourceType: 'compositeWithTrainedAlgorithmicMedia', altText: 'Synthetic alt text' }];
    const p = publication(provenance, locale);
    const item = publicationView(p);
    assert.ok(item.content?.notices.includes(t('publicationProvenance.generated')));
    assert.ok(item.content?.notices.includes(t('publicationProvenance.aiAssisted')));
    const [image] = (publicationJsonLd(item, 'https://example.invalid/a') as unknown as { image: { url: string; caption: string; digitalSourceType: string }[] }).image;
    assert.equal(image!.digitalSourceType, 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
    assert.equal(image!.caption, 'Synthetic alt text');
    assert.ok(image!.url.endsWith(`/v1/publications/${id}/images/${original}`));
    assert.ok(unescaped(await printed(p)).includes(t('publicationProvenance.generated')));
  });
  const reader = readFileSync(new URL('../../../apps/web/components/public/magazine/PublicationProvenance.tsx', import.meta.url), 'utf8');
  assert.match(reader, /alt=\{image\.altText\}/);
  assert.match(reader, /<figcaption>\{t\('publicationProvenance\.generated'\)\}<\/figcaption>/);
});

test('a withdrawn credit keeps the label and says the name is unavailable, on the page and in the PDF', async () => {
  for (const locale of LOCALES) await scoped(locale, async () => {
    const provenance = recorded('ai_assisted');
    if (provenance.availability === 'recorded') provenance.credits = {};
    const p = publication(provenance, locale);
    const notices = publicationView(p).content!.notices;
    assert.ok(notices.includes(t('publicationProvenance.aiAssisted')));
    assert.ok(notices.includes(t('publicationProvenance.revoked')));
    assert.ok(unescaped(await printed(p)).includes(t('publicationProvenance.revoked')));
  });
});

test('a declaration of no assistance adds no AI, evidence or credit notice anywhere', async () => {
  for (const locale of LOCALES) await scoped(locale, async () => {
    const p = publication(recorded('none'), locale);
    const item = publicationView(p);
    assert.equal(item.assistantAssisted, false);
    assert.deepEqual(item.content?.notices, []);
    const html = unescaped(await printed(p));
    for (const key of ['declarationEvidence', 'revoked', 'aiAssisted', 'generated', 'machineReviewed']) assert.ok(!html.includes(t(`publicationProvenance.${key}`)), `${locale} ${key}`);
  });
});

test('content without a record is still labelled: unavailable provenance and the older assistance flags', async () => {
  for (const locale of LOCALES) await scoped(locale, async () => {
    const legacy = publicationView(publication({ availability: 'unavailable', machineAssisted: true }, locale));
    assert.equal(legacy.assistantAssisted, true);
    assert.ok(legacy.content?.notices.includes(t('publicationProvenance.unavailable')));
    assert.ok(legacy.content?.notices.includes(t('articles.assistantAssisted')));
    const flagOnly = publicationView(publication(undefined, locale, true));
    assert.equal(flagOnly.assistantAssisted, true);
    assert.ok(flagOnly.content?.notices.includes(t('articles.assistantAssisted')));
  });
});

test('the PDF falls back to English for a label an unmaintained language lacks', async () => {
  const p = publication(recorded('ai_assisted'), 'ru');
  assert.match(await printed(p), /lang="ru"/);
});
