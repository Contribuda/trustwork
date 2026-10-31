import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../apps/api/src/app.js';
import { failingPool, SAME_ORIGIN } from './helpers.js';

/**
 * The web proxy is compiled by Next (bundler resolution); the root type-check uses NodeNext, so the module and
 * `next/server` are loaded at runtime through tsx with a minimal local type.
 */
interface WebProxyModule {
  proxy(request: unknown): Response;
  contentSecurityPolicy(nonce: string, options: { development: boolean; https: boolean }): string;
  MEDIA_CSP: string;
}
const PROXY_MODULE: string = '../../apps/web/proxy.ts';
const NEXT_SERVER: string = 'next/server';
const { proxy, contentSecurityPolicy, MEDIA_CSP } = (await import(PROXY_MODULE)) as WebProxyModule;
const { NextRequest } = (await import(NEXT_SERVER)) as { NextRequest: new (url: string, init?: { headers?: Record<string, string> }) => unknown };

const API_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'];

test('API: security headers on success, not-found and server-error responses; HSTS only for an https origin', async () => {
  const https = await createApp({ env: { PUBLIC_ORIGIN: 'https://hub.example.test' }, pool: failingPool(), logSink: () => undefined });
  const http = await createApp({ logSink: () => undefined });
  try {
    const responses = [
      await https.fastify.inject({ method: 'GET', url: '/health' }),
      await https.fastify.inject({ method: 'GET', url: '/nope' }),
      await https.fastify.inject({ method: 'POST', url: '/v1/auth/login', headers: SAME_ORIGIN, payload: { email: 'x@example.invalid', password: 'irrelevant password' } }),
    ];
    assert.deepEqual(responses.map((r) => r.statusCode), [200, 404, 500]);
    for (const r of responses) {
      for (const name of API_HEADERS) assert.ok(r.headers[name], `${name} on ${r.statusCode}`);
      assert.equal(r.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
      assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.match(String(r.headers['permissions-policy']), /camera=\(\)/);
    }
    const local = await http.fastify.inject({ method: 'GET', url: '/health' });
    assert.equal(local.headers['strict-transport-security'], undefined, 'no HSTS on a plain-http development origin');
    assert.ok(local.headers['content-security-policy']);
  } finally {
    await https.close();
    await http.close();
  }
});

const cspOf = (response: Response) => response.headers.get('content-security-policy') ?? '';
const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

test('web: every page gets a fresh nonce-based CSP that Next can read from the request', () => {
  const first = proxy(new NextRequest('http://127.0.0.1:3000/companies'));
  const second = proxy(new NextRequest('http://127.0.0.1:3000/companies'));
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
