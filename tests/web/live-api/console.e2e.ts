import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { HUBS } from '../../../apps/web/app/admin/_fixtures/hubs.js';
import { CONTROL_ORIGIN, WEB_ORIGIN } from './ports.js';
import { expectAccessible, expectNoHorizontalOverflow, msg, PASSWORD, SAME_ORIGIN, shot, verifiedAccount } from './support.js';

/**
 * HUBC-007 browser plan against the live API (demo mode off): a node operator creates a hub through the API; two hub
 * staff members configure it in the console in Georgian (modes saved and applied; a data residency change saved as a
 * draft by A, whose activation B requests, A approves and B applies, since the drafter never activates a sensitive
 * version and nobody approves their own request); a participant finds nothing, and an unelevated staff session
 * confirms its second factor in the console before it sees anything; staff invitations go from the console to the
 * invited person's workspace and back, a sensitive role through a second person; key screens pass axe and fit 1280,
 * 768 and 375 px; residency and the overview read back from the API. Every person and hub is synthetic.
 */

const LANG = 'ka' as const;
const SLUG = `synthetic-console-${Date.now().toString(36)}`;
const HUB_PERMISSIONS = [
  'admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.modes.edit', 'admin.hub.residency.edit', 'admin.hub.legal.edit', 'admin.config.edit', 'admin.hub.lifecycle.request', 'admin.hub.launch.check',
  'admin.staff.read',
];

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of text.replace(/=+$/, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
}
function totpAt(secretBase32: string, ms: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(ms / 30_000)));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function control(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${CONTROL_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** A staff mutation outside the browser UI: same origin, CSRF header and an idempotency key in header and body. */
async function staffPost(request: APIRequestContext, path: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = randomUUID();
  const response = await request.post(path, {
    headers: { ...SAME_ORIGIN, 'Idempotency-Key': key },
    data: { contractVersion: '1.0.0', idempotencyKey: key, reason: 'Synthetic console journey', ...data },
  });
  expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

/** Enrols a second factor for the signed-in person; `elevate` then opens an elevated staff session with a fresh code. */
async function secondFactor(context: BrowserContext): Promise<{ secret: string; elevate: () => Promise<void> }> {
  const stepUp = async () => expect((await context.request.post('/v1/auth/step-up', { headers: SAME_ORIGIN, data: { password: PASSWORD } })).status()).toBe(200);
  await stepUp();
  const started = await context.request.post('/v1/me/second-factor/totp', { headers: SAME_ORIGIN });
  expect(started.status(), await started.text()).toBe(201);
  const { factorId, secret } = (await started.json()) as { factorId: string; secret: string };
  const confirmed = await context.request.post('/v1/me/second-factor/totp/confirm', { headers: SAME_ORIGIN, data: { factorId, code: totpAt(secret, Date.now()) } });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  return {
    secret,
    elevate: async () => {
      await stepUp();
      const elevated = await context.request.post('/v1/admin/session/elevate', { headers: SAME_ORIGIN, data: { proof: { method: 'totp', code: totpAt(secret, Date.now() + 30_000) } } });
      expect(elevated.status(), await elevated.text()).toBe(200);
    },
  };
}

/** A signed-in person with a second factor. */
async function enrolled(context: BrowserContext, name: string): Promise<{ personId: string; email: string; secret: string; elevate: () => Promise<void> }> {
  const { personId, email } = await verifiedAccount(context.request, name);
  return { personId, email, ...(await secondFactor(context)) };
}

async function inGeorgian(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'trustwork.country', value: 'GE', url: WEB_ORIGIN },
    { name: 'trustwork.locale', value: LANG, url: WEB_ORIGIN },
  ]);
}

/** Fills the visible console form's reason and submits it; returns the form's status line. */
async function submit(page: Page, panelId: string, submitLabel: string) {
  const form = page.locator(`#${panelId} form`).first();
  await form.getByLabel(msg('admin.common.reason', LANG)).fill('Synthetic console journey');
  await form.getByRole('button', { name: submitLabel }).click();
  return form.locator('.admin-form__result');
}

test('the console configures a live hub: modes applied, a residency draft activated by two other hands', async ({ browser }) => {
  test.setTimeout(240_000);
  // A node operator creates the hub through the API.
  const operatorCtx = await browser.newContext();
  const operator = await enrolled(operatorCtx, 'Synthetic Node Operator');
  await control('/staff', { personId: operator.personId, role: 'ops-engineer', permissions: ['admin.node.hubs.manage'], scope: { kind: 'node' } });
  await operator.elevate();
  const created = await staffPost(operatorCtx.request, '/v1/admin/hubs', {
    slug: SLUG, name: { ka: 'სინთეზური ჰაბი', en: 'Synthetic Console Hub' }, defaultLocale: 'ka', locales: ['ka', 'en'], timeZone: 'Asia/Tbilisi', currency: 'GEL', countryPack: null,
    territories: [{ level: 'country', code: 'GE' }],
  });
  const hubId = (created.result as { objectId: string }).objectId;

  // Two node staff members who manage the node's hubs (each the other's second person). A hub-scoped role counts only
  // in the deployment that serves that hub (TRUSTWORK_HUB_ID), which this shared stack does not set.
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await enrolled(aCtx, 'Synthetic Hub Steward A');
  const b = await enrolled(bCtx, 'Synthetic Hub Steward B');
  for (const person of [a, b]) await control('/staff', { personId: person.personId, role: 'data-steward', permissions: HUB_PERMISSIONS, scope: { kind: 'node' } });
  await a.elevate();
  await b.elevate();
  // The hub is shown once its modes are configured: steward A drafts and activates the first modes version.
  const draft = await staffPost(aCtx.request, `/v1/admin/hubs/${hubId}/config`, { domain: 'modes', payload: { ...HUBS[0]!.modes, dataMode: 'live' } });
  const version = draft.version as { id: string; revision: number };
  await staffPost(aCtx.request, `/v1/admin/hubs/${hubId}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: null });

  for (const ctx of [aCtx, bCtx]) await inGeorgian(ctx);
  const pageA = await aCtx.newPage();

  // Modes: saved as a new version and applied at once.
  await pageA.goto(`/admin/hubs/${SLUG}/hub/modes`);
  await expect(pageA.getByRole('heading', { level: 1 })).toBeVisible();
  await pageA.locator('select[name="f.moderation"]').selectOption('pre_moderate_all');
  const modesResult = await submit(pageA, 'change-modes', msg('admin.common.saveVersion', LANG));
  await expect(modesResult).toHaveText(msg('admin.common.applied', LANG));
  const current = await (await aCtx.request.get(`/v1/admin/hubs/${hubId}/config/current`)).json() as { items: Array<{ domain: string; payload: { moderation?: string } }> };
  expect(current.items.find((i) => i.domain === 'modes')?.payload.moderation).toBe('pre_moderate_all');
  await expectAccessible(pageA);
  await shot(pageA, 'console-01-modes-ka');

  // Residency: steward A saves a draft; the drafter never activates a sensitive version.
  const residencyAction = msg('admin.approvals.actions.hub.change_residency', LANG);
  await pageA.goto(`/admin/hubs/${SLUG}/hub/residency`);
  await pageA.locator('input[name="f.country"]').fill('GE');
  const residencyResult = await submit(pageA, 'change-residency', msg('admin.hub.residency.requestChange', LANG));
  await expect(residencyResult).toHaveText(msg('admin.common.draftSaved', LANG, { action: residencyAction }));
  await shot(pageA, 'console-02-residency-draft-ka');

  // Steward A sees the draft waiting, without a way to request its activation.
  await pageA.goto(`/admin/hubs/${SLUG}/approvals`);
  const ownWaiting = pageA.locator('#waiting li').first();
  await expect(ownWaiting).toContainText(msg('admin.approvals.ownDraft', LANG));
  await expect(ownWaiting.getByRole('button', { name: msg('admin.approvals.requestActivation', LANG) })).toHaveCount(0);

  // Steward B requests the activation: the API opens the second-person request.
  const pageB = await bCtx.newPage();
  await pageB.goto(`/admin/hubs/${SLUG}/approvals`);
  const waiting = pageB.locator('#waiting li').first();
  await expect(waiting).toBeVisible();
  await expectAccessible(pageB);
  await shot(pageB, 'console-03-waiting-ka');
  await waiting.getByLabel(msg('admin.common.reason', LANG)).fill('Hosting moves to the hub country');
  await waiting.getByRole('button', { name: msg('admin.approvals.requestActivation', LANG) }).click();
  await expect(waiting.locator('.admin-form__result')).toHaveText(msg('admin.common.sentToSecondPerson', LANG, { action: residencyAction }));

  // Steward A approves B's request for the exact draft.
  await pageA.goto(`/admin/hubs/${SLUG}/approvals`);
  const card = pageA.locator('#for-me li').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.admin-diff')).toContainText(residencyAction);
  await expect(card).toContainText(msg('admin.approvals.fields.action', LANG));
  await card.locator('select[name="f.decision"]').selectOption('approve');
  await card.getByLabel(msg('admin.common.reason', LANG)).fill('Checked the residency change');
  await card.getByRole('button', { name: msg('admin.approvals.decide', LANG) }).click();
  await expect(card.locator('.admin-form__result')).toHaveText(msg('admin.common.applied', LANG));
  await expectAccessible(pageA);
  await shot(pageA, 'console-04-approve-ka');

  // Steward B, the requester, applies the approved change.
  await pageB.goto(`/admin/hubs/${SLUG}/approvals`);
  const ready = pageB.locator('#ready');
  await expect(ready).toBeVisible();
  await ready.getByLabel(msg('admin.common.reason', LANG)).fill('Apply the approved residency');
  await ready.getByRole('button', { name: msg('admin.approvals.apply', LANG) }).click();
  await expect(ready.locator('.admin-form__result')).toHaveText(msg('admin.common.applied', LANG));
  const after = await (await bCtx.request.get(`/v1/admin/hubs/${hubId}/config/current`)).json() as { items: Array<{ domain: string; payload: { hostingCountry?: string } }> };
  expect(after.items.find((i) => i.domain === 'residency')?.payload.hostingCountry).toBe('GE');
  await shot(pageB, 'console-05-applied-ka');

  // Residency reads back from the active version; what nothing records says so, and no demo wording is left.
  await pageB.goto(`/admin/hubs/${SLUG}/hub/residency`);
  const decision = pageB.locator('#decision');
  await expect(decision).toContainText(msg('admin.hub.residency.personalData', LANG));
  await expect(decision).toContainText(msg('admin.hub.residency.regimes.not_recorded', LANG));
  await expect(pageB.getByTestId('residency-services-none')).toHaveText(msg('admin.hub.residency.servicesNone', LANG));
  await expect(pageB.getByTestId('residency-processors-none')).toHaveText(msg('admin.hub.residency.subProcessorsNone', LANG));
  await expect(pageB.locator('#subprocessors')).not.toContainText(msg('admin.hub.residency.subProcessorsNote', LANG));
  await expectAccessible(pageB);
  await shot(pageB, 'console-05b-residency-ka');

  // The overview counts what the API lists: a real moderation case shows; a queue with no read is named, never empty.
  const readerCtx = await browser.newContext();
  const reader = await enrolled(readerCtx, 'Synthetic Queue Reader');
  await control('/staff', { personId: reader.personId, role: 'ops-engineer', scope: { kind: 'node' }, permissions: [
    'admin.hub.read', 'admin.moderation.read', 'admin.moderation.decide', 'admin.moderation.case.open', 'admin.support.case.close', 'admin.support.grant.approve', 'admin.links.decide', 'admin.pipelines.run',
    'admin.providers.read', 'admin.claims.decide',
  ] });
  await reader.elevate();
  await staffPost(readerCtx.request, '/v1/admin/moderation/cases', { hubId, targetKind: 'publication', targetId: randomUUID(), clauseCodes: ['synthetic.clause'] });
  await inGeorgian(readerCtx);
  const overview = await readerCtx.newPage();
  await overview.goto(`/admin/hubs/${SLUG}`);
  const queue = (id: string) => msg(`admin.overview.queue.${id}`, LANG);
  await expect(overview.locator('#queues li', { hasText: queue('reports') })).toContainText('1');
  const uncounted = overview.getByTestId('queues-uncounted');
  await expect(uncounted).toContainText(queue('claims'));
  for (const id of ['reports', 'support_cases', 'grant_requests', 'link_proposals', 'alerts']) await expect(uncounted).not.toContainText(queue(id));
  await expect(overview.getByTestId('nothing-waiting')).toHaveCount(0);
  await expect(overview.locator('#health')).toHaveCount(0);
  const compliance = overview.locator('#compliance');
  await expect(compliance).toContainText(msg('admin.common.notRecorded', LANG));
  await expect(compliance).toContainText(msg('admin.common.none', LANG));
  await expectAccessible(overview);
  await shot(overview, 'console-05c-overview-ka');
  await readerCtx.close();

  // Narrow and medium screens: nothing scrolls sideways.
  for (const width of [768, 375]) {
    await pageA.setViewportSize({ width, height: 900 });
    await pageA.goto(`/admin/hubs/${SLUG}/hub/identity`);
    await expect(pageA.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(pageA);
    await shot(pageA, `console-06-identity-${width}-ka`);
  }
  await pageA.setViewportSize({ width: 1280, height: 900 });
  await expectAccessible(pageA);

  // Staff (HC-150): a staff administrator sees the hub's staff by name, gives steward A a hub role, reads what A may do
  // and revokes the role again; a sensitive role is not offered, and nobody gives a role to themselves.
  await control('/definition', { role: 'editor', scopes: ['hub'], permissions: ['admin.hub.read', 'admin.notifications.read'] });
  const cCtx = await browser.newContext();
  const c = await enrolled(cCtx, 'Synthetic Staff Admin');
  // A synthetic test definition with the staff permissions (staff-admin itself is sensitive and needs a second person).
  await control('/staff', { personId: c.personId, role: 'ops-engineer', permissions: ['admin.hub.read', 'admin.staff.read', 'admin.staff.assign', 'admin.staff.revoke'], scope: { kind: 'node' } });
  await c.elevate();
  await inGeorgian(cCtx);
  const pageC = await cCtx.newPage();
  await pageC.goto(`/admin/hubs/${SLUG}/staff`);
  const people = pageC.locator('#people');
  for (const name of ['Synthetic Hub Steward A', 'Synthetic Hub Steward B', 'Synthetic Staff Admin']) await expect(people.getByRole('rowheader', { name: new RegExp(name) })).toBeVisible();
  await expect(people).toContainText(msg('admin.staff.enrolled', LANG));
  const add = pageC.locator('#add-role form');
  await expect(add.locator('select[name="f.role"] option')).toHaveText([msg('admin.roles.editor', LANG)]);
  await expect(add.locator('select[name="f.personId"] option', { hasText: 'Synthetic Staff Admin' })).toHaveCount(0);
  await add.locator('select[name="f.personId"]').selectOption({ label: 'Synthetic Hub Steward A' });
  await add.getByLabel(msg('admin.common.reason', LANG)).fill('Steward A also edits the hub news');
  await add.getByRole('button', { name: msg('admin.staff.addRoleSubmit', LANG) }).click();
  await expect(add.locator('.admin-form__result')).toHaveText(msg('admin.common.applied', LANG));
  await pageC.goto(`/admin/hubs/${SLUG}/staff?person=${a.personId}`);
  const rowA = pageC.getByTestId(`staff-${a.personId}`);
  await expect(rowA).toContainText(msg('admin.roles.editor', LANG));
  await expect(pageC.locator('#access')).toContainText(msg('admin.roles.editor', LANG));
  await expectAccessible(pageC);
  await shot(pageC, 'console-09-staff-ka');
  const revoke = rowA.locator('details', { hasText: msg('admin.staff.revoke', LANG) }).first();
  await revoke.locator('summary').click();
  await revoke.getByLabel(msg('admin.common.reason', LANG)).fill('Steward A no longer edits the news');
  await revoke.getByRole('button', { name: msg('admin.staff.revokeSubmit', LANG) }).click();
  await expect(revoke.locator('.admin-form__result')).toHaveText(msg('admin.common.applied', LANG));
  await pageC.goto(`/admin/hubs/${SLUG}/staff`);
  await expect(pageC.getByTestId(`staff-${a.personId}`)).not.toContainText(msg('admin.roles.editor', LANG));
  for (const width of [768, 375]) {
    await pageC.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(pageC);
    await shot(pageC, `console-10-staff-${width}-ka`);
  }

  for (const ctx of [operatorCtx, aCtx, bCtx, cCtx]) await ctx.close();
});

/** Creates an invitation on the staff screen; returns its status line. */
async function invite(page: Page, email: string, role: string, days = '') {
  await page.goto(`/admin/hubs/${SLUG}/staff`);
  const form = page.locator('#invite form');
  await form.getByLabel(msg('admin.staff.inviteEmail', LANG)).fill(email);
  await form.locator('select[name="f.role"]').selectOption(role);
  await form.getByLabel(msg('admin.staff.inviteDays', LANG)).fill(days);
  await form.getByLabel(msg('admin.common.reason', LANG)).fill('Synthetic invitation journey');
  await form.getByRole('button', { name: msg('admin.staff.inviteSubmit', LANG) }).click();
  return form.locator('.admin-form__result');
}

/** The invitation to an address, as the staff screen lists it. */
const invitationOf = (page: Page, email: string) => page.locator('#invitations li', { hasText: email });

/** Opens one of an invitation's disclosures, gives a reason and submits it; returns the status line. */
async function act(row: ReturnType<typeof invitationOf>, summary: string, submitLabel: string) {
  const disclosure = row.locator('details', { hasText: summary });
  await disclosure.locator('summary').click();
  await disclosure.getByLabel(msg('admin.common.reason', LANG)).fill('Synthetic invitation journey');
  await disclosure.getByRole('button', { name: submitLabel }).click();
  return disclosure.locator('.admin-form__result');
}

test('staff invitations: invited in the console, answered in the workspace with a second factor, applied by the inviter; a sensitive role through a second person', async ({ browser }) => {
  test.setTimeout(240_000);
  const stage = (key: string) => msg(`admin.staff.invitation.stage.${key}`, LANG);
  const invitedRole = msg('admin.roles.editor', LANG);
  const sensitiveRole = msg('admin.roles.compliance-officer', LANG);
  await control('/definition', { role: 'compliance-officer', scopes: ['hub'], permissions: ['admin.hub.read', 'admin.audit.read'] });

  // The inviter and a second staff administrator. With three or more staff the hub runs in full separation of duties,
  // where the second person acts through a different role.
  const inviterCtx = await browser.newContext();
  const secondCtx = await browser.newContext();
  const inviter = await enrolled(inviterCtx, 'Synthetic Inviter');
  const second = await enrolled(secondCtx, 'Synthetic Second Person');
  const staffAdmin = ['admin.hub.read', 'admin.staff.read', 'admin.staff.assign', 'admin.staff.revoke'];
  await control('/staff', { personId: inviter.personId, role: 'ops-engineer', permissions: staffAdmin, scope: { kind: 'node' } });
  await control('/staff', { personId: second.personId, role: 'data-steward', permissions: staffAdmin, scope: { kind: 'node' } });
  await inviter.elevate();
  await second.elevate();
  for (const ctx of [inviterCtx, secondCtx]) await inGeorgian(ctx);
  const page = await inviterCtx.newPage();
  const hubId = ((await (await inviterCtx.request.get('/v1/admin/hubs')).json()) as { items: Array<{ hub: { id: string; slug: string } }> }).items.find((i) => i.hub.slug === SLUG)!.hub.id;

  // Nobody invites their own address; the API knows it, the console says so.
  await expect(await invite(page, inviter.email, 'editor')).toHaveText(msg('admin.errors.self_grant', LANG));

  // The invited person has an account but no second factor yet.
  const inviteeCtx = await browser.newContext();
  const invitee = await verifiedAccount(inviteeCtx.request, 'Synthetic Invited Editor');
  await inGeorgian(inviteeCtx);
  await expect(await invite(page, invitee.email, 'editor', '30')).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  const row = invitationOf(page, invitee.email);
  await expect(row).toContainText(stage('response'));
  await expect(row).toContainText(invitedRole);
  await expect(row.locator('details', { hasText: msg('admin.staff.invitation.apply', LANG) })).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'console-11-invitations-ka');
  // One open invitation per address and role, also with the address in capitals.
  await expect(await invite(page, invitee.email.toUpperCase(), 'editor')).toHaveText(msg('admin.errors.invitation_open', LANG));

  const listed = (await (await inviterCtx.request.get(`/v1/admin/staff/invitations?hubId=${hubId}`)).json()) as { invitations: Array<{ id: string; email: string; expiresAt: string }> };
  const first = listed.invitations.find((i) => i.email === invitee.email)!;

  // Nobody else sees or answers it: to a stranger it does not exist, and the staff list is not theirs to read.
  const strangerCtx = await browser.newContext();
  await verifiedAccount(strangerCtx.request, 'Synthetic Stranger');
  await inGeorgian(strangerCtx);
  const strangerPage = await strangerCtx.newPage();
  await strangerPage.goto('/app/settings');
  await expect(strangerPage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(strangerPage.locator('#staff-invitations')).toHaveCount(0);
  const answer = (ctx: BrowserContext, accept: boolean) => ctx.request.post(`/v1/me/staff-invitations/${first.id}/respond`, { headers: { ...SAME_ORIGIN, 'Idempotency-Key': randomUUID() }, data: { accept } });
  expect((await answer(strangerCtx, true)).status()).toBe(404);
  expect((await strangerCtx.request.get(`/v1/admin/staff/invitations?hubId=${hubId}`)).status()).toBeGreaterThanOrEqual(401);

  // The workspace says a second factor is needed, and accepting without one comes back refused, in the person's language.
  const workspace = await inviteeCtx.newPage();
  await workspace.goto('/app/settings');
  await expect(workspace.getByTestId('staff-invitations-link')).toHaveText(msg('settings.staffInvitations.linkOpen', LANG, { count: '1' }));
  const card = workspace.getByTestId(`my-invitation-${first.id}`);
  await expect(card.getByRole('heading', { level: 3 })).toHaveText(invitedRole);
  await expect(card).toContainText('Synthetic Inviter');
  await expect(card).toContainText('30');
  await expect(workspace.getByTestId('invitation-second-factor')).toContainText(msg('settings.staffInvitations.secondFactorNeeded', LANG));
  await expectAccessible(workspace);
  await workspace.locator('#staff-invitations').scrollIntoViewIfNeeded();
  await shot(workspace, 'console-12-invitation-needs-factor-ka');
  await card.getByRole('button', { name: msg('settings.staffInvitations.accept', LANG), exact: true }).click();
  await expect(workspace.getByTestId('invitation-result')).toHaveText(msg('settings.staffInvitations.result.second_factor', LANG));
  await expect(card).toBeVisible();
  const refused = await answer(inviteeCtx, true);
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { details: { required: string } }).details.required).toBe('second_factor');

  // With a second factor the same section accepts.
  await secondFactor(inviteeCtx);
  await workspace.goto('/app/settings');
  await expect(workspace.getByTestId('invitation-second-factor')).toHaveText(msg('settings.staffInvitations.secondFactorReady', LANG));
  for (const width of [768, 375]) {
    await workspace.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(workspace);
    await shot(workspace, `console-13-invitation-${width}-ka`);
  }
  await workspace.setViewportSize({ width: 1280, height: 900 });
  await card.getByRole('button', { name: msg('settings.staffInvitations.accept', LANG), exact: true }).click();
  await expect(workspace.getByTestId('invitation-result')).toHaveText(msg('settings.staffInvitations.result.accepted', LANG));
  await expect(workspace.getByTestId('invitations-none')).toBeVisible();
  await expectAccessible(workspace);
  await shot(workspace, 'console-14-invitation-accepted-ka');

  // The inviter applies it; the role shows in the directory, with its end.
  await page.goto(`/admin/hubs/${SLUG}/staff`);
  await expect(row).toContainText(stage('apply'));
  await expect(await act(row, msg('admin.staff.invitation.apply', LANG), msg('admin.staff.invitation.applySubmit', LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(row).toContainText(stage('applied'));
  await expect(page.getByTestId(`staff-${invitee.personId}`)).toContainText(invitedRole);

  // A sensitive role: offered through the invitation; the first apply asks a second person.
  const officerCtx = await browser.newContext();
  const officer = await enrolled(officerCtx, 'Synthetic Invited Officer');
  await inGeorgian(officerCtx);
  await expect(await invite(page, officer.email, 'compliance-officer')).toHaveText(msg('admin.common.applied', LANG));
  await expect(page.locator('#invite select[name="f.role"] option', { hasText: msg('admin.staff.invitation.sensitiveRole', LANG, { role: sensitiveRole }) })).toHaveCount(1);
  const officerPage = await officerCtx.newPage();
  await officerPage.goto('/app/settings');
  await officerPage.getByRole('button', { name: msg('settings.staffInvitations.accept', LANG), exact: true }).click();
  await expect(officerPage.getByTestId('invitation-result')).toHaveText(msg('settings.staffInvitations.result.accepted', LANG));

  // Another staff administrator sees the accepted invitation and may withdraw it, but only the inviter applies it.
  const secondPage = await secondCtx.newPage();
  await secondPage.goto(`/admin/hubs/${SLUG}/staff`);
  const seen = invitationOf(secondPage, officer.email);
  await expect(seen).toContainText(msg('admin.errors.not_inviter', LANG));
  await expect(seen.locator('details', { hasText: msg('admin.staff.invitation.apply', LANG) })).toHaveCount(0);
  await expect(seen.locator('details', { hasText: msg('admin.staff.invitation.withdraw', LANG) })).toHaveCount(1);

  await page.goto(`/admin/hubs/${SLUG}/staff`);
  const sensitive = invitationOf(page, officer.email);
  await expect(sensitive).toContainText(stage('apply'));
  await expect(await act(sensitive, msg('admin.staff.invitation.apply', LANG), msg('admin.staff.invitation.applySubmit', LANG)))
    .toHaveText(msg('admin.common.sentToSecondPerson', LANG, { action: msg('admin.approvals.actions.staff.assign_sensitive_role', LANG) }));
  await page.reload();
  await expect(sensitive).toContainText(stage('second_person'));
  await expect(sensitive.locator('details', { hasText: msg('admin.staff.invitation.apply', LANG) })).toHaveCount(0);
  await expect(page.getByTestId(`staff-${officer.personId}`)).toHaveCount(0);
  await expectAccessible(page);
  await shot(page, 'console-15-invitation-second-person-ka');

  // The second person approves the exact assignment; nothing takes effect until then, and the inviter applies again.
  await secondPage.goto(`/admin/hubs/${SLUG}/staff`);
  await expect(invitationOf(secondPage, officer.email)).toContainText(stage('second_person'));
  await secondPage.goto(`/admin/hubs/${SLUG}/approvals`);
  const approval = secondPage.locator('#for-me li').first();
  await expect(approval.locator('.admin-diff')).toContainText(msg('admin.approvals.actions.staff.assign_sensitive_role', LANG));
  await approval.locator('select[name="f.decision"]').selectOption('approve');
  await approval.getByLabel(msg('admin.common.reason', LANG)).fill('Checked the compliance role');
  await approval.getByRole('button', { name: msg('admin.approvals.decide', LANG) }).click();
  await expect(approval.locator('.admin-form__result')).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(sensitive).toContainText(stage('approved'));
  await expect(await act(sensitive, msg('admin.staff.invitation.apply', LANG), msg('admin.staff.invitation.applySubmit', LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(sensitive).toContainText(stage('applied'));
  await expect(page.getByTestId(`staff-${officer.personId}`)).toContainText(sensitiveRole);

  // Withdrawing ends an open invitation: its person no longer sees it.
  const lateCtx = await browser.newContext();
  const late = await verifiedAccount(lateCtx.request, 'Synthetic Late Invitee');
  await inGeorgian(lateCtx);
  await expect(await invite(page, late.email, 'editor')).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  const withdrawn = invitationOf(page, late.email);
  await expect(await act(withdrawn, msg('admin.staff.invitation.withdraw', LANG), msg('admin.staff.invitation.withdrawSubmit', LANG))).toHaveText(msg('admin.common.applied', LANG));
  await page.reload();
  await expect(withdrawn).toContainText(stage('withdrawn'));
  await expect(withdrawn.locator('details')).toHaveCount(0);
  const latePage = await lateCtx.newPage();
  await latePage.goto('/app/settings');
  await expect(latePage.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(latePage.locator('#staff-invitations')).toHaveCount(0);

  // A declined invitation closes as well.
  const noCtx = await browser.newContext();
  const no = await verifiedAccount(noCtx.request, 'Synthetic Declining Invitee');
  await inGeorgian(noCtx);
  await expect(await invite(page, no.email, 'editor')).toHaveText(msg('admin.common.applied', LANG));
  const noPage = await noCtx.newPage();
  await noPage.goto('/app/settings');
  await noPage.getByRole('button', { name: msg('settings.staffInvitations.decline', LANG), exact: true }).click();
  await expect(noPage.getByTestId('invitation-result')).toHaveText(msg('settings.staffInvitations.result.declined', LANG));
  await page.goto(`/admin/hubs/${SLUG}/staff`);
  await expect(invitationOf(page, no.email)).toContainText(stage('declined'));

  // Narrow screens: the invitations fit too.
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expectNoHorizontalOverflow(page);
    await shot(page, `console-16-invitations-${width}-ka`);
  }

  for (const ctx of [inviterCtx, secondCtx, inviteeCtx, strangerCtx, officerCtx, lateCtx, noCtx]) await ctx.close();
});

test('negative authorization: a participant finds nothing; an unelevated staff session confirms its second factor first', async ({ browser }) => {
  const participantCtx = await browser.newContext();
  await verifiedAccount(participantCtx.request, 'Synthetic Participant');
  await inGeorgian(participantCtx);
  const page = await participantCtx.newPage();
  const response = await page.goto(`/admin/hubs/${SLUG}/hub/modes`);
  expect(response?.status()).toBe(404);
  // The console's "not found" reads like any other, in the visitor's language.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(msg('error.notFoundTitle', LANG));
  await expect(page.getByRole('link', { name: msg('auth.backHome', LANG) })).toBeVisible();
  await participantCtx.close();

  // A staff member whose session is not elevated reaches only the elevation form, never the settings.
  const staffCtx = await browser.newContext();
  const staff = await enrolled(staffCtx, 'Synthetic Unelevated Steward');
  const node = await control('/staff', { personId: staff.personId, role: 'ops-engineer', permissions: ['admin.node.hubs.manage'], scope: { kind: 'node' } });
  expect(node.nodeId).toBeTruthy();
  await inGeorgian(staffCtx);
  const gate = await staffCtx.newPage();
  await gate.goto('/admin');
  await expect(gate.locator('select[name="f.moderation"]')).toHaveCount(0);
  const form = gate.getByTestId('admin-elevate-form');
  await expect(form).toBeVisible();
  await expectAccessible(gate);
  await shot(gate, 'console-07-elevation-ka');
  // A wrong code is refused in the visitor's language; the password and the right code open the console.
  await form.locator('input[name="f.password"]').fill(PASSWORD);
  await form.locator('input[name="f.code"]').fill('000000');
  await form.getByRole('button', { name: msg('admin.elevation.action', LANG) }).click();
  await expect(form.getByRole('alert')).toHaveText(msg('admin.elevation.wrongCode', LANG));
  await form.locator('input[name="f.password"]').fill(PASSWORD);
  await form.locator('input[name="f.code"]').fill(totpAt(staff.secret, Date.now() + 30_000));
  await form.getByRole('button', { name: msg('admin.elevation.action', LANG) }).click();
  await expect(gate.getByTestId('admin-elevate-form')).toHaveCount(0);
  await expect(gate.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(gate, 'console-08-elevated-ka');
  await staffCtx.close();
});
