import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Helpers of the platform release journey (QA-002). The suite runs against an already running compose stack (the
 * release overlay, tests/release/platform/run.mjs); it starts nothing itself. Copy comes from the dictionaries, never
 * retyped, so the same steps run in English and in Spanish.
 */
export const REPO = resolve(import.meta.dirname, '../../..');
export const STACK_ORIGIN = (process.env.TRUSTWORK_STACK_ORIGIN ?? 'http://localhost:8080').replace(/\/$/, '');
export const MAIL_READER = (process.env.TRUSTWORK_RELEASE_MAIL_READER ?? 'http://127.0.0.1:8025').replace(/\/$/, '');
export const OUT = resolve(import.meta.dirname, 'dist');
/** The header the release overlay's `edge_header` gate reads (tests/release/platform/compose.release.yaml). */
export const EDGE_COUNTRY_HEADER = 'x-release-edge-country';
export const EDGE_REGION_HEADER = 'x-release-edge-region';

export type Language = 'en' | 'es';
export const PASSWORD = 'release candidate passphrase 2026';
export const TERMS_VERSION = 'draft-2026-10';

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

/** The message of `key` in `language` (application layers, then the design system), with simple `{name}` parameters. */
export function msg(key: string, language: Language, params: Record<string, string> = {}): string {
  for (const layer of layers(language)) {
    const value = key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), layer);
    if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
  }
  if (language !== 'en') return msg(key, 'en', params);
  throw new Error(`no message for ${key}`);
}

/** Cookies of a visitor of the US hub who chose `language` (Spanish is offered by cookie until WEB-005 adds /es/). */
export function visitorState(language: Language) {
  const host = new URL(STACK_ORIGIN).hostname;
  return {
    cookies: [
      { name: 'trustwork.country', value: 'US', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
      { name: 'trustwork.locale', value: language, domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
    ],
    origins: [],
  };
}

/** Same-origin mutation headers for steps made outside the browser UI. */
export const SAME_ORIGIN = { 'X-Trustwork-Request': '1', Origin: STACK_ORIGIN } as const;

let counter = 0;
export function uniqueEmail(label: string): string {
  counter += 1;
  return `release-${label}-${Date.now().toString(36)}-${counter}@example.invalid`;
}

export interface SinkMail { to: string[]; from: string; subject: string | null; language: string | null; text: string | null; links: string[]; receivedAt: string }

/** Every message the SMTP sink received for an address, oldest first. */
export async function mailTo(address: string): Promise<SinkMail[]> {
  const response = await fetch(`${MAIL_READER}/messages?to=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: SinkMail[] }).items;
}

/** Waits until a message with a link matching `pattern` arrives at the sink (outbox -> worker -> SMTP); returns it. */
export async function waitForMail(address: string, pattern: RegExp, timeoutMs = 60_000): Promise<{ mail: SinkMail; link: URL }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const mail of (await mailTo(address)).reverse()) {
      const link = mail.links.find((l) => pattern.test(new URL(l).pathname));
      if (link) return { mail, link: new URL(link) };
    }
    if (Date.now() > deadline) throw new Error(`no mail matching ${pattern} to ${address} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Signs a person up through the same-origin API in `language` and verifies the address with the link of the real
 * message the SMTP sink received. The request context ends up signed in.
 */
export async function verifiedAccount(request: APIRequestContext, name: string, language: Language, email = uniqueEmail('colleague')): Promise<{ email: string; personId: string }> {
  const signup = await request.post('/v1/auth/signup', { headers: { ...SAME_ORIGIN, 'Accept-Language': language }, data: { name, email, password: PASSWORD, acceptedTermsVersion: TERMS_VERSION } });
  expect(signup.status(), await signup.text()).toBe(202);
  const { mail, link } = await waitForMail(email, /^\/verify-email\//);
  expect(mail.language?.split('-')[0], 'the verification mail is in the language of the sign-up request').toBe(language);
  const token = decodeURIComponent(link.pathname.split('/').pop()!);
  const verify = await request.post('/v1/auth/verify-email', { headers: SAME_ORIGIN, data: { token } });
  expect(verify.status(), await verify.text()).toBe(200);
  return { email, personId: ((await verify.json()) as { personId: string }).personId };
}

/** Client forms render `data-hydrated` once React owns them. */
export async function ready(page: Page): Promise<void> {
  await page.locator('form[data-hydrated]').first().waitFor();
}

/** WCAG 2.x A/AA scan of the current page (the same tags as the other browser suites). */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

/** Viewport screenshot for the release evidence, kept out of git (tests/release/platform/dist). */
export async function shot(page: Page, project: string, name: string): Promise<void> {
  const dir = resolve(OUT, 'screenshots', project);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}

/**
 * Names of every synthetic record of both demo datasets (the example hub and the US hub, DEMO-US). With demo mode off
 * none of them may appear on any page.
 */
export function fixtureNames(): string[] {
  const names: string[] = [];
  for (const dir of ['apps/web/fixtures', 'apps/web/fixtures/us']) {
    const read = <T>(file: string) => JSON.parse(readFileSync(resolve(REPO, dir, file), 'utf8')) as T;
    names.push(...read<{ companies: Array<{ company: { name: string } }> }>('companies.json').companies.map((r) => r.company.name));
    names.push(...read<{ projects: Array<{ project: { name: string } }> }>('projects.json').projects.map((r) => r.project.name));
    names.push(...read<{ people: Array<{ person: { displayName: string } }> }>('people.json').people.map((r) => r.person.displayName));
  }
  return [...new Set(names)];
}

/** Asserts that none of the fixture names is in the page's visible text. */
export async function expectNoFixtureData(page: Page, where: string): Promise<void> {
  const text = await page.locator('body').innerText();
  const found = fixtureNames().filter((name) => text.includes(name));
  expect(found, `${where}: fixture records with demo mode off`).toEqual([]);
  await expect(page.getByTestId('demo-banner'), `${where}: demo strip`).toHaveCount(0);
}
