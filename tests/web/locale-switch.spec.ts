import { expect, test, type Page } from '@playwright/test';
import { hydrated } from './helpers.js';

/**
 * The language choice must stick: the first-visit gate and the header switcher write the cookies, the page
 * re-renders in the chosen language and keeps it after a reload. The other suites start from preset cookies,
 * so without this spec a broken writer goes unnoticed.
 */
const htmlLang = (page: Page) => page.locator('html').getAttribute('lang');

test.describe('first visit', () => {
  test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

  for (const [name, tag] of [['Русский', 'ru'], ['ქართული', 'ka'], ['Հայերեն', 'hy'], ['Azərbaycanca', 'az-Latn'], ['Oʻzbekcha', 'uz-Latn']] as const) {
    test(`the gate applies ${tag} and the choice survives a reload`, async ({ page }) => {
      await page.goto('/');
      const gate = page.getByRole('dialog', { name: 'Choose your country' });
      await expect(gate).toBeVisible();
      await (await hydrated(gate.getByRole('radio', { name }))).click();
      await gate.getByRole('button', { name: 'Continue' }).click();
      await expect.poll(() => htmlLang(page)).toBe(tag);
      await page.reload();
      expect(await htmlLang(page)).toBe(tag);
      await expect(page.getByRole('dialog', { name: 'Choose your country' })).toHaveCount(0);
      const cookies = await page.context().cookies();
      expect(cookies.find((c) => c.name === 'trustwork.locale')?.value).toBe(tag);
    });
  }
});

test('the header switcher changes the language both ways', async ({ page }) => {
  await page.goto('/news');
  expect(await htmlLang(page)).toBe('ru');
  await hydrated(page.locator('.lsw'));
  for (const [name, tag] of [['ქართული', 'ka'], ['English', 'en'], ['Русский', 'ru']] as const) {
    await page.locator('.lsw').first().click();
    await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
    await expect.poll(() => htmlLang(page)).toBe(tag);
  }
  await page.reload();
  expect(await htmlLang(page)).toBe('ru');
});
