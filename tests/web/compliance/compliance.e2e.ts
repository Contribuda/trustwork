import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PASSWORDS } from '../../backend/helpers/personas.js';
const copy = JSON.parse(readFileSync(resolve('apps/web/locales/ru/compliance.json'), 'utf8')).compliance;
const settings = JSON.parse(readFileSync(resolve('apps/web/locales/ru/settings.json'), 'utf8')).settings;
const path = '/app/settings/account/compliance';
const headers = { Origin: 'http://127.0.0.1:3586', 'X-Trustwork-Request': '1' };
const shots = resolve('tests/web/compliance/evidence');

test('real own-account appeal: anonymous isolation, safe notice, Russian desktop/375, stale step-up and submission', async ({ page }) => {
  await page.context().addCookies([
    { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/' },
    { name: 'trustwork.country', value: 'US', domain: '127.0.0.1', path: '/' },
  ]);
  await page.goto(path);
  await expect(page).toHaveURL(/\/login\?/);
  expect((await page.request.get('/v1/screening/me')).status()).toBe(401);
  const login = await page.request.post('/v1/auth/login', { headers, data: { email: 'petr@example.invalid', password: PASSWORDS.petr } });
  expect(login.status(), await login.text()).toBe(200);
  expect((await page.request.get('/v1/admin/screening/queue')).status()).toBe(403);
  expect((await page.request.get('/v1/screening/me?personId=11111111-1111-4111-8111-111111111111')).status()).toBe(422);
  await page.goto(`${path}?personId=11111111-1111-4111-8111-111111111111`);
  await expect(page.getByRole('heading', { name: copy.title, exact: true })).toBeVisible();
  await expect(page.getByText(copy.generic, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: copy.reason })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/OFAC|SDN|920002|SYNTHETIC-B|reviewerId|original_decider/);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) }))).toEqual([]);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, 'ru-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: resolve(shots, 'ru-375.png'), fullPage: true });
  await page.getByRole('textbox', { name: copy.reason }).fill('Synthetic appeal evidence: please review my identity document.');
  await page.request.post('http://127.0.0.1:4587/stale');
  await page.getByRole('button', { name: copy.submit, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(settings.stepUp.title);
  await expect(page.locator('#step-up-password')).toBeFocused();
  await page.getByRole('dialog').locator('#step-up-password').fill('wrong-password');
  await page.getByRole('button', { name: settings.stepUp.confirm, exact: true }).click();
  await expect(page.locator('#step-up-password')).toHaveValue('');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').locator('#step-up-password').fill(PASSWORDS.petr);
  await page.locator('#step-up-password').press('Enter');
  await expect(page.getByText(copy.submitted, { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('[role="status"][tabindex="-1"]')).toBeFocused();
  expect((await (await page.request.get('/v1/screening/me')).json()).status).toBe('appeal_pending');
  await page.screenshot({ path: resolve(shots, 'ru-375-submitted.png'), fullPage: true });
});

test('restricted places cannot use the compliance page or appeal API', async ({ page }) => {
  await page.context().addCookies([{ name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/' }]);
  await page.setExtraHTTPHeaders({ 'X-Sanc007-Country': 'RU' });
  await page.goto(path);
  const jurisdiction = JSON.parse(readFileSync(resolve('apps/web/locales/ru/jurisdiction.json'), 'utf8')).jurisdiction;
  await expect(page.getByRole('heading', { name: jurisdiction.title, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: copy.reason })).toHaveCount(0);
  const denied = await page.request.post('/v1/screening/me/appeal', { headers: { ...headers, 'X-Sanc007-Country': 'RU' }, data: { companyId: null, reason: 'Synthetic' } });
  expect(denied.status()).toBe(451);
  expect((await denied.json()).code).toBe('jurisdiction.restricted');
});
