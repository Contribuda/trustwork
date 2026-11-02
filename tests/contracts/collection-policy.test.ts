import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botUserAgent, decideCollection, detectBarrier, HostPoliteness, parseRetryAfter, readContentUsage, readTdm, TDM_GOVERNED_USES, type CollectionInput,
} from '../../packages/contracts/src/collection-policy.js';
import { ALL_USES, MOST_RESTRICTIVE_USES, parseRsl } from '../../packages/contracts/src/sources.js';

/**
 * SRC-002: the pure pre-collection gate. Deny reasons stop the fetch; unknown, unparsable or conflicting signals narrow
 * the uses to the most restrictive reading; a changed signal digest denies until a person re-checks the source.
 */
const NOW = new Date('2026-11-02T10:00:00Z');
const D = (c: string) => c.repeat(64);
const base = (over: Partial<CollectionInput> = {}): CollectionInput => ({
  url: 'https://registry.example/companies/123?page=2',
  userAgent: botUserAgent('https://hub.example/bot'),
  source: { status: 'active', allowedUses: { ...ALL_USES }, termsAutomatedAccess: 'permitted', personalData: false, legalBasis: null, recorded: { robots: D('a'), terms: D('b'), rsl: null, tdm: null, contentUsage: null } },
  restrictedPlace: false,
  robots: { status: 'ok', body: 'User-agent: *\nAllow: /' },
  rsl: null,
  tdm: { status: 'none', policyUrl: null },
  contentUsage: { status: 'none', preferences: {} },
  barrier: null,
  digests: { robots: D('a'), terms: D('b'), rsl: null, tdm: null, contentUsage: null },
  hostFreeAt: null,
  now: NOW,
  ...over,
});

test('a clean source with permissive signals is allowed with its own flags', () => {
  const d = decideCollection(base());
  assert.equal(d.verdict, 'allow');
  assert.deepEqual(d.allowedUses, ALL_USES);
  assert.deepEqual(d.reasons, []);
});

test('registry and law deny: inactive source, restricted place, unchecked or forbidding terms, missing legal basis', () => {
  const cases: Array<[Partial<CollectionInput>, string]> = [
    [{ source: { ...base().source, status: 'paused' } }, 'source_not_active'],
    [{ restrictedPlace: true }, 'restricted_place'],
    [{ source: { ...base().source, termsAutomatedAccess: null } }, 'terms_unchecked'],
    [{ source: { ...base().source, termsAutomatedAccess: 'unclear' } }, 'terms_forbid_automated'],
    [{ source: { ...base().source, personalData: true, legalBasis: null } }, 'legal_basis_missing'],
  ];
  for (const [over, reason] of cases) {
    const d = decideCollection(base(over));
    assert.equal(d.verdict, 'deny', reason);
    assert.ok(d.reasons.includes(reason as never), reason);
    assert.deepEqual(d.allowedUses, MOST_RESTRICTIVE_USES, 'a deny allows nothing');
  }
});

test('robots: disallow and an unavailable robots.txt deny; a missing one allows (RFC 9309)', () => {
  assert.equal(decideCollection(base({ robots: { status: 'ok', body: 'User-agent: *\nDisallow: /companies/' } })).verdict, 'deny');
  assert.ok(decideCollection(base({ robots: { status: 'unavailable', body: null } })).reasons.includes('robots_unavailable'));
  assert.equal(decideCollection(base({ robots: { status: 'not_found', body: null } })).verdict, 'allow');
  assert.equal(decideCollection(base({ robots: { status: 'ok', body: 'User-agent: TrustworkBot\nDisallow: /\n\nUser-agent: *\nAllow: /' } })).verdict, 'deny', 'the group for our token wins');
});

test('barriers deny whatever robots says', () => {
  for (const barrier of ['login', 'paywall', 'challenge'] as const) assert.equal(decideCollection(base({ barrier })).verdict, 'deny', barrier);
});

test('a changed signal digest denies and names the signal', () => {
  const d = decideCollection(base({ digests: { ...base().digests, robots: D('c') } }));
  assert.equal(d.verdict, 'deny');
  assert.deepEqual(d.changed, ['robots']);
  assert.ok(d.reasons.includes('signal_changed'));
  assert.equal(decideCollection(base({ source: { ...base().source, recorded: { ...base().source.recorded, tdm: null } }, digests: { ...base().digests, tdm: D('d') } })).verdict, 'allow',
    'a first reading (nothing recorded yet) is not a change');
});

test('TDM reservation narrows mining uses; unparsable or conflicting signals give the most restrictive reading', () => {
  const reserved = decideCollection(base({ tdm: { status: 'reserved', policyUrl: null } }));
  assert.equal(reserved.verdict, 'allow');
  for (const k of TDM_GOVERNED_USES) assert.equal(reserved.allowedUses[k], false, k);
  assert.equal(reserved.allowedUses.displayHeadlineAndLink, true);
  for (const tdm of [{ status: 'unparsable', policyUrl: null }, { status: 'conflict', policyUrl: null }] as const) {
    assert.deepEqual(decideCollection(base({ tdm })).allowedUses, MOST_RESTRICTIVE_USES, tdm.status);
  }
  assert.deepEqual(decideCollection(base({ contentUsage: { status: 'unparsable', preferences: {} } })).allowedUses, MOST_RESTRICTIVE_USES);
  const failedRsl = parseRsl('<not rsl', 'https://registry.example/rsl.xml');
  assert.deepEqual(decideCollection(base({ rsl: failedRsl })).allowedUses, MOST_RESTRICTIVE_USES, 'an unreadable RSL document closes everything');
});

test('Content-Usage narrows model and search uses; flags never exceed the source', () => {
  const d = decideCollection(base({ contentUsage: readContentUsage('ai=n, search=n') }));
  assert.equal(d.allowedUses.sendToModelProviders, false);
  assert.equal(d.allowedUses.indexForSearch, false);
  assert.ok(d.reasons.includes('content_usage_restricts'));
  const narrowSource = decideCollection(base({ source: { ...base().source, allowedUses: { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true } }, contentUsage: readContentUsage('ai=y, search=y') }));
  assert.deepEqual(narrowSource.allowedUses, { ...MOST_RESTRICTIVE_USES, displayHeadlineAndLink: true }, 'a permissive signal never widens the source flags');
  assert.ok(decideCollection(base({ tdm: { status: 'not_reserved', policyUrl: null }, contentUsage: readContentUsage('tdm=n') })).reasons.includes('signal_conflict'));
});

test('politeness: a busy host waits; 429 with Retry-After backs off; success resets to the crawl delay', () => {
  const wait = decideCollection(base({ hostFreeAt: new Date(NOW.getTime() + 30_000) }));
  assert.equal(wait.verdict, 'wait');
  assert.equal(wait.waitUntil, new Date(NOW.getTime() + 30_000).toISOString());
  const p = new HostPoliteness();
  const t0 = NOW.getTime();
  p.start('registry.example');
  assert.ok(p.freeAt('registry.example', t0), 'one request in flight at a time');
  p.finish('registry.example', t0, { status: 429, retryAfter: '120' }, 5);
  assert.equal(p.freeAt('registry.example', t0)?.getTime(), t0 + 120_000);
  p.start('registry.example');
  p.finish('registry.example', t0 + 120_000, { status: 200, retryAfter: null }, 5);
  assert.equal(p.freeAt('registry.example', t0 + 120_000)?.getTime(), t0 + 125_000);
  assert.equal(parseRetryAfter('Wed, 02 Nov 2026 10:01:00 GMT', t0), 60_000);
  assert.equal(parseRetryAfter('soon', t0), null);
});

test('readers: TDMRep file and headers, Content-Usage, barriers', () => {
  const file = JSON.stringify([{ location: '/companies/*', 'tdm-reservation': 1, 'tdm-policy': 'https://registry.example/tdm-policy.json' }, { location: '/*', 'tdm-reservation': 0 }]);
  assert.deepEqual(readTdm({ headers: {}, wellKnown: file, path: '/companies/123' }), { status: 'reserved', policyUrl: 'https://registry.example/tdm-policy.json' });
  assert.equal(readTdm({ headers: {}, wellKnown: file, path: '/about' }).status, 'not_reserved');
  assert.equal(readTdm({ headers: { 'tdm-reservation': '0' }, wellKnown: file, path: '/companies/1' }).status, 'conflict');
  assert.equal(readTdm({ headers: {}, wellKnown: '{not json', path: '/' }).status, 'unparsable');
  assert.equal(readTdm({ headers: { 'tdm-reservation': 'maybe' }, wellKnown: null, path: '/' }).status, 'unparsable');
  assert.deepEqual(readContentUsage('tdm=n, future-thing=y'), { status: 'parsed', preferences: { tdm: false } });
  assert.equal(readContentUsage('tdm').status, 'unparsable');
  assert.equal(readContentUsage('ai=y, ai=n').status, 'unparsable', 'a repeated category that disagrees is unreadable');
  const r = (over: Partial<Parameters<typeof detectBarrier>[0]>) => detectBarrier({ status: 200, headers: {}, finalUrl: 'https://registry.example/companies/1', bodyStart: '<html></html>', ...over });
  assert.equal(r({ status: 401 }), 'login');
  assert.equal(r({ finalUrl: 'https://registry.example/account/login?next=/companies/1' }), 'login');
  assert.equal(r({ bodyStart: '<script type="application/ld+json">{"isAccessibleForFree": false}</script>' }), 'paywall');
  assert.equal(r({ bodyStart: '<div class="g-recaptcha" data-sitekey="x"></div>' }), 'challenge');
  assert.equal(r({}), null);
});
