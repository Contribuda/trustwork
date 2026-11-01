import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AllowedUsesSchema, computeDigest, FORBIDDEN_CONTROL_WORDS, HubSourceSchema, TAKEDOWN_REASONS } from '@trustwork/contracts';
import {
  ALL_USES, allowedUsesProblems, contentSourceRef, DecideItemCommandSchema, defaultSponsoredPolicyView, egressBlocker, evaluateRobots, intersectUses, MOST_RESTRICTIVE_USES,
  parseRsl, RegisterSourceCommandSchema, RslReadingSchema, SetSponsoredPolicyCommandSchema, SOURCE_READER_KINDS, SOURCES_REQUEST_SCHEMAS, SourcedFieldNameSchema,
  SourceViewSchema, sponsoredPolicyDigestInput, StageBatchCommandSchema, toHubSource, USE_KEYS, usesAbove, type SourceView,
} from '../../packages/contracts/src/sources.js';
import { SourceKindSchema, SourceRefInputSchema } from '../../apps/api/src/modules/content/schemas.js';

/**
 * SRC-001 contracts: the licence model is the console's AllowedUses (the flags CNT-001 checks), RSL 1.0 readings never
 * widen what a source may do and fall back to the most restrictive flags, robots.txt follows RFC 9309, the egress rule
 * keeps display-only sources away from model providers and peers, and no request accepts a ranking control.
 */
const RSL = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<rsl xmlns="https://rslstandard.org/rsl">${body}</rsl>`;
const SITE = 'https://synthetic-manufacturer.example/guides/drainage';
const DISPLAY_ONLY = { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true };
const base = { contractVersion: '1.0.0', idempotencyKey: 'k-1', reason: 'Synthetic registry action' };
const terms = {
  readerKind: 'industry_media', purposes: ['news_desk'], licence: { kind: 'open_licence', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', agreementRef: null },
  allowedUses: { ...ALL_USES }, attributionTemplate: 'Source: Synthetic Trade Journal', takedownContact: 'rights@synthetic-journal.example', personalData: false, legalBasis: null,
};

test('the licence flags are exactly the console AllowedUses that CNT-001 checks', () => {
  assert.deepEqual(USE_KEYS, Object.keys(AllowedUsesSchema.shape));
  assert.equal(AllowedUsesSchema.safeParse(MOST_RESTRICTIVE_USES).success, true);
  assert.ok(USE_KEYS.every((k) => MOST_RESTRICTIVE_USES[k] === false));
  // The reader kinds are CNT-001's cited-source kinds without own reporting.
  assert.deepEqual([...SOURCE_READER_KINDS].sort(), SourceKindSchema.options.filter((k) => k !== 'own_reporting').sort());
  // A source reference built from an item is a valid CNT-001 source reference carrying the item's effective flags.
  const ref = contentSourceRef({ name: 'Synthetic Trade Journal', readerKind: 'industry_media', licence: { kind: 'open_licence', name: 'CC BY 4.0' } },
    { url: SITE, sourceTime: null, observedAt: '2026-10-30T10:00:00.000Z', effectiveUses: DISPLAY_ONLY });
  assert.equal(SourceRefInputSchema.safeParse(ref).success, true);
  assert.deepEqual(ref.allowedUses, DISPLAY_ONLY);
});

test('licence rules: no licence means headline, link, summary and indexing only; rewriting needs the stored text; RSL binds without an agreement', () => {
  assert.deepEqual(allowedUsesProblems({ kind: 'unknown', agreementRef: null }, { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true, displaySummary: true, indexForSearch: true }, null), []);
  for (const key of ['storeFullText', 'sendToModelProviders', 'rewriteWithAttribution', 'syndicateToPeers', 'reuseImages', 'translate'] as const) {
    assert.ok(allowedUsesProblems({ kind: 'all_rights_reserved', agreementRef: null }, { ...MOST_RESTRICTIVE_USES, [key]: true, storeFullText: true }, null).includes('licence_restricts_use'), key);
  }
  assert.deepEqual(allowedUsesProblems({ kind: 'open_licence', agreementRef: null }, { ...ALL_USES, storeFullText: false }, null), ['rewrite_needs_full_text']);
  const ceiling = { ...ALL_USES, sendToModelProviders: false };
  assert.deepEqual(allowedUsesProblems({ kind: 'open_licence', agreementRef: null }, ALL_USES, ceiling), ['rsl_forbids_use']);
  assert.deepEqual(allowedUsesProblems({ kind: 'publisher_agreement', agreementRef: 'agreement-1' }, ALL_USES, ceiling), [], 'a publisher agreement on record overrides the machine-readable terms');
  assert.deepEqual(allowedUsesProblems({ kind: 'publisher_agreement', agreementRef: null }, ALL_USES, ceiling), ['rsl_forbids_use'], 'an agreement without a reference does not');
  assert.deepEqual(usesAbove(ALL_USES, ceiling), ['sendToModelProviders']);
  assert.deepEqual(intersectUses(ALL_USES, DISPLAY_ONLY), DISPLAY_ONLY);
  // The command refines the same rules.
  assert.equal(RegisterSourceCommandSchema.safeParse({ ...base, kind: 'rss', name: 'Synthetic Trade Journal', url: 'https://synthetic-journal.example/feed.xml', ownerPersonId: crypto.randomUUID(), ...terms }).success, true);
  assert.equal(RegisterSourceCommandSchema.safeParse({ ...base, kind: 'rss', name: 'X', url: null, ownerPersonId: crypto.randomUUID(), ...terms, licence: { ...terms.licence, kind: 'unknown' } }).success, false);
  assert.equal(RegisterSourceCommandSchema.safeParse({ ...base, kind: 'web_page', name: 'X', url: null, ownerPersonId: crypto.randomUUID(), ...terms }).success, false, 'a crawled source names its URL');
  assert.equal(RegisterSourceCommandSchema.safeParse({ ...base, kind: 'rss', name: 'X', url: null, ownerPersonId: crypto.randomUUID(), ...terms, personalData: true }).success, false, 'personal data needs a legal basis');
});

test('acceptance: a display-only source never reaches a model provider or a peer', () => {
  assert.equal(egressBlocker(DISPLAY_ONLY, 'model_provider'), 'licence_forbids_model_use');
  assert.equal(egressBlocker(DISPLAY_ONLY, 'peer'), 'licence_forbids_syndication');
  assert.equal(egressBlocker(MOST_RESTRICTIVE_USES, 'model_provider'), 'licence_forbids_model_use');
  assert.equal(egressBlocker(ALL_USES, 'model_provider'), null);
  assert.equal(egressBlocker(ALL_USES, 'peer'), null);
  // A later narrowing of the source applies to old copies: the effective flags are the stricter reading.
  assert.equal(egressBlocker(intersectUses(ALL_USES, DISPLAY_ONLY), 'model_provider'), 'licence_forbids_model_use');
});

test('RSL 1.0: readings are suggestions that never exceed the terms', () => {
  const searchOnly = parseRsl(RSL('<content url="/"><license><permits type="usage">search</permits><prohibits type="usage">ai-all</prohibits></license></content>'), SITE);
  assert.equal(searchOnly.status, 'parsed');
  assert.deepEqual(searchOnly.permittedUsages, ['search']);
  assert.equal(searchOnly.ceiling.sendToModelProviders, false);
  assert.equal(searchOnly.ceiling.displayHeadlineAndLink, true);
  assert.equal(searchOnly.ceiling.storeFullText, true, 'RSL does not speak to storage: the licence decides');
  assert.deepEqual(searchOnly.suggested, { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true, indexForSearch: true }, 'the suggestion opens only what RSL grants');
  assert.equal(RslReadingSchema.safeParse(searchOnly).success, true);

  const open = parseRsl(RSL('<content url="https://synthetic-manufacturer.example/"><license><permits type="usage">all</permits><payment type="attribution"/></license></content>'), SITE);
  assert.deepEqual(open.permittedUsages, ['ai-train', 'ai-input', 'ai-index', 'search']);
  assert.equal(open.suggested.sendToModelProviders, true);

  // Model providers need both AI input and AI indexing.
  assert.equal(parseRsl(RSL('<content url="/"><license><permits type="usage">ai-input,search</permits></license></content>'), SITE).ceiling.sendToModelProviders, false);
  // A prohibition removes what a permission granted; no permits element grants every usage minus the prohibitions.
  assert.deepEqual(parseRsl(RSL('<content url="/"><license><prohibits type="usage">ai-train ai-index</prohibits></license></content>'), SITE).permittedUsages, ['ai-input', 'search']);
  // Licences the hub cannot satisfy or evaluate do not count: payment, non-commercial users, geography.
  for (const condition of ['<payment type="use"/>', '<payment type="purchase"/>', '<permits type="user">non-commercial</permits>', '<prohibits type="user">commercial</prohibits>', '<permits type="geo">US</permits>']) {
    const r = parseRsl(RSL(`<content url="/"><license><permits type="usage">all</permits>${condition}</license></content>`), SITE);
    assert.equal(r.status, 'parsed', condition);
    assert.deepEqual(r.permittedUsages, [], condition);
    assert.equal(r.ceiling.displayHeadlineAndLink, false, condition);
  }
  // A free licence next to a paid one: only the free one counts.
  const mixed = parseRsl(RSL('<content url="/"><license><permits type="usage">search</permits></license><license><permits type="usage">ai-all</permits><payment type="use"/></license></content>'), SITE);
  assert.deepEqual(mixed.permittedUsages, ['search']);
  // The longest content entry covering the URL wins.
  const scoped = parseRsl(RSL('<content url="/"><license><permits type="usage">all</permits></license></content><content url="/guides/*"><license><permits type="usage">search</permits></license></content>'), SITE);
  assert.deepEqual(scoped.permittedUsages, ['search']);
  // Prefixed namespace form.
  assert.equal(parseRsl('<r:rsl xmlns:r="https://rslstandard.org/rsl"><r:content url="/"><r:license><r:permits type="usage">search</r:permits></r:license></r:content></r:rsl>', SITE).status, 'parsed');
  for (const value of [searchOnly, open, scoped, mixed]) assert.equal(usesAbove(value.suggested, value.ceiling).length, 0);
});

test('acceptance: RSL parsing failures fall back to the most restrictive flags', () => {
  const failures: Record<string, string> = {
    malformed: '<rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">search',
    notXml: 'User-agent: *\nAllow: /',
    empty: '',
    wrongNamespace: '<rsl xmlns="https://example.invalid/other"><content url="/"><license><permits type="usage">all</permits></license></content></rsl>',
    noNamespace: '<rsl><content url="/"><license><permits type="usage">all</permits></license></content></rsl>',
    doctype: '<!DOCTYPE rsl [<!ENTITY x "all">]><rsl xmlns="https://rslstandard.org/rsl"><content url="/"><license><permits type="usage">&x;</permits></license></content></rsl>',
    cdata: RSL('<content url="/"><license><permits type="usage"><![CDATA[all]]></permits></license></content>'),
    unknownUsage: RSL('<content url="/"><license><permits type="usage">everything</permits></license></content>'),
    unknownElement: RSL('<content url="/"><license><grant type="usage">all</grant></license></content>'),
    foreignElement: RSL('<content url="/"><license><x:permits xmlns:x="https://example.invalid" type="usage">all</x:permits></license></content>'),
    noContent: RSL(''),
    contentWithoutUrl: RSL('<content><license><permits type="usage">all</permits></license></content>'),
    unknownEntity: RSL('<content url="/"><license><permits type="usage">&all;</permits></license></content>'),
    trailing: `${RSL('<content url="/"><license><permits type="usage">all</permits></license></content>')}<extra/>`,
    oversized: RSL(`<!--${'x'.repeat(70_000)}--><content url="/"><license><permits type="usage">all</permits></license></content>`),
  };
  for (const [name, doc] of Object.entries(failures)) {
    const r = parseRsl(doc, SITE);
    assert.equal(r.status, 'failed', name);
    assert.deepEqual(r.ceiling, MOST_RESTRICTIVE_USES, name);
    assert.deepEqual(r.suggested, MOST_RESTRICTIVE_USES, name);
    assert.equal(RslReadingSchema.safeParse(r).success, true, name);
  }
  const unmatched = parseRsl(RSL('<content url="/catalogue/"><license><permits type="usage">all</permits></license></content>'), SITE);
  assert.equal(unmatched.status, 'no_matching_content');
  assert.deepEqual(unmatched.ceiling, MOST_RESTRICTIVE_USES);
  // The schema refuses a failed reading that claims any flag.
  assert.equal(RslReadingSchema.safeParse({ status: 'failed', permittedUsages: [], ceiling: ALL_USES, suggested: MOST_RESTRICTIVE_USES, problem: 'x' }).success, false);
});

test('robots.txt (RFC 9309): product token groups, longest match, allow on ties, oversized files disallow', () => {
  const robots = 'User-agent: *\nDisallow: /private/\nAllow: /private/public-guides/\nCrawl-delay: 3\n\nUser-agent: TrustworkSourcesBot\nUser-agent: OtherBot\nDisallow: /catalogue/*.pdf$\nDisallow: /\nAllow: /guides/\nLicense: https://synthetic-manufacturer.example/license.xml\n';
  const generic = evaluateRobots(robots, 'SomeBot/1.0', '/private/secret');
  assert.equal(generic.allowed, false);
  assert.equal(generic.crawlDelaySeconds, 3);
  assert.equal(evaluateRobots(robots, 'SomeBot', '/private/public-guides/a').allowed, true, 'the longer allow wins');
  const ours = evaluateRobots(robots, 'TrustworkSourcesBot/1.0', '/guides/drainage');
  assert.equal(ours.allowed, true);
  assert.equal(ours.status, 'restricted');
  assert.deepEqual(ours.licenceUrls, ['https://synthetic-manufacturer.example/license.xml']);
  assert.equal(evaluateRobots(robots, 'trustworksourcesbot', '/news').allowed, false, 'agent names are case-insensitive; the named group replaces the * group');
  assert.equal(evaluateRobots(robots, 'TrustworkSourcesBot', '/catalogue/sheet.pdf').allowed, false);
  assert.equal(evaluateRobots('', 'Bot', '/x').status, 'allowed', 'no robots.txt allows everything');
  assert.equal(evaluateRobots('User-agent: *\nDisallow:\n', 'Bot', '/x').allowed, true, 'an empty disallow allows');
  assert.equal(evaluateRobots('User-agent: *\nDisallow: /\n', 'Bot', '/robots.txt').allowed, true);
  const tie = evaluateRobots('User-agent: *\nDisallow: /a\nAllow: /a\n', 'Bot', '/a');
  assert.equal(tie.allowed, true);
  const huge = evaluateRobots(`User-agent: *\nAllow: /\n#${'x'.repeat(520_000)}`, 'Bot', '/x');
  assert.equal(huge.allowed, false, 'what cannot be read is never more permissive');
});

test('the source read model keeps the console HubSource form', () => {
  const view: SourceView = SourceViewSchema.parse({
    id: crypto.randomUUID(), hubId: crypto.randomUUID(), kind: 'web_page', name: 'Synthetic Manufacturer Guides', url: SITE, purposes: ['knowledge_base'],
    licence: { kind: 'open_licence', name: 'CC BY 4.0', url: null, agreementRef: null },
    robots: { checkedAt: '2026-10-30T10:00:00.000Z', robotsUrl: 'https://synthetic-manufacturer.example/robots.txt', userAgent: 'TrustworkSourcesBot', allowed: true, crawlDelaySeconds: null, robotsDigest: 'a'.repeat(64) },
    terms: { checkedAt: '2026-10-30T10:00:00.000Z', termsUrl: 'https://synthetic-manufacturer.example/terms', termsDigest: 'b'.repeat(64), automatedAccess: 'permitted', reviewedBy: crypto.randomUUID(), notes: '' },
    allowedUses: DISPLAY_ONLY, attributionTemplate: 'Source: Synthetic Manufacturer', takedownContact: 'legal@synthetic-manufacturer.example', ownerPersonId: crypto.randomUUID(),
    personalData: false, legalBasis: null, proposedBy: { kind: 'person', personId: crypto.randomUUID() }, status: 'active', activatedBy: crypto.randomUUID(),
    activatedAt: '2026-10-30T11:00:00.000Z', pauseReason: null, revision: 3, readerKind: 'company_statement', editedBy: crypto.randomUUID(), crawlPolicy: null,
    rsl: { status: 'absent', digest: null, checkedAt: null, ceiling: null, suggested: null }, createdAt: '2026-10-30T09:00:00.000Z', updatedAt: '2026-10-30T11:00:00.000Z',
  });
  const hub = toHubSource(view);
  assert.equal(HubSourceSchema.safeParse(hub).success, true);
  assert.deepEqual(Object.keys(hub).sort(), Object.keys(HubSourceSchema.shape).sort());
});

test('commands: strict, no ranking controls, a person decides drafts and discards, sponsored content needs a second person to switch on', () => {
  const walk = (schema: z.ZodType): string[] => {
    const out: string[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === 'object') out.push(...Object.keys(record.properties));
      if (Array.isArray(record.enum)) out.push(...record.enum.filter((v): v is string => typeof v === 'string'));
      Object.values(record).forEach(visit);
    };
    visit(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
    return out;
  };
  let words = 0;
  for (const [name, schema] of Object.entries(SOURCES_REQUEST_SCHEMAS)) {
    for (const word of walk(schema as z.ZodType)) { words += 1; assert.ok(!FORBIDDEN_CONTROL_WORDS.test(word), `${name} accepts "${word}"`); }
  }
  assert.ok(words > 80, `walked ${words} names`);
  for (const field of ['score', 'rank', 'position', 'badge', 'weight', 'boost', 'featured', 'publish']) {
    assert.equal(DecideItemCommandSchema.safeParse({ ...base, expectedRevision: 1, decision: 'discard', treatment: null, language: null, credit: null, eventTime: null, useAssistedSummary: false, [field]: true }).success, false, field);
  }
  assert.equal(DecideItemCommandSchema.safeParse({ ...base, expectedRevision: 1, decision: 'publish', treatment: 'summary', language: 'en', credit: 'Editorial office', eventTime: null, useAssistedSummary: false }).success, false, 'there is no publish decision');
  assert.equal(DecideItemCommandSchema.safeParse({ ...base, expectedRevision: 1, decision: 'draft', treatment: 'summary', language: 'en', credit: 'Synthetic editorial office', eventTime: null, useAssistedSummary: false }).success, true);
  assert.equal(DecideItemCommandSchema.safeParse({ ...base, expectedRevision: 1, decision: 'draft', treatment: null, language: 'en', credit: 'X', eventTime: null, useAssistedSummary: false }).success, false);
  assert.equal(SourcedFieldNameSchema.safeParse('licenceNumber').success, true);
  for (const f of ['qualityScore', 'rankHint', 'searchWeight', 'badgeLevel']) assert.equal(SourcedFieldNameSchema.safeParse(f).success, false, f);
  const item = { externalId: 'e-1', url: SITE, title: 'Synthetic guide', summary: null, fullText: null, sourceTime: null, sponsored: null };
  assert.equal(StageBatchCommandSchema.safeParse({ ...base, items: [item, item], fields: [], links: [] }).success, false, 'each external id once');
  assert.equal(StageBatchCommandSchema.safeParse({ ...base, items: [item], fields: [{ recordKind: 'company', recordId: crypto.randomUUID(), field: 'legalName', value: 'Synthetic Co', itemExternalId: 'other' }], links: [] }).success, false);
  assert.equal(SetSponsoredPolicyCommandSchema.safeParse({ ...base, allowed: false, maxSlotsPerPage: 1, requireVerifiedSponsor: true, approvalId: null }).success, false, 'no slots when off');
  assert.equal(SetSponsoredPolicyCommandSchema.safeParse({ ...base, allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: true, approvalId: null }).success, true);
  // Off by default, labelled, never a ranking signal.
  const policy = defaultSponsoredPolicyView('hub-1');
  assert.deepEqual([policy.allowed, policy.maxSlotsPerPage, policy.readerLabel, policy.affectsRankingOrMatching, policy.separateSlotOnly], [false, 0, true, false, true]);
  const digestInput = sponsoredPolicyDigestInput({ hubId: 'hub-1', version: 2, allowed: true, maxSlotsPerPage: 1, requireVerifiedSponsor: false });
  assert.equal(digestInput.action, 'sponsored.enable');
  assert.match(computeDigest(digestInput).value, /^[a-f0-9]{64}$/);
  assert.deepEqual([...TAKEDOWN_REASONS].sort(), ['court_order', 'legal_demand', 'licence_ended', 'privacy_request', 'rights_holder_request']);
});
