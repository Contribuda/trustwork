import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ENGINE_LOCALES, localeCountry } from './i18n/helpers.js';
import { usRoutes } from './demo-us/dataset.js';
import { datasetForCountry } from '../../apps/web/fixtures/datasets.js';

/**
 * ADR-009 owner decision 10: outside the Russian locale no Russian text may reach a reader, demo content
 * included. Every public page is rendered for each engine language through the locale cookie and the
 * visible text is scanned for Cyrillic. Language names in the switcher («Русский») are the only allowed hit.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/web/fixtures');
type Row = Record<string, unknown>;
const fixture = (name: string): Row[] => (JSON.parse(readFileSync(resolve(root, `${name}.json`), 'utf8')) as Record<string, Row[]>)[name] ?? [];

const routes = new Set<string>(['/', '/articles', '/news', '/magazine', '/magazine/archive', '/companies', '/people', '/projects', '/events', '/search?q=fasad']);
for (const p of fixture('publications')) { routes.add(`/articles/${p.slug}`); routes.add(`/news/${p.slug}`); }
for (const i of fixture('issues')) routes.add(`/magazine/${(i.issue as { number: number }).number}`);
for (const c of fixture('companies')) routes.add(`/companies/${c.slug}`);
for (const p of fixture('people')) routes.add(`/people/${p.slug}`);
for (const p of fixture('projects')) routes.add(`/projects/${p.slug}`);
for (const e of fixture('events')) routes.add(`/events/${e.slug}`);

// The United States demo hub (DEMO-US) has its own routes: a visitor whose country is US reads them.
const US_ROUTES = usRoutes();

// Every language directory except Russian (INTL-004: a new language is scanned without editing this list).
const LOCALES: Array<[string, string]> = ENGINE_LOCALES.filter((tag) => tag !== 'ru').map((tag) => [tag, tag === 'en' ? 'UZ' : localeCountry(tag)]);

const visibleText = (html: string) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/Русский/g, ' ').replace(/\s+/g, ' ');

for (const [tag, country] of LOCALES) {
  test(`no Russian text on public pages in ${tag}`, async ({ playwright, baseURL }) => {
    test.setTimeout(240_000);
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } });
    const leaks: string[] = [];
    let rendered = 0;
    const us = datasetForCountry(country) === 'us';
    for (const route of us ? US_ROUTES : routes) {
      const response = await context.get(route, { maxRedirects: 0 });
      if (response.status() !== 200) continue;
      rendered += 1;
      const hits = [...new Set(visibleText(await response.text()).match(/[Ѐ-ӿ][Ѐ-ӿ\s,.:;«»()\-–—]*/g) ?? [])].map((s) => s.trim()).filter(Boolean);
      if (hits.length) leaks.push(`${route}: ${hits.slice(0, 3).join(' | ')}`);
    }
    await context.dispose();
    expect(rendered).toBeGreaterThanOrEqual(us ? 50 : 90);
    expect(leaks, leaks.join('\n')).toEqual([]);
  });
}
