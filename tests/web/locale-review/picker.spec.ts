import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { AXE_TAGS, hydrated } from '../helpers.js';

/**
 * INTL-007 in the browser: every offered language shows its review status in the header picker and the first-visit
 * window, a screen reader gets the label and the sentence behind it, the public note explains them, and the same facts
 * are published as data. Expected text comes from the dictionaries, so the check holds in every language.
 */
type Status = 'reference' | 'machine_draft';
type Copy = { title: string; noReview: string; link: string; status: Record<Status, { label: string; description: string }> };
const copy = (tag: string) => (JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../apps/web/locales/${tag}/translations.json`), 'utf8')) as { translations: Copy }).translations;

const LANGUAGES = ['English', 'Español', 'Oʻzbekcha', 'ქართული', 'Հայերեն', 'Azərbaycanca', 'Русский'];
const ENGINE_LANGUAGES = ['en', 'es', 'uz-Latn', 'ka', 'hy', 'az-Latn'];
const prefix = (tag: string) => (tag === 'en' ? '' : `/${tag}`);
const cookies = (locale: string) => ({
  cookies: [
    { name: 'trustwork.country', value: 'US', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
    { name: 'trustwork.locale', value: locale, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  ],
  origins: [],
});

async function openPicker(page: Page, path: string) {
  await page.goto(path);
  await (await hydrated(page.locator('.lsw').first())).click();
  return page.getByRole('dialog');
}

for (const tag of ENGINE_LANGUAGES) {
  test.describe(`picker in ${tag}`, () => {
    test.use({ storageState: cookies(tag) });

    test('every language shows its status; a draft is labelled and stays selectable', async ({ page }) => {
      const { status } = copy(tag);
      const dialog = await openPicker(page, `${prefix(tag)}/news`);
      for (const name of LANGUAGES) {
        const language = dialog.getByRole('button', { name: new RegExp(`^${name}`) });
        await expect(language, name).toBeEnabled();
        const review = name === 'English' ? status.reference : status.machine_draft;
        await expect(language, name).toContainText(review.label);
        // The name carries the label and the description the sentence behind it: both are announced.
        await expect(language, name).toHaveAccessibleName(new RegExp(review.label));
        await expect(language, name).toHaveAccessibleDescription(new RegExp(review.description.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      const axe = await new AxeBuilder({ page }).include('.lsw-dialog').withTags([...AXE_TAGS]).analyze();
      expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    });
  });
}

test.describe('English reader', () => {
  test.use({ storageState: cookies('en') });

  test('the picker links to the public note, in the page language', async ({ page }) => {
    const dialog = await openPicker(page, '/news');
    await dialog.getByRole('link', { name: copy('en').link }).click();
    await expect(page).toHaveURL(/\/translations$/);
    await expect(page.getByRole('heading', { level: 1, name: copy('en').title })).toBeVisible();
  });

  test('a language with a partial dictionary keeps saying so to a screen reader', async ({ page }) => {
    const dialog = await openPicker(page, '/news');
    await expect(dialog.getByRole('button', { name: /^Русский/ })).toHaveAccessibleDescription(/missing text is shown in English/);
  });
});

test.describe('first visit', () => {
  test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

  test('the first-visit window shows every status too', async ({ page }) => {
    const { status } = copy('en');
    await page.goto('/');
    const gate = page.getByRole('dialog', { name: 'Choose your country' });
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('radio', { name: /^English/ })).toContainText(status.reference.label);
    await expect(gate.getByRole('radio', { name: /^ქართული/ })).toContainText(status.machine_draft.label);
    await expect(gate.getByRole('radio', { name: /^ქართული/ })).toHaveAccessibleDescription(new RegExp(status.machine_draft.description.slice(0, 24)));
  });
});

for (const tag of ENGINE_LANGUAGES) {
  test.describe(`note in ${tag}`, () => {
    test.use({ storageState: cookies(tag) });

    test('the public note reads in the language and passes axe', async ({ page }) => {
      const text = copy(tag);
      await page.goto(`${prefix(tag)}/translations`);
      await expect(page.locator('html')).toHaveAttribute('lang', tag);
      await expect(page.getByRole('heading', { level: 1, name: text.title })).toBeVisible();
      const rows = page.locator('.tr-table tbody tr');
      await expect(rows).toHaveCount(LANGUAGES.length);
      await expect(page.locator('.tr-table tbody tr', { hasText: 'ქართული' })).toContainText(text.status.machine_draft.label);
      await expect(page.locator('.tr-table tbody tr', { hasText: 'ქართული' })).toContainText(text.noReview);
      await expect(page.locator('.tr-table tbody tr', { hasText: 'English' })).toContainText(text.status.reference.label);
      const axe = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
      expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    });
  });
}

test('Russian is not maintained: its note opens with the English labels', async ({ page }) => {
  await page.goto('/ru/translations');
  await expect(page.locator('.tr-table tbody tr', { hasText: 'ქართული' })).toContainText(copy('en').status.machine_draft.label);
});

test('the review status is published as data, for every language and without contributor notes', async ({ request }) => {
  const response = await request.get('/translations/status.json');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  const statement = (await response.json()) as { schema: string; reference: string; locales: Array<{ tag: string; status: string; review: unknown }> };
  expect(statement.schema).toBe('trustwork-locale-review/1');
  expect(statement.reference).toBe('en');
  expect(statement.locales.map((locale) => locale.tag).sort()).toEqual(['az-Latn', 'en', 'es', 'hy', 'ka', 'ru', 'uz-Latn']);
  expect(statement.locales.find((locale) => locale.tag === 'en')?.status).toBe('reference');
  for (const locale of statement.locales.filter((entry) => entry.tag !== 'en')) expect(locale, locale.tag).toEqual({ tag: locale.tag, status: 'machine_draft', review: null });
});
