import { expect, test } from '@playwright/test';
import { ROUTES, WORKSPACE_NAV, expectRussianOnly, hydrated } from './helpers.js';

test.describe('workspace shell', () => {
  for (const route of ROUTES.filter((r) => r.path.startsWith('/app') || r.path.startsWith('/onboarding'))) {
    test(`${route.name}: Russian copy only`, async ({ page }) => {
      await page.goto(route.path);
      await expectRussianOnly(page);
    });
  }

  test('sidebar has exactly the eight destinations in order plus «В отрасль», no inbox, no switchers', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    const nav = page.getByRole('navigation', { name: 'Рабочее пространство' }).first();
    const links = nav.locator('ul a').filter({ visible: true });
    await expect(links).toHaveText(WORKSPACE_NAV.map((label) => new RegExp('^' + label)));
    await expect(nav.getByRole('link', { name: 'В отрасль' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Обзор' })).toHaveAttribute('aria-current', 'page');
    const text = await page.evaluate(() => document.body.innerText);
    for (const forbidden of ['Входящие', 'Сменить компанию', 'Агенты', 'Настроить меню', 'Режим: покупатель']) expect(text).not.toContain(forbidden);
    await expect(page.getByRole('button', { name: 'Аккаунт' })).toHaveCount(1);
  });

  test('unpinned commerce sections move under «Ещё» for the reader persona', async ({ page }) => {
    await page.goto('/app?persona=reader');
    const nav = page.getByRole('navigation', { name: 'Рабочее пространство' }).first();
    await expect(nav.locator('ul a').filter({ visible: true })).toHaveText(['Обзор', 'Моя страница', 'Компания', 'Проекты', 'Публикации', 'Помощник']);
    await (await hydrated(nav.getByRole('button', { name: 'Ещё' }))).click();
    await expect(nav.getByRole('link', { name: 'Закупки' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Продажи' })).toBeVisible();
  });

  test('mixed persona overview shows procurement and sales together; reader has no commerce cards', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Обзор');
    await expect(page.getByText('Закупки, продажи и ваши проекты')).toBeVisible();
    await expect(page.locator('#procurement')).toBeVisible();
    await expect(page.locator('#sales')).toBeVisible();
    await expect(page.locator('#decisions')).toContainText('Нужно ваше решение');
    await page.goto('/app?persona=reader');
    await expect(page.getByText('Ваши проекты и публикации')).toBeVisible();
    await expect(page.locator('#procurement')).toHaveCount(0);
    await expect(page.locator('#sales')).toHaveCount(0);
    await expect(page.locator('#publications')).toContainText('Черновик');
    await expect(page.getByText('Проектов пока нет')).toBeVisible();
  });

  test('keyboard walk: skip link, brand, collapse, nav, header controls; collapse keeps focus and announces state', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    await hydrated(page.getByRole('button', { name: 'Аккаунт' }));
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'К содержимому' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: / — (на главную|home)$/ }).first()).toBeFocused();
    await page.keyboard.press('Tab');
    const collapse = page.getByRole('button', { name: 'Свернуть меню' });
    await expect(collapse).toBeFocused();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    const expand = page.getByRole('button', { name: 'Развернуть меню' });
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    const nav = page.getByRole('navigation', { name: 'Рабочее пространство' }).first();
    await expect(nav).toHaveAttribute('data-collapsed', 'true');
    await expect(nav.getByRole('link', { name: 'Обзор' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(collapse).toBeFocused();
    for (const label of WORKSPACE_NAV) {
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('link', { name: new RegExp('^' + label) })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(nav.getByRole('link', { name: 'В отрасль' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Страна и язык/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Поиск' }).first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Уведомления/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Аккаунт' })).toBeFocused();
  });

  test('avatar menu follows the menu-button pattern with «Помощь» before «Выйти»', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    const avatar = await hydrated(page.getByRole('button', { name: 'Аккаунт' }));
    await avatar.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.getByText('Анна Примерова').first()).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['Моя страница', 'Настройки аккаунта', 'Безопасность и сессии', 'Оплата и тарифы', 'В отрасль', 'Помощь', 'Выйти']);
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(avatar).toBeFocused();
  });

  test('bell opens an object-linked notifications list with the count in its name', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    await (await hydrated(page.getByRole('button', { name: 'Уведомления, 2 новых' }))).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Сравнение предложений по балкам готово');
    await expect(dialog.getByRole('link', { name: 'Все уведомления' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('assistant overlay opens from the launcher, never reflows main, closes on Escape and returns focus', async ({ page }) => {
    await page.goto('/app?persona=mixed');
    const main = page.locator('main#main');
    const before = await main.boundingBox();
    const launcher = page.getByRole('button', { name: /Помощник/ }).last();
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
    await hydrated(launcher);
    await launcher.focus();
    await page.keyboard.press('Enter');
    const overlay = page.getByRole('complementary', { name: 'Окно помощника' });
    await expect(overlay).toBeVisible();
    await expect(page.getByRole('button', { name: 'Закрыть', exact: true })).toBeFocused();
    const after = await main.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.x).toBe(before?.x);
    await expect(overlay).toContainText('решение ждёт вас');
    await expect(overlay.getByRole('button', { name: 'Открыть', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Сообщение помощнику' }).fill('Проверка общего разговора');
    await page.keyboard.press('Enter');
    await expect(overlay.getByRole('log')).toContainText('Проверка общего разговора');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Помощник/ }).last()).toBeFocused();
    await page.getByRole('navigation', { name: 'Рабочее пространство' }).first().getByRole('link', { name: 'Помощник' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Помощник');
    await expect(page.getByRole('log')).toContainText('Проверка общего разговора');
  });

  test('company without membership shows a purposeful empty state; member sees private floors only with the grant', async ({ page }) => {
    await page.goto('/app/company?persona=reader');
    await expect(page.getByText('Вы пока не связаны с компанией')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Присоединиться по приглашению' })).toBeVisible();
    await page.goto('/app/company?persona=mixed');
    await (await hydrated(page.getByRole('tab', { name: 'Каталог' }))).click();
    await expect(page.getByRole('tabpanel')).toContainText('Минимальная цена (не публикуется)');
  });

  test('project detail: participant sees shared milestones without budget tab; owner sees budget', async ({ page }) => {
    await page.goto('/app/projects/project-school?persona=mixed');
    // The scroll hint renders only when the tab row overflows, so it is not asserted at desktop width.
    await page.goto('/app/projects/project-dacha?persona=mixed');
    await expect(page.getByRole('tab', { name: 'Бюджет' })).toHaveCount(0);
    await (await hydrated(page.getByRole('tab', { name: 'План' }))).click();
    await expect(page.getByRole('tabpanel')).toContainText('Утепление стен');
    await expect(page.getByRole('tabpanel')).not.toContainText('Транш кредита');
    await page.goto('/app/projects/project-dacha?persona=owner');
    await (await hydrated(page.getByRole('tab', { name: 'Бюджет' }))).click();
    await expect(page.getByRole('tabpanel')).toContainText('Лимит');
    expect((await page.goto('/app/projects/project-dacha?persona=reader'))?.status()).toBe(404);
  });

  test('error, offline and loading scenarios render their states', async ({ page }) => {
    await page.goto('/app?persona=mixed&scenario=error');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Не удалось загрузить раздел');
    await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'К обзору' })).toHaveAttribute('href', /\/app\?persona=mixed/);
    await page.goto('/app/projects/project-dacha?persona=reader');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Раздел не найден');
    await expect(page.getByRole('link', { name: 'К обзору' })).toHaveAttribute('href', /\/app\?persona=reader/);
    await page.goto('/app?persona=mixed&scenario=offline');
    await expect(page.getByRole('status').filter({ hasText: 'Нет соединения' }).first()).toBeVisible();
    await page.goto('/app?persona=mixed&scenario=loading', { waitUntil: 'commit' });
    await expect(page.getByRole('status', { name: 'Загружаем раздел…' })).toBeVisible({ timeout: 10_000 });
  });

  test('sales without a company explains instead of disabling; procurement for a personal project works', async ({ page }) => {
    await page.goto('/app/sales?persona=reader');
    await expect(page.getByText('Продажи ведутся от имени компании')).toBeVisible();
    await page.goto('/app/procurement?persona=owner');
    await expect(page.getByText('Окна для загородного дома')).toBeVisible();
  });
});
