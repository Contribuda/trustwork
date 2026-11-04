import { expect, test } from '@playwright/test';
import { control, enrolled, inGeorgian, LANG, liveHub, staffPost, submitIn } from './console-staff.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, SAME_ORIGIN, shot, verifiedAccount } from './support.js';

/**
 * HC-22 Claims against the live API, in Georgian (demo mode off). A reviewer sees the country rule on each claim, records and
 * binds the checks and approves; a company with no country cannot be decided until a holder of the authority permission
 * corrects it; a reader decides nothing and a participant finds nothing. Key states pass axe and fit 1280 and 375 px. Sorted
 * after `console.e2e.ts`: its staff raise the node's staff count. Every person, hub and company is synthetic.
 */
const SLUG = `synthetic-claims-${Date.now().toString(36)}`;
const REVIEWER = ['admin.hub.read', 'admin.claims.read', 'admin.claims.decide', 'admin.claims.policy.edit'];
const L = 'adminParticipants.claims.live';
const PATH = `/admin/hubs/${SLUG}/participants/claims`;

test('a reviewer decides a claim with the country rule in view; a company with no country waits for a correction', async ({ browser }) => {
  test.setTimeout(240_000);
  const { hubId } = await liveHub(browser, SLUG);
  const [reviewerCtx, stewardCtx, readerCtx, claimantCtx, secondClaimantCtx] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  const reviewer = await enrolled(reviewerCtx, 'Synthetic Claims Reviewer');
  const steward = await enrolled(stewardCtx, 'Synthetic Claims Steward');
  const reader = await enrolled(readerCtx, 'Synthetic Claims Reader');
  await control('/staff', { personId: reviewer.personId, role: 'trust-reviewer', permissions: REVIEWER, scope: { kind: 'node' } });
  await control('/staff', { personId: steward.personId, role: 'data-steward', permissions: ['admin.hub.read', 'admin.claims.read', 'admin.claims.authority.decide'], scope: { kind: 'node' } });
  await control('/staff', { personId: reader.personId, role: 'auditor', permissions: ['admin.hub.read', 'admin.claims.read'], scope: { kind: 'node' } });
  for (const person of [reviewer, steward, reader]) await person.elevate();
  for (const ctx of [reviewerCtx, stewardCtx, readerCtx, claimantCtx]) await inGeorgian(ctx);

  // The hub's recipe and a manual provider, configured through the API (HC-23 has its own journey).
  const base = `/v1/admin/hubs/${hubId}`;
  const drafted = await staffPost(reviewerCtx.request, `${base}/verification/recipes`, {
    key: 'company-verified', subjectKind: 'company', trigger: 'claim_verified', recheckMonths: 12, badgeCategories: ['register_record_matches'], steps: [{ check: 'register_match', required: true }, { check: 'sanctions_screening', required: true }],
  });
  const recipe = drafted.recipe as { id: string; revision: number };
  await staffPost(reviewerCtx.request, `${base}/verification/recipes/${recipe.id}/activate`, { expectedRevision: recipe.revision });
  await staffPost(reviewerCtx.request, `${base}/verification/providers`, { checkType: 'register_match', adapter: 'synthetic_register', mode: 'manual', retentionDays: 365, legalBasis: 'statutory_public_register', costMinor: null });

  // Two unclaimed pages, one with a country and one without, and a claimant for each.
  const covered = (await control('/company', { name: 'Synthetic Covered Builders', country: 'GE' })).id as string;
  const unknown = (await control('/company', { name: 'Synthetic Unplaced Builders', country: null })).id as string;
  const claimant = await verifiedAccount(claimantCtx.request, 'Synthetic Claimant One');
  const second = await verifiedAccount(secondClaimantCtx.request, 'Synthetic Claimant Two');
  await control('/screen', {});
  const submit = async (ctx: typeof claimantCtx, companyId: string) => {
    const response = await ctx.request.post('/v1/claims', { headers: { ...SAME_ORIGIN, 'Idempotency-Key': `claim-${companyId}` }, data: { hubId, companyId, level: 'verified', recipeId: recipe.id, tie: null } });
    expect(response.status(), await response.text()).toBe(201);
    return ((await response.json()) as { claim: { id: string } }).claim.id;
  };
  const page = await reviewerCtx.newPage();
  await page.goto(PATH);
  await expect(page.locator('#queue')).toContainText(msg('adminParticipants.claims.empty', LANG));
  const claimId = await submit(claimantCtx, covered);
  const secondId = await submit(secondClaimantCtx, unknown);
  expect(claimant.personId).not.toBe(second.personId);

  const unfold = async () => page.locator('details').evaluateAll((all) => all.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  await page.reload();
  const card = page.getByTestId(`live-claim-${claimId}`);
  const missing = page.getByTestId(`live-claim-${secondId}`);
  await expect(card).toContainText('Synthetic Covered Builders');
  await expect(card.getByTestId('claim-territory-covered')).toContainText(msg(`${L}.territory.covered`, LANG));
  await expect(missing.getByTestId('claim-territory-missing')).toHaveText(msg(`${L}.territory.missing`, LANG));
  await expect(missing.getByRole('button', { name: msg('adminParticipants.claims.decide', LANG), exact: true })).toBeDisabled();
  await expectAccessible(page);
  await shot(page, 'claims-01-queue-ka');

  // Evidence: recorded after the claim, bound to it, then the decision.
  await unfold();
  const scope = `[data-testid="live-claim-${claimId}"]`;
  await card.locator('input[name="f.evidenceRef"]').fill('register:SYN-GE-1');
  await expect(await submitIn(page, scope, msg('adminParticipants.claims.recordCheck', LANG))).toHaveText(msg('admin.common.applied', LANG));
  await expect(await submitIn(page, scope, msg(`${L}.evidence.screening`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await unfold();
  for (const box of await card.locator('input[name^="f.check."]').all()) await box.check();
  await expect(await submitIn(page, scope, msg(`${L}.evidence.bind`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(card).toContainText(msg(`${L}.standing.passed`, LANG));
  await card.locator('select[name="f.decision"]').selectOption('approved');
  await expect(await submitIn(page, scope, msg('adminParticipants.claims.decide', LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(page.locator('#decided')).toContainText('Synthetic Covered Builders');
  await expect(page.locator('#decided')).toContainText(msg(`${L}.states.approved`, LANG));

  // A reviewer does not correct a country; a holder of the authority permission does, and the claim can then be decided.
  await unfold();
  await expect(missing.getByRole('button', { name: msg(`${L}.correct.submit`, LANG), exact: true })).toBeDisabled();
  const stewardPage = await stewardCtx.newPage();
  await stewardPage.goto(PATH);
  await stewardPage.locator('details').evaluateAll((all) => all.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  await stewardPage.getByTestId(`live-claim-${secondId}`).locator('input[name="f.country"]').fill('GE');
  await expect(await submitIn(stewardPage, `[data-testid="live-claim-${secondId}"]`, msg(`${L}.correct.submit`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(missing.getByTestId('claim-territory-covered')).toBeVisible();
  await expect(missing.getByRole('button', { name: msg('adminParticipants.claims.decide', LANG), exact: true })).toBeEnabled();
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await shot(page, 'claims-02-corrected-ka');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expectNoHorizontalOverflow(page);
  await missing.scrollIntoViewIfNeeded();
  await shot(page, 'claims-03-phone-ka');

  // A reader sees the queue and decides nothing; a participant finds nothing.
  const readerPage = await readerCtx.newPage();
  await readerPage.goto(PATH);
  await expect(readerPage.getByTestId(`live-claim-${secondId}`).getByRole('button', { name: msg('adminParticipants.claims.decide', LANG), exact: true })).toBeDisabled();
  const claimantPage = await claimantCtx.newPage();
  expect((await claimantPage.goto(PATH))?.status()).toBe(404);
});
