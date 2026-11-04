import { expect, test } from '@playwright/test';
import { control, enrolled, inGeorgian, LANG, liveHub, staffPost, submitIn } from './console-staff.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, shot, verifiedAccount } from './support.js';

/**
 * HC-23 Verification against the live API, in Georgian (demo mode off): a steward drafts and activates a recipe, records
 * it for the launch checklist, registers a provider and sets the claim periods; a provider goes live through a second
 * person; a reader sees everything and can change nothing; a participant finds nothing. Key states pass axe and fit 1280
 * and 375 px. This file sorts after `console.e2e.ts` on purpose: its staff raise the node's staff count, and those journeys
 * approve within one role. Every person and hub is synthetic.
 */
const SLUG = `synthetic-verification-${Date.now().toString(36)}`;
const PERMISSIONS = ['admin.hub.read', 'admin.claims.read', 'admin.claims.policy.edit', 'admin.config.edit', 'admin.providers.toggle', 'admin.providers.secret.write'];
const L = 'adminParticipants.verification.live';
const PATH = `/admin/hubs/${SLUG}/participants/verification`;

test('a steward configures verification on a live hub; a second person is needed to go live', async ({ browser }) => {
  test.setTimeout(240_000);
  const { hubId } = await liveHub(browser, SLUG);
  const [aCtx, bCtx, readerCtx, participantCtx] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  const a = await enrolled(aCtx, 'Synthetic Verification Steward A');
  const b = await enrolled(bCtx, 'Synthetic Verification Steward B');
  const reader = await enrolled(readerCtx, 'Synthetic Verification Reader');
  // Two roles: with enough staff on the node, separation of duties asks the second person to act through a different role.
  await control('/staff', { personId: a.personId, role: 'data-steward', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: b.personId, role: 'ops-engineer', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: reader.personId, role: 'auditor', permissions: ['admin.hub.read', 'admin.claims.read'], scope: { kind: 'node' } });
  for (const person of [a, b, reader]) await person.elevate();
  for (const ctx of [aCtx, bCtx, readerCtx, participantCtx]) await inGeorgian(ctx);

  // Empty: the page says so and nothing is invented.
  const page = await aCtx.newPage();
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('adminParticipants.verification.title', LANG));
  await expect(page.locator('#recipes')).toContainText(msg('adminParticipants.verification.noRecipes', LANG));
  await expect(page.getByTestId('launch-record-state')).toHaveText(msg(`${L}.launch.none`, LANG));
  await expect(page.locator('#launch-record')).toContainText(msg(`${L}.launch.noActive`, LANG));

  // A recipe: drafted in the form, sanctions screening fixed, then activated.
  await page.locator('input[name="f.key"]').fill('company-verified');
  await page.locator('select[name="f.trigger"]').selectOption('claim_verified');
  await page.locator('input[name="f.categories"]').fill('register_record_matches, sanctions_screening_clear');
  await page.locator('select[name="f.step.register_match"]').selectOption('required');
  await page.locator('select[name="f.step.officer_match"]').selectOption('any');
  await page.locator('select[name="f.step.signed_authority"]').selectOption('any');
  await expect(page.getByTestId('sanctions-fixed')).toBeVisible();
  await expect(await submitIn(page, '#recipe-draft', msg(`${L}.draft.submit`, LANG))).toHaveText(msg('admin.common.applied', LANG));

  await page.reload();
  const card = page.getByTestId('live-recipe-company-verified-1');
  await expect(card).toContainText(msg(`${L}.states.draft`, LANG));
  await expect(card).toContainText(msg(`${L}.checks.sanctions_screening`, LANG));
  await expectAccessible(page);
  await expect(await submitIn(page, '[data-testid="live-recipe-company-verified-1"]', msg(`${L}.recipes.activate`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(card).toContainText(msg(`${L}.states.active`, LANG));

  // The launch checklist reads the hub's verification configuration: recording it moves the gate.
  const gate = async () => {
    const body = (await (await aCtx.request.get(`/v1/admin/hubs/${hubId}/launch`)).json()) as { gates: Array<{ gate: string; engineConfirms: boolean }> };
    return body.gates.find((g) => g.gate === 'verification_recipe_enabled')?.engineConfirms;
  };
  expect(await gate()).toBe(false);
  await expect(await submitIn(page, '#launch-record', msg(`${L}.launch.record`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  expect(await gate()).toBe(true);
  await page.reload();
  await expect(page.locator('#launch-record')).toContainText(msg(`${L}.launch.state.current`, LANG));

  // A manual provider and the claim periods.
  await page.locator('select[name="f.checkType"]').selectOption('register_match');
  await page.locator('input[name="f.adapter"]').fill('synthetic_register');
  await page.locator('select[name="f.mode"]').selectOption('manual');
  await page.locator('select[name="f.legalBasis"]').selectOption('statutory_public_register');
  await page.locator('input[name="f.costMinor"]').fill('250');
  await expect(await submitIn(page, '#provider-register', msg(`${L}.providers.register`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.locator('input[name="f.waitingDays"]').fill('10');
  await expect(await submitIn(page, '#claim-periods', msg(`${L}.claims.save`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(page.getByTestId('live-providers')).toContainText('synthetic_register');
  await expect(page.locator('input[name="f.waitingDays"]')).toHaveValue('10');
  await expect(page.locator('#go-live')).toContainText(msg(`${L}.goLive.noCredentials`, LANG));
  await shot(page, 'verification-01-configured-ka');

  // Live mode: a hub credential first (KEYS-001 has no console screen yet), then a second person for this provider.
  const registered = await staffPost(aCtx.request, `/v1/admin/hubs/${hubId}/credentials`, { provider: 'synthetic_register', adapter: 'synthetic_register_api', mode: 'live', secret: { store: 'env', ref: 'env:SYNTHETIC_REGISTER' } });
  const credential = registered.credential as { id: string; activation: { actionDigest: string } };
  const scope = { kind: 'hub', hubId };
  const asked = await staffPost(aCtx.request, '/v1/admin/approvals', { subject: { action: 'providers.enable_non_fake', scope, actionDigest: credential.activation.actionDigest } });
  await staffPost(bCtx.request, `/v1/admin/approvals/${(asked.approval as { id: string }).id}/approve`, { actionDigest: credential.activation.actionDigest });
  await staffPost(aCtx.request, `/v1/admin/hubs/${hubId}/credentials/${credential.id}/activate`, { approvalId: (asked.approval as { id: string }).id });

  await page.reload();
  await expect(await submitIn(page, '#go-live', msg(`${L}.goLive.ask`, LANG))).toContainText(msg('admin.approvals.actions.providers.enable_non_fake', LANG));
  await page.reload();
  await expect(page.locator('#go-live')).toContainText(msg(`${L}.goLive.waiting`, LANG));
  await expectAccessible(page);
  await shot(page, 'verification-02-waiting-ka');

  const approvals = (await (await bCtx.request.get(`/v1/admin/approvals?hubId=${hubId}`)).json()) as { forMe: Array<{ id: string; action: string; actionDigest: string }> };
  const request = approvals.forMe.find((r) => r.action === 'providers.enable_non_fake')!;
  await staffPost(bCtx.request, `/v1/admin/approvals/${request.id}/approve`, { actionDigest: request.actionDigest });

  // The approver sees that it is taken; only the requester finishes it.
  const pageB = await bCtx.newPage();
  await pageB.goto(PATH);
  await expect(pageB.locator('#go-live')).toContainText(msg(`${L}.goLive.approvedForOther`, LANG));
  await page.reload();
  await expect(await submitIn(page, '#go-live', msg(`${L}.goLive.apply`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(page.getByTestId('live-providers')).toContainText(msg(`${L}.modes.live`, LANG));
  await expect(page.locator('#go-live')).toHaveCount(0);
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await shot(page, 'verification-03-live-ka');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expectNoHorizontalOverflow(page);
  await shot(page, 'verification-04-phone-ka');

  // A reader sees the section and every form is read-only.
  const readerPage = await readerCtx.newPage();
  await readerPage.goto(PATH);
  await expect(readerPage.getByTestId('live-recipe-company-verified-1')).toBeVisible();
  await expect(readerPage.locator('#recipe-draft form button[type="submit"]')).toBeDisabled();
  await expect(readerPage.locator('#claim-periods')).toContainText(msg('admin.common.readOnly', LANG));

  // A participant finds nothing.
  await verifiedAccount(participantCtx.request, 'Synthetic Verification Participant');
  const participantPage = await participantCtx.newPage();
  expect((await participantPage.goto(PATH))?.status()).toBe(404);
  await expect(participantPage.getByText('company-verified')).toHaveCount(0);
});
