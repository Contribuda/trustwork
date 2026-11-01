import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { apiConfigFromEnv, ConfigError } from '../../apps/api/src/config.js';
import { failingPool, SAME_ORIGIN } from './helpers.js';

/**
 * The web proxy is compiled by Next (bundler resolution); the root type-check uses NodeNext, so the module and
 * `next/server` are loaded at runtime through tsx with a minimal local type.
 */
interface WebProxyModule {
  proxy(request: unknown): Response;
  contentSecurityPolicy(nonce: string, options: { development: boolean; https: boolean }): string;
  configuredHsts(raw?: string): string | null;
  MEDIA_CSP: string;
  config: { matcher: string[] };
}
const PROXY_MODULE: string = '../../apps/web/proxy.ts';
const NEXT_SERVER: string = 'next/server';
const { proxy, contentSecurityPolicy, configuredHsts, MEDIA_CSP, config: proxyConfig } = (await import(PROXY_MODULE)) as WebProxyModule;
const { NextRequest } = (await import(NEXT_SERVER)) as { NextRequest: new (url: string, init?: { headers?: Record<string, string> }) => unknown };

const API_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'];

test('API: security headers on success, not-found and server-error responses; no HSTS unless configured', async () => {
  const https = await createApp({ env: { PUBLIC_ORIGIN: 'https://hub.example.test' }, pool: failingPool(), logSink: () => undefined });
  const pinned = await createApp({ env: { PUBLIC_ORIGIN: 'https://hub.example.test', TRUSTWORK_HSTS: 'max-age=63072000' }, logSink: () => undefined });
  try {
    const responses = [
      await https.fastify.inject({ method: 'GET', url: '/health' }),
      await https.fastify.inject({ method: 'GET', url: '/nope' }),
      await https.fastify.inject({ method: 'POST', url: '/v1/auth/login', headers: SAME_ORIGIN, payload: { email: 'x@example.invalid', password: 'irrelevant password' } }),
    ];
    assert.deepEqual(responses.map((r) => r.statusCode), [200, 404, 500]);
    for (const r of responses) {
      for (const name of API_HEADERS) assert.ok(r.headers[name], `${name} on ${r.statusCode}`);
      assert.equal(r.headers['strict-transport-security'], undefined, 'default: no HSTS even for an https origin (the domain operator decides)');
      assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.match(String(r.headers['permissions-policy']), /camera=\(\)/);
    }
    const configured = await pinned.fastify.inject({ method: 'GET', url: '/health' });
    assert.equal(configured.headers['strict-transport-security'], 'max-age=63072000', 'configured: the exact value, no includeSubDomains or preload added');
  } finally {
    await https.close();
    await pinned.close();
  }
});

test('API: TRUSTWORK_HSTS must be a valid header value', () => {
  assert.equal(apiConfigFromEnv({}).securityHeaders.hsts, null);
  assert.equal(apiConfigFromEnv({ TRUSTWORK_HSTS: 'max-age=31536000; includeSubDomains; preload' }).securityHeaders.hsts, 'max-age=31536000; includeSubDomains; preload');
  for (const bad of ['31536000', 'max-age=1; evil=1', 'max-age=abc', 'max-age=1\r\nSet-Cookie: x=1']) {
    assert.throws(() => apiConfigFromEnv({ TRUSTWORK_HSTS: bad }), (e: unknown) => e instanceof ConfigError && /TRUSTWORK_HSTS/.test(e.message), bad);
  }
});

const cspOf = (response: Response) => response.headers.get('content-security-policy') ?? '';
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

test('web: every private page gets a fresh nonce-based CSP that Next can read from the request', () => {
  const first = proxy(new NextRequest('http://127.0.0.1:3000/login'));
  const second = proxy(new NextRequest('http://127.0.0.1:3000/login'));
  const csp = cspOf(first);
  const nonce = nonceOf(csp);
  assert.ok(nonce && nonce.length >= 22, csp);
  assert.notEqual(nonceOf(cspOf(second)), nonce, 'a new nonce per request');
  assert.match(csp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, 'no inline script allowance');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'not on plain http (loopback stand)');
  // NextResponse.next({ request: { headers } }) forwards the overridden request headers to the renderer.
  assert.equal(first.headers.get('x-middleware-request-content-security-policy'), csp);
  assert.equal(first.headers.get('x-middleware-request-x-nonce'), nonce);
  assert.equal(first.headers.get('x-frame-options'), 'DENY');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(first.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(first.headers.get('permissions-policy') ?? '', /camera=\(\)/);
  assert.equal(first.headers.get('strict-transport-security'), null, 'default: no HSTS (the hosted preview lives under a path of another domain)');
});

test('web: public pages, in every language and with filters, get the same nonce-based CSP as private pages (WEB-005)', () => {
  for (const path of ['/', '/companies', '/ru/news/some-story', '/news?topic=markets', '/events/forum/register', '/ru/events/forum/pay']) {
    const response = proxy(new NextRequest(`http://127.0.0.1:3000${path}`));
    const csp = cspOf(response);
    assert.ok(nonceOf(csp), `${path}: a script nonce`);
    assert.match(csp, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/, path);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, path);
    assert.equal(response.headers.get('x-middleware-request-content-security-policy'), csp, `${path}: Next reads the nonce from the request`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
});

test('web: HSTS only when TRUSTWORK_HSTS is set, with exactly the configured value', () => {
  const previous = process.env.TRUSTWORK_HSTS;
  try {
    process.env.TRUSTWORK_HSTS = 'max-age=86400';
    const pinned = proxy(new NextRequest('http://internal:3000/', { headers: { 'x-forwarded-proto': 'https' } }));
    assert.equal(pinned.headers.get('strict-transport-security'), 'max-age=86400', 'no includeSubDomains or preload added');
    const redirect = proxy(new NextRequest('http://internal:3000/?lang=ru'));
    assert.equal(redirect.headers.get('strict-transport-security'), 'max-age=86400');
    process.env.TRUSTWORK_HSTS = 'max-age=1; evil';
    assert.equal(proxy(new NextRequest('http://internal:3000/')).headers.get('strict-transport-security'), null, 'a malformed value is never sent');
  } finally {
    if (previous === undefined) delete process.env.TRUSTWORK_HSTS;
    else process.env.TRUSTWORK_HSTS = previous;
  }
  assert.equal(configuredHsts(undefined), null);
  assert.equal(configuredHsts(' max-age=31536000; includeSubDomains '), 'max-age=31536000; includeSubDomains');
  assert.equal(configuredHsts('includeSubDomains'), null);
});

test('web: https requests add upgrade-insecure-requests; locale redirects carry the headers too; media is sandboxed', () => {
  const behindProxy = proxy(new NextRequest('http://internal:3000/', { headers: { 'x-forwarded-proto': 'https' } }));
  assert.match(cspOf(behindProxy), /upgrade-insecure-requests/);
  const redirect = proxy(new NextRequest('http://127.0.0.1:3000/events?country=UZ&lang=ru'));
  assert.equal(redirect.status, 307);
  assert.ok(nonceOf(cspOf(redirect)));
  assert.equal(redirect.headers.get('x-frame-options'), 'DENY');
  const media = proxy(new NextRequest('http://127.0.0.1:3000/media/logo.svg'));
  assert.equal(cspOf(media), MEDIA_CSP);
  assert.match(MEDIA_CSP, /sandbox/);
  assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
});

test('web: development relaxes only what the bundler needs', () => {
  const dev = contentSecurityPolicy('n0nce', { development: true, https: false });
  assert.match(dev, /'unsafe-eval'/);
  assert.match(dev, /connect-src 'self' ws: wss:/);
  assert.doesNotMatch(contentSecurityPolicy('n0nce', { development: false, https: true }), /unsafe-eval|ws:/);
});

/** Next's own matcher compiler (the function `next build` uses for the proxy manifest), loaded at runtime. */
const NEXT_MATCHERS: string = 'next/dist/build/analysis/get-page-static-info.js';
const { getMiddlewareMatchers } = (await import(NEXT_MATCHERS)) as { getMiddlewareMatchers(matcher: string[], config: { basePath?: string; i18n?: undefined }): { regexp: string }[] };

test('web: the proxy runs on the home page and on every page with and without a base path, never on static files', () => {
  for (const basePath of ['', '/trustwork']) {
    const regexps = getMiddlewareMatchers(proxyConfig.matcher, { basePath }).map((m) => new RegExp(m.regexp));
    const runs = (path: string) => regexps.some((r) => r.test(path));
    // With a base path the home page is `<base>` without a trailing slash; the catch-all alone does not match it.
    for (const path of [basePath || '/', `${basePath}/companies`, `${basePath}/companies/acme`, `${basePath}/media/artworks/a.svg`]) assert.ok(runs(path), `${basePath || '(none)'}: runs on ${path}`);
    for (const path of [`${basePath}/_next/static/chunks/a.js`, `${basePath}/icon.svg`, `${basePath}/favicon.ico`, `${basePath}/icons/a.png`]) assert.ok(!runs(path), `${basePath || '(none)'}: skips ${path}`);
    // QA-002 D3: only the refusal page's own assets skip the proxy; the image optimizer and other framework paths pass the jurisdiction gate.
    for (const path of [`${basePath}/_next/image`, `${basePath}/_next/data/build/index.json`, `${basePath}/legal/terms`]) assert.ok(runs(path), `${basePath || '(none)'}: runs on ${path}`);
  }
});
