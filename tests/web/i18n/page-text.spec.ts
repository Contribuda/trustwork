import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ROUTES } from '../helpers.js';
import { ENGINE_LOCALES, localeCountry } from './helpers.js';

/**
 * INTL-004 acceptance "every page renders byte-identical text before and after the move in all six
 * languages": a text snapshot of the server-rendered pages. For every engine language and every route
 * (the a11y routes plus every fixture detail page) the visible text of the document is hashed; the hashes
 * live in `page-text.snapshot.json`. The snapshot was written from the single-file dictionaries before the
 * move to `apps/web/locales/<tag>/<namespace>.json` and still matches after it.
 *
 * When you change copy on purpose, rewrite the snapshot and commit it with the copy change:
 * `TRUSTWORK_UPDATE_PAGE_TEXT=1 npx playwright test page-text`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const snapshotFile = resolve(here, 'page-text.snapshot.json');
const update = process.env.TRUSTWORK_UPDATE_PAGE_TEXT === '1';

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

type Snapshot = Record<string, Record<string, string>>;
const recorded: Snapshot = existsSync(snapshotFile) ? (JSON.parse(readFileSync(snapshotFile, 'utf8')) as Snapshot) : {};
const written: Snapshot = {};

test.describe.configure({ mode: update ? 'serial' : 'parallel' });

for (const [tag, country] of LOCALES) {
  test(`page text in ${tag} matches the snapshot`, async ({ playwright, baseURL }) => {
    test.setTimeout(300_000);
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } });
    const actual: Record<string, string> = {};
    for (const route of [...routes].sort()) {
      const response = await context.get(route, { maxRedirects: 0 });
      const text = documentText(await response.text());
      actual[route] = `${response.status()} ${Buffer.byteLength(text)} ${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
    }
    await context.dispose();
    expect(Object.keys(actual).length).toBeGreaterThanOrEqual(90);
    if (update) {
      written[tag] = actual;
      return;
    }
    expect(recorded[tag], `no snapshot for ${tag}; run with TRUSTWORK_UPDATE_PAGE_TEXT=1`).toBeTruthy();
    const changed = Object.keys({ ...recorded[tag], ...actual }).filter((route) => recorded[tag]![route] !== actual[route]);
    expect(changed, `pages whose text changed in ${tag}:\n${changed.map((r) => `${r}: ${recorded[tag]![r]} -> ${actual[r]}`).join('\n')}`).toEqual([]);
  });
}

test.afterAll(() => {
  if (!update || Object.keys(written).length !== LOCALES.length) return;
  const ordered = Object.fromEntries(LOCALES.map(([tag]) => [tag, written[tag]]));
  writeFileSync(snapshotFile, `${JSON.stringify(ordered, null, 2)}\n`);
});
