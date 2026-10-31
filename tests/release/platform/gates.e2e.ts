import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { EDGE_COUNTRY_HEADER, EDGE_REGION_HEADER, SAME_ORIGIN, verifiedAccount, visitorState } from './support.js';

/**
 * QA-002 release gates over HTTP on the compose stack (desktop English project only): security headers and the strict
 * nonce Content-Security-Policy on every page, anonymous and signed in; no internal header leaks through the proxy;
 * the jurisdiction gate in its configured mode refuses the restricted places at the web door and at the API. Readiness,
 * the screening baseline and the worker are checked by run.mjs against the containers.
 */
const PUBLIC_PAGES = ['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine', '/magazine/archive', '/search?q=roof', '/login', '/signup', '/recover', '/verify-email/not-a-real-token-000', '/restricted'];
const WORKSPACE_PAGES = ['/app', '/app/me', '/app/company', '/app/projects', '/app/procurement', '/app/sales', '/app/publications', '/app/assistant', '/app/notifications', '/app/settings', '/onboarding'];

/** Script elements the browser executes (no type, a JavaScript type or a module); data blocks are not scripts. */
function executableScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => {
    const type = /\btype="([^"]*)"/i.exec(tag)?.[1]?.toLowerCase();
    return !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';
  });
}

async function expectStrictDocument(response: APIResponse, path: string): Promise<string> {
  const headers = response.headers();
  const csp = headers['content-security-policy'] ?? '';
  const directives = new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d.split(/\s+/).slice(1)] as const));
  const script = directives.get('script-src') ?? [];
  const nonce = script.find((s) => s.startsWith("'nonce-"))?.slice(7, -1);
  expect(nonce, `${path}: script nonce in "${csp}"`).toBeTruthy();
  expect(script, `${path}: strict-dynamic`).toContain("'strict-dynamic'");
  expect(script, `${path}: no unsafe-inline scripts`).not.toContain("'unsafe-inline'");
  expect(script, `${path}: no unsafe-eval in a production build`).not.toContain("'unsafe-eval'");
  expect(directives.get('object-src'), path).toEqual(["'none'"]);
  expect(directives.get('base-uri'), path).toEqual(["'self'"]);
  expect(directives.get('frame-ancestors'), path).toEqual(["'none'"]);
  expect(directives.get('form-action'), path).toEqual(["'self'"]);
  expect(directives.get('default-src'), path).toEqual(["'self'"]);
  expect(headers['x-frame-options'], path).toBe('DENY');
  expect(headers['x-content-type-options'], path).toBe('nosniff');
  expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
  expect(headers['cross-origin-opener-policy'], path).toBe('same-origin');
  expect(headers['permissions-policy'] ?? '', path).toMatch(/camera=\(\).*geolocation=\(\).*payment=\(\)/);
  expect(headers.server, `${path}: the proxy strips Server`).toBeUndefined();
  expect(headers['x-powered-by'], path).toBeUndefined();
  const leaked = Object.keys(headers).filter((h) => h === 'x-nonce' || h.startsWith('x-middleware-'));
  expect(leaked, `${path}: internal headers leak through the proxy`).toEqual([]);
  const html = await response.text();
  const scripts = executableScripts(html);
  expect(scripts.length, `${path}: the page has scripts`).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`)), `${path}: every script carries this response's nonce`).toEqual([]);
  return nonce!;
}

async function get(request: APIRequestContext, path: string, headers: Record<string, string> = {}): Promise<APIResponse> {
  return request.get(path, { headers, maxRedirects: 0, failOnStatusCode: false });
}

test('every page carries the security headers and a strict nonce CSP, anonymous and signed in', async ({ playwright, baseURL }) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL!, storageState: visitorState('en') });
  const nonces = new Set<string>();
  for (const path of PUBLIC_PAGES) {
    const response = await get(anonymous, path);
    expect(response.status(), path).toBe(200);
    nonces.add(await expectStrictDocument(response, path));
  }
  // A fresh nonce per response, never a constant.
  nonces.add(await expectStrictDocument(await get(anonymous, '/'), '/ (again)'));
  expect(nonces.size).toBe(PUBLIC_PAGES.length + 1);
  await anonymous.dispose();

  const signedIn = await playwright.request.newContext({ baseURL: baseURL!, storageState: visitorState('en') });
  await verifiedAccount(signedIn, 'Gate Checker', 'en');
  for (const path of WORKSPACE_PAGES) {
    const response = await get(signedIn, path);
    expect(response.status(), path).toBe(200);
    await expectStrictDocument(response, path);
  }
  await signedIn.dispose();
});

test('the API answers through the proxy with its own headers and refuses forged mutations', async ({ request }) => {
  const me = await get(request, '/v1/me');
  expect(me.status()).toBe(401);
  const headers = me.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['content-security-policy'] ?? '').toMatch(/frame-ancestors 'none'/);
  expect(headers.server).toBeUndefined();
  const forged = await request.post('/v1/companies', { headers: { Origin: 'https://attacker.example', 'X-Trustwork-Request': '1', 'Idempotency-Key': `gate-${Date.now()}` }, data: { name: 'x', handle: null, publicDescription: null }, failOnStatusCode: false });
  expect(forged.status()).toBe(403);
  expect(((await forged.json()) as { code: string }).code).toBe('auth.csrf_rejected');
  const noHeader = await request.post('/v1/auth/signup', { headers: { Origin: SAME_ORIGIN.Origin }, data: {}, failOnStatusCode: false });
  expect(noHeader.status()).toBe(403);
});

test('the jurisdiction gate (edge_header mode) refuses restricted places at the web door and at the API', async ({ request }) => {
  const restricted: Array<[string, string | null]> = [['CU', null], ['IR', null], ['KP', null], ['RU', null], ['UA', 'UA-43'], ['UA', 'UA-14']];
  for (const [country, region] of restricted) {
    const edge = { [EDGE_COUNTRY_HEADER]: country, ...(region ? { [EDGE_REGION_HEADER]: region } : {}) };
    const label = region ?? country;
    const page = await get(request, '/', { ...edge, accept: 'text/html' });
    expect([200, 451], `${label}: page status`).toContain(page.status());
    expect(page.headers()['x-robots-tag'], `${label}: refusal page is noindex`).toBe('noindex');
    expect(await page.text(), `${label}: the refusal page renders, not the home page`).not.toContain('href="/signup"');
    const api = await get(request, '/v1/me', edge);
    expect(api.status(), `${label}: API`).toBe(451);
    expect(((await api.json()) as { code: string }).code).toBe('jurisdiction.restricted');
    // Repository media go through the door too (static chunks and icons are outside the proxy matcher: defect QA-002-D3).
    const media = await get(request, '/media/artworks/release-probe.svg', edge);
    expect(media.status(), `${label}: media`).toBe(451);
  }
  // Places that are not restricted are served (a Ukrainian region that is not listed, the United States, no header).
  for (const edge of [{ [EDGE_COUNTRY_HEADER]: 'UA', [EDGE_REGION_HEADER]: 'UA-30' }, { [EDGE_COUNTRY_HEADER]: 'US' }, {}]) {
    const page = await get(request, '/', { ...edge, accept: 'text/html' });
    expect(page.status(), JSON.stringify(edge)).toBe(200);
    expect(page.headers()['x-robots-tag']).toBeUndefined();
    expect((await get(request, '/v1/me', edge)).status(), JSON.stringify(edge)).toBe(401);
  }
});
