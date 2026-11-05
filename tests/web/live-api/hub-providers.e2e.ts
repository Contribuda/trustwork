import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { control, enrolled, inGeorgian, LANG, liveHub, staffPost, submitIn } from './console-staff.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, shot, verifiedAccount } from './support.js';

/**
 * HC-100 Providers and HC-102 Egress against the live API, in Georgian (demo mode off). Fake and manual adapters only, a
 * synthetic key, no external call. A fake connection goes from draft to enabled; a key is entered once, goes straight to the
 * write-only route and is not in the page or in any request to the web server afterwards; a manual connection is enabled
 * through a second person; a cost, a credential and an egress cell are recorded. A reader changes nothing and a participant
 * finds nothing. Sorted after `console.e2e.ts`: its staff raise the node's staff count. Every person and hub is synthetic.
 */
const SLUG = `synthetic-providers-${Date.now().toString(36)}`;
const PERMISSIONS = ['admin.hub.read', 'admin.config.edit', 'admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test', 'admin.providers.toggle', 'admin.providers.kill', 'admin.providers.egress.edit', 'admin.providers.budget.edit'];
const L = 'providers.console';
const PATH = `/admin/hubs/${SLUG}/integrations/providers`;
const CANARY = `synthetic-canary-${randomBytes(12).toString('hex')}`;

test('stewards connect providers on a live hub; a key is written once and never comes back', async ({ browser }) => {
  test.setTimeout(240_000);
  const { hubId } = await liveHub(browser, SLUG);
  const [aCtx, bCtx, readerCtx, participantCtx] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  const a = await enrolled(aCtx, 'Synthetic Providers Steward A');
  const b = await enrolled(bCtx, 'Synthetic Providers Steward B');
  const reader = await enrolled(readerCtx, 'Synthetic Providers Reader');
  // Two roles: with enough staff on the node, separation of duties asks the second person to act through a different role.
  await control('/staff', { personId: a.personId, role: 'data-steward', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: b.personId, role: 'ops-engineer', permissions: PERMISSIONS, scope: { kind: 'node' } });
  await control('/staff', { personId: reader.personId, role: 'auditor', permissions: ['admin.hub.read', 'admin.providers.read'], scope: { kind: 'node' } });
  for (const person of [a, b, reader]) await person.elevate();
  for (const ctx of [aCtx, bCtx, readerCtx, participantCtx]) await inGeorgian(ctx);

  const page = await aCtx.newPage();
  const seen: string[] = [];
  page.on('request', (request) => { if (request.postData()?.includes(CANARY)) seen.push(new URL(request.url()).pathname); });
  await page.goto(PATH);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(`${L}.title`, LANG));
  await expect(page.locator('#connections')).toContainText(msg(`${L}.none`, LANG));

  /** Actions and key entry are folded on a card; a reload folds them again. */
  const unfold = async () => page.locator('details').evaluateAll((all) => all.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  const inCard = async (adapter: string, label: string) => {
    await unfold();
    return submitIn(page, `[data-testid="connection-${adapter}"]`, label);
  };
  const add = async (label: string, adapter: string, mode: string) => {
    await page.locator('input[name="f.label"]').fill(label);
    await page.locator('input[name="f.adapterId"]').fill(adapter);
    await page.locator('select[name="f.mode"]').selectOption(mode);
    await page.locator('input[name="f.hostingCountry"]').fill('GE');
    await page.locator('input[name="f.cap.llm"]').check();
    await expect(await submitIn(page, '#connection-draft', msg(`${L}.add`, LANG))).toHaveText(msg('admin.common.applied', LANG));
    await page.reload();
  };

  // A fake connection: tested and enabled by one person.
  await add('Synthetic fake', 'synthetic_fake', 'fake');
  const fake = page.getByTestId('connection-synthetic_fake');
  await expect(fake).toContainText(msg(`${L}.neverTested`, LANG));
  await expect(fake).toContainText(msg(`${L}.secret.fake`, LANG));
  await expect(await inCard('synthetic_fake', msg(`${L}.test`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(fake).toContainText(msg('providers.testOutcomes.ok', LANG));
  await expect(await inCard('synthetic_fake', msg(`${L}.enable`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(fake).toContainText(msg(`${L}.status.enabled`, LANG));

  // A key: entered once; the page shows a fingerprint, and the value is nowhere afterwards.
  await add('Synthetic manual', 'synthetic_manual', 'manual');
  const manual = page.getByTestId('connection-synthetic_manual');
  await expect(manual).toContainText(msg(`${L}.secret.none`, LANG));
  await unfold();
  const entry = manual.locator('form[data-testid^="secret-entry-"]');
  await entry.locator('input[name="secret"]').fill(CANARY);
  await entry.getByLabel(msg('admin.common.reason', LANG)).fill('Synthetic console journey');
  await entry.getByRole('button', { name: msg(`${L}.secret.submit`, LANG) }).click();
  await expect(entry.locator('.admin-form__result')).toHaveText(msg(`${L}.secret.saved`, LANG));
  await expect(entry.locator('input[name="secret"]')).toHaveValue('');
  await expect(manual.locator('[data-testid^="secret-versions-"]')).toContainText(msg('providers.secretStatus.active', LANG));
  await expect(manual.locator('[data-testid^="secret-versions-"] code')).toHaveText(/^[a-f0-9]{12}$/);
  expect(await page.content()).not.toContain(CANARY);
  await page.reload();
  expect(await page.content()).not.toContain(CANARY);
  const hubPath = `/v1/admin/hubs/${hubId}/providers`;
  const listed = await (await aCtx.request.get(`${hubPath}/connections`)).text();
  expect(listed).not.toContain(CANARY);
  expect(seen.length).toBe(1);
  expect(seen[0]).toMatch(new RegExp(`^${hubPath}/connections/[0-9a-f-]+/secret$`));
  await expectAccessible(page);

  // A second person enables it: A tests and asks, B approves, A finishes.
  await expect(await inCard('synthetic_manual', msg(`${L}.test`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(await inCard('synthetic_manual', msg(`${L}.ask`, LANG))).toContainText(msg('admin.approvals.actions.providers.enable_non_fake', LANG));
  await page.reload();
  await expect(manual).toContainText(msg(`${L}.waiting`, LANG));
  await shot(page, 'providers-01-waiting-ka');
  const list = (await (await bCtx.request.get(`/v1/admin/approvals?hubId=${hubId}`)).json()) as { forMe: Array<{ id: string; action: string; actionDigest: string }> };
  const request = list.forMe.find((r) => r.action === 'providers.enable_non_fake')!;
  await staffPost(bCtx.request, `/v1/admin/approvals/${request.id}/approve`, { actionDigest: request.actionDigest });
  await page.reload();
  await expect(await inCard('synthetic_manual', msg(`${L}.enable`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(manual).toContainText(msg(`${L}.status.enabled`, LANG));

  // A kill switch stops it at once.
  await expect(await inCard('synthetic_manual', msg(`${L}.killEngage`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(manual).toContainText(msg(`${L}.status.killed`, LANG));

  // A credential by name, and a model cost.
  await page.locator('input[name="f.credProvider"]').fill('synthetic_register');
  await page.locator('input[name="f.credAdapter"]').fill('synthetic_register_api');
  await page.locator('select[name="f.credMode"]').selectOption('fake');
  await page.locator('input[name="f.credRef"]').fill('env:SYNTHETIC_REGISTER');
  await expect(await submitIn(page, '#credential-register', msg(`${L}.credentials.register`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(page.getByTestId('credential-synthetic_register')).toContainText('env:SYNTHETIC_REGISTER');
  await page.locator('input[name="f.priceModel"]').fill('synthetic-model-1');
  await page.locator('input[name="f.priceInput"]').fill('3');
  await expect(await submitIn(page, '#cost-record', msg(`${L}.costs.record`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(page.getByTestId('model-costs-table')).toContainText('synthetic-model-1');
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await shot(page, 'providers-02-page-ka');
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expectNoHorizontalOverflow(page);
  await manual.scrollIntoViewIfNeeded();
  await shot(page, 'providers-03-phone-ka');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Egress: public by one person, and the review the launch checklist reads goes to a second person.
  await page.goto(`/admin/hubs/${SLUG}/integrations/egress`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg(`${L}.egress.title`, LANG));
  await expect(page.getByTestId('egress-sentence')).toHaveText(msg(`${L}.egress.reachesNothing`, LANG));
  await page.locator('select[name="f.egressClass"]').selectOption('public');
  await page.locator('select[name="f.egressDecision"]').selectOption('allow');
  await expect(await submitIn(page, '#egress-cell', msg(`${L}.egress.change`, LANG))).toHaveText(msg('admin.common.applied', LANG));
  await expect(await submitIn(page, '#egress-review', msg(`${L}.egress.signOff`, LANG))).toContainText(msg('admin.approvals.actions.egress.allow_private_class', LANG));
  await page.reload();
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await shot(page, 'providers-04-egress-ka');

  // A reader sees the section with read-only forms and no key entry; a participant finds nothing.
  const readerPage = await readerCtx.newPage();
  await readerPage.goto(PATH);
  await expect(readerPage.getByTestId('connection-synthetic_manual')).toBeVisible();
  await expect(readerPage.locator('#connection-draft form button[type="submit"]')).toBeDisabled();
  await readerPage.locator('details').evaluateAll((all) => all.forEach((d) => { (d as HTMLDetailsElement).open = true; }));
  await expect(readerPage.getByTestId('connection-synthetic_manual').locator('form[data-testid^="secret-entry-"] button[type="submit"]')).toBeDisabled();
  expect(await readerPage.content()).not.toContain(CANARY);
  await verifiedAccount(participantCtx.request, 'Synthetic Providers Participant');
  const participantPage = await participantCtx.newPage();
  expect((await participantPage.goto(PATH))?.status()).toBe(404);
});
