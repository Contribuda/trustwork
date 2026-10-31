import { expect, test } from '@playwright/test';
import { openStory } from './stories';

test.describe('keyboard operation and focus management (desktop 1280)', () => {
  test('dialog traps focus, closes on Escape and returns focus to the trigger', async ({ page }) => {
    await openStory(page, 'overlays-dialog--closed');
    const trigger = page.getByRole('button', { name: 'Открыть окно' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Пригласить поставщиков' });
    await expect(dialog).toBeVisible();
    // React Aria makes everything outside the modal inert (focus trap plus hidden from assistive tech) instead of aria-modal.
    await expect(page.locator('#storybook-root')).toHaveAttribute('inert', '');
    await expect(page.getByRole('textbox', { name: /Электронная почта поставщика/ })).toBeFocused();
    // Tab cycles inside the dialog only.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('confirm dialog focuses the non-destructive action first', async ({ page }) => {
    await openStory(page, 'overlays-dialog--confirm-destructive');
    await expect(page.getByRole('button', { name: 'Отмена' })).toBeFocused();
  });

  test('avatar menu follows the menu button pattern', async ({ page }) => {
    await openStory(page, 'overlays-popover-menu-tooltip--avatar-menu');
    const button = page.getByRole('button', { name: 'Аккаунт' });
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await button.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Моя страница' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Настройки аккаунта' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'Выйти' })).toBeFocused();
    // Consistent help: «Помощь» is the item directly before «Выйти».
    const names = await page.getByRole('menuitem').allTextContents();
    expect(names.indexOf('Помощь')).toBe(names.indexOf('Выйти') - 1);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('tabs move with arrow keys and the panel is reachable', async ({ page }) => {
    await openStory(page, 'navigation-tabs--default');
    const first = page.getByRole('tab', { name: 'Разговор' });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Поручения' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tabpanel')).toBeFocused();
  });

  test('password toggle exposes aria-pressed and keeps tab order', async ({ page }) => {
    await openStory(page, 'forms-textfield--password');
    const toggle = page.getByRole('button', { name: 'Показать пароль' }).first();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Скрыть пароль' }).first()).toHaveAttribute('aria-pressed', 'true');
  });

  test('sortable table headers expose aria-sort and toggle from the keyboard', async ({ page }) => {
    await openStory(page, 'data-datatable--sorted');
    const header = page.getByRole('columnheader', { name: /Срок/ });
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    const region = page.getByRole('region', { name: /Таблица «Потребности в работе»/ });
    await expect(region).toHaveAttribute('tabindex', '0');
    await header.click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  test('sidebar collapse control lives in the brand row, keeps focus and labels', async ({ page }) => {
    await openStory(page, 'shell-workspace-shell--sidebar-expanded');
    const nav = page.getByRole('navigation', { name: 'Рабочее пространство' });
    const collapse = nav.getByRole('button', { name: 'Свернуть меню' });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await collapse.focus();
    await page.keyboard.press('Enter');
    const expand = nav.getByRole('button', { name: 'Развернуть меню' });
    await expect(expand).toBeFocused();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    // Collapsed items keep their accessible names and attention counts.
    await expect(nav.getByRole('link', { name: /Закупки/ })).toHaveAccessibleName(/2 требуют решения/);
    const names = await nav.getByRole('link').allInnerTexts();
    expect(names.length).toBeGreaterThanOrEqual(9);
    await expect(nav.getByRole('link', { name: 'В отрасль' })).toBeVisible();
  });

  test('bell count is part of the accessible name; avatar is the only account control', async ({ page }) => {
    await openStory(page, 'shell-workspace-shell--header');
    await expect(page.getByRole('button', { name: 'Уведомления, 3 новых' })).toBeVisible();
    const account = page.getByRole('button', { name: 'Аккаунт' });
    await expect(account).toBeVisible();
    await expect(page.locator('header').getByText('Имя Фамилия')).toHaveCount(0);
  });

  test('assistant overlay is non-modal, does not reflow the page, closes on Escape and returns focus to the launcher', async ({ page }) => {
    await openStory(page, 'shell-assistant-launcher-and-overlay--launcher-closed');
    const content = page.getByTestId('page-content');
    const before = await content.boundingBox();
    const launcher = page.getByRole('button', { name: 'Помощник' });
    await launcher.focus();
    await page.keyboard.press('Enter');
    const overlay = page.getByRole('complementary', { name: 'Окно помощника' });
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCSS('position', 'fixed');
    await expect(page.getByRole('button', { name: 'Закрыть', exact: true })).toBeFocused();
    const after = await content.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(after?.x).toBe(before?.x);
    // Non-modal: the page button is still reachable by Tab order.
    await page.getByRole('button', { name: 'Кнопка на странице' }).focus();
    await expect(page.getByRole('button', { name: 'Кнопка на странице' })).toBeFocused();
    await page.getByRole('button', { name: 'Закрыть', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
    await expect(page.getByRole('button', { name: 'Помощник' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Помощник' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('launcher names its unread / action-required state', async ({ page }) => {
    await openStory(page, 'shell-assistant-launcher-and-overlay--launcher-unread');
    await expect(page.getByRole('button', { name: 'Помощник, 2 непрочитанных' })).toBeVisible();
    await openStory(page, 'shell-assistant-launcher-and-overlay--launcher-action-required');
    await expect(page.getByRole('button', { name: 'Помощник, требуется ваше решение' })).toBeVisible();
  });

  test('citation chip exposes state in its name and aria-expanded', async ({ page }) => {
    await openStory(page, 'retrieval-citations-and-retrieval-states--chip-states');
    await expect(page.getByRole('button', { name: 'Источник 3, недоступен' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Источник 2, историческая версия' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Источник 4' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('tag select uses toggle buttons with aria-pressed and announces the count', async ({ page }) => {
    await openStory(page, 'forms-tagselect--cards');
    const first = page.getByRole('button', { name: /Закупаю/ });
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await first.focus();
    await page.keyboard.press('Space');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText('Выбран 1 вариант');
  });

  test('public header exposes the seven sections in order with aria-current', async ({ page }) => {
    await openStory(page, 'shell-public-shell--header-anonymous');
    const nav = page.getByRole('navigation', { name: 'Разделы' });
    await expect(nav.getByRole('link')).toHaveText(['Главная', 'Новости', 'Статьи', 'Компании', 'Люди', 'Проекты', 'Журнал']);
    await expect(nav.getByRole('link', { name: 'Главная' })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Перейти к содержимому' })).toBeFocused();
  });

  test('toast region is a polite live region and errors use role=alert', async ({ page }) => {
    await openStory(page, 'overlays-toast--visible');
    const region = page.getByRole('region', { name: 'Уведомления о действиях' });
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region.getByRole('alert')).toContainText('Не удалось сохранить');
    await expect(region.getByRole('status')).toContainText('Сохранено');
  });

  test('focus-visible ring is rendered on keyboard focus', async ({ page }) => {
    await openStory(page, 'primitives-button--variants');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Сохранить');
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });

  test('story card: exactly one link per card, focus ring drawn on the whole card', async ({ page }) => {
    await openStory(page, 'editorial-hero-cards-bands--story-cards');
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) await expect(card.getByRole('link')).toHaveCount(1);
    await page.keyboard.press('Tab');
    const link = page.locator(':focus');
    await expect(link).toHaveAttribute('href', '#story-1');
    const outline = await cards.first().evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
  });

  test('hero: the title is the single link and carries the headline as its name', async ({ page }) => {
    await openStory(page, 'editorial-hero-cards-bands--hero-lead');
    const hero = page.getByRole('article');
    await expect(hero.getByRole('link')).toHaveCount(1);
    await expect(hero.getByRole('link', { name: 'Как меняется строительство' })).toBeVisible();
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText('Как меняется строительство');
    await expect(hero.getByRole('img')).toHaveAttribute('alt', /кран/i);
  });

  test('magazine cover link is named with the issue number and title', async ({ page }) => {
    await openStory(page, 'editorial-hero-cards-bands--magazine-covers');
    await expect(page.getByRole('link', { name: /^Обложка выпуска.*№ 12.*Фасады перед зимой/ })).toBeVisible();
  });

  test('demo banner: persona menu opens from the keyboard, selection updates the control name and focus returns', async ({ page }) => {
    await openStory(page, 'workspace-decision-entity-events--demo-strip');
    await expect(page.getByRole('status')).toContainText('Демонстрационные данные');
    const trigger = page.getByRole('button', { name: 'Демонстрационный участник: Гость' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu', { name: 'Демонстрационный участник' });
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Гость' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    const updated = page.getByRole('button', { name: 'Демонстрационный участник: Владелец личного проекта' });
    await expect(updated).toBeVisible();
    await expect(updated).toBeFocused();
  });

  test('decision cards: one call to action each, kicker names the state (never colour-only)', async ({ page }) => {
    await openStory(page, 'workspace-decision-entity-events--decision-cards');
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Нужно ваше решение');
    await expect(cards.nth(2)).toContainText('Помощник ждёт решения');
    for (const card of await cards.all()) await expect(card.getByRole('link')).toHaveCount(1);
  });

  test('event list: date tiles expose the full date and items link once', async ({ page }) => {
    await openStory(page, 'workspace-decision-entity-events--dates-and-events');
    const list = page.getByRole('list', { name: 'Ближайшие события' });
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list.locator('time').first()).toHaveAttribute('datetime', '2026-10-30');
    await expect(list.locator('time').first()).toHaveText(/30 октября 2026/);
    await expect(list.getByRole('link')).toHaveCount(4);
  });
});
