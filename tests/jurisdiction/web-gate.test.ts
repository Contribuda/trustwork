import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * SANC-001, the web door: the proxy refuses requests from restricted places before anything else (pages render the
 * refusal page in place, everything else is 451), relays a refused session to the API so its gate can hold the person,
 * fails closed on a broken configuration and never forwards anything but the session cookie and the address.
 * The proxy module and `next/server` load at runtime through tsx (Next compiles them with bundler resolution).
 */
process.env.TRUSTWORK_JURISDICTION_GATE = 'fake';
// The relay must never reach a real API (another process may listen on the development port): port 9 refuses at once.
process.env.TRUSTWORK_API_ORIGIN = 'http://127.0.0.1:9';
interface JurisdictionModule {
  clientAddressOf(get: (name: string) => string | null): string | null;
  decideWebRequest(request: { method: string; pathname: string; header(name: string): string | null }, state?: unknown): { kind: string; status?: number; body?: { code: string }; sighting?: { place: string; dataset: string } };
  webJurisdictionGate(env?: Record<string, string | undefined>, reset?: boolean): { gate: { mode: string } | null; broken: boolean };
  sessionCookieOf(header: string | null): string | null;
  relaySighting(input: { cookieHeader: string | null; address: string | null }, options?: { origin?: string | null; fetch?: typeof fetch; timeoutMs?: number }): Promise<string>;
  jurisdictionOpenPath(pathname: string): boolean;
}
const LIB: string = '../../apps/web/app/_lib/jurisdiction.ts';
const PROXY: string = '../../apps/web/proxy.ts';
const NEXT_SERVER: string = 'next/server';
const lib = (await import(LIB)) as JurisdictionModule;
const { proxy } = (await import(PROXY)) as { proxy(request: unknown, event?: { waitUntil(p: Promise<unknown>): void }): Response };
const { NextRequest } = (await import(NEXT_SERVER)) as { NextRequest: new (url: string, init?: { method?: string; headers?: Record<string, string> }) => unknown };

const headersOf = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;
const HTML = { accept: 'text/html,application/xhtml+xml' };

test('client address: the edge-written X-Real-IP, else the last X-Forwarded-For hop; never an earlier, client-claimed hop', () => {
  assert.equal(lib.clientAddressOf(headersOf({ 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '203.0.113.1' })), '192.0.2.1');
  assert.equal(lib.clientAddressOf(headersOf({ 'x-forwarded-for': '192.0.2.1, 203.0.113.9' })), '203.0.113.9');
  assert.equal(lib.clientAddressOf(headersOf({})), null);
});

test('decisions: pages are refused in place, calls and server actions with 451, the refusal page stays open', () => {
  const state = lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'fake' }, true);
  const restricted = (pathname: string, extra: Record<string, string> = {}, method = 'GET') => lib.decideWebRequest({ method, pathname, header: headersOf({ 'x-real-ip': '192.0.2.10', ...extra }) }, state);
  assert.equal(restricted('/companies', HTML).kind, 'refuse_page');
  assert.equal(restricted('/companies', { ...HTML, 'next-action': 'abc' }, 'POST').kind, 'refuse_call');
  const call = restricted('/v1/me', { accept: 'application/json' });
  assert.deepEqual([call.kind, call.status, call.body?.code], ['refuse_call', 451, 'jurisdiction.restricted']);
  assert.equal(restricted('/v1/me', HTML).kind, 'refuse_call', 'an API path is never a page');
  assert.equal(restricted('/restricted', HTML).kind, 'pass');
  assert.equal(lib.decideWebRequest({ method: 'GET', pathname: '/companies', header: headersOf({ 'x-real-ip': '203.0.113.7', ...HTML }) }, state).kind, 'pass');
  assert.equal(lib.decideWebRequest({ method: 'GET', pathname: '/companies', header: headersOf(HTML) }, state).kind, 'pass', 'no address: served (a local stand)');
});

test('configuration: unconfigured serves (the API refuses to start in production); a broken range table fails closed', () => {
  assert.equal(lib.webJurisdictionGate({}, true).gate?.mode, 'unconfigured');
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-web-gate-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '{"format":"trustwork-restricted-ranges-1","dataset":"x","month":"2026-10","attribution":"","codes":["US"],"v4":[],"v6":[]}');
    const broken = lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'ranges_file', TRUSTWORK_JURISDICTION_RANGES_FILE: join(dir, 'bad.json') }, true);
    assert.equal(broken.broken, true);
    const decision = lib.decideWebRequest({ method: 'GET', pathname: '/companies', header: headersOf({ 'x-real-ip': '203.0.113.7' }) }, broken);
    assert.deepEqual([decision.kind, decision.status], ['unavailable', 503]);
    assert.equal(lib.decideWebRequest({ method: 'GET', pathname: '/restricted', header: headersOf({}) }, broken).kind, 'pass');
    assert.equal(lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'fake', NODE_ENV: 'production' }, true).broken, true, 'fake is refused in production');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'fake' }, true);
  }
});

test('relay: only the session cookie and the address go to the API; no session, no relay; a failure never throws', async () => {
  assert.equal(lib.sessionCookieOf('trustwork.locale=ru; __Host-sr_session=abc; other=1'), '__Host-sr_session=abc');
  assert.equal(lib.sessionCookieOf('sr_session=dev'), 'sr_session=dev');
  assert.equal(lib.sessionCookieOf('trustwork.locale=ru'), null);
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, headers: init.headers }); return new Response(null, { status: 451 }); }) as unknown as typeof fetch;
  assert.equal(await lib.relaySighting({ cookieHeader: 'trustwork.locale=ru; __Host-sr_session=abc', address: '192.0.2.10' }, { origin: 'http://api.internal:3001', fetch: fakeFetch }), 'relayed');
  assert.equal(calls[0]?.url, 'http://api.internal:3001/v1/jurisdiction/sighting');
  assert.equal(calls[0]?.headers.cookie, '__Host-sr_session=abc', 'no other cookie travels');
  assert.equal(calls[0]?.headers['x-forwarded-for'], '192.0.2.10');
  assert.equal(await lib.relaySighting({ cookieHeader: 'trustwork.locale=ru', address: '192.0.2.10' }, { origin: 'http://api.internal:3001', fetch: fakeFetch }), 'skipped');
  assert.equal(await lib.relaySighting({ cookieHeader: '__Host-sr_session=abc', address: '192.0.2.10' }, { origin: null, fetch: fakeFetch }), 'skipped');
  const failing = (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch;
  assert.equal(await lib.relaySighting({ cookieHeader: '__Host-sr_session=abc', address: '192.0.2.10' }, { origin: 'http://api.internal:3001', fetch: failing }), 'failed');
});

test('proxy: a restricted page renders the refusal page in place, a call is 451 JSON, the relay waits beside the response', async () => {
  lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'fake' }, true);
  const waited: Promise<unknown>[] = [];
  const event = { waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  const page = proxy(new NextRequest('http://127.0.0.1:3000/companies?x=1', { headers: { ...HTML, 'x-real-ip': '192.0.2.10', cookie: '__Host-sr_session=abc' } }), event);
  assert.match(page.headers.get('x-middleware-rewrite') ?? '', /\/restricted$/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(page.headers.get('content-security-policy'), 'the refusal page keeps the nonce-based CSP');
  assert.equal(page.headers.get('x-middleware-request-x-trustwork-refusal'), 'jurisdiction');
  const call = proxy(new NextRequest('http://127.0.0.1:3000/v1/me', { headers: { accept: 'application/json', 'x-real-ip': '192.0.2.10' } }), event);
  assert.equal(call.status, 451);
  assert.deepEqual(((await call.json()) as { code: string }).code, 'jurisdiction.restricted');
  const media = proxy(new NextRequest('http://127.0.0.1:3000/media/a.svg', { headers: { 'x-real-ip': '192.0.2.10' } }), event);
  assert.equal(media.status, 451, 'media is refused too');
  const served = proxy(new NextRequest('http://127.0.0.1:3000/companies', { headers: { ...HTML, 'x-real-ip': '203.0.113.7' } }), event);
  assert.equal(served.headers.get('x-middleware-rewrite'), null);
  assert.equal(served.status, 200);
  const refusalPage = proxy(new NextRequest('http://127.0.0.1:3000/restricted', { headers: { ...HTML, 'x-real-ip': '192.0.2.10' } }), event);
  assert.equal(refusalPage.headers.get('x-middleware-rewrite'), null, 'the refusal page itself is served');
  assert.ok(waited.length >= 1, 'the relay of a refused session runs beside the response');
  await Promise.all(waited);
});

test('proxy: the gate runs before language routing (WEB-005); the refusal page is not a localized address', () => {
  lib.webJurisdictionGate({ TRUSTWORK_JURISDICTION_GATE: 'fake' }, true);
  const event = { waitUntil: () => {} };
  const refused = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://127.0.0.1:3000${url}`, { headers: { ...HTML, 'x-real-ip': '192.0.2.10', ...headers } }), event);
  for (const url of ['/news', '/ru/news', '/en/news', '/news?topic=markets', '/companies?country=GE&lang=ka']) {
    const response = refused(url, { cookie: 'trustwork.locale=ru; trustwork.country=UZ' });
    assert.match(response.headers.get('x-middleware-rewrite') ?? '', /\/restricted$/, `${url}: refused in place, never a language redirect`);
    assert.equal(response.headers.get('location'), null, url);
    assert.equal(response.headers.get('set-cookie'), null, `${url}: no locale cookie is set`);
  }
  const page = proxy(new NextRequest('http://127.0.0.1:3000/restricted', { headers: { ...HTML, 'x-real-ip': '192.0.2.10', cookie: 'trustwork.locale=ru' } }), event);
  assert.equal(page.headers.get('location'), null, 'the refusal page follows the cookie language, it is never redirected to a prefix');
  assert.equal(page.headers.get('x-middleware-request-x-trustwork-public-route'), null);
  assert.match(page.headers.get('content-security-policy') ?? '', /'nonce-/);
});
