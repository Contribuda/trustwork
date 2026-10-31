import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { CONTROL_ORIGIN, WEB_ORIGIN } from '../live-api/ports.js';
import { SAME_ORIGIN, expectAccessible, expectNoHorizontalOverflow, msg, shot, uniqueEmail, verifiedAccount } from '../live-api/support.js';

/**
 * WEB-002 on the live API (stack of tests/web/live-api: real API, migrated PostgreSQL, demo mode off). One buyer (a
 * person) and one seller (a company) go through intake, clarification, conversion, publication, invitation, a quote, an
 * amendment that makes the quote stale (and visibly not comparable), revalidation, a new version, acceptance of exact
 * terms with consent to electronic records, an order with a transaction-budget reservation (refused when the budget is
 * too small; an unknown outcome reconciled without a second order) and the seller's separate acceptance. Each side's
 * private half never appears on the other side's pages. Russian interface; copy from the dictionaries.
 */
test.use({ actionTimeout: 30_000 });

const COOKIES = [
  { name: 'trustwork.country', value: 'UZ', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  { name: 'trustwork.locale', value: 'ru', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
];
async function context(browser: Browser, viewport = { width: 1280, height: 800 }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: WEB_ORIGIN, viewport, locale: 'ru-RU', timezoneId: 'Asia/Tashkent', reducedMotion: 'reduce' });
  await ctx.addCookies(COOKIES);
  return ctx;
}
const ru = (key: string, params: Record<string, string | number> = {}) => msg(key, 'ru', Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
const hydrated = (page: Page) => page.locator('form[data-hydrated]').first().waitFor({ state: 'attached' });
const text = (page: Page) => page.evaluate(() => document.body.innerText);

async function confirm(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function budget(personId: string, limitMinor: string, currency: string): Promise<string> {
  const response = await fetch(`${CONTROL_ORIGIN}/budget`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ personId, limitMinor, currency }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

const BUYER_NOTE = `Закрытая заметка покупателя ${Date.now().toString(36)}`;
const SELLER_NOTE = `Закрытая заметка продавца ${Date.now().toString(36)}`;

test('procurement and sales on the live API: stale quotes are not comparable, orders reserve a budget, private halves stay private', async ({ browser }) => {
  test.setTimeout(420_000);
  const buyerCtx = await context(browser);
  const sellerCtx = await context(browser);
  const buyer = await buyerCtx.newPage();
  const seller = await sellerCtx.newPage();
  const { personId: buyerId } = await verifiedAccount(buyer.request, 'Бахром Закупщик', uniqueEmail('buyer'));
  await verifiedAccount(seller.request, 'Зарина Продавец', uniqueEmail('seller'));
  const company = `Поставка ${Date.now().toString(36)}`;
  const created = await seller.request.post('/v1/companies', { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-co-${Date.now()}` }, data: { name: company, handle: null, publicDescription: 'Металлопрокат для строек.' } });
  expect(created.status(), await created.text()).toBe(201);

  let needUrl = '';
  let rfqUrl = '';
  let quoteUrl = '';

  await test.step('empty states, then intake of a need with missing fields', async () => {
    await buyer.goto('/app/procurement');
    await expect(buyer.getByText(ru('procurement.empty'))).toBeVisible();
    await seller.goto('/app/sales');
    await expect(seller.getByText(ru('sales.empty'))).toBeVisible();
    await buyer.getByRole('link', { name: ru('procurement.createNeed') }).first().click();
    await expect(buyer).toHaveURL(/\/app\/procurement\/needs\/new$/);
    await hydrated(buyer);
    await buyer.getByLabel(ru('commerce.need.title'), { exact: true }).fill('Балки для склада');
    await buyer.getByLabel(ru('commerce.lines.description', { n: 1 }), { exact: true }).fill('Балка двутавровая 30Б1');
    await buyer.getByLabel(ru('commerce.lines.kind', { n: 1 }), { exact: true }).selectOption('goods');
    await buyer.getByLabel(ru('commerce.lines.quantity', { n: 1 }), { exact: true }).fill('10');
    await buyer.getByLabel(ru('commerce.lines.unit', { n: 1 }), { exact: true }).selectOption('t');
    await buyer.getByLabel(ru('commerce.lines.description', { n: 2 }), { exact: true }).fill('Доставка на объект');
    await buyer.getByLabel(ru('commerce.lines.kind', { n: 2 }), { exact: true }).selectOption('services');
    await buyer.getByLabel(ru('commerce.lines.quantity', { n: 2 }), { exact: true }).fill('1');
    await buyer.getByLabel(ru('commerce.lines.unit', { n: 2 }), { exact: true }).selectOption('ls');
    await buyer.getByLabel(ru('commerce.need.region'), { exact: true }).selectOption({ index: 1 });
    await shot(buyer, 'web002-01-need-intake');
    const [response] = await Promise.all([buyer.waitForResponse((r) => r.url().endsWith('/v1/needs') && r.request().method() === 'POST'), buyer.getByRole('button', { name: ru('commerce.need.create') }).click()]);
    expect(response.status()).toBe(201);
    expect(response.request().headers()['x-trustwork-request']).toBe('1');
    expect(response.request().headers()['idempotency-key']).toBeTruthy();
    await expect(buyer).toHaveURL(/\/app\/procurement\/needs\/(?!new$)[^/]+$/);
    needUrl = new URL(buyer.url()).pathname;
    await expect(buyer.getByText(ru('commerce.missing.window'))).toBeVisible();
    await expect(buyer.getByText(ru('commerce.missing.acceptance'))).toBeVisible();
    await expect(buyer.getByText(ru('commerce.convert.notReady'))).toBeVisible();
  });

  await test.step('clarification, then conversion into an RFQ draft with a private ceiling', async () => {
    await hydrated(buyer);
    await buyer.getByLabel(ru('commerce.need.windowFrom'), { exact: true }).fill('2027-03-01');
    await buyer.getByLabel(ru('commerce.need.windowTo'), { exact: true }).fill('2027-03-20');
    await buyer.getByLabel(ru('commerce.need.acceptance'), { exact: true }).fill('Накладная подписана на объекте, сертификаты приложены.');
    await buyer.getByRole('button', { name: ru('commerce.need.save') }).click();
    await expect(buyer.getByText(ru('commerce.need.nothingMissing'))).toBeVisible();
    await buyer.getByLabel(ru('commerce.rfq.deadline'), { exact: true }).fill('2029-12-01T12:00');
    await buyer.getByLabel(ru('commerce.rfq.budgetCeiling'), { exact: true }).fill('25000000');
    await buyer.getByLabel(ru('commerce.rfq.internalNotes'), { exact: true }).fill(BUYER_NOTE);
    await buyer.getByRole('button', { name: ru('commerce.convert.submit') }).click();
    await expect(buyer).toHaveURL(/\/app\/procurement\/rfq\/[^/?]+/);
    rfqUrl = new URL(buyer.url()).pathname;
    await expect(buyer.getByRole('link', { name: ru('commerce.versionDraft', { version: 1 }) })).toBeVisible();
    await expect(buyer.getByRole('complementary').getByLabel(ru('commerce.rfq.internalNotes'), { exact: true })).toHaveValue(BUYER_NOTE);
    await buyer.goto(needUrl);
    await expect(buyer.getByText(ru('commerce.need.converted'))).toBeVisible();
  });

  await test.step('publication of version 1 and an invitation pinned to it', async () => {
    await buyer.goto(rfqUrl);
    await hydrated(buyer);
    await buyer.getByRole('button', { name: ru('commerce.rfq.publish', { version: 1 }) }).click();
    await confirm(buyer, ru('commerce.rfq.publish', { version: 1 }));
    await expect(buyer.getByText(ru('commerce.versionCurrent', { version: 1 })).first()).toBeVisible();
    await buyer.goto(`${rfqUrl}?tab=suppliers`);
    await hydrated(buyer);
    await buyer.getByLabel(ru('commerce.invite.supplier'), { exact: true }).selectOption({ label: `${company} · ${ru('commerce.party.company')}` });
    await buyer.getByRole('button', { name: ru('commerce.invite.submit') }).click();
    await expect(buyer.getByRole('cell', { name: company })).toBeVisible();
    await shot(buyer, 'web002-02-rfq-suppliers');
  });

  await test.step('the seller prepares and sends version 1 of the quote, with a private floor', async () => {
    await seller.goto('/app/sales');
    await seller.getByRole('link', { name: 'Балки для склада' }).click();
    await expect(seller).toHaveURL(/\/app\/sales\/rfq\//);
    await expect(seller.getByText(ru('commerce.sales.privacyNote'))).toBeVisible();
    await hydrated(seller);
    await seller.getByRole('button', { name: ru('commerce.sales.prepare') }).click();
    await confirm(seller, ru('commerce.sales.prepare'));
    await expect(seller).toHaveURL(/\/app\/sales\/quotes\/[^/?]+/);
    quoteUrl = new URL(seller.url()).pathname;
    await hydrated(seller);
    await seller.getByLabel(ru('commerce.quote.unitPrice', { n: 1, currency: 'UZS' }), { exact: true }).fill('950000');
    await seller.getByLabel(ru('commerce.quote.floor', { n: 1 }), { exact: true }).fill('900000');
    await seller.getByLabel(ru('commerce.quote.unitPrice', { n: 2, currency: 'UZS' }), { exact: true }).fill('500000');
    await seller.getByLabel(ru('commerce.quote.notes'), { exact: true }).fill(SELLER_NOTE);
    await seller.getByRole('button', { name: ru('commerce.quote.send', { version: 1 }) }).click();
    await confirm(seller, ru('commerce.quote.send', { version: 1 }));
    await expect(seller.getByText(ru('commerce.quote.sentImmutable', { version: 1, date: '@' }).split('@')[0]!)).toBeVisible();
    await shot(seller, 'web002-03-quote-sent');
    for (const path of [quoteUrl, `${quoteUrl}?tab=versions`, '/app/sales']) {
      await seller.goto(path);
      const body = await text(seller);
      expect(body, `${path}: the buyer's notes never reach the seller`).not.toContain(BUYER_NOTE);
      expect(body).not.toContain('25 000 000');
    }
  });

  await test.step('the buyer compares, then amends the request: the quote for version 1 becomes stale and not comparable', async () => {
    await buyer.goto(`${rfqUrl}?tab=compare`);
    const grid = buyer.getByRole('region', { name: ru('commerce.compare.caption', { version: 1 }) });
    await expect(grid.locator('tfoot')).not.toContainText(ru('compare.totalIncomplete'));
    expect(await text(buyer), 'the seller floor and notes never reach the buyer').not.toContain(SELLER_NOTE);
    await buyer.locator('summary', { hasText: ru('commerce.rfq.amend') }).click();
    await buyer.getByLabel(ru('commerce.rfq.amendReason'), { exact: true }).fill('Количество уточнено после расчёта');
    await buyer.getByRole('button', { name: ru('commerce.rfq.amend'), exact: true }).click();
    await confirm(buyer, ru('commerce.rfq.amend'));
    await expect(buyer.getByText(ru('commerce.versionDraft', { version: 2 })).first()).toBeVisible();
    await buyer.goto(rfqUrl);
    await expect(buyer.getByRole('link', { name: ru('commerce.versionDraft', { version: 2 }) })).toBeVisible();
    await hydrated(buyer);
    await buyer.getByLabel(ru('commerce.lines.quantity', { n: 1 }), { exact: true }).fill('12');
    await buyer.getByRole('button', { name: ru('commerce.rfq.saveDraft') }).click();
    await expect(buyer.getByText(ru('commerce.rfq.draftSaved'))).toBeVisible();
    await buyer.getByRole('button', { name: ru('commerce.rfq.publish', { version: 2 }) }).click();
    await confirm(buyer, ru('commerce.rfq.publish', { version: 2 }));
    await expect(buyer.getByText(ru('commerce.versionCurrent', { version: 2 })).first()).toBeVisible();
    await buyer.goto(`${rfqUrl}?tab=compare`);
    await expect(buyer.getByText(ru('commerce.compare.empty'))).toBeVisible();
    await expect(buyer.getByRole('heading', { name: ru('commerce.compare.historicalTitle') })).toBeVisible();
    await buyer.getByRole('link', { name: /Показать устаревшие предложения/ }).click();
    const withStale = buyer.getByRole('region', { name: ru('commerce.compare.caption', { version: 2 }) });
    await expect(withStale.locator('thead')).toContainText(ru('commerce.stale', { version: 1 }));
    await expect(withStale.locator('tfoot')).toContainText(ru('compare.totalIncomplete'));
    await expect(buyer.getByRole('button', { name: ru('commerce.accept.submit') })).toHaveCount(0);
    await shot(buyer, 'web002-04-compare-stale');
    await buyer.goto(`${rfqUrl}?tab=quotes`);
    await expect(buyer.getByText(ru('commerce.stale', { version: 1 })).first()).toBeVisible();
    // Revalidation: a new invitation pinned to version 2.
    await buyer.goto(`${rfqUrl}?tab=suppliers`);
    await hydrated(buyer);
    await buyer.getByRole('button', { name: ru('commerce.invite.revalidate') }).click();
    await confirm(buyer, ru('commerce.invite.revalidate'));
    await expect(buyer.getByText(ru('commerce.versionN', { version: 2 })).first()).toBeVisible();
  });

  await test.step('the seller sees the change and answers version 2 with a new quote version', async () => {
    await seller.goto(quoteUrl);
    await expect(seller.getByText(ru('commerce.sales.rfqChanged', { version: 2, old: 1 }))).toBeVisible();
    await hydrated(seller);
    await seller.getByRole('button', { name: ru('commerce.quote.createForNew') }).click();
    await confirm(seller, ru('commerce.quote.createForNew'));
    await expect(seller.getByLabel(ru('commerce.quote.quantity', { n: 1, unit: 't' }), { exact: true })).toHaveValue('12');
    await expect(seller.getByLabel(ru('commerce.quote.unitPrice', { n: 1, currency: 'UZS' }), { exact: true })).toHaveValue('950000.00');
    await seller.getByRole('button', { name: ru('commerce.quote.send', { version: 2 }) }).click();
    await confirm(seller, ru('commerce.quote.send', { version: 2 }));
    await expect(seller.getByText(ru('commerce.stale', { version: 1 }))).toHaveCount(0);
  });

  let agreementPath = '';
  await test.step('the buyer accepts exact terms (consent required), then the order: budget refused, unknown outcome reconciled', async () => {
    await buyer.goto(`${rfqUrl}?tab=compare`);
    const grid = buyer.getByRole('region', { name: ru('commerce.compare.caption', { version: 2 }) });
    await expect(grid.locator('tfoot')).not.toContainText(ru('compare.totalIncomplete'));
    await hydrated(buyer);
    await buyer.getByRole('button', { name: ru('commerce.accept.submit') }).click();
    await expect(buyer.getByRole('alert').filter({ hasText: ru('commerce.consent.required') })).toBeVisible();
    await buyer.getByLabel(ru('commerce.consent.label'), { exact: true }).check();
    await buyer.getByRole('button', { name: ru('commerce.accept.submit') }).click();
    const [accepted] = await Promise.all([buyer.waitForResponse((r) => r.url().endsWith('/v1/agreements') && r.request().method() === 'POST'), confirm(buyer, ru('commerce.accept.submit'))]);
    expect(accepted.status(), await accepted.text()).toBe(201);
    agreementPath = `/v1/agreements/${((await accepted.json()) as { agreement: { id: string } }).agreement.id}`;
    await expect(buyer).toHaveURL(/tab=order/);
    await expect(buyer.getByText(ru('commerce.order.immutable')).first()).toBeVisible();
    await expect(buyer.getByText(ru('commerce.order.noMandate'))).toBeVisible();

    const small = await budget(buyerId, '1000', 'UZS');
    await hydrated(buyer);
    await buyer.getByLabel(ru('commerce.order.budget'), { exact: true }).fill(small);
    await buyer.getByRole('button', { name: ru('commerce.order.place') }).click();
    await expect(buyer.getByRole('form', { name: ru('commerce.order.place') }).getByRole('alert')).toContainText(ru('commerce.order.budgetUnavailable', { reason: ru('error.commercial.budget_insufficient') }));

    const enough = await budget(buyerId, '100000000000', 'UZS');
    await buyer.getByLabel(ru('commerce.order.budget'), { exact: true }).fill(enough);
    // The API places the order but the answer never reaches the browser: the outcome is unknown.
    await buyer.route('**/v1/agreements/*/orders', async (route) => {
      await route.fetch();
      await route.abort('connectionreset');
    });
    await buyer.getByRole('button', { name: ru('commerce.order.place') }).click();
    await expect(buyer.getByText(ru('commerce.order.outcomeUnknown'))).toBeVisible();
    await expect(buyer.getByRole('button', { name: ru('commerce.order.place') })).toBeHidden();
    await shot(buyer, 'web002-05-order-outcome-unknown');
    await buyer.unroute('**/v1/agreements/*/orders');
    await buyer.getByRole('button', { name: ru('commerce.order.checkResult') }).click();
    await expect(buyer.getByText(ru('commerce.order.awaitingSeller'))).toBeVisible();
    await expect(buyer.getByText(ru('commerce.order.budgetReserved'))).toBeVisible();
    const view = (await (await buyer.request.get(agreementPath)).json()) as { orders: unknown[] };
    expect(view.orders, 'reconciliation placed no second order').toHaveLength(1);
  });

  await test.step('the seller accepts the order as a separate event; obligations follow; the reservation is never shown', async () => {
    await seller.goto(`${quoteUrl}?tab=order`);
    await expect(seller.getByRole('heading', { name: ru('commerce.sellerOrder.selected', { version: 2 }) })).toBeVisible();
    const sellerView = await (await seller.request.get(agreementPath)).text();
    for (const key of ['reservationId', 'transactionBudgetId', 'budgetCeiling', 'internalNotes']) expect(sellerView).not.toContain(key);
    await hydrated(seller);
    await seller.getByLabel(ru('commerce.consent.label'), { exact: true }).check();
    await seller.getByRole('button', { name: ru('commerce.sellerOrder.accept') }).click();
    await confirm(seller, ru('commerce.sellerOrder.accept'));
    await expect(seller.getByText(ru('commerce.status.agreement.accepted_by_both')).first()).toBeVisible();
    await expect(seller.getByRole('list', { name: ru('commerce.order.obligations') })).toBeVisible();
    expect(await text(seller)).not.toContain(BUYER_NOTE);
    await shot(seller, 'web002-06-seller-accepted');
    await buyer.goto(`${rfqUrl}?tab=order`);
    await expect(buyer.getByText(/Поставщик принял заказ/)).toBeVisible();
    await buyer.goto(`${rfqUrl}?tab=approvals`);
    await expect(buyer.getByText(ru('commerce.event.seller_accepts_order'))).toBeVisible();
    await expect(buyer.getByText(ru('commerce.event.buyer_accepts_terms'))).toBeVisible();
  });

  await test.step('denial: someone else, the other side and anonymous visitors get no access', async () => {
    const otherCtx = await context(browser);
    const other = await otherCtx.newPage();
    await verifiedAccount(other.request, 'Посторонний Человек', uniqueEmail('other'));
    expect((await other.goto(rfqUrl))?.status()).toBe(404);
    expect((await other.goto(quoteUrl))?.status()).toBe(404);
    expect((await other.goto(needUrl))?.status()).toBe(404);
    await otherCtx.close();
    expect((await buyer.goto(quoteUrl))?.status(), 'the buyer never opens the seller editor').toBe(404);
    await seller.goto(rfqUrl);
    await expect(seller, 'the seller is sent to its own view of the request').toHaveURL(/\/app\/sales\/rfq\//);
    expect(await text(seller)).not.toContain(BUYER_NOTE);
    const anonymousCtx = await context(browser);
    const anonymous = await anonymousCtx.newPage();
    await anonymous.goto(rfqUrl);
    await expect(anonymous).toHaveURL(/\/login\?next=/);
    await anonymousCtx.close();
  });

  await test.step('keyboard, screen-reader names and 375 px on the commerce screens', async () => {
    for (const path of [`${rfqUrl}?tab=compare&stale=1`, `${rfqUrl}?tab=order`, '/app/procurement']) {
      await buyer.goto(path);
      await expectAccessible(buyer);
    }
    const phoneCtx = await context(browser, { width: 375, height: 812 });
    await phoneCtx.addCookies((await buyerCtx.cookies()).filter((c) => c.name.endsWith('sr_session')));
    const phone = await phoneCtx.newPage();
    for (const [path, name] of [[`${rfqUrl}?tab=compare&stale=1`, 'compare'], [`${rfqUrl}?tab=order`, 'order'], [needUrl, 'need'], ['/app/procurement', 'list']] as const) {
      await phone.goto(path);
      await expectNoHorizontalOverflow(phone);
      await expectAccessible(phone);
      await shot(phone, `web002-phone-${name}`);
    }
    await phone.goto(rfqUrl);
    const tab = phone.getByRole('navigation', { name: ru('commerce.tabs.label') }).getByRole('link', { name: ru('commerce.tabs.approvals') });
    await tab.focus();
    await phone.keyboard.press('Enter');
    await expect(phone).toHaveURL(/tab=approvals/);
    await phoneCtx.close();
  });

  await buyerCtx.close();
  await sellerCtx.close();
});
