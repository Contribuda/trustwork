import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { ENGINE_LOCALES, REPO, clientNamespaceTable, dictionarySignatures, languagesIn, localeCountry, namespaceSignatures, namespacesIn } from './helpers.js';

/**
 * INTL-003 acceptance "the largest client chunk contains at most one language's dictionary" (audit E1:
 * a 939 KB chunk carried all six dictionaries and every page referenced it). Client chunks may carry only
 * the design system's English reference; the active language reaches a page once, in its own payload.
 */
const dist = resolve(REPO, 'apps/web', process.env.NEXT_DIST_DIR ?? '.next');
const signatures = dictionarySignatures();

function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? scripts(path) : path.endsWith('.js') ? [path] : [];
  });
}

test('client chunks carry at most one language, and only the English reference', () => {
  const chunks = scripts(join(dist, 'static/chunks')).map((path) => ({ path, size: statSync(path).size, languages: languagesIn(readFileSync(path, 'utf8'), signatures) }));
  expect(chunks.length).toBeGreaterThan(10);
  const largest = chunks.reduce((a, b) => (b.size > a.size ? b : a));
  expect(largest.languages.length, `${relative(dist, largest.path)} (${largest.size} bytes): ${largest.languages.join(', ')}`).toBeLessThanOrEqual(1);
  const offenders = chunks.filter((chunk) => chunk.languages.some((tag) => tag !== 'en')).map((chunk) => `${relative(dist, chunk.path)}: ${chunk.languages.join(', ')}`);
  expect(offenders, offenders.join('\n')).toEqual([]);
  const english = chunks.filter((chunk) => chunk.languages.includes('en'));
  expect(english.length, 'the English reference is bundled once').toBeLessThanOrEqual(1);
});

const PAGES = ['/', '/companies', '/events', '/app?persona=owner'];
const LOCALES: Array<[string, string]> = ENGINE_LOCALES.map((tag) => [tag, localeCountry(tag)]);

for (const [tag, country] of LOCALES) {
  test(`a ${tag} page carries the ${tag} dictionary and no other`, async ({ playwright, baseURL }) => {
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } });
    for (const path of PAGES) {
      const response = await context.get(path);
      expect(response.status(), path).toBe(200);
      expect(languagesIn(await response.text(), signatures), path).toEqual([tag]);
    }
    await context.dispose();
  });
}

/**
 * INTL-004 acceptance "client bundles contain only the namespaces the route uses": a page's document (HTML
 * and the payload that hydrates it) carries the root namespaces plus its route group's, and no other
 * namespace in full. Server components may still render a few strings of other namespaces as text, which
 * stays far below the share that marks a received namespace.
 */
const table = clientNamespaceTable();
const ROUTE_GROUP_PAGES: Array<[string, string]> = [
  ['/', 'public'],
  ['/companies', 'public'],
  ['/events', 'public'],
  ['/magazine/12/read', 'public'],
  ['/login', 'auth'],
  ['/recover/demo-recovery-token-0001', 'auth'],
  ['/onboarding?persona=reader', 'onboarding'],
  ['/app?persona=owner', 'workspace'],
  ['/app/assistant?persona=mixed', 'workspace'],
  // An unknown public address gets the public 404 inside the public document (WEB-005).
  ['/this-route-does-not-exist', 'public'],
];

for (const [tag, country] of LOCALES.filter(([tag]) => ['en', 'ru', 'ka'].includes(tag))) {
  test(`${tag} pages receive only their route group's namespaces`, async ({ playwright, baseURL }) => {
    const signatures = namespaceSignatures(tag);
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } });
    for (const [path, group] of ROUTE_GROUP_PAGES) {
      const response = await context.get(path);
      expect([200, 404], path).toContain(response.status());
      const expected = [...new Set([...table.root!, ...(group === 'root' ? [] : table[group]!)])].sort();
      expect(namespacesIn(await response.text(), signatures), `${tag} ${path}`).toEqual(expected);
    }
    await context.dispose();
  });
}
