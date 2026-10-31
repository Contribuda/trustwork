import { expect, test, type Page } from '@playwright/test';
import { bodyText, expectAccessible, expectNoHorizontalOverflow, msg, shot } from './support.js';

/**
 * WEB-002 in demo mode (the hosted preview: synthetic projections, nothing is sent). Russian interface, like the rest
 * of the demo suites. Copy comes from the dictionaries. The live API journey is tests/web/commerce/live.e2e.ts.
 */
const RFQ = '/app/procurement/rfq/rfq-fasad-1';
const P = 'persona=mixed';
const BUYER_SECRET = msg('commerce.demo.internalNotes');
const SELLER_SECRET = msg('commerce.demo.sellerNotes');

async function noPageErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('procurement list, RFQ versions and the buyer-private record', async ({ page }) => {
  const errors = await noPageErrors(page);
  await page.goto(`/app/procurement?${P}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('procurement.title'));
  await expect(page.getByText(msg('commerce.demoNote'))).toBeVisible();
  await expect(page.getByRole('heading', { name: msg('commerce.list.rfqs') })).toBeVisible();
  await expect(page.getByRole('heading', { name: msg('commerce.list.needs') })).toBeVisible();
  await page.getByRole('link', { name: 'Стальные балки для школы на набережной' }).click();
  await expect(page).toHaveURL(new RegExp(`${RFQ}`));
  const tabs = page.getByRole('navigation', { name: msg('commerce.tabs.label') });
  await expect(tabs.getByRole('link', { name: msg('commerce.tabs.requirements') })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: msg('commerce.versionSuperseded', { version: 1 }) })).toBeVisible();
  await expect(page.getByRole('link', { name: msg('commerce.versionCurrent', { version: 2 }) })).toBeVisible();
  await expect(page.getByText(msg('commerce.rfq.amendmentReasonShown', { reason: msg('commerce.demo.amendmentReason') }))).toBeVisible();
  const rail = page.getByRole('complementary', { name: msg('commerce.rfq.rail') });
  await expect(rail.getByText(msg('commerce.privateLabel')).first()).toBeVisible();
  await expect(rail.getByLabel(msg('commerce.rfq.internalNotes'), { exact: true })).toHaveValue(BUYER_SECRET);
  expect(await bodyText(page)).not.toContain(SELLER_SECRET);
  expect(errors).toEqual([]);
});

test('a quote for an amended request is visibly stale and never compared or totalled', async ({ page }) => {
  await page.goto(`${RFQ}?${P}&tab=compare`);
  const grid = page.getByRole('region', { name: msg('commerce.compare.caption', { version: 2 }) });
  await expect(grid).toBeVisible();
  // The current versions: one complete total, one substitution that is not comparable.
  await expect(grid.getByText(msg('compare.notComparable')).first()).toBeVisible();
  await expect(grid.getByText(msg('compare.totalIncomplete'))).toHaveCount(1);
  const staleChip = msg('commerce.stale', { version: 1 });
  await expect(grid.getByText(staleChip)).toHaveCount(0);
  await page.getByRole('link', { name: /Показать устаревшие предложения/ }).click();
  await expect(page).toHaveURL(/stale=1/);
  const withStale = page.getByRole('region', { name: msg('commerce.compare.caption', { version: 2 }) });
  // Both versions that answer version 1 (one superseded, one never revalidated) are marked stale and never totalled.
  await expect(withStale.locator('thead').getByText(staleChip)).toHaveCount(2);
  await expect(withStale.locator('tfoot').getByText(msg('compare.totalIncomplete'))).toHaveCount(3);
  // The quotes tab shows the stale flag next to the version it answers.
  await page.goto(`${RFQ}?${P}&tab=quotes`);
  await expect(page.getByText(staleChip).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: msg('commerce.compare.historicalTitle') })).toHaveCount(0);
  await page.goto(`${RFQ}?${P}&tab=compare`);
  await expect(page.getByRole('heading', { name: msg('commerce.compare.historicalTitle') })).toBeVisible();
});

test('accepting exact terms needs consent to electronic records; the demo sends nothing', async ({ page }) => {
  await page.goto(`${RFQ}?${P}&tab=compare`);
  const accept = page.locator('form[data-hydrated]').filter({ has: page.getByRole('button', { name: msg('commerce.accept.submit') }) }).first();
  await accept.waitFor();
  await accept.getByRole('button', { name: msg('commerce.accept.submit') }).click();
  await expect(accept.getByRole('alert')).toContainText(msg('commerce.consent.required'));
  await expect(accept.getByLabel(msg('commerce.consent.label'), { exact: true })).toBeFocused();
  await accept.getByLabel(msg('commerce.consent.label'), { exact: true }).check();
  await accept.getByRole('button', { name: msg('commerce.accept.submit') }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(msg('commerce.accept.body'));
  await expect(dialog.getByRole('button', { name: msg('commerce.cancel') })).toBeFocused();
  await dialog.getByRole('button', { name: msg('commerce.accept.submit') }).click();
  await expect(accept.getByText(msg('commerce.demoNotSent'))).toBeVisible();
});

test('need intake shows what is missing and refuses an empty title with focus on the field', async ({ page }) => {
  await page.goto(`/app/procurement/needs/demo-need-1?${P}`);
  await expect(page.getByRole('heading', { name: msg('commerce.need.missingTitle') })).toBeVisible();
  await expect(page.getByText(msg('commerce.missing.region'))).toBeVisible();
  await expect(page.getByText(msg('commerce.missing.quantity', { n: 1 }))).toBeVisible();
  await page.goto(`/app/procurement/needs/new?${P}`);
  const form = page.locator('form[data-hydrated]');
  await form.waitFor();
  await form.getByRole('button', { name: msg('commerce.need.create') }).click();
  await expect(form.getByRole('alert')).toContainText(msg('commerce.need.titleRequired'));
  await expect(form.getByLabel(msg('commerce.need.title'), { exact: true })).toBeFocused();
  await form.getByLabel(msg('commerce.need.title'), { exact: true }).fill('Кирпич для забора');
  await form.getByLabel(msg('commerce.lines.description', { n: 1 }), { exact: true }).fill('Кирпич облицовочный');
  await form.getByLabel(msg('commerce.lines.quantity', { n: 1 }), { exact: true }).fill('1200');
  await form.getByRole('button', { name: msg('commerce.need.create') }).click();
  await expect(form.getByText(msg('commerce.demoNotSent'))).toBeVisible();
});

test('sales: requests, the quote editor with private floors, the separate order acceptance', async ({ page }) => {
  const errors = await noPageErrors(page);
  await page.goto(`/app/sales?${P}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('sales.title'));
  await expect(page.getByText(msg('commerce.sales.privacyNote'))).toBeVisible();
  await page.goto(`/app/sales/quotes/demo-sale-lead-1-quote?${P}`);
  await expect(page.getByText(msg('commerce.quote.floorHint')).first()).toBeVisible();
  await expect(page.getByLabel(msg('commerce.quote.notes'), { exact: true })).toHaveValue(SELLER_SECRET);
  expect(await bodyText(page)).not.toContain(BUYER_SECRET);
  await page.getByRole('button', { name: msg('commerce.quote.send', { version: 1 }) }).click();
  await expect(page.getByRole('dialog')).toContainText(msg('commerce.quote.sendConfirm'));
  await page.getByRole('dialog').getByRole('button', { name: msg('commerce.quote.send', { version: 1 }) }).click();
  await expect(page.getByText(msg('commerce.demoNotSent'))).toBeVisible();
  // An amended request: the quote refers to version 1.
  await page.goto(`/app/sales/quotes/demo-sale-lead-3-quote?${P}`);
  await expect(page.getByText(msg('commerce.sales.rfqChanged', { version: 2, old: 1 }))).toBeVisible();
  await expect(page.getByRole('button', { name: msg('commerce.quote.createForNew') })).toBeVisible();
  // The buyer accepted the terms and placed the order: the seller accepts separately.
  await page.goto(`/app/sales/quotes/demo-sale-lead-2-quote?${P}&tab=order`);
  await expect(page.getByRole('heading', { name: msg('commerce.sellerOrder.selected', { version: 1 }) })).toBeVisible();
  await expect(page.getByRole('button', { name: msg('commerce.sellerOrder.accept') })).toBeVisible();
  expect(await bodyText(page)).not.toContain(BUYER_SECRET);
  expect(errors).toEqual([]);
});

test('denial and empty states: no company, no grant, someone else’s request', async ({ page }) => {
  await page.goto('/app/sales?persona=reader');
  await expect(page.getByText(msg('sales.noCompanyTitle'))).toBeVisible();
  await page.goto('/app/procurement?persona=reader');
  await expect(page.getByText(msg('procurement.empty'))).toBeVisible();
  const response = await page.goto(`${RFQ}?persona=owner`);
  expect(response?.status()).toBe(404);
  const seller = await page.goto(`/app/sales/quotes/${encodeURIComponent('rfq-fasad-1-quote-a')}?${P}`);
  expect(seller?.status(), 'the buyer side never opens the seller editor').toBe(404);
});

test('keyboard: the tabs and the comparison are reachable and operable without a mouse', async ({ page }) => {
  await page.goto(`${RFQ}?${P}`);
  const compare = page.getByRole('navigation', { name: msg('commerce.tabs.label') }).getByRole('link', { name: msg('commerce.tabs.compare') });
  await compare.focus();
  await expect(compare).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/tab=compare/);
  const region = page.getByRole('region', { name: msg('commerce.compare.caption', { version: 2 }) });
  await region.focus();
  await expect(region).toBeFocused();
  const reason = region.locator('summary').first();
  await reason.focus();
  await page.keyboard.press('Enter');
  await expect(region.getByText(msg('compare.whyNotComparable'), { exact: false }).first()).toBeVisible();
});

test('accessibility scan of the commerce screens and desktop screenshots', async ({ page }) => {
  test.setTimeout(120_000);
  const pages: Array<[string, string]> = [
    [`/app/procurement?${P}`, 'procurement-list'],
    [`${RFQ}?${P}`, 'rfq-requirements'],
    [`${RFQ}?${P}&tab=compare&stale=1`, 'rfq-compare-stale'],
    [`${RFQ}?${P}&tab=suppliers`, 'rfq-suppliers'],
    [`${RFQ}?${P}&tab=negotiation`, 'rfq-negotiation'],
    [`/app/procurement/needs/demo-need-1?${P}`, 'need'],
    [`/app/sales?${P}`, 'sales-list'],
    [`/app/sales/quotes/demo-sale-lead-1-quote?${P}`, 'quote-editor'],
    [`/app/sales/quotes/demo-sale-lead-2-quote?${P}&tab=order`, 'seller-order'],
  ];
  for (const [path, name] of pages) {
    await page.goto(path);
    await expectAccessible(page);
    await shot(page, 'commerce-screenshots', `desktop-ru-${name}`);
  }
});

test.describe('phone width (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test('no horizontal scrolling; the comparison becomes one card per line', async ({ page }) => {
    test.setTimeout(120_000);
    for (const [path, name] of [
      [`/app/procurement?${P}`, 'procurement-list'],
      [`${RFQ}?${P}&tab=compare&stale=1`, 'rfq-compare-stale'],
      [`${RFQ}?${P}&tab=order`, 'rfq-order'],
      [`/app/sales/quotes/demo-sale-lead-1-quote?${P}`, 'quote-editor'],
      [`/app/sales/quotes/demo-sale-lead-2-quote?${P}&tab=order`, 'seller-order'],
    ] as const) {
      await page.goto(path);
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
      await shot(page, 'commerce-screenshots', `phone-ru-${name}`);
    }
    await page.goto(`${RFQ}?${P}&tab=compare`);
    await expect(page.locator('.cm-compare thead')).toBeHidden();
  });
});
