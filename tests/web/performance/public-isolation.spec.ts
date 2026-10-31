import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIResponse } from '@playwright/test';
import { hydrated } from '../helpers.js';
import { ENGINE_LOCALES } from '../i18n/helpers.js';

/**
 * WEB-005 in the browser: every public route carries the strict per-request nonce policy (the architect's decision of
 * 2026-10-31: no inline-script allowance on any page), public pages are the same for every visitor apart from that
 * nonce, private and per-visitor responses are never cacheable, and the parts of a page that belong to the visitor are
 * decided in that visitor's browser only. Full-page caching of public pages is deferred (docs/engine/architecture.md).
 */
const port = Number(process.env.TRUSTWORK_E2E_PORT ?? 3459);
const COMPANY = '/companies/fasad-primer'; // the demo persona "mixed" (Anna Primerova) administers this company
/** The route list names the example hub's records (DEMO-US: the visitor's country selects the dataset). */
const EXAMPLE_HUB = 'trustwork.country=UZ; trustwork.locale=en';

const fixtures = resolve(import.meta.dirname, '../../../apps/web/fixtures');
type Row = Record<string, unknown>;
const fixture = (name: string): Row[] => (JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), 'utf8')) as Record<string, Row[]>)[name] ?? [];
/** Every public route of the demo stand: sections, list filters, search, every entry page and the event flows. */
const PUBLIC_ROUTES = new Set<string>(['/', '/news', '/news?topic=markets', '/articles', '/magazine', '/magazine/archive', '/companies', '/companies?view=map', '/people', '/projects', '/events', '/search?q=fasad', '/this-route-does-not-exist']);
for (const p of fixture('publications')) { PUBLIC_ROUTES.add(`/articles/${p.slug}`); PUBLIC_ROUTES.add(`/news/${p.slug}`); }
for (const i of fixture('issues')) { const n = (i.issue as { number: number }).number; PUBLIC_ROUTES.add(`/magazine/${n}`); PUBLIC_ROUTES.add(`/magazine/${n}/read`); }
for (const c of fixture('companies')) PUBLIC_ROUTES.add(`/companies/${c.slug}`);
for (const p of fixture('people')) PUBLIC_ROUTES.add(`/people/${p.slug}`);
for (const p of fixture('projects')) PUBLIC_ROUTES.add(`/projects/${p.slug}`);
for (const e of fixture('events')) { PUBLIC_ROUTES.add(`/events/${e.slug}`); PUBLIC_ROUTES.add(`/events/${e.slug}/register`); }

const inLanguage = (tag: string, route: string) => (tag === 'en' ? route : `/${tag}${route === '/' ? '' : route.startsWith('/?') ? route.slice(1) : route}`);
/** A page without its per-request nonce (in attributes and in the page data): what must be identical for every visitor. */
async function withoutNonce(response: APIResponse): Promise<string> {
  const nonce = /'nonce-([^']+)'/.exec(response.headers()['content-security-policy'] ?? '')?.[1];
  expect(nonce).toBeTruthy();
  return (await response.text()).replaceAll(nonce!, '');
}

test.describe('public pages', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('every public route, in every language, carries the per-request nonce policy and never allows inline scripts', async ({ request }) => {
    test.setTimeout(300_000);
    expect(PUBLIC_ROUTES.size).toBeGreaterThan(80);
    let checked = 0;
    for (const [index, route] of [...PUBLIC_ROUTES].entries()) {
      // Every route in English and in one other language (rotating through all of them).
      const other = ENGINE_LOCALES.filter((tag) => tag !== 'en')[index % (ENGINE_LOCALES.length - 1)]!;
      for (const address of [route, inLanguage(other, route)]) {
        const response = await request.get(address, { maxRedirects: 0, headers: { cookie: EXAMPLE_HUB } });
        expect([200, 404], address).toContain(response.status());
        const csp = response.headers()['content-security-policy'] ?? '';
        const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
        const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
        expect(nonce, `${address}: a script nonce`).toBeTruthy();
        expect(scriptSrc, address).not.toContain("'unsafe-inline'");
        expect(scriptSrc, address).not.toMatch(/(^|\s)\*(\s|$)/);
        const html = await response.text();
        // Every inline and external script of the document carries this request's nonce.
        const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
        expect(scripts.length, address).toBeGreaterThan(0);
        for (const tag of scripts) expect(tag, `${address}: ${tag.slice(0, 80)}`).toContain(`nonce="${nonce}"`);
        expect(response.headers()['cache-control'] ?? '', `${address}: rendered for this request only`).toMatch(/no-store/);
        expect(response.headers()['set-cookie'], `${address}: a public page sets no cookie`).toBeUndefined();
        checked += 1;
      }
    }
    expect(checked).toBe(PUBLIC_ROUTES.size * 2);
  });

  test('a public page is the same for an anonymous visitor, a signed-in persona and a visitor with a session cookie (apart from the nonce)', async ({ request }) => {
    const anonymous = await withoutNonce(await request.get(`/ru${COMPANY}`, { maxRedirects: 0, headers: { cookie: EXAMPLE_HUB } }));
    const persona = await withoutNonce(await request.get(`/ru${COMPANY}?persona=mixed`, { maxRedirects: 0, headers: { cookie: EXAMPLE_HUB } }));
    const withCookies = await withoutNonce(
      await request.get(`/ru${COMPANY}`, { maxRedirects: 0, headers: { cookie: `__Host-sr_session=forged-session; sr_session=forged-session; ${EXAMPLE_HUB}` } }),
    );
    // A session cookie (here a forged one) and the language cookie change nothing on a prefixed public page.
    expect(withCookies).toBe(anonymous);
    // A demo persona in the address only changes the demo strip that names it; the page itself is the same.
    const main = (html: string) => /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? '';
    expect(main(anonymous).length).toBeGreaterThan(10_000);
    expect(main(persona)).toBe(main(anonymous));
  });

  test('private, sign-in and per-visitor responses are never cacheable', async ({ request }) => {
    for (const path of ['/app?persona=mixed', '/app/company?persona=mixed', '/login', '/onboarding?persona=reader', '/news?topic=markets', '/search?q=fasad', '/', COMPANY]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.headers()['cache-control'], path).toMatch(/private/);
      expect(response.headers()['cache-control'], path).toMatch(/no-store/);
      expect(response.headers()['x-nextjs-cache'], path).toBeUndefined();
    }
    const viewer = await request.get('/app/viewer?persona=mixed');
    expect(viewer.headers()['cache-control']).toBe('private, no-store');
    expect(viewer.headers().vary).toMatch(/Cookie/);
    expect(((await viewer.json()) as { viewer: { name: string } | null }).viewer?.name).toBeTruthy();
    expect(((await (await request.get('/app/viewer')).json()) as { viewer: unknown }).viewer, 'anonymous demo visitor').toBeNull();
  });
});

test.describe('parts of a public page that belong to the visitor', () => {
  test('the company administrator sees the workspace action; the next visitor of the same page does not', async ({ browser }) => {
    const member = await browser.newContext();
    const page = await member.newPage();
    await page.goto(`/ru${COMPANY}?persona=mixed`);
    const action = page.getByRole('link', { name: 'Открыть в рабочем пространстве' });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute('href', /\/app\/company\?persona=mixed$/);
    await expect(page.getByRole('heading', { name: 'Ваша компания уже здесь?' })).toHaveCount(0);
    await member.close();

    const visitor = await browser.newContext();
    const next = await visitor.newPage();
    await next.goto(`/ru${COMPANY}`);
    await hydrated(next.locator('header').getByRole('link').first());
    await expect(next.getByRole('link', { name: 'Открыть в рабочем пространстве' })).toHaveCount(0);
    await expect(next.getByRole('heading', { name: 'Ваша компания уже здесь?' })).toBeVisible();
    await expect(next.locator('header').getByRole('link', { name: 'Войти в сервис' }).first()).toBeVisible();
    await visitor.close();
  });

  test('a person sees "edit" on their own public page, everybody else the contact actions', async ({ page }) => {
    await page.goto('/ru/people/anna-primerova?persona=mixed');
    const own = page.locator('.cp-identity__actions');
    await expect(own.getByRole('link', { name: 'Редактировать' })).toHaveAttribute('href', /\/app\/me\?persona=mixed$/);
    await expect(own.getByRole('link', { name: 'Написать', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Это ваша страница?' })).toHaveCount(0);
    await page.goto(`http://127.0.0.1:${port}/ru/people/anna-primerova?persona=reader`);
    await expect(page.getByRole('heading', { name: 'Это ваша страница?' })).toBeVisible();
    await expect(own.getByRole('link', { name: 'Написать', exact: true })).toBeVisible();
    await expect(own.getByRole('link', { name: 'Редактировать' })).toHaveCount(0);
  });
});
