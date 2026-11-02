import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Collector, type CollectFetch, type CollectResponse, type CollectSource } from '../../apps/worker/src/collect/collector.js';
import { botUserAgent } from '../../packages/contracts/src/collection-policy.js';
import { ALL_USES, MOST_RESTRICTIVE_USES } from '../../packages/contracts/src/sources.js';

/**
 * SRC-002 worker adapter with a fake network that records every call: a deny never sends the target request (the
 * registry and law deny before any call at all); robots.txt and TDMRep are cached for 24 hours; a 5xx robots.txt
 * disallows; content behind a barrier is dropped; a changed signal digest comes back for the caller to pause the
 * source. No real network is used.
 */
type Route = { status: number; body?: string; headers?: Record<string, string>; url?: string };
function fakeNet(routes: Record<string, Route | (() => Route)>) {
  const calls: string[] = [];
  const fetch: CollectFetch = async (url) => {
    calls.push(url);
    const entry = routes[url];
    const r: Route = typeof entry === 'function' ? entry() : entry ?? { status: 404 };
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const response: CollectResponse = { status: r.status, url: r.url ?? url, headers: { get: (n) => headers.get(n.toLowerCase()) ?? null }, text: async () => r.body ?? '' };
    return response;
  };
  return { calls, fetch };
}
const ORIGIN = 'https://registry.example';
const TARGET = `${ORIGIN}/companies/123`;
const ROBOTS_OK = 'User-agent: *\nAllow: /';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const source = (over: Partial<CollectSource> = {}): CollectSource => ({
  id: 'src-1', status: 'active', allowedUses: { ...ALL_USES }, termsAutomatedAccess: 'permitted', personalData: false, legalBasis: null, rsl: null,
  recorded: { robots: sha(ROBOTS_OK), terms: null, rsl: null, tdm: null, contentUsage: null }, ...over,
});
let clock = Date.parse('2026-11-02T10:00:00Z');
const collector = (fetch: CollectFetch) => new Collector({ fetch, userAgent: botUserAgent('https://hub.example/bot'), now: () => clock });

test('registry and law deny with zero network calls', async () => {
  for (const over of [{ status: 'paused' }, { termsAutomatedAccess: 'forbidden' as const }, { termsAutomatedAccess: null }, { personalData: true, legalBasis: null }]) {
    const net = fakeNet({});
    const r = await collector(net.fetch).collect({ url: TARGET, source: source(over), restrictedPlace: false });
    assert.equal(r.decision.verdict, 'deny');
    assert.deepEqual(net.calls, [], `no request at all for ${JSON.stringify(over)}`);
  }
  const net = fakeNet({});
  await collector(net.fetch).collect({ url: TARGET, source: source(), restrictedPlace: true });
  assert.deepEqual(net.calls, [], 'a restricted place sends nothing');
});

test('robots disallow or unavailable: the target is never requested', async () => {
  for (const robots of [{ status: 200, body: 'User-agent: *\nDisallow: /companies/' }, { status: 503 }]) {
    const net = fakeNet({ [`${ORIGIN}/robots.txt`]: robots, [TARGET]: { status: 200, body: 'secret' } });
    const r = await collector(net.fetch).collect({ url: TARGET, source: source({ recorded: { ...source().recorded, robots: null } }), restrictedPlace: false });
    assert.equal(r.decision.verdict, 'deny');
    assert.equal(net.calls.includes(TARGET), false, 'zero calls to a denied URL');
    assert.equal(r.body, null);
  }
});

test('an allowed fetch returns the body with its narrowed uses; robots and TDMRep are cached for a day', async () => {
  const net = fakeNet({ [`${ORIGIN}/robots.txt`]: { status: 200, body: ROBOTS_OK }, [TARGET]: { status: 200, body: '<html>Synthetic Builders</html>', headers: { 'tdm-reservation': '1', 'content-type': 'text/html' } } });
  const c = collector(net.fetch);
  const first = await c.collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(first.decision.verdict, 'allow');
  assert.equal(first.body, '<html>Synthetic Builders</html>');
  assert.equal(first.decision.allowedUses.storeFullText, false, 'the TDM reservation header narrows mining uses');
  clock += 60_000;
  await c.collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(net.calls.filter((u) => u.endsWith('/robots.txt')).length, 1, 'robots.txt read once within 24 hours');
  clock += 86_400_000;
  await c.collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(net.calls.filter((u) => u.endsWith('/robots.txt')).length, 2, 'and again after a day');
});

test('a barrier drops the content; an unreadable Content-Usage gives the most restrictive reading', async () => {
  const net = fakeNet({ [`${ORIGIN}/robots.txt`]: { status: 200, body: ROBOTS_OK }, [TARGET]: { status: 200, body: 'Members only', url: `${ORIGIN}/account/login?next=/companies/123` } });
  const blocked = await collector(net.fetch).collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(blocked.decision.verdict, 'deny');
  assert.ok(blocked.decision.reasons.includes('barrier_login'));
  assert.equal(blocked.body, null, 'nothing behind a login wall is returned');
  const net2 = fakeNet({ [`${ORIGIN}/robots.txt`]: { status: 200, body: ROBOTS_OK }, [TARGET]: { status: 200, body: 'ok', headers: { 'content-usage': 'tdm' } } });
  const narrowed = await collector(net2.fetch).collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.deepEqual(narrowed.decision.allowedUses, MOST_RESTRICTIVE_USES);
});

test('a changed robots.txt digest denies and names the change for the caller to pause the source', async () => {
  const net = fakeNet({ [`${ORIGIN}/robots.txt`]: { status: 200, body: 'User-agent: *\nAllow: /\n# changed terms' }, [TARGET]: { status: 200, body: 'x' } });
  const r = await collector(net.fetch).collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(r.decision.verdict, 'deny');
  assert.deepEqual(r.decision.changed, ['robots']);
  assert.equal(net.calls.includes(TARGET), false);
});

test('a 429 with Retry-After makes the next request to the host wait', async () => {
  let n = 0;
  const net = fakeNet({ [`${ORIGIN}/robots.txt`]: { status: 200, body: ROBOTS_OK }, [TARGET]: () => (++n === 1 ? { status: 429, headers: { 'retry-after': '300' } } : { status: 200, body: 'ok' }) });
  const c = collector(net.fetch);
  const first = await c.collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(first.body, null, 'a 429 returns no content');
  const second = await c.collect({ url: TARGET, source: source(), restrictedPlace: false });
  assert.equal(second.decision.verdict, 'wait');
  assert.equal(second.decision.waitUntil, new Date(clock + 300_000).toISOString());
  assert.equal(net.calls.filter((u) => u === TARGET).length, 1, 'no request while the host is cooling down');
});
