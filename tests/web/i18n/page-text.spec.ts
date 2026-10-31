import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ROUTES } from '../helpers.js';
import { ENGINE_LOCALES, localeCountry } from './helpers.js';

/**
 * Text snapshot for refactors that must not change a single visible word (INTL-004 acceptance "every page
 * renders byte-identical text before and after the move in all six languages"; reusable for any later
 * restructuring of dictionaries, layouts or stylesheets).
 *
 * The document text of every route (the a11y routes plus every fixture detail page) in every language
 * directory is recorded from one build and compared against another. It is not a standing gate: pages show
 * today's date and upcoming events, and format instants in the server's time zone, so a recording is only
 * comparable on the same day with the same `TZ`. Opt-in, one worker, the same request order every run:
 *
 *   TZ=UTC NEXT_DIST_DIR=.next-e2e npx next build --webpack            # base commit
 *   TZ=UTC TRUSTWORK_PAGE_TEXT=record NEXT_DIST_DIR=.next-e2e npx playwright test page-text
 *   TZ=UTC NEXT_DIST_DIR=.next-e2e npx next build --webpack            # your change
 *   TZ=UTC TRUSTWORK_PAGE_TEXT=compare NEXT_DIST_DIR=.next-e2e npx playwright test page-text
 *
 * The recording goes to `TRUSTWORK_PAGE_TEXT_FILE` (default `apps/web/dist/page-text.json`, ignored by git).
 */
const mode = process.env.TRUSTWORK_PAGE_TEXT;
const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.env.TRUSTWORK_PAGE_TEXT_FILE ?? resolve(here, '../../../apps/web/dist/page-text.json'));

type Row = Record<string, unknown>;
const fixtures = resolve(here, '../../../apps/web/fixtures');
const fixture = (name: string): Row[] => (JSON.parse(readFileSync(resolve(fixtures, `${name}.json`), 'utf8')) as Record<string, Row[]>)[name] ?? [];

const routes = new Set<string>([...ROUTES.map((route) => route.path), '/events', '/search?q=fasad']);
for (const p of fixture('publications')) {
  routes.add(`/articles/${p.slug}`);
  routes.add(`/news/${p.slug}`);
}
for (const i of fixture('issues')) routes.add(`/magazine/${(i.issue as { number: number }).number}`);
for (const c of fixture('companies')) routes.add(`/companies/${c.slug}`);
for (const p of fixture('people')) routes.add(`/people/${p.slug}`);
for (const p of fixture('projects')) routes.add(`/projects/${p.slug}`);
for (const e of fixture('events')) routes.add(`/events/${e.slug}`);

const LOCALES: Array<[string, string]> = ENGINE_LOCALES.map((tag) => [tag, localeCountry(tag)]);

/** The document title and the text a reader sees: scripts, styles, icons and comments removed, entities decoded. */
function documentText(html: string): string {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return `${title}\n${body}`
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

/** The first difference between two texts, with some context, for the failure message. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at ${i}: "…${a.slice(Math.max(0, i - 40), i + 60)}…" -> "…${b.slice(Math.max(0, i - 40), i + 60)}…"`;
}

test.describe('page text snapshot', () => {
  test.skip(mode !== 'record' && mode !== 'compare', 'set TRUSTWORK_PAGE_TEXT=record or compare (see the header of this file)');

  test('every page in every language', async ({ playwright, baseURL }) => {
    test.setTimeout(600_000);
    const actual: Record<string, Record<string, string>> = {};
    for (const [tag, country] of LOCALES) {
      const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } });
      const pages: Record<string, string> = {};
      for (const route of [...routes].sort()) {
        const response = await context.get(route, { maxRedirects: 0 });
        pages[route] = `${response.status()} ${documentText(await response.text())}`;
      }
      actual[tag] = pages;
      await context.dispose();
    }
    expect(Object.keys(actual.en ?? {}).length).toBeGreaterThanOrEqual(90);
    if (mode === 'record') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(actual, null, 1)}\n`);
      return;
    }
    expect(existsSync(file), `no recording at ${file}; run with TRUSTWORK_PAGE_TEXT=record on the base build first`).toBe(true);
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as typeof actual;
    const changed: string[] = [];
    for (const [tag] of LOCALES) {
      const before = recorded[tag] ?? {};
      const after = actual[tag] ?? {};
      for (const route of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const a = before[route] ?? '(missing)';
        const b = after[route] ?? '(missing)';
        if (a !== b) changed.push(`${tag} ${route} ${firstDifference(a, b)}`);
      }
    }
    expect(changed, changed.slice(0, 20).join('\n')).toEqual([]);
  });
});
