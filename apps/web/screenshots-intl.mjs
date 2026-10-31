// Evidence screenshots in non-Russian locales (ADR-009 owner decision 10). Run against a local build or set BASE_URL: node screenshots-intl.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const out = process.env.OUT_DIR ?? '../../docs/evidence/intl-content';
mkdirSync(out, { recursive: true });
const shots = [
  ['en', 'UZ', '/magazine', 'magazine-cover-en.png', '.mg-flip, .lp--cover, main'],
  ['uz-Latn', 'UZ', '/magazine', 'magazine-cover-uz.png', '.mg-flip, .lp--cover, main'],
  ['en', 'UZ', '/articles/logistika-sbornyh-konstrukcij', 'article-en.png', null],
  ['ka', 'GE', '/news/novye-trebovaniya-k-pozharnym-ispytaniyam', 'news-ka.png', null],
  ['hy', 'AM', '/events', 'events-hy.png', null],
];
const browser = await chromium.launch();
for (const [locale, country, path, file, selector] of shots) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const domain = new URL(base).hostname;
  await context.addCookies([
    { name: 'trustwork.country', value: country, domain, path: '/' },
    { name: 'trustwork.locale', value: locale, domain, path: '/' },
  ]);
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (selector) {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await el.screenshot({ path: `${out}/${file}` });
  } else {
    await page.screenshot({ path: `${out}/${file}`, fullPage: false });
  }
  console.log('saved', file);
  await context.close();
}
await browser.close();
