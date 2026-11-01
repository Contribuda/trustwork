import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const evidence = process.env.BILL003_EVIDENCE_DIR ?? resolve(import.meta.dirname, '../evidence');
test('real API/DataPort: Russian empty, published synthetic prices, phone, languages and unauthorized command', async ({ page, request }) => {
  mkdirSync(evidence, { recursive: true });
  await page.goto('/ru/pricing');
  await expect(page.locator('h1')).toHaveText('Цены и комиссии');
  await expect(page.locator('.fee-pricing-list')).toHaveCount(0);
  await expect(page.locator('.fee-pricing')).toContainText('Отсутствие опубликованной цены означает недоступность, а не нулевую стоимость.');
  await page.screenshot({ path: resolve(evidence, 'pricing-ru-empty-desktop.png'), fullPage: true });
  const publish = await request.post('http://127.0.0.1:3542/publish');
  expect(publish.status()).toBe(200);
  expect(await publish.json()).toMatchObject({ dataPort: 'passed', synthetic: true });
  await page.reload();
  await expect(page.locator('.fee-pricing-list li')).toHaveCount(3);
  await expect(page.locator('.fee-pricing')).toContainText('Проверка чертежей');
  await expect(page.locator('.fee-pricing')).not.toContainText('drawing_review');
  await expect(page.locator('.fee-pricing')).not.toContainText('synthetic_review');
  await expect(page.locator('.fee-pricing')).toContainText('Категория недоступна: публичное название не зарегистрировано.');
  await expect(page.locator('.fee-pricing-amount').first()).toContainText('1');
  await expect(page.locator('.fee-pricing')).not.toContainText('work.envelope.roofing');
  await page.locator('.fee-pricing-reference summary').first().click();
  await expect(page.locator('.fee-pricing-reference').first()).toContainText('Отпечаток условий:');
  await page.screenshot({ path: resolve(evidence, 'pricing-ru-positive-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.locator('.fee-pricing-list li')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, 'pricing-ru-positive-375.png'), fullPage: true });
  await page.locator('button.lsw').click();
  await expect(page.locator('.lsw-lang')).toHaveCount(7);
  await page.keyboard.press('Escape');
  // Every offered language resolves the same actual public catalogue, without a session.
  for (const lang of ['en', 'es', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) {
    await page.goto(lang === 'en' ? '/pricing' : `/${lang}/pricing`);
    await expect(page.locator('.fee-pricing-list li')).toHaveCount(3);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
  }
  const denied = await page.evaluate(async () => {
    const r = await fetch('/v1/admin/billing/fees', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Trustwork-Request': '1', 'idempotency-key': 'synthetic-browser-denied' }, body: JSON.stringify({ reason: 'Synthetic unauthorized browser test', terms: {} }) });
    return { status: r.status, body: await r.json() };
  });
  expect(denied.status).toBe(401);
});
