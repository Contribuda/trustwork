import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { createApp, type CreatedApp } from '../../../../apps/api/src/app.js';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import type { CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { priceCommand } from '../../../../apps/web/app/admin/_data/live-prices.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../../../backend/helpers/app.js';
import { codeNow } from '../../../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { registerFeeServingHubs } from '../../../billing/fees/helpers.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../../../hubs/helpers.js';

/**
 * HC-91 Prices through the console's live adapter on the real API and PostgreSQL: runtime role, real sessions, TOTP and
 * elevated sessions, real second-person approvals. The negative cases run through the console and, with the console's
 * check stepped over, against the API, because the page is never the authority. Every person, hub and amount is synthetic.
 */
const h = await startHarness('console_live_prices');
const SLUG = 'synthetic-live-prices';
const OTHER_SLUG = 'synthetic-live-prices-other';
type Who = 'owner' | 'officer' | 'moderator' | 'operator' | 'outsider';
const WHO: Who[] = ['owner', 'officer', 'moderator', 'operator', 'outsider'];
const emailOf = (key: Who) => `live-prices-${key.toLowerCase()}@example.invalid`;
const PRICE_PERMISSIONS = [
  'admin.hub.read', 'admin.hub.modes.edit', 'admin.config.edit', 'admin.billing.fees.draft', 'admin.billing.fees.activate', 'admin.commerce.price.draft', 'admin.commerce.price.activate', 'admin.commerce.usage.read',
];
const tomorrow = (days = 1) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

class Failure extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`API ${status} ${code ?? ''}`);
  }
}

function apiOf(client: Client): ConsoleApi {
  return {
    async get(path) {
      const r = await client.get(path);
      if (r.status >= 200 && r.status < 300) return r.body;
      const code = (r.body as { code?: string } | null)?.code ?? null;
      if (r.status === 404 && code === 'access.not_found') return null;
      throw new Failure(r.status, code);
    },
    async post(path, body, key) {
      const r = await client.post(path, body, { idempotencyKey: key });
      return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body };
    },
  };
}

function apiFor(harness: Harness, hubId: string): Promise<CreatedApp> {
  return createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: hubId,
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'),
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

test('HC-91 Prices through the live adapter', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub(SLUG)).hub_id;
  const otherHubId = (await a.createHub(OTHER_SLUG)).hub_id;
  await registerFeeServingHubs(h.db.admin, hubId, otherHubId);
  await withMaintenance(h.db.admin, async (trx) => {
    const release = (role: 'support-agent' | 'data-steward', scopes: Array<'hub' | 'node'>, permissions: string[]) => staffRoleDefinitions.release(trx, { version: 1, role, scopes, permissions: permissions as never,
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await release('data-steward', ['hub', 'node'], PRICE_PERMISSIONS);
    await release('support-agent', ['hub'], ['admin.hub.read', 'admin.commerce.usage.read']);
  });
  const scope = { kind: 'hub' as const, hubId };
  await a.assign({ personId: w.people.owner, role: 'data-steward', scope });
  await a.assign({ personId: w.people.officer, role: 'data-steward', scope });
  await a.assign({ personId: w.people.moderator, role: 'support-agent', scope });
  // Node-wide staff of both hubs: the one person who could open the prices of a hub this deployment does not serve.
  await a.assign({ personId: w.people.operator, role: 'data-steward', scope: { kind: 'node', nodeId: w.nodeId } });
  await addLogins(h, WHO.map((k) => [w.people[k], emailOf(k)]));
  const app = await apiFor(h, hubId);
  t.after(async () => { await app.close(); await h.close(); });

  const unelevated = new Client(app);
  await signIn(unelevated, emailOf('owner'));
  const clients = {} as Record<Who, Client>;
  const secrets = {} as Partial<Record<Who, Buffer>>;
  for (const key of WHO) {
    clients[key] = new Client(app);
    await signIn(clients[key], emailOf(key));
    if (key !== 'outsider') secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async (key: Who) => {
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]!) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const staffPost = (key: Who, url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const idempotencyKey = `live-${randomUUID()}`;
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic price check', ...body }, { idempotencyKey });
  };
  const portOf = (key: Who) => createApiConsolePort({ api: apiOf(clients[key]), siteHost: () => 'live-prices.example.org', engineVersion: '0.1.0', now: () => h.clock.now() });
  const live = { demo: false } as const;
  const run = (key: Who, command: CommandInput['command'], fields: Record<string, string> = {}, slug = SLUG) =>
    portOf(key).command(live, { command, hubSlug: slug, setupToken: null, reason: 'Synthetic price check', expectedRevision: null, fields });
  /** The API with the console's own checks stepped over: what a crafted request gets. */
  const direct = (key: Who, command: Parameters<typeof priceCommand>[0], fields: Record<string, string>) => priceCommand(command, fields, {
    hubId, viewerId: w.people[key], form: { currency: 'USD', now: h.clock.now() },
    post: (path, rest) => { const k = `direct-${randomUUID()}`; return clients[key].post(path, { reason: 'Synthetic price check', ...rest }, { idempotencyKey: k }).then((r) => ({ status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body })); },
    send: (path, rest) => staffPost(key, path, rest).then((r) => ({ status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body })),
    read: async () => (await portOf('owner').prices(hubId))!,
  });
  const view = async (key: Who = 'owner') => {
    const v = await portOf(key).prices(hubId);
    assert.ok(v?.served, 'this deployment serves the hub');
    return v;
  };
  const decide = (key: Who, requestId: string, digest: string) => run(key, 'approvals.decide', { requestId, decision: 'approve', digest });
  const pendingRequest = async (digest: string) => {
    const { requests } = await portOf('owner').approvals(hubId);
    const request = requests.find((r) => r.actionDigest.value === digest);
    assert.ok(request, 'the second person sees the request');
    return request;
  };

  for (const key of ['owner', 'officer', 'moderator', 'operator'] as const) await elevate(key);
  for (const id of [hubId, otherHubId]) {
    const modes = await staffPost('operator', `/v1/admin/hubs/${id}/config`, { domain: 'modes', payload: HUBS[0]!.modes });
    assert.equal(modes.status, 201, JSON.stringify(modes.body));
    const version = (modes.body as { version: { id: string; revision: number } }).version;
    assert.equal((await staffPost('operator', `/v1/admin/hubs/${id}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: null })).status, 200);
  }

  const feeFields = { feeKind: 'consultation', feePayer: 'buyer', feeCategory: 'synthetic_review', feePercent: '12.5', feeEffectiveFrom: tomorrow(), feeAcceptance: 'synthetic-fees-1' };

  await t.test('who reads: each list by its own permission; a reader of usage sees no fee and no sale price; no one else reads', async () => {
    const reader = await view('moderator');
    assert.deepEqual([reader.fees, reader.sales], [null, null], 'hidden, not empty');
    assert.deepEqual(reader.usage, []);
    assert.deepEqual([(await view()).fees, (await view()).sales, (await view()).usage], [[], [], []]);
    assert.deepEqual(await portOf('outsider').prices(hubId), { served: true, fees: null, sales: null, usage: null }, 'a participant reads no list');
    const port = createApiConsolePort({ api: apiOf(unelevated), siteHost: () => 'x', engineVersion: '0', now: () => h.clock.now() });
    assert.deepEqual(await port.prices(hubId), { served: true, fees: null, sales: null, usage: null }, 'nor does a session without an elevation');
  });

  await t.test('a hub this deployment does not serve: nothing is shown, and a draft never lands on the served hub', async () => {
    assert.deepEqual(await portOf('operator').prices(otherHubId), { served: false, fees: null, sales: null, usage: null });
    assert.deepEqual(await run('operator', 'prices.fee_draft', feeFields, OTHER_SLUG), { status: 'not_found' });
    assert.deepEqual((await view()).fees, [], 'the served hub received nothing');
    const rows = await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.marketplace_fee_version');
    assert.equal(rows.rows[0].n, 0);
  });

  await t.test('a fee draft: exact basis points, refusals before anything is sent, a reader refused twice', async () => {
    const back = await run('owner', 'prices.fee_draft', { ...feeFields, feeEffectiveFrom: '2020-01-01' });
    assert.equal(back.status === 'rejected' && back.code, 'back_dated');
    const empty = await run('owner', 'prices.fee_draft', { ...feeFields, feePercent: '' });
    assert.equal(empty.status === 'rejected' && empty.field, 'feePercent', 'a fee needs an amount');
    const over = await run('owner', 'prices.fee_draft', { ...feeFields, feePercent: '100.01' });
    assert.equal(over.status === 'rejected' && over.field, 'feePercent');
    const ticket = await run('owner', 'prices.fee_draft', { ...feeFields, feeKind: 'ticket' });
    assert.equal(ticket.status === 'rejected' && ticket.field, 'feeCategory', 'categories apply to consultations and tasks');
    const denied = await run('moderator', 'prices.fee_draft', feeFields);
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    const api = await direct('moderator', 'prices.fee_draft', feeFields);
    assert.equal(api.status === 'rejected' && api.code, 'denied', 'the API refuses a reader');
    assert.deepEqual(await run('owner', 'prices.fee_draft', feeFields), { status: 'applied' });
    const [fee] = (await view()).fees!;
    assert.deepEqual([fee?.terms.basisPoints, fee?.terms.fixedMinor, fee?.terms.currency, fee?.status, fee?.draftedBy], [1250, null, 'USD', 'draft', w.people.owner]);
  });

  await t.test('a fee goes active only through two people: the drafter cannot ask, the approver cannot finish, one approval is used once', async () => {
    const [fee] = (await view()).fees!;
    const fields = { target: 'fee', id: fee!.id };
    const own = await run('owner', 'prices.request_activation', fields);
    assert.equal(own.status === 'rejected' && own.code, 'drafter_cannot_ask');
    const early = await run('officer', 'prices.activate', fields);
    assert.equal(early.status === 'rejected' && early.code, 'second_person_pending');
    const reader = await run('moderator', 'prices.request_activation', fields);
    assert.equal(reader.status === 'rejected' && reader.code, 'denied');
    assert.deepEqual(await run('officer', 'prices.request_activation', fields), { status: 'pending_second_person', secondPerson: 'billing.activate_fee_version' });
    const twice = await run('officer', 'prices.request_activation', fields);
    assert.equal(twice.status === 'rejected' && twice.code, 'second_person_pending');
    const request = await pendingRequest(fee!.digest);
    const self = await decide('officer', request.id, fee!.digest);
    assert.equal(self.status === 'rejected' && self.code, 'own_request');
    assert.deepEqual(await decide('owner', request.id, fee!.digest), { status: 'applied' });
    const approver = await run('owner', 'prices.activate', fields);
    assert.equal(approver.status === 'rejected' && approver.code, 'second_person_pending', 'only the requester finishes it');
    assert.equal((await view('officer')).fees![0]!.stage.stage, 'approved');
    const answers = await Promise.all([run('officer', 'prices.activate', fields), run('officer', 'prices.activate', fields)]);
    assert.equal(answers.filter((r) => r.status === 'applied').length, 1, JSON.stringify(answers));
    const [active] = (await view()).fees!;
    assert.deepEqual([active?.status, active?.activatedBy], ['active', w.people.officer]);
    assert.deepEqual(await run('officer', 'prices.activate', fields), { status: 'not_found' }, 'an active version is no target');
    const pricing = (await clients.outsider.get('/v1/pricing')).body as { fees: Array<{ id: string }> };
    assert.ok(pricing.fees.some((f) => f.id === fee!.id), 'it is on the public price page');
    const audit = await h.db.admin.query("SELECT outcome FROM trustwork.admin_audit_event WHERE action = 'billing.fee_activated' AND object_id = $1", [fee!.id]);
    assert.deepEqual(audit.rows.map((r) => r.outcome), ['applied']);
  });

  const saleFields = { saleKind: 'capability', saleSubject: 'project_planner.share_item', saleCode: 'synthetic_capability', saleName: 'Synthetic capability', saleMeter: 'agent_actions', salePerUnits: '1', saleAmountMinor: '25', saleEffectiveFrom: tomorrow(), saleAcceptance: 'synthetic-sale-1' };

  await t.test('a sale price: the approval binds what it replaces, so an approval for one choice does not open the other', async () => {
    const unknown = await run('owner', 'prices.sale_draft', { ...saleFields, saleSubject: 'core.synthetic_unknown' });
    assert.equal(unknown.status === 'rejected' && unknown.field, 'saleSubject', JSON.stringify(unknown));
    assert.deepEqual(await run('owner', 'prices.sale_draft', saleFields), { status: 'applied' });
    const first = (await view()).sales![0]!;
    assert.deepEqual(first.options.map((o) => o.supersedes), [null]);
    const fields = { target: 'sale', id: first.id };
    assert.deepEqual(await run('officer', 'prices.request_activation', fields), { status: 'pending_second_person', secondPerson: 'commerce.activate_price_version' });
    const request = await pendingRequest(first.options[0]!.digest);
    assert.deepEqual(await decide('owner', request.id, first.options[0]!.digest), { status: 'applied' });
    assert.deepEqual(await run('officer', 'prices.activate', fields), { status: 'applied' });

    assert.deepEqual(await run('owner', 'prices.sale_draft', { ...saleFields, saleAmountMinor: '30', saleEffectiveFrom: tomorrow(2) }), { status: 'applied' });
    const second = (await view()).sales!.find((s) => s.status === 'draft')!;
    assert.deepEqual(second.options.map((o) => o.supersedes), [null, first.id], 'the choice is the API\'s list');
    const replace = { target: 'sale', id: second.id, supersedes: first.id };
    assert.deepEqual(await run('officer', 'prices.request_activation', replace), { status: 'pending_second_person', secondPerson: 'commerce.activate_price_version' });
    const digest = second.options.find((o) => o.supersedes === first.id)!.digest;
    const secondRequest = await pendingRequest(digest);
    assert.deepEqual(await decide('owner', secondRequest.id, digest), { status: 'applied' });
    const other = await run('officer', 'prices.activate', { target: 'sale', id: second.id });
    assert.equal(other.status === 'rejected' && other.code, 'second_person_pending', 'the approval replaces that version, not nothing');
    const foreign = await run('officer', 'prices.activate', { ...replace, supersedes: randomUUID() });
    assert.deepEqual(foreign, { status: 'not_found' }, 'a version the API did not offer is no choice');
    assert.deepEqual(await run('officer', 'prices.activate', replace), { status: 'applied' });
    const after = (await view()).sales!;
    assert.deepEqual(after.find((s) => s.id === first.id)?.supersededBy, second.id);
    assert.equal(after.find((s) => s.id === second.id)?.status, 'active');
  });

  const costFields = { costSubject: 'meter', costMeter: 'checks', costPerUnit: '3.25', costBasis: 'measured_average' };
  const usageFields = { usageSubject: 'meter', usageMeter: 'checks', usageDirection: 'input', usageBasis: 'markup', usagePercent: '100', usageEffectiveFrom: tomorrow(), usageAcceptance: 'synthetic-usage-1' };

  await t.test('a usage price: no cost, no price; a markup is computed once; a new cost changes the report, not the price', async () => {
    const noCost = await run('owner', 'prices.usage_draft', usageFields);
    assert.equal(noCost.status === 'rejected' && noCost.code, 'cost_record_missing', JSON.stringify(noCost));
    assert.deepEqual(await run('owner', 'prices.cost_record', costFields), { status: 'applied' });
    assert.deepEqual(await run('owner', 'prices.usage_draft', usageFields), { status: 'applied' });
    const row = (await view('moderator')).usage![0]!;
    assert.deepEqual([row.terms.salePerUnitMinor, row.terms.costPerUnitMinor, row.terms.markupPercent, row.marginPerUnitMinor, row.status], ['6.5', '3.25', 100, '3.25', 'draft']);
    const fields = { target: 'usage', id: row.id };
    assert.deepEqual(await run('officer', 'prices.request_activation', fields), { status: 'pending_second_person', secondPerson: 'commerce.activate_price_version' });
    const request = await pendingRequest(row.digest);
    assert.deepEqual(await decide('owner', request.id, row.digest), { status: 'applied' });
    assert.deepEqual(await run('officer', 'prices.activate', fields), { status: 'applied' });
    assert.deepEqual(await run('owner', 'prices.cost_record', { ...costFields, costPerUnit: '4' }), { status: 'applied' });
    const after = (await view()).usage![0]!;
    assert.deepEqual([after.status, after.terms.salePerUnitMinor, after.currentCost?.costPerUnitMinor, after.currentMarginPerUnitMinor], ['active', '6.5', '4', '2.5']);
  });

  await t.test('a draft is cancelled, not activated, and a reader cannot cancel it', async () => {
    assert.deepEqual(await run('owner', 'prices.usage_draft', { ...usageFields, usageBasis: 'flat', usageSale: '7', usageEffectiveFrom: tomorrow(3) }), { status: 'applied' });
    const draft = (await view()).usage!.find((u) => u.status === 'draft')!;
    const denied = await direct('moderator', 'prices.usage_cancel', { id: draft.id });
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    assert.deepEqual(await run('owner', 'prices.usage_cancel', { id: draft.id }), { status: 'applied' });
    assert.equal((await view()).usage!.find((u) => u.id === draft.id)?.status, 'cancelled');
    const again = await run('owner', 'prices.usage_cancel', { id: draft.id });
    assert.equal(again.status === 'rejected' && again.code, 'stale');
  });

  await t.test('one live price per subject: the other price list is named, not hidden', async () => {
    assert.deepEqual(await run('owner', 'prices.cost_record', { costSubject: 'capability', costKey: 'project_planner.share_item', costMeter: 'agent_actions', costPerUnit: '1', costBasis: 'contract' }), { status: 'applied' });
    assert.deepEqual(await run('owner', 'prices.usage_draft', { ...usageFields, usageSubject: 'capability', usageKey: 'project_planner.share_item', usageMeter: 'agent_actions', usageBasis: 'flat', usageSale: '3', usageEffectiveFrom: tomorrow(4) }), { status: 'applied' });
    const row = (await view()).usage!.find((u) => u.terms.subject.kind === 'capability' && u.status === 'draft')!;
    const fields = { target: 'usage', id: row.id };
    assert.deepEqual(await run('officer', 'prices.request_activation', fields), { status: 'pending_second_person', secondPerson: 'commerce.activate_price_version' });
    const request = await pendingRequest(row.digest);
    assert.deepEqual(await decide('owner', request.id, row.digest), { status: 'applied' });
    const answer = await run('officer', 'prices.activate', fields);
    assert.equal(answer.status === 'rejected' && answer.code, 'priced_elsewhere', JSON.stringify(answer));
  });

  await t.test('another hub\'s rows are never shown, even in a list that answers', async () => {
    const stranger = await portOf('owner').prices(otherHubId);
    assert.deepEqual(stranger, { served: false, fees: null, sales: null, usage: null });
  });
});
