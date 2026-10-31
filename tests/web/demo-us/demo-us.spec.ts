import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { AXE_TAGS, hydrated } from '../helpers.js';
import { ENGINE_LOCALES, appDictionary, uiDictionary } from '../i18n/helpers.js';
import { US_FILES, properNames, translatableStrings, usFile, usRoutes, type Json } from './dataset.js';
import { E2E_DEFAULT_COUNTRY } from './e2e-config.js';

/**
 * DEMO-US in the browser: the reference deployment opens as the San Diego hub in English (Spanish second) with
 * synthetic, labelled demo data, and Uzbekistan, Georgia, Armenia and Azerbaijan stay selectable examples. The main
 * test server is configured like the hosted preview (demo mode, default country US); run the suite with
 * TRUSTWORK_E2E_DEFAULT_COUNTRY=UZ to check a deployment that defaults to Uzbekistan instead.
 */
const US_HUB = E2E_DEFAULT_COUNTRY === 'US';
const pick = (root: unknown, key: string): string => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], root) as string;
const banner = (tag: string) => pick(uiDictionary(tag), 'demo.banner') ?? pick(appDictionary(tag), 'demo.banner');
const visible = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
const cookie = (country: string, locale: string) => ({ cookies: [
  { name: 'trustwork.country', value: country, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  { name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
], origins: [] });
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';

test.describe('first visit to the demo', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles', storageState: { cookies: [], origins: [] } });

  test(US_HUB ? 'the US hub in English with USD and month-day dates' : `the ${E2E_DEFAULT_COUNTRY} default: the example hub, not the US one`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.lsw__code').first()).toHaveText(E2E_DEFAULT_COUNTRY);
    await expect(page.getByText(banner('en')).first()).toBeVisible();
    const home = visible(await page.content());
    if (US_HUB) {
      expect(home).toContain('How to compare three bids for a backyard ADU');
      expect(home).toMatch(new RegExp(`\\b${MONTH} \\d{1,2}, 2026\\b`));
      expect(home).not.toMatch(new RegExp(`\\b\\d{1,2} ${MONTH} 2026\\b`));
      await page.goto('/events/building-better-adus-forum-2026');
      const event = visible(await page.content());
      expect(event).toContain('$95.00');
      expect(event).toMatch(new RegExp(`\\bNovember 14, 2026\\b`));
      await page.goto('/companies');
      expect(visible(await page.content())).toContain('Sample Coast Builders');
    } else {
      expect(home).not.toContain('Sample Coast Builders');
      await page.goto('/companies');
      expect(visible(await page.content())).not.toContain('Sample Coast Builders');
    }
    expect(home.replace(/Русский/g, ' ')).not.toMatch(/[Ѐ-ӿ]{3,}/);
  });
});

test.describe('the US hub', () => {
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles', storageState: cookie('US', 'en') });

  test('every US demo route renders under the demo strip in English and Spanish', async ({ playwright, baseURL }) => {
    test.setTimeout(240_000);
    const routes = usRoutes();
    expect(routes.length).toBeGreaterThan(50);
    for (const tag of ['en', 'es']) {
      const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=US; trustwork.locale=${tag}` } });
      const problems: string[] = [];
      for (const route of routes) {
        const response = await context.get(route, { maxRedirects: 0 });
        if (response.status() !== 200) { problems.push(`${tag} ${route}: HTTP ${response.status()}`); continue; }
        const html = await response.text();
        if (!html.includes(`<html lang="${tag}"`)) problems.push(`${tag} ${route}: html lang`);
        if (!visible(html).includes(banner(tag))) problems.push(`${tag} ${route}: no demo strip`);
      }
      await context.dispose();
      expect(problems, problems.join('\n')).toEqual([]);
    }
  });

  test('US demo content reads in every engine language, with no English left over', async ({ playwright, baseURL }) => {
    test.setTimeout(240_000);
    const names = properNames();
    const english = US_FILES.flatMap((file) => translatableStrings(file, usFile(file) as Json, names).map(([, text]) => text)).filter((text) => text.length >= 30 && !text.includes('\n'));
    const pages = ['/', '/companies/sample-coast-builders', '/companies/ejemplo-tile-stone', '/people/luis-ejemplo', '/projects/mesa-example-commons', '/articles/how-to-compare-three-adu-bids', '/events/building-better-adus-forum-2026', '/magazine/2', '/app?persona=mixed'];
    const leftovers: string[] = [];
    for (const tag of ENGINE_LOCALES.filter((t) => t !== 'en')) {
      const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=US; trustwork.locale=${tag}` } });
      for (const path of pages) {
        const response = await context.get(path);
        expect(response.status(), `${tag} ${path}`).toBe(200);
        const text = visible(await response.text());
        const hits = english.filter((value) => text.includes(value));
        if (hits.length) leftovers.push(`${tag} ${path}: ${hits.slice(0, 2).join(' | ')}`);
        if (tag !== 'ru' && /[Ѐ-ӿ]/.test(text.replace(/Русский/g, ''))) leftovers.push(`${tag} ${path}: Cyrillic`);
      }
      await context.dispose();
    }
    expect(leftovers, leftovers.join('\n')).toEqual([]);
  });

  for (const [persona, name, label] of [
    ['mixed', 'Dana Sampleton', 'Company employee: buys and sells'],
    ['seller', 'Luis Ejemplo', 'Business owner: sells works and services'],
    ['owner', 'Morgan Demoworth', 'Owner of a personal project'],
    ['buyer', 'Priya Mockford', 'Buyer: purchases for projects'],
    ['reader', 'Jordan Sketchley', 'Reader and author without a company'],
  ] as const) {
    test(`persona ${persona}: ${name}`, async ({ page }) => {
      await page.goto(`/app?persona=${persona}`);
      const text = visible(await page.content());
      expect(text).toContain(label);
      await page.goto(`/app/me?persona=${persona}`);
      expect(visible(await page.content())).toContain(name);
    });
  }

  test('choosing Uzbekistan, Georgia, Armenia or Azerbaijan opens the example hub', async ({ playwright, baseURL }) => {
    for (const country of ['UZ', 'GE', 'AM', 'AZ']) {
      const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=en` } });
      const text = visible(await (await context.get('/companies')).text());
      expect(text, country).not.toContain('Sample Coast Builders');
      expect((await context.get('/companies/sample-coast-builders')).status(), country).toBe(404);
      expect((await context.get('/companies/fasad-primer')).status(), country).toBe(200);
      await context.dispose();
    }
  });

  for (const path of ['/', '/companies/sample-coast-builders', '/projects/mesa-example-commons', '/events/building-better-adus-forum-2026', '/app?persona=seller']) {
    test(`no accessibility violations on the US hub: ${path}`, async ({ page }) => {
      await page.goto(path);
      await hydrated(page.locator('body'));
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
});

/** Evidence for the pull request (desktop and phone, English and Spanish); written to the test output directory, never committed. */
async function shoot(page: Page, file: string, width: number, height: number, outputDir: string) {
  await page.setViewportSize({ width, height });
  await hydrated(page.locator('body'));
  await page.screenshot({ path: resolve(outputDir, 'demo-us-screenshots', file) });
}

for (const tag of ['en', 'es'] as const) {
  test.describe(`screenshots in ${tag}`, () => {
    test.skip(!US_HUB, 'screenshots record the hosted-preview configuration');
    test.use({ locale: tag === 'en' ? 'en-US' : 'es-US', timezoneId: 'America/Los_Angeles', storageState: cookie('US', tag) });
    for (const [name, path] of [['home', '/'], ['project', '/projects/mesa-example-commons'], ['company', '/companies/ejemplo-tile-stone'], ['workspace', '/app?persona=mixed']] as const) {
      for (const [device, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
        test(`${name} (${device})`, async ({ page }, testInfo) => {
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('lang', tag);
          await shoot(page, `demo-us-${tag}-${name}-${device}.png`, width, height, testInfo.project.outputDir);
        });
      }
    }
  });
}

test.describe('screenshot of the first visit', () => {
  test.skip(!US_HUB, 'screenshots record the hosted-preview configuration');
  test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles', storageState: { cookies: [], origins: [] } });
  for (const [device, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
    test(`first visit (${device})`, async ({ page }, testInfo) => {
      await page.goto('/');
      await expect(page.getByRole('dialog', { name: 'Choose your country' })).toBeVisible();
      await shoot(page, `demo-us-en-first-visit-${device}.png`, width, height, testInfo.project.outputDir);
    });
  }
});
