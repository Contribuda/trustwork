import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { AXE_TAGS, ROUTES, hydrated } from '../helpers.js';
import { appDictionary, leaves, uiDictionary } from '../i18n/helpers.js';

/**
 * LANG-ES in the browser: a visitor of the United States hub who chooses Spanish gets every page in Spanish,
 * with es-US formats, the brand Trustwork and no English left over from the dictionaries. Russian text is
 * covered for every language by locale-leak.spec.ts, which picks the es directory up by itself.
 */
const SPANISH = { cookies: [
  { name: 'trustwork.country', value: 'US', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  { name: 'trustwork.locale', value: 'es', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
], origins: [] };

/**
 * English dictionary strings that Spanish translates differently: if one of them shows on a Spanish page, a
 * string escaped translation (a hard-coded or missing key). Short strings and messages with arguments are left
 * out, as are strings that the Spanish dictionary also uses (brand names, units).
 */
function englishOnlyStrings(): string[] {
  const en = [...leaves(appDictionary('en')), ...leaves(uiDictionary('en'))];
  const es = new Map([...leaves(appDictionary('es')), ...leaves(uiDictionary('es'))]);
  const spanishValues = new Set(es.values());
  return [...new Set(en.filter(([key, value]) => es.get(key) !== value && value.length >= 14 && !/[{}<>|]/.test(value) && !spanishValues.has(value)).map(([, value]) => value))];
}

/**
 * A US visitor reads the San Diego demo hub (DEMO-US): the shared route list names records of the example hub, so its
 * detail pages are replaced by the US records of the same kind.
 */
const US_EQUIVALENT: Record<string, string> = {
  '/news/standart-ventfasady-vesna': '/news/demo-plan-check-pilot-backyard-homes',
  '/articles/kak-sravnivat-predlozheniya-fasad': '/articles/how-to-compare-three-adu-bids',
  '/companies/fasad-primer': '/companies/sample-coast-builders',
  '/companies/beton-obraztsovyi': '/companies/demo-canyon-concrete',
  '/people/anna-primerova': '/people/dana-sampleton',
  '/projects/shkola-na-reke': '/projects/mesa-example-commons',
  '/magazine/12': '/magazine/2',
  '/magazine/12/read': '/magazine/2/read',
  '/app/projects/project-school?persona=mixed': '/app/projects/us-project-school?persona=mixed',
};

/** Public pages carry the language in their address (ADR 012 decision 27); private ones follow the cookie. */
const inSpanish = (path: string) => (/^\/(?:app|login|signup|recover|logout|verify-email|onboarding)(?:[/?]|$)/.test(path) ? path : `/es${path === '/' ? '' : path}`);

const visibleText = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');

test.describe('Spanish (es) with the United States', () => {
  test.use({ locale: 'es-US', timezoneId: 'America/Los_Angeles', storageState: SPANISH });

  test('every route renders in Spanish with no English dictionary text left over', async ({ playwright, baseURL }) => {
    test.setTimeout(240_000);
    const english = englishOnlyStrings();
    expect(english.length).toBeGreaterThan(1000);
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: 'trustwork.country=US; trustwork.locale=es' } });
    const leftovers: string[] = [];
    let rendered = 0;
    for (const route of ROUTES) {
      const path = inSpanish(US_EQUIVALENT[route.path] ?? route.path);
      const response = await context.get(path, { maxRedirects: 0 });
      if (![200, 404].includes(response.status())) continue;
      const html = await response.text();
      rendered += 1;
      // Next renders a page's notFound() as a document shell that the browser completes from the page data, so the
      // language attribute is only checked on pages that render (the 404's Spanish copy is in that data).
      if (response.status() === 200) expect(html, path).toMatch(/<html[^>]* lang="es"/);
      const text = visibleText(html);
      const hits = english.filter((value) => text.includes(value));
      if (hits.length) leftovers.push(`${path}: ${hits.slice(0, 3).join(' | ')}`);
    }
    await context.dispose();
    expect(rendered).toBeGreaterThanOrEqual(ROUTES.length - 2);
    expect(leftovers, leftovers.join('\n')).toEqual([]);
  });

  test('the public shell, the brand and the demo content read in Spanish', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    const nav = page.getByRole('navigation', { name: 'Secciones' }).first();
    for (const label of ['Noticias', 'Artículos', 'Eventos', 'Empresas', 'Personas', 'Proyectos', 'Revista']) await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Trustwork: inicio' }).first()).toBeVisible();
    // A US visitor reads the San Diego demo hub (DEMO-US), its content in Spanish.
    await page.goto('/companies/ejemplo-tile-stone');
    await expect(page.getByText('Azulejo y piedra colocados por el propio dueño, de la losa plana a la lechada sellada').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Solicitar una cotización' }).first()).toBeVisible();
  });

  test('dates use the es-US format', async ({ page }) => {
    await page.goto('/news/demo-plan-check-pilot-backyard-homes');
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toMatch(/\b\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)( de \d{4})?\b/);
    expect(text).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/);
  });

  for (const path of ['/', '/companies/ejemplo-tile-stone', '/login']) {
    test(`no accessibility violations in Spanish on ${path}`, async ({ page }) => {
      await page.goto(path);
      await hydrated(page.locator('body'));
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  /** Evidence for the pull request (desktop and phone); written to the test output directory, never committed. */
  for (const [name, path] of [['home', '/'], ['companies', '/companies'], ['company', '/companies/ejemplo-tile-stone'], ['news', '/news/demo-plan-check-pilot-backyard-homes'], ['events', '/events'], ['workspace', '/app?persona=mixed']] as const) {
    for (const [device, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
      test(`screenshot ${name} (${device})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height });
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('lang', 'es');
        await page.screenshot({ path: resolve(testInfo.project.outputDir, 'es-screenshots', `es-${name}-${device}.png`) });
      });
    }
  }
});

test.describe('choosing Spanish', () => {
  test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

  const htmlLang = (page: Page) => page.locator('html').getAttribute('lang');

  test('the first-visit window offers Español and the choice survives a reload', async ({ page }) => {
    await page.goto('/');
    const gate = page.getByRole('dialog', { name: 'Choose your country' });
    await expect(gate).toBeVisible();
    await (await hydrated(gate.getByRole('radio', { name: 'Español' }))).click();
    await gate.getByRole('button', { name: 'Continue' }).click();
    // The choice writes cookies and refreshes the route; on a busy machine that takes longer than the default poll.
    await expect.poll(() => htmlLang(page), { timeout: 15_000 }).toBe('es');
    await page.reload();
    expect(await htmlLang(page)).toBe('es');
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'trustwork.locale')?.value).toBe('es');
    await expect(page.getByRole('navigation', { name: 'Secciones' }).first()).toBeVisible();
  });

  test('a link can carry the language: ?lang=es', async ({ page }) => {
    await page.goto('/news?country=US&lang=es');
    await expect.poll(() => htmlLang(page), { timeout: 15_000 }).toBe('es');
  });
});
