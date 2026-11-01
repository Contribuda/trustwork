import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_ROUTE_HEADER, UNLOCALIZED_SEGMENTS, isEntryNavigation, isFilteredQuery, isPublicPath, localizePath, splitLanguage } from '../../../apps/web/app/_lib/public-paths.js';

/**
 * ADR 012 decision 27 (WEB-005): the address rules shared by the proxy, server components and the browser, and the
 * proxy's routing decisions. The proxy is compiled by Next (bundler resolution), so it is loaded at runtime through tsx
 * with a minimal local type, like tests/ops/security-headers.test.ts.
 */
interface WebProxyModule {
  proxy(request: unknown): Response;
  routePublic(
    pathname: string,
    cookieLang: string | undefined,
    entry: boolean,
    languages: { default: string; offered: readonly string[] },
  ): { kind: string; lang?: string; path?: string; location?: string; permanent?: boolean; personal?: boolean };
  internalPublicPath(lang: string, path: string): string;
  config: { matcher: string[] };
}
const PROXY_MODULE: string = '../../../apps/web/proxy.ts';
const NEXT_SERVER: string = 'next/server';
const { proxy, routePublic, internalPublicPath, config: proxyConfig } = (await import(PROXY_MODULE)) as WebProxyModule;
const { NextRequest } = (await import(NEXT_SERVER)) as { NextRequest: new (url: string, init?: { headers?: Record<string, string> }) => unknown };

const LANGUAGES = { default: 'en', offered: ['en', 'es', 'ru', 'uz-Latn', 'ka'] };

test('public paths: everything but the workspace, sign-in, onboarding, media, the API and framework files', () => {
  for (const path of ['/', '/news', '/news/a-story?x=1', '/companies/acme#team', '/magazine/12/read', '/this-route-does-not-exist', '/legal/terms', '/legal/privacy']) assert.ok(isPublicPath(path), path);
  for (const path of [
    '/app',
    '/app/viewer',
    '/login?next=%2Fapp',
    '/signup',
    '/recover/abc',
    '/logout',
    '/verify-email/t',
    // The mailed invitation link (QA-002 D1): transactional, never a localized public address.
    '/invitations/11111111-1111-4111-8111-111111111111/token',
    '/onboarding/goals',
    '/admin/hubs/x',
    '/restricted',
    '/media/artworks/a.svg',
    '/v1/me',
    '/_next/static/a.js',
    '/__nextjs_original-stack-frame',
    '/.well-known/x',
    '/icon.svg',
    '/manifest.webmanifest',
    'https://example.org/news',
    '//evil.example/news',
    'news',
  ])
    assert.ok(!isPublicPath(path), path);
  assert.ok(UNLOCALIZED_SEGMENTS.has('app'));
});

test('splitLanguage and localizePath: one prefix per non-default language, idempotent, query and fragment kept', () => {
  const prefixed = ['es', 'ru', 'uz-Latn', 'ka'];
  assert.deepEqual(splitLanguage('/ru/news/a?x=1#b', prefixed), { lang: 'ru', path: '/news/a?x=1#b' });
  assert.deepEqual(splitLanguage('/uz-Latn', prefixed), { lang: 'uz-Latn', path: '/' });
  assert.deepEqual(splitLanguage('/fr/news', prefixed), { lang: null, path: '/fr/news' }, 'a language not offered is an ordinary path');
  assert.deepEqual(splitLanguage('/news', prefixed), { lang: null, path: '/news' });
  assert.equal(localizePath('/news?topic=markets#feed', 'ru', 'en'), '/ru/news?topic=markets#feed');
  assert.equal(localizePath('/', 'ka', 'en'), '/ka');
  assert.equal(localizePath('/#about', 'ka', 'en'), '/ka#about');
  assert.equal(localizePath('/ru/news', 'ru', 'en'), '/ru/news', 'already prefixed');
  assert.equal(localizePath('/news', 'en', 'en'), '/news', 'the default language has no prefix');
  assert.equal(localizePath('/login?next=%2Fapp', 'ru', 'en'), '/login?next=%2Fapp', 'private addresses follow the cookie, not the URL');
  assert.equal(localizePath('https://example.org/news', 'ru', 'en'), 'https://example.org/news');
  assert.equal(localizePath('#team', 'ru', 'en'), '#team');
  assert.equal(localizePath('/news', 'es', 'es'), '/news', 'a deployment whose default is Spanish leaves Spanish unprefixed');
});

test('entry navigations: typed, bookmarked or from another site; never in-site, client-side or programmatic fetches', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  assert.ok(isEntryNavigation(headers({})), 'no Fetch Metadata (old browsers, crawlers, curl)');
  assert.ok(isEntryNavigation(headers({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })));
  assert.ok(isEntryNavigation(headers({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })));
  assert.ok(!isEntryNavigation(headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })));
  assert.ok(!isEntryNavigation(headers({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' })));
  assert.ok(!isEntryNavigation(headers({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' })));
  assert.ok(!isEntryNavigation(headers({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })));
  assert.ok(isEntryNavigation(headers({ 'sec-fetch-mode': 'cors' })), 'a server-side fetch (Node sends only Sec-Fetch-Mode) is not a browser');
  assert.ok(!isEntryNavigation(headers({ rsc: '1' })), 'client-side navigation');
  assert.ok(!isEntryNavigation(headers({ 'next-router-prefetch': '1' })), 'prefetch');
});

test('routePublic: serve, redirect /en/ permanently, redirect an entry by the cookie, never a prefixed address', () => {
  assert.deepEqual(routePublic('/news', undefined, true, LANGUAGES), { kind: 'serve', lang: 'en', path: '/news' });
  assert.deepEqual(routePublic('/ru/news', undefined, true, LANGUAGES), { kind: 'serve', lang: 'ru', path: '/news' });
  assert.deepEqual(routePublic('/en/news?x=1', undefined, false, LANGUAGES), { kind: 'redirect', location: '/news?x=1', permanent: true, personal: false });
  assert.deepEqual(routePublic('/news', 'ru', true, LANGUAGES), { kind: 'redirect', location: '/ru/news', permanent: false, personal: true });
  assert.deepEqual(routePublic('/', 'uz-Latn', true, LANGUAGES), { kind: 'redirect', location: '/uz-Latn', permanent: false, personal: true });
  assert.deepEqual(routePublic('/news', 'ru', false, LANGUAGES), { kind: 'serve', lang: 'en', path: '/news' }, 'in-site navigation keeps the English page');
  assert.deepEqual(routePublic('/ka/news', 'ru', true, LANGUAGES), { kind: 'serve', lang: 'ka', path: '/news' }, 'a prefixed address keeps its language');
  assert.deepEqual(routePublic('/news', 'en', true, LANGUAGES), { kind: 'serve', lang: 'en', path: '/news' });
  assert.deepEqual(routePublic('/news', 'fr', true, LANGUAGES), { kind: 'serve', lang: 'en', path: '/news' }, 'a cookie for a language not offered is ignored');
});

test('internalPublicPath and filtered queries: one internal page per language; filters never change who sees what', () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.equal(internalPublicPath('en', '/'), '/en');
  assert.equal(internalPublicPath('ru', '/news/a'), '/ru/news/a');
  assert.ok(isFilteredQuery(q('q=fasad')));
  assert.ok(isFilteredQuery(q('topic=markets&page=2')));
  assert.ok(!isFilteredQuery(q('persona=owner&_rsc=abc')), 'the demo persona and Next internals are not filters');
});

test('the proxy hands the internal page to the router in one header and drops any copy a client sends', () => {
  const route = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://127.0.0.1:3000${url}`, { headers }));
  const forged = { [PUBLIC_ROUTE_HEADER]: 'en/people/someone-private' };
  assert.equal(route('/news', forged).headers.get(`x-middleware-request-${PUBLIC_ROUTE_HEADER}`), 'en/news');
  assert.equal(route('/news?topic=markets').headers.get(`x-middleware-request-${PUBLIC_ROUTE_HEADER}`), 'en/news');
  assert.equal(route('/ru/companies/acme').headers.get(`x-middleware-request-${PUBLIC_ROUTE_HEADER}`), null, 'a prefixed address is its own internal page');
  const overridden = route('/ru/companies/acme', forged).headers.get('x-middleware-override-headers') ?? '';
  assert.ok(!overridden.split(',').includes(PUBLIC_ROUTE_HEADER), 'the forged header is removed from the request');
  assert.equal(route('/ru/companies/acme', forged).headers.get(`x-middleware-request-${PUBLIC_ROUTE_HEADER}`), null);
  assert.equal(route('/login', forged).headers.get(`x-middleware-request-${PUBLIC_ROUTE_HEADER}`), null, 'private pages never carry it');
});

test('next.config.ts applies the header with the same name and excludes exactly what the proxy matcher excludes', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../apps/web/next.config.ts'), 'utf8');
  assert.ok(source.includes(`const PUBLIC_ROUTE_HEADER = '${PUBLIC_ROUTE_HEADER}';`), 'header name in next.config.ts');
  const matcherExclusions = /\(\?!(.*?)\)\.\*/.exec(proxyConfig.matcher[1]!)?.[1]?.split('|') ?? [];
  const rewriteExclusions = /'\/:path\(\(\?!(.*?)\)\.\+\)'/.exec(source)?.[1]?.replace(/\\\\/g, '\\').split('|') ?? [];
  assert.ok(matcherExclusions.length >= 5 && rewriteExclusions.length >= 5, `${matcherExclusions} / ${rewriteExclusions}`);
  for (const item of matcherExclusions) assert.ok(rewriteExclusions.includes(item), `the rewrite also skips ${item}`);
});

test('under a base path the language redirects keep exactly one base path (the hosted preview, /trustwork)', () => {
  const NextRequestWithConfig = NextRequest as unknown as new (url: string, init: { headers?: Record<string, string>; nextConfig: { basePath: string } }) => unknown;
  const route = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequestWithConfig(`http://127.0.0.1:3000${url}`, { headers, nextConfig: { basePath: '/trustwork' } }));
  const location = (response: Response) => new URL(response.headers.get('location') ?? '', 'http://127.0.0.1:3000').pathname;
  assert.equal(location(route('/trustwork/companies', { cookie: 'trustwork.locale=ru' })), '/trustwork/ru/companies');
  assert.equal(location(route('/trustwork/en/news')), '/trustwork/news');
  assert.equal(location(route('/trustwork/companies?country=GE&lang=ka')), '/trustwork/ka/companies');
  assert.match(location(route('/trustwork', { cookie: 'trustwork.locale=ru' })), /^\/trustwork\/ru\/?$/);
});

test('every public page gets the per-request nonce policy, exactly like private pages (no inline-script allowance)', () => {
  const csp = (url: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://127.0.0.1:3000${url}`, { headers })).headers.get('content-security-policy') ?? '';
  for (const url of ['/', '/news', '/ru/news/a-story', '/news?topic=markets', '/companies/acme', '/es/magazine/12/read', '/events/forum/register', '/ka/this-route-does-not-exist']) {
    const policy = csp(url);
    const scriptSrc = /script-src ([^;]+)/.exec(policy)?.[1] ?? '';
    assert.match(scriptSrc, /'nonce-[A-Za-z0-9+/=]{20,}'/, `${url}: a script nonce`);
    assert.match(scriptSrc, /'strict-dynamic'/, url);
    assert.doesNotMatch(scriptSrc, /'unsafe-inline'|\*/, `${url}: no inline-script allowance and no wildcard`);
  }
  assert.notEqual(/'nonce-([^']+)'/.exec(csp('/news'))?.[1], /'nonce-([^']+)'/.exec(csp('/news'))?.[1], 'a new nonce per request');
});
