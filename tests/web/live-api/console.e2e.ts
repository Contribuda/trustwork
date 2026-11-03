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
 * confirms its second factor in the console before it sees anything; key screens pass axe and fit 1280, 768 and
 * 375 px; residency and the overview read back from the API. Every person and hub is synthetic.
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

/** A signed-in person with a second factor; `elevate` then opens an elevated staff session with a fresh code. */
async function enrolled(context: BrowserContext, name: string): Promise<{ personId: string; secret: string; elevate: () => Promise<void> }> {
  const { personId } = await verifiedAccount(context.request, name);
  const stepUp = async () => expect((await context.request.post('/v1/auth/step-up', { headers: SAME_ORIGIN, data: { password: PASSWORD } })).status()).toBe(200);
  await stepUp();
  const started = await context.request.post('/v1/me/second-factor/totp', { headers: SAME_ORIGIN });
  expect(started.status(), await started.text()).toBe(201);
  const { factorId, secret } = (await started.json()) as { factorId: string; secret: string };
  const confirmed = await context.request.post('/v1/me/second-factor/totp/confirm', { headers: SAME_ORIGIN, data: { factorId, code: totpAt(secret, Date.now()) } });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
  return {
    personId, secret,
    elevate: async () => {
      await stepUp();
      const elevated = await context.request.post('/v1/admin/session/elevate', { headers: SAME_ORIGIN, data: { proof: { method: 'totp', code: totpAt(secret, Date.now() + 30_000) } } });
      expect(elevated.status(), await elevated.text()).toBe(200);
    },
  };
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
