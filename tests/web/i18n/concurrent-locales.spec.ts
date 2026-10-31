import { expect, test } from '@playwright/test';
import { appDictionary, uiDictionary } from './helpers.js';

/**
 * INTL-003 acceptance "parallel requests in different languages never mix strings", against the production
 * server: requests in six languages are sent at the same time and every response must be entirely in its
 * own language: `<html lang>`, server components (page heading), client components rendered on the server
 * (navigation in the shell, the demo strip) and no Cyrillic outside Russian.
 */
const LOCALES: Array<[string, string]> = [['en', 'US'], ['ru', 'UZ'], ['uz-Latn', 'UZ'], ['ka', 'GE'], ['hy', 'AM'], ['az-Latn', 'AZ']];
const PAGES = ['/', '/companies', '/events', '/people', '/projects', '/articles'];

const pick = (root: unknown, key: string): string => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], root) as string;
const decode = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const visible = (html: string) => decode(html.replace(/<!-- -->/g, '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/Русский/g, ' ').replace(/\s+/g, ' ');

test('concurrent requests in six languages never mix strings', async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(LOCALES.map(([tag, country]) => playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=${tag}` } })));
  const rounds = 3;
  const jobs = Array.from({ length: rounds }, () => PAGES.flatMap((path) => LOCALES.map((locale, i) => ({ path, locale, context: contexts[i]! })))).flat();
  const results = await Promise.all(
    jobs.map(async ({ path, locale, context }) => {
      const response = await context.get(path);
      return { path, tag: locale[0], status: response.status(), html: await response.text() };
    }),
  );
  for (const context of contexts) await context.dispose();

  const problems: string[] = [];
  for (const { path, tag, status, html } of results) {
    if (status !== 200) { problems.push(`${tag} ${path}: HTTP ${status}`); continue; }
    if (!html.includes(`<html lang="${tag}"`)) problems.push(`${tag} ${path}: html lang`);
    const nav = pick(uiDictionary(tag), 'publicNav.0');
    if (!decode(html).includes(`>${nav}<`)) problems.push(`${tag} ${path}: client shell navigation is not "${nav}"`);
    const banner = pick(appDictionary(tag), 'demo.banner');
    if (!decode(html).includes(banner)) problems.push(`${tag} ${path}: demo strip is not "${banner}"`);
    if (tag !== 'ru' && /[Ѐ-ӿ]/.test(visible(html))) problems.push(`${tag} ${path}: Cyrillic ${visible(html).match(/[Ѐ-ӿ][Ѐ-ӿ\s]*/)?.[0]}`);
  }
  expect(results.length).toBe(rounds * PAGES.length * LOCALES.length);
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a US visitor sees month-day dates, a visitor elsewhere day-month', async ({ playwright, baseURL }) => {
  const month = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
  const monthDay = new RegExp(`\\b${month} \\d{1,2}, \\d{4}\\b`);
  const dayMonth = new RegExp(`\\b\\d{1,2} ${month} \\d{4}\\b`);
  for (const [country, expected, unexpected] of [['US', monthDay, dayMonth], ['GB', dayMonth, monthDay], ['UZ', dayMonth, monthDay]] as const) {
    const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `trustwork.country=${country}; trustwork.locale=en` } });
    // Full dates of the month calendar (day titles) and the listing.
    const text = decode(await (await context.get('/events')).text());
    expect(text, country).toMatch(expected);
    expect(text, country).not.toMatch(unexpected);
    await context.dispose();
  }
});

test('English counts use the CLDR forms: "1 company" but "13 companies"', async ({ playwright, baseURL }) => {
  const context = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: 'trustwork.country=US; trustwork.locale=en' } });
  const many = visible(await (await context.get('/companies')).text()).match(/Found: (\d+) (compan\w+)/);
  expect(many?.[2]).toBe(Number(many?.[1]) === 1 ? 'company' : 'companies');
  const ru = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: 'trustwork.country=UZ; trustwork.locale=ru' } });
  const russian = visible(await (await ru.get('/companies')).text()).match(/Найдено: (\d+) (компани[а-я]*)/);
  const forms: Record<string, string> = { one: 'компания', few: 'компании', many: 'компаний', other: 'компании' };
  expect(russian?.[2]).toBe(forms[new Intl.PluralRules('ru').select(Number(russian?.[1]))]);
  await context.dispose();
  await ru.dispose();
});
