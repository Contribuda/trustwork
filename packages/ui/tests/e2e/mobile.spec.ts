import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { axeTags, openStory } from './stories';

test.describe('mobile (375 px) behaviour', () => {
  test('data table collapses to cards that keep every column label', async ({ page }) => {
    await openStory(page, 'data-datatable--sorted');
    await expect(page.getByRole('table')).toHaveCount(0);
    const cards = page.getByRole('list').first().getByRole('listitem');
    await expect(cards).toHaveCount(4);
    await expect(cards.first().getByRole('term')).toHaveText(['Потребность', 'Проект', 'Вид', 'Статус', 'Срок', 'Предложения']);
    await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.evaluate(() => document.documentElement.clientWidth));
  });

  test('comparison table becomes a per-line accordion with a supplier switcher', async ({ page }) => {
    await openStory(page, 'data-comparisontable-and-versionpicker--table');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Поставщик для сравнения/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Не сопоставимо/ }).first()).toHaveCount(0);
  });

  test('assistant overlay becomes a modal sheet with focus trap and close control', async ({ page }) => {
    await openStory(page, 'shell-assistant-launcher-and-overlay--launcher-closed');
    await page.getByRole('button', { name: 'Помощник' }).click();
    const dialog = page.getByRole('dialog', { name: 'Окно помощника' });
    await expect(dialog).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    await expect(page.locator('#storybook-root')).toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'Помощник' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Помощник' })).toBeFocused();
  });

  test('public header menu opens a modal sheet with the seven sections', async ({ page }) => {
    await openStory(page, 'shell-public-shell--header-anonymous');
    await page.getByRole('button', { name: 'Меню' }).click();
    const dialog = page.getByRole('dialog', { name: 'Меню' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveText(['Главная', 'Новости', 'Статьи', 'Компании', 'Люди', 'Проекты', 'Журнал', 'Войти в сервис']);
    const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
  });

  test('login page at 375 px has no horizontal scroll and passes axe', async ({ page }) => {
    await openStory(page, 'shell-authshell--login');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
    expect(axe.violations).toEqual([]);
  });

  test('showcase home at 375 px has no horizontal scroll, stacks the grids and passes axe', async ({ page }) => {
    await openStory(page, 'showcase-compositions--home');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    // Hero tiles stack under the lead story and every card spans the full container width.
    const heroes = page.getByRole('article').filter({ has: page.getByRole('heading', { level: 2 }) });
    const first = await heroes.first().boundingBox();
    expect((first?.width ?? 0)).toBeGreaterThan(clientWidth - 40);
    const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });

  test('touch targets of icon-only controls are at least 24x24 CSS px', async ({ page }) => {
    await openStory(page, 'primitives-button--icon-only');
    for (const button of await page.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
    }
  });
});
