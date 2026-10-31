import { expect, test } from '@playwright/test';
import { PUBLIC_NAV, WORKSPACE_NAV } from './helpers.js';

/** Runs in the `tablet` (768) and `mobile` (375) projects only. */
test.describe('narrow widths', () => {
  test('no horizontal page scroll on key pages', async ({ page }) => {
    for (const path of [
      '/',
      '/news',
      '/companies/fasad-primer',
      '/magazine/12',
      '/magazine/12/read',
      '/login',
      '/onboarding?persona=reader',
      '/app?persona=mixed',
      '/app/projects?persona=mixed',
      '/app/settings?persona=mixed',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
  });

  test('public menu sheet keeps the seven sections in order', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 1280) >= 768, 'mobile only');
    await page.goto('/');
    await page.getByRole('button', { name: 'Меню' }).click();
    const dialog = page.getByRole('dialog', { name: 'Меню' });
    await expect(dialog.getByRole('navigation').getByRole('link')).toHaveText([...PUBLIC_NAV]);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Меню' })).toBeFocused();
  });

  test('workspace: mobile navigation sheet has the same destinations; tablet starts collapsed', async ({ page, viewport }) => {
    await page.goto('/app?persona=mixed');
    const width = viewport?.width ?? 1280;
    if (width < 768) {
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      const dialog = page.getByRole('dialog', { name: 'Меню' });
      await expect(dialog.getByRole('navigation', { name: 'Рабочее пространство' }).locator('ul a')).toHaveText(WORKSPACE_NAV.map((label) => new RegExp('^' + label)));
      await expect(dialog.getByRole('link', { name: 'В отрасль' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } else {
      const nav = page.getByRole('navigation', { name: 'Рабочее пространство' }).first();
      await expect(nav).toHaveAttribute('data-collapsed', 'true');
      await expect(page.getByRole('button', { name: 'Развернуть меню' })).toBeVisible();
    }
  });

  test('assistant overlay on mobile is a modal sheet with its own close control', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 1280) >= 768, 'mobile only');
    await page.goto('/app?persona=mixed');
    await page.waitForLoadState('networkidle');
    await page
      .getByRole('button', { name: /Помощник/ })
      .last()
      .click();
    const dialog = page.getByRole('dialog', { name: 'Окно помощника' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('tables collapse to labelled cards on mobile', async ({ page, viewport }) => {
    test.skip((viewport?.width ?? 1280) >= 768, 'mobile only');
    await page.goto('/app/me?persona=mixed');
    const tab = page.getByRole('tab', { name: 'История' });
    await expect(async () => {
      await tab.click();
      await expect(tab).toHaveAttribute('data-selected', 'true');
    }).toPass();
    await expect(page.locator('.ws-table tbody tr').first()).toBeVisible();
    const display = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-table tbody tr')!).display);
    expect(display).toBe('grid');
    const label = await page.evaluate(() => getComputedStyle(document.querySelector('.ws-table tbody td')!, '::before').content);
    expect(label).toContain('Организация');
  });
});
