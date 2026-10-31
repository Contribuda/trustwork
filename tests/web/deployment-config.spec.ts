import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Deployment configuration in the browser (CFG-001). The suite's main server runs like the hosted preview
 * (`TRUSTWORK_DEFAULT_COUNTRY=US`); a second server of the same build runs with nothing configured (see
 * playwright.config.ts), where the engine has no default country (ADR 012 decision 11): the first visit asks for a
 * country, preselects none and only continues once one is chosen. Covered in English and in Georgian.
 */
const port = Number(process.env.TRUSTWORK_E2E_PORT ?? 3459);
const NEUTRAL = `http://127.0.0.1:${Number(process.env.TRUSTWORK_E2E_NEUTRAL_PORT ?? port + 1)}`;
const ka = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../apps/web/locales/ka/core.json'), 'utf8')) as { locale: { gateTitle: string; country: string; featured: string; gateConfirm: string } }).locale;

const htmlLang = (page: Page) => page.locator('html').getAttribute('lang');
const countryCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'trustwork.country')?.value;

test.describe('no default country configured', () => {
  test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

  test('English: the first visit preselects no country and continues only after a choice', async ({ page }) => {
    await page.goto(`${NEUTRAL}/`);
    expect(await htmlLang(page)).toBe('en');
    await expect(page.locator('.lsw__code').first()).toHaveText('Country');
    const gate = page.getByRole('dialog', { name: 'Choose your country' });
    await expect(gate).toBeVisible();
    const countries = gate.getByRole('radiogroup', { name: 'Platform countries' });
    await expect(countries.getByRole('radio', { checked: true })).toHaveCount(0);
    const confirm = gate.getByRole('button', { name: 'Continue' });
    await expect(confirm).toBeDisabled();
    await countries.getByRole('radio', { name: /United States/ }).click();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => countryCookie(page)).toBe('US');
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Choose your country' })).toHaveCount(0);
    await expect(page.locator('.lsw__code').first()).toHaveText('US');
    expect(await htmlLang(page)).toBe('en');
  });

  test('Georgian: the same neutral start in another language, any country from the list', async ({ page }) => {
    await page.context().addCookies([{ name: 'trustwork.locale', value: 'ka', url: NEUTRAL }]);
    await page.goto(`${NEUTRAL}/`);
    expect(await htmlLang(page)).toBe('ka');
    await expect(page.locator('.lsw__code').first()).toHaveText(ka.country);
    const gate = page.getByRole('dialog', { name: ka.gateTitle });
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('radiogroup', { name: ka.featured }).getByRole('radio', { checked: true })).toHaveCount(0);
    const confirm = gate.getByRole('button', { name: ka.gateConfirm });
    await expect(confirm).toBeDisabled();
    await gate.getByRole('combobox').selectOption('BR');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => countryCookie(page)).toBe('BR');
    await page.reload();
    await expect(page.locator('.lsw__code').first()).toHaveText('BR');
    expect(await htmlLang(page)).toBe('ka');
  });

  test('a restricted place cannot be set by a link', async ({ page }) => {
    await page.goto(`${NEUTRAL}/?country=RU&lang=en`);
    expect(await countryCookie(page)).toBeUndefined();
    await expect(page.getByRole('dialog', { name: 'Choose your country' })).toBeVisible();
  });
});

test.describe('hosted preview configuration', () => {
  test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

  test('English: a first visit starts in the United States, preselected in the gate', async ({ page }) => {
    await page.goto('/');
    expect(await htmlLang(page)).toBe('en');
    await expect(page.locator('.lsw__code').first()).toHaveText('US');
    const gate = page.getByRole('dialog', { name: 'Choose your country' });
    await expect(gate.getByRole('radiogroup', { name: 'Platform countries' }).getByRole('radio', { name: /United States/ })).toHaveAttribute('aria-checked', 'true');
    await expect(gate.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
