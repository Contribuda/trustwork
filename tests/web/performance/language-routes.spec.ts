import { expect, test, type APIRequestContext } from '@playwright/test';
import { ENGINE_LOCALES } from '../i18n/helpers.js';
import { hydrated } from '../helpers.js';

/**
 * ADR 012 decision 27 in the browser (WEB-005): English public pages have no prefix, every other language has its own
 * prefix, each page names its canonical URL and its alternates in every language, and the language cookie redirects
 * only an entry onto an unprefixed public page. The main test server runs like the hosted preview (demo data, English,
 * United States).
 */
const port = Number(process.env.TRUSTWORK_E2E_PORT ?? 3459);
const SITE = 'http://127.0.0.1:3000'; // the stand's site URL: no TRUSTWORK_SITE_URL is configured for the suite
const STORY = '/news/standart-ventfasady-vesna';
const htmlLang = (html: string) => /<html lang="([^"]+)"/.exec(html)?.[1];
const OTHER = ENGINE_LOCALES.filter((tag) => tag !== 'en');

/** One request without following redirects; the story and company records belong to the example hub (DEMO-US selects the dataset by the visitor's country). */
async function fresh(request: APIRequestContext, path: string, headers: Record<string, string> = {}) {
  return request.get(path, { maxRedirects: 0, headers: { cookie: 'trustwork.country=UZ; trustwork.locale=en', ...headers } });
}

test.describe('language in the address', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('English is unprefixed, every other language has its prefix, /en/ redirects to the unprefixed page', async ({ request }) => {
    const english = await fresh(request, STORY);
    expect(english.status()).toBe(200);
    expect(htmlLang(await english.text())).toBe('en');
    for (const tag of OTHER) {
      const response = await fresh(request, `/${tag}${STORY}`);
      expect(response.status(), tag).toBe(200);
      expect(htmlLang(await response.text()), tag).toBe(tag);
    }
    const home = await fresh(request, `/${OTHER[0]}`);
    expect(htmlLang(await home.text())).toBe(OTHER[0]);
    const prefixedEnglish = await fresh(request, `/en${STORY}`);
    expect(prefixedEnglish.status()).toBe(308);
    expect(new URL(prefixedEnglish.headers().location!, `http://127.0.0.1:${port}`).pathname).toBe(STORY);
    expect((await fresh(request, `/fr${STORY}`)).status(), 'a language the deployment does not offer is no prefix').toBe(404);
  });

  test('an unknown public address is a 404 in the language of its prefix', async ({ page }) => {
    const response = await page.goto('/ka/this-route-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ka');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('header').getByRole('navigation').first()).toBeVisible();
  });

  test('every page names its canonical URL and its alternates in every offered language', async ({ request }) => {
    const html = await (await fresh(request, `/ru${STORY}`)).text();
    expect(html).toContain(`<link rel="canonical" href="${SITE}/ru${STORY}"/>`);
    expect(html).toContain(`<link rel="alternate" hrefLang="en" href="${SITE}${STORY}"/>`);
    for (const tag of OTHER) expect(html, tag).toContain(`<link rel="alternate" hrefLang="${tag}" href="${SITE}/${tag}${STORY}"/>`);
    expect(html).toContain(`<link rel="alternate" hrefLang="x-default" href="${SITE}${STORY}"/>`);
    const home = await (await fresh(request, '/ka')).text();
    expect(home).toContain(`<link rel="canonical" href="${SITE}/ka"/>`);
    expect(home).toContain(`<link rel="alternate" hrefLang="en" href="${SITE}"/>`);
    // A filtered list is rendered per request and points search engines at the list itself.
    const filtered = await (await fresh(request, '/ru/news?topic=markets')).text();
    expect(filtered).toContain(`<link rel="canonical" href="${SITE}/ru/news"/>`);
    expect(filtered).toMatch(/<meta name="robots" content="noindex[^"]*"\/>/);
  });

  test('links inside a page keep its language', async ({ request }) => {
    const html = await (await fresh(request, '/ru/news')).text();
    const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!).filter((href) => !href.startsWith('/_next/') && !href.startsWith('/media/'));
    const publicLinks = hrefs.filter((href) => !/^\/(?:app|login|signup|recover|logout|verify-email|onboarding|manifest|icon|apple-icon|favicon)(?:[/?#.]|$)/.test(href));
    expect(publicLinks.length).toBeGreaterThan(20);
    expect(publicLinks.filter((href) => href !== '/ru' && !href.startsWith('/ru/') && !href.startsWith('/ru?') && !href.startsWith('/ru#'))).toEqual([]);
    const forms = [...html.matchAll(/<form\b[^>]*>/g)].map((m) => /action="([^"]+)"/.exec(m[0])?.[1]).filter((action): action is string => Boolean(action) && action!.startsWith('/'));
    expect(forms.length).toBeGreaterThan(0);
    for (const action of forms) expect(action).toMatch(/^\/ru\//);
  });
});

test.describe('the language cookie', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const ru = { cookie: 'trustwork.country=UZ; trustwork.locale=ru' };

  test('redirects an entry onto an unprefixed public page, never a prefixed, private or in-site request', async ({ request }) => {
    for (const path of ['/', '/news', STORY, '/companies/fasad-primer']) {
      const entry = await fresh(request, path, ru);
      expect(entry.status(), path).toBe(307);
      expect(new URL(entry.headers().location!, `http://127.0.0.1:${port}`).pathname, path).toBe(path === '/' ? '/ru' : `/ru${path}`);
      expect(entry.headers()['cache-control'], 'the redirect depends on the cookie: never stored').toBe('private, no-store');
      expect(entry.headers().vary).toBe('Cookie');
    }
    // A navigation inside the site (an explicit choice of the English page) and client-side requests stay where they are.
    const inSite = await fresh(request, STORY, { ...ru, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' });
    expect(inSite.status()).toBe(200);
    expect(htmlLang(await inSite.text())).toBe('en');
    expect((await fresh(request, STORY, { ...ru, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).status(), 'a fetch from the page (client-side navigation)').toBe(200);
    // A prefixed address keeps the language it names.
    const georgian = await fresh(request, `/ka${STORY}`, ru);
    expect(georgian.status()).toBe(200);
    expect(htmlLang(await georgian.text())).toBe('ka');
    // Private and sign-in pages are not localized by address: they follow the cookie.
    const login = await fresh(request, '/login', ru);
    expect(login.status()).toBe(200);
    expect(htmlLang(await login.text())).toBe('ru');
  });

  test('?country=&lang= sets both cookies and opens the page in that language', async ({ request }) => {
    const response = await fresh(request, '/companies?country=GE&lang=ka');
    expect(response.status()).toBe(307);
    expect(new URL(response.headers().location!, `http://127.0.0.1:${port}`).pathname).toBe('/ka/companies');
    const cookies = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value.split(';')[0]);
    expect(cookies).toEqual(expect.arrayContaining(['trustwork.country=GE', 'trustwork.locale=ka']));
  });

  test('the header switcher opens the same page in the chosen language and the choice sticks', async ({ page, context }) => {
    await context.addCookies([
      { name: 'trustwork.country', value: 'UZ', url: `http://127.0.0.1:${port}` },
      { name: 'trustwork.locale', value: 'ru', url: `http://127.0.0.1:${port}` },
    ]);
    await page.goto(STORY);
    await expect(page).toHaveURL(new RegExp(`/ru${STORY}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await (await hydrated(page.locator('.lsw').first())).click();
    await page.getByRole('dialog').getByRole('button', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`127\\.0\\.0\\.1:${port}${STORY}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect((await context.cookies()).find((c) => c.name === 'trustwork.locale')?.value).toBe('en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await (await hydrated(page.locator('.lsw').first())).click();
    await page.getByRole('dialog').getByRole('button', { name: 'ქართული', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/ka${STORY}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ka');
  });
});
