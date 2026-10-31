import { expect, test, type Page } from '@playwright/test';
import { WEB_ORIGIN } from './ports.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, SAME_ORIGIN, shot, verifiedAccount } from './support.js';

/**
 * PPL-001 on the live API in the Russian interface: the "My page" public editor publishes a profile only as a consent,
 * the person page shows exactly the consented public parts with the self-declared experience label, and hiding the
 * profile withdraws the consent and removes the page for every visitor at once.
 */
async function publicTab(page: Page): Promise<void> {
  await page.goto('/app/me');
  await page.getByRole('tab', { name: msg('me.tabs.publicProfile') }).click();
  await expect(page.getByText(msg('me.public.liveNote'))).toBeVisible();
}

test('the public profile exists only with consent and disappears when it is withdrawn', async ({ page, browser }) => {
  const { personId } = await verifiedAccount(page.request, 'Profile Dilnoza');
  await publicTab(page);
  // Nothing is public before the person publishes.
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  expect((await visitor.goto(`${WEB_ORIGIN}/people/${personId}`))?.status()).toBe(404);

  await page.getByLabel(msg('onboarding3.who.headline')).fill('Roofing estimator');
  await page.getByText(msg('onboarding3.profile.publish'), { exact: true }).click();
  await expect(page.getByText(msg('me.public.notice.profilePublic'))).toBeVisible();
  await page.getByRole('button', { name: msg('common.save'), exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: msg('common.saved') })).toBeVisible();
  await expectAccessible(page);
  await shot(page, '20-me-public-profile-ru');

  // Experience has no editor yet: declared through the API, shown as self-declared.
  const entry = await page.request.post('/v1/me/experience', {
    headers: { ...SAME_ORIGIN, 'Idempotency-Key': `e2e-exp-${Date.now()}` },
    data: { organisation: { companyId: null, name: 'Demo Roofing LLC' }, role: 'Estimator', summary: null, from: '2024-01-01', to: null, visibility: 'public' },
  });
  expect(entry.status(), await entry.text()).toBe(201);
  const consents = (await (await page.request.get('/v1/me/consents')).json()) as { items: { purpose: string; withdrawnAt: string | null; noticeVersion: string }[] };
  expect(consents.items.filter((c) => c.purpose === 'profile_public' && c.withdrawnAt === null).map((c) => c.noticeVersion)).toEqual(['profile_public.v1']);

  expect((await visitor.goto(`${WEB_ORIGIN}/people/${personId}`))?.status()).toBe(200);
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('Profile Dilnoza');
  await expect(visitor.getByText('Demo Roofing LLC')).toBeVisible();
  await expect(visitor.getByText(msg('personPage.selfDeclared'))).toBeVisible();
  await expectAccessible(visitor);
  await shot(visitor, '21-person-page-consented-ru');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  const mobile = await phone.newPage();
  await mobile.goto(`${WEB_ORIGIN}/people/${personId}`);
  await expectNoHorizontalOverflow(mobile);
  await shot(mobile, '22-person-page-consented-phone-ru');
  await phone.close();

  // Hiding withdraws the consent: the page is gone for everyone in the same request.
  await publicTab(page);
  await page.getByText(msg('onboarding3.profile.publish'), { exact: true }).click();
  await page.getByRole('button', { name: msg('common.save'), exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: msg('common.saved') })).toBeVisible();
  expect((await visitor.goto(`${WEB_ORIGIN}/people/${personId}`))?.status()).toBe(404);
  const after = (await (await page.request.get('/v1/me/consents')).json()) as { items: { purpose: string; withdrawnAt: string | null }[] };
  expect(after.items.filter((c) => c.purpose === 'profile_public').every((c) => c.withdrawnAt !== null)).toBe(true);
  await anonymous.close();
});
