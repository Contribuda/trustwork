import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Helpers of the WEB-002 browser tests (demo and live). Copy is read from the dictionaries, never retyped. */
const REPO = resolve(import.meta.dirname, '../../..');
const cache = new Map<string, Record<string, unknown>[]>();
function layers(language: string): Record<string, unknown>[] {
  const hit = cache.get(language);
  if (hit) return hit;
  const dir = resolve(REPO, 'apps/web/locales', language);
  const all = [...readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Record<string, unknown>), JSON.parse(readFileSync(resolve(REPO, 'packages/ui/locales', `${language}.json`), 'utf8')) as Record<string, unknown>];
  cache.set(language, all);
  return all;
}

/** The message of `key` (application layers first, then the design system) with simple `{name}` parameters. */
export function msg(key: string, params: Record<string, string | number> = {}, language = 'ru'): string {
  for (const layer of layers(language)) {
    const value = key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), layer);
    if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
  }
  throw new Error(`no message for ${key}`);
}

export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Screenshots for the pull request, kept out of git under apps/web/dist. */
export async function shot(page: Page, folder: string, name: string): Promise<void> {
  const dir = resolve(REPO, 'apps/web/dist', folder);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: true });
}

/** Visible text of the page body (for "never shown" assertions across the whole page). */
export async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
