import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO, dictionarySignatures, languagesIn } from './helpers.js';

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
const LOCALES: Array<[string, string]> = [['en', 'US'], ['ru', 'UZ'], ['uz-Latn', 'UZ'], ['ka', 'GE'], ['hy', 'AM'], ['az-Latn', 'AZ']];

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
