import { expect, test } from '@playwright/test';
import { control, enrolled, inGeorgian, LANG, liveHub, staffPost, submitIn } from './console-staff.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, shot, verifiedAccount } from './support.js';

/**
 * HC-91 Prices against the live API, in Georgian (demo mode off). On a hub the deployment does not serve the screen shows
 * nothing; once the API serves the hub, one steward drafts a commission fee, another asks a second person, the drafter
 * approves and the person who asked activates it, and the fee reaches the public price page. A usage price shows cost, sale
 * and margin. A reader sees what their permission allows and changes nothing; a participant finds nothing. Key states pass
 * axe and fit 1280 and 375 px. The billing routes act for the served hub, so the journey restarts the API for its own hub
 * and restores it afterwards. This file sorts after `console.e2e.ts` on purpose: its staff raise the node's staff count, and
 * those journeys approve within one role. Every person, hub and amount is synthetic.
 */
const SLUG = `synthetic-prices-${Date.now().toString(36)}`;
const PERMISSIONS = ['admin.hub.read', 'admin.billing.fees.draft', 'admin.billing.fees.activate', 'admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.usage.read'];
const L = 'admin.billing.prices.live';
const PATH = `/admin/hubs/${SLUG}/billing/prices`;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('two stewards put a commission fee and a usage price live; a reader and a participant cannot', async ({ browser }) => {
  test.setTimeout(240_000);
  const { hubId } = await liveHub(browser, SLUG);
  const [aCtx, bCtx, readerCtx, participantCtx] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  const a = await enrolled(aCtx, 'Synthetic Prices Steward A');
  const b = await enrolled(bCtx, 'Synthetic Prices Steward B');
  const reader = await enrolled(readerCtx, 'Synthetic Prices Reader');
  // Two roles: with enough staff on the node, separation of duties asks the second person to act through a different role.
  await control('/staff', { personId: a.personId, role: 'data-steward', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: b.personId, role: 'ops-engineer', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: reader.personId, role: 'auditor', permissions: ['admin.hub.read', 'admin.commerce.usage.read'], scope: { kind: 'node' } });
  for (const person of [a, b, reader]) await person.elevate();
  for (const ctx of [aCtx, bCtx, readerCtx, participantCtx]) await inGeorgian(ctx);

  // This deployment serves no hub yet: nothing is shown and no form exists.
  const page = await aCtx.newPage();
  await page.goto(PATH);
  await expect(page.getByTestId('prices-not-served')).toHaveText(msg(`${L}.notServed`, LANG));
  await expect(page.locator('#fee-draft')).toHaveCount(0);

  await control('/serving-hub', { hubId });
  try {
    // Steward A drafts a commission fee.
    await page.reload();
    await expect(page.locator('#fees')).toContainText(msg(`${L}.noFees`, LANG));
    await page.locator('select[name="f.feeKind"]').selectOption('consultation');
    await page.locator('select[name="f.feePayer"]').selectOption('seller');
    await page.locator('input[name="f.feePercent"]').fill('12.5');
    await page.locator('input[name="f.feeEffectiveFrom"]').fill(inDays(1));
    await page.locator('input[name="f.feeAcceptance"]').fill('synthetic-fees-1');
    await expect(await submitIn(page, '#fee-draft', msg(`${L}.feeDraft`, LANG))).toHaveText(msg('admin.common.applied', LANG));
    await page.reload();
    const fee = page.getByTestId('fee-consultation-1');
    await expect(fee).toContainText('12,5');
    await expect(fee).toContainText(msg(`${L}.drafterNote`, LANG));
    await expect(fee.getByRole('button')).toHaveCount(0);
    await expectAccessible(page);

    // Steward B asks a second person; the drafter approves; only the person who asked activates.
    const pageB = await bCtx.newPage();
    await pageB.goto(PATH);
    await expect(await submitIn(pageB, '[data-testid="fee-consultation-1"]', msg(`${L}.ask`, LANG))).toContainText(msg('admin.approvals.actions.billing.activate_fee_version', LANG));
    await page.reload();
    await expect(fee).toContainText(msg(`${L}.waiting`, LANG));
    await shot(page, 'prices-01-waiting-ka');
    const approvals = (await (await aCtx.request.get(`/v1/admin/approvals?hubId=${hubId}`)).json()) as { forMe: Array<{ id: string; action: string; actionDigest: string }> };
    const request = approvals.forMe.find((r) => r.action === 'billing.activate_fee_version')!;
    await staffPost(aCtx.request, `/v1/admin/approvals/${request.id}/approve`, { actionDigest: request.actionDigest });
    await page.reload();
    await expect(fee).toContainText(msg(`${L}.approvedForOther`, LANG));
    await pageB.reload();
    await expect(await submitIn(pageB, '[data-testid="fee-consultation-1"]', msg(`${L}.activate`, LANG))).toHaveText(msg('admin.common.applied', LANG));
    const pricing = (await (await aCtx.request.get('/v1/pricing')).json()) as { hubId: string; fees: Array<{ terms: { basisPoints: number } }> };
    expect(pricing.hubId).toBe(hubId);
    expect(pricing.fees.map((f) => f.terms.basisPoints)).toEqual([1250]);

    // A usage price: the cost first, then a markup the engine computes.
    await page.reload();
    await page.locator('select[name="f.costSubject"]').selectOption('meter');
    await page.locator('select[name="f.costMeter"]').selectOption('checks');
    await page.locator('input[name="f.costPerUnit"]').fill('3.25');
    await expect(await submitIn(page, '#cost-record', msg(`${L}.costRecord`, LANG))).toHaveText(msg('admin.common.applied', LANG));
    await page.locator('select[name="f.usageSubject"]').selectOption('meter');
    await page.locator('select[name="f.usageMeter"]').selectOption('checks');
    await page.locator('select[name="f.usageBasis"]').selectOption('markup');
    await page.locator('input[name="f.usagePercent"]').fill('100');
    await page.locator('input[name="f.usageEffectiveFrom"]').fill(inDays(1));
    await page.locator('input[name="f.usageAcceptance"]').fill('synthetic-usage-1');
    await expect(await submitIn(page, '#usage-draft', msg('admin.billing.prices.draft', LANG))).toHaveText(msg('admin.common.applied', LANG));
    await page.reload();
    const usage = page.getByTestId('usage-checks-1');
    await expect(usage).toContainText(msg('admin.product.margin', LANG));
    await expect(usage).toContainText(msg(`${L}.drafterNote`, LANG));
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
    await shot(page, 'prices-02-usage-ka');
    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload();
    await expectNoHorizontalOverflow(page);
    await page.locator('#fees').scrollIntoViewIfNeeded();
    await shot(page, 'prices-03-phone-ka');

    // A reader of usage sees the usage prices, with no form to use, and is told the rest is hidden.
    const readerPage = await readerCtx.newPage();
    await readerPage.goto(PATH);
    await expect(readerPage.getByTestId('fees-hidden')).toHaveText(msg(`${L}.feesHidden`, LANG));
    await expect(readerPage.getByTestId('sales-hidden')).toHaveText(msg(`${L}.salesHidden`, LANG));
    await expect(readerPage.getByTestId('usage-checks-1')).toBeVisible();
    await expect(readerPage.locator('#usage-draft form button[type="submit"]')).toBeDisabled();

    // A participant finds nothing.
    await verifiedAccount(participantCtx.request, 'Synthetic Prices Participant');
    const participantPage = await participantCtx.newPage();
    expect((await participantPage.goto(PATH))?.status()).toBe(404);
  } finally {
    await control('/serving-hub', { hubId: null });
  }
});
