import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { axeTags, openStory } from './stories';

/**
 * axe scans AFTER an interaction opens a menu, dialog, popover, sheet or the assistant overlay.
 * The per-story scan in a11y.spec.ts only sees initial renders; these cases cover the opened state reached by a user.
 */
const cases: Array<{ name: string; story: string; open: (page: Page) => Promise<void>; expectRole: string; expectName: string | RegExp; disableRules?: string[] }> = [
  { name: 'dialog opened from its trigger', story: 'overlays-dialog--closed', open: (p) => p.getByRole('button', { name: 'Открыть окно' }).click(), expectRole: 'dialog', expectName: 'Пригласить поставщиков' },
  { name: 'destructive confirm dialog', story: 'overlays-dialog--confirm-destructive', open: async () => undefined, expectRole: 'dialog', expectName: 'Отозвать поручение?' },
  { name: 'avatar menu opened from the header', story: 'shell-workspace-shell--header', open: (p) => p.getByRole('button', { name: 'Аккаунт' }).click(), expectRole: 'menu', expectName: /Аккаунт/ },
  { name: 'row actions menu in the data table', story: 'data-datatable--sorted', open: (p) => p.getByRole('button', { name: /Действия со строкой/ }).first().click(), expectRole: 'menu', expectName: /Действия со строкой/ },
  { name: 'notifications popover', story: 'overlays-popover-menu-tooltip--popover-closed', open: (p) => p.getByRole('button', { name: 'Уведомления' }).click(), expectRole: 'dialog', expectName: 'Уведомления' },
  { name: 'select listbox', story: 'forms-select--default', open: (p) => p.getByRole('button', { name: /Регион/ }).click(), expectRole: 'listbox', expectName: /Регион/ },
  {
    name: 'combobox listbox after typing',
    story: 'forms-select--combobox',
    open: (p) => p.getByRole('combobox', { name: 'Направление деятельности' }).first().fill('М'),
    expectRole: 'listbox',
    expectName: /Направление деятельности/,
    // React Aria keeps a non-modal combobox popover interactive and hides the rest of the page from assistive
    // technology with aria-hidden (the input and listbox stay exposed). axe reports the other, still focusable,
    // fields in the story as `aria-hidden-focus`; this is the library's intended pattern, documented in
    // docs/design/system/accessibility-evidence.md, not a defect of the component.
    disableRules: ['aria-hidden-focus'],
  },
  { name: 'assistant overlay opened from the launcher', story: 'shell-assistant-launcher-and-overlay--launcher-closed', open: (p) => p.getByRole('button', { name: 'Помощник' }).click(), expectRole: 'complementary', expectName: 'Окно помощника' },
  { name: 'tooltip shown on focus', story: 'overlays-popover-menu-tooltip--tooltip', open: (p) => p.getByRole('button', { name: 'Уведомления' }).focus(), expectRole: 'tooltip', expectName: 'Уведомления' },
  { name: 'non-comparable cell disclosure', story: 'data-comparisontable-and-versionpicker--table', open: (p) => p.getByRole('button', { name: /Не сопоставимо/ }).first().click(), expectRole: 'region', expectName: /Сравнение/ },
  { name: 'demo persona menu', story: 'workspace-decision-entity-events--demo-strip', open: (p) => p.getByRole('button', { name: /Демонстрационный участник: / }).click(), expectRole: 'menu', expectName: 'Демонстрационный участник' },
  { name: 'sidebar «Ещё» disclosure', story: 'shell-workspace-shell--sidebar-with-more', open: (p) => p.getByRole('button', { name: 'Ещё' }).click(), expectRole: 'link', expectName: 'Закупки' },
];

test.describe('axe after opening overlays and disclosures (desktop)', () => {
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      await openStory(page, c.story);
      await c.open(page);
      await expect(page.getByRole(c.expectRole as 'dialog', { name: c.expectName }).first()).toBeVisible();
      await page.waitForTimeout(250);
      const axe = await new AxeBuilder({ page }).withTags(axeTags).disableRules(c.disableRules ?? []).analyze();
      expect(axe.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
});

test('focused control scrolled into view is not obscured by the sticky header (WCAG 2.2 2.4.11)', async ({ page }) => {
  await openStory(page, 'shell-workspace-shell--header-with-long-content');
  const control = page.getByTestId('deep-control');
  const header = page.getByRole('banner').or(page.locator('header')).first();
  const headerHeight = (await header.boundingBox())?.height ?? 64;
  // Scroll so the control sits just above the viewport (the reviewer's case), then focus it from the keyboard side.
  await control.evaluate((el) => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, top + 40);
  });
  const before = await control.boundingBox();
  expect((before?.y ?? 0) + (before?.height ?? 0)).toBeLessThanOrEqual(0);
  await control.focus();
  await expect(control).toBeFocused();
  const after = await control.boundingBox();
  expect(after?.y ?? -1).toBeGreaterThanOrEqual(headerHeight);
  const topAtFocus = await control.evaluate((el) => document.elementFromPoint(el.getBoundingClientRect().left + 4, el.getBoundingClientRect().top + 4) === el);
  expect(topAtFocus).toBe(true);
});
