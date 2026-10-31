import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { CONTROL_ORIGIN, WEB_ORIGIN } from './ports.js';

/** Helpers of the live API browser suite (WEB-004). Locale copy is read from the dictionaries, never retyped. */
const REPO = resolve(import.meta.dirname, '../../..');
export const LANGUAGES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'] as const;
export type Language = (typeof LANGUAGES)[number];
/** A country whose pack offers the language (the locale cookie only applies within the chosen country). */
export const COUNTRY_OF: Record<Language, string> = { en: 'US', ru: 'UZ', 'uz-Latn': 'UZ', ka: 'GE', hy: 'AM', 'az-Latn': 'AZ' };

const dictionaries = new Map<Language, Record<string, unknown>[]>();
function layers(language: Language): Record<string, unknown>[] {
  const cached = dictionaries.get(language);
  if (cached) return cached;
  const dir = resolve(REPO, 'apps/web/locales', language);
  const app = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as Record<string, unknown>);
  const ui = JSON.parse(readFileSync(resolve(REPO, 'packages/ui/locales', `${language}.json`), 'utf8')) as Record<string, unknown>;
  const all = [...app, ui];
  dictionaries.set(language, all);
  return all;
}

/** The message of `key` in `language` (application layers first, then the design system), with simple `{name}` params. */
export function msg(key: string, language: Language = 'ru', params: Record<string, string> = {}): string {
  for (const layer of layers(language)) {
    const value = key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), layer);
    if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
  }
  if (language !== 'en') return msg(key, 'en', params);
  throw new Error(`no message for ${key}`);
}

/** Headers of a same-origin mutation made outside the browser UI (the API checks the header and the Origin). */
export const SAME_ORIGIN = { 'X-Trustwork-Request': '1', Origin: WEB_ORIGIN } as const;

let counter = 0;
export function uniqueEmail(label: string): string {
  counter += 1;
  return `e2e-${label}-${Date.now().toString(36)}-${counter}@example.invalid`;
}
export const PASSWORD = 'correct horse battery staple 42';

/** The newest mail intent of a template to an address, with its opened token (waits briefly for the commit). */
export async function mailToken(to: string, template: 'verify_email' | 'recovery' | 'membership_invitation'): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${CONTROL_ORIGIN}/mail?to=${encodeURIComponent(to)}`);
    const { items } = (await response.json()) as { items: Array<{ template: string; params: Record<string, string> }> };
    const found = items.find((m) => m.template === template);
    if (found?.params.token) return found.params.token;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${template} mail to ${to}`);
}

export async function mailCount(to: string): Promise<number> {
  const response = await fetch(`${CONTROL_ORIGIN}/mail?to=${encodeURIComponent(to)}`);
  return ((await response.json()) as { items: unknown[] }).items.length;
}

/** Moves the API clock (step-up and session windows); always reset in `finally`. */
export async function setApiClockOffset(offsetMs: number): Promise<void> {
  await fetch(`${CONTROL_ORIGIN}/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offsetMs }) });
}

/** Signs up and verifies through the same-origin API (the browser flow is tested separately); the context ends up signed in. */
export async function verifiedAccount(request: APIRequestContext, name: string, email = uniqueEmail('user')): Promise<{ email: string; personId: string }> {
  const signup = await request.post('/v1/auth/signup', { headers: SAME_ORIGIN, data: { name, email, password: PASSWORD, acceptedTermsVersion: 'draft-2026-10' } });
  expect(signup.status()).toBe(202);
  const verify = await request.post('/v1/auth/verify-email', { headers: SAME_ORIGIN, data: { token: await mailToken(email, 'verify_email') } });
  expect(verify.status(), await verify.text()).toBe(200);
  return { email, personId: ((await verify.json()) as { personId: string }).personId };
}

export async function ready(page: Page): Promise<void> {
  await page.locator('form[data-hydrated]').first().waitFor();
}

/** WCAG 2.x A/AA scan of the current page; any violation fails (same rule as tests/web/a11y.spec.ts). */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** No horizontal scrolling at the current viewport (narrow-screen check). */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const SHOTS = resolve(REPO, 'apps/web/dist/live-screenshots');
/** Viewport screenshot for the pull request (Russian interface), kept out of git under apps/web/dist. */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}
