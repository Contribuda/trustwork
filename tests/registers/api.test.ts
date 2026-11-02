import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { PublicSourcedFactSchema } from '../../packages/contracts/src/sourced-facts.js';
import { SKIP_REASON, startHarness, type Client, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../admin/helpers.js';
import { staffRoleDefinitions } from '../../packages/data/src/repositories/admin.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../hubs/helpers.js';

const h = await startHarness('registers_api');
const PERMISSIONS = ['admin.sources.read', 'admin.sources.manage', 'admin.sources.dedupe.decide'];
const USES = {
  displayHeadlineAndLink: true, displaySummary: true, storeFullText: false, indexForSearch: true, sendToModelProviders: false, translate: false, rewriteWithAttribution: false,
  reuseImages: false, syndicateToPeers: false,
};

/**
 * REG-001 through the HTTP API on real PostgreSQL with real sessions, TOTP and elevated sessions: staff routes refuse a
 * participant, an unelevated staff member and staff of another hub; a person never types a fact (the fake run takes
 * subjects only); the public route of the served hub answers without a session with PublicSourcedFactSchema rows only,
 * never a fact about a natural person or an identifier value outside the register link; company reminders are for the
 * company's administrators. Every person, hub, company, identifier and source is synthetic.
 */
test('REG-001 registers API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const admin = h.db.admin;
  await syncKernel(admin);
  const w: HubWorld = await buildHubWorld(admin);
  const a = actors(admin, h.pool, w);
  await withMaintenance(admin, (trx) => staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['hub'], permissions: PERMISSIONS as never,
    caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null }));
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-registers-api')).hub_id;
  const otherHubId = (await a.createHub('synthetic-registers-other')).hub_id;
  const seeded = await withMaintenance(admin, async (trx) => {
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    const people = { staff: await person('Synthetic Registers Staff'), second: await person('Synthetic Registers Second Steward'), elsewhere: await person('Synthetic Other Hub Steward'),
      participant: await person('Synthetic Participant'), administrator: await person('Synthetic Company Administrator') };
    const companyId = (await trx.insertInto('company').values({ display_name: 'Synthetic Registers API Builders', claim_status: 'claimed',
      legal_identifiers: JSON.stringify([{ kind: 'US-CA-CSLB', value: '7000001', status: 'claimed' }, { kind: 'US-CA-CSLB', value: '7000002', status: 'claimed' }]) } as never)
      .returning('id').executeTakeFirstOrThrow()).id;
    await trx.insertInto('membership').values({ person_id: people.administrator, company_id: companyId, role: 'administrator', permissions: ['company.members.manage'], status: 'active',
      valid_from: new Date('2026-10-01T09:00:00Z') }).execute();
    const sourceId = (await trx.insertInto('source').values({
      hub_id: hubId, kind: 'register_open_data', name: 'Synthetic API Licence Board', url: 'https://board.synthetic-api.invalid/data', reader_kind: 'official_register',
      purposes: ['company_directory'], licence_kind: 'statutory_public', allowed_uses: JSON.stringify(USES), attribution_template: 'Source: Synthetic API Licence Board',
      takedown_contact: 'records@synthetic-api.invalid', owner_person_id: people.staff, personal_data: false, proposed_by_person: people.staff, edited_by: people.staff, status: 'active',
      activated_by: people.second, activated_at: new Date(),
    } as never).returning('id').executeTakeFirstOrThrow()).id;
    return { people, companyId, sourceId };
  });
  await a.assign({ personId: seeded.people.staff, role: 'data-steward' as never, scope: { kind: 'hub', hubId } });
  await a.assign({ personId: seeded.people.elsewhere, role: 'data-steward' as never, scope: { kind: 'hub', hubId: otherHubId } });
  const { people, companyId, sourceId } = seeded;
  const email = (k: string) => `registers-api-${k}@example.invalid`;
  await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
  const clients = {} as Record<'staff' | 'elsewhere' | 'participant' | 'administrator' | 'unelevated', Client>;
  clients.unelevated = h.client();
  await signIn(clients.unelevated, email('staff'));
  for (const key of ['staff', 'elsewhere', 'participant', 'administrator'] as const) {
    clients[key] = h.client();
    await signIn(clients[key], email(key));
    if (key === 'participant' || key === 'administrator') continue;
    h.staff.set(people[key], ['data-steward']);
    const secret = await enrolNow(h, clients[key]);
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    assert.equal((await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null })).status, 200);
    h.clock.reset();
  }
  const base = `/v1/admin/hubs/${hubId}/registers`;
  const send = (client: Client, url: string, rest: Record<string, unknown>): Promise<Response> => {
    const key = `registers-${randomUUID()}`;
    return client.post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: key, reason: 'Synthetic registers action', ...rest }, { idempotencyKey: key });
  };
  const code = (r: Response) => (r.body as { code?: string } | null)?.code;
  const bind = { adapter: 'us_ca_cslb_licence_file', sourceId, refreshDays: 7 };

  await t.test('negative authorization: participant, unelevated staff, staff of another hub', async () => {
    for (const client of [clients.participant, clients.unelevated]) {
      const r = await send(client, `${base}/adapters`, bind);
      assert.equal(r.status, 403, JSON.stringify(r.body));
    }
    const elsewhere = await send(clients.elsewhere, `${base}/adapters`, bind);
    assert.equal(elsewhere.status, 403, JSON.stringify(elsewhere.body));
    assert.equal(code(elsewhere), 'access.forbidden');
    const read = await clients.elsewhere.get(`${base}/companies/${companyId}/facts`);
    assert.equal(read.status, 404, JSON.stringify(read.body));
    const overview = await clients.participant.get(base);
    assert.equal(overview.status, 403, JSON.stringify(overview.body));
  });

  let adapterId = '';
  await t.test('a steward binds an adapter and runs the fake with subjects only', async () => {
    const bound = await send(clients.staff, `${base}/adapters`, bind);
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    adapterId = (bound.body as { adapter: { id: string; mode: string } }).adapter.id;
    assert.equal((bound.body as { adapter: { mode: string } }).adapter.mode, 'fake');
    const typed = await send(clients.staff, `${base}/adapters/${adapterId}/fake-runs`, { subjects: [{ identifierValue: '7000001', value: { status: 'active' } }] });
    assert.equal(typed.status, 422, 'a person cannot type a fact');
    const run = await send(clients.staff, `${base}/adapters/${adapterId}/fake-runs`, { subjects: [{ identifierValue: '7000001' }, { identifierValue: '7000002' }] });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const items = (run.body as { items: Array<{ kind: string; link: string; recordedBy: string }> }).items;
    assert.equal(items.length, 2);
    assert.ok(items.every((f) => f.kind === 'licence_status' && f.link.startsWith('https://synthetic-register.invalid/') && f.recordedBy === people.staff));
    const staffView = await clients.staff.get(`${base}/companies/${companyId}/facts`);
    assert.equal(staffView.status, 200);
    assert.equal((staffView.body as { items: unknown[] }).items.length, 2);
    const overview = await clients.staff.get(base);
    assert.equal(overview.status, 200);
    assert.ok((overview.body as { catalogue: Array<{ id: string }> }).catalogue.some((c) => c.id === 'gleif_lei'));
    const duplicate = await send(clients.staff, `${base}/adapters`, bind);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    const wrongHub = await clients.elsewhere.get(`/v1/admin/hubs/${otherHubId}/registers/adapters/${adapterId}/facts`);
    assert.equal(wrongHub.status, 404, 'an adapter of another hub is not found');
  });

  await t.test('the public route of the served hub shows only the public projection, without a session', async () => {
    const previous = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = hubId;
    try {
      const anonymous = h.client();
      const r = await anonymous.get(`/v1/companies/${companyId}/sourced-facts`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const out = r.body as { hubConfigured: boolean; items: unknown[] };
      assert.equal(out.hubConfigured, true);
      const staffItems = (await clients.staff.get(`${base}/companies/${companyId}/facts`)).body as { items: Array<{ subject: { holderKind: string } }> };
      assert.equal(out.items.length, staffItems.items.filter((f) => f.subject.holderKind === 'organisation').length, 'natural persons never reach the public route');
      for (const item of out.items) {
        assert.deepEqual(Object.keys(PublicSourcedFactSchema.parse(item)).sort(), Object.keys(item as object).sort());
        assert.ok(!('subject' in (item as object)) && !('recordedBy' in (item as object)));
      }
    } finally {
      if (previous === undefined) delete process.env.TRUSTWORK_HUB_ID; else process.env.TRUSTWORK_HUB_ID = previous;
    }
    const unconfigured = await h.client().get(`/v1/companies/${companyId}/sourced-facts`);
    assert.equal(unconfigured.status, 200);
    assert.deepEqual(unconfigured.body, { hubConfigured: false, items: [] });
  });

  await t.test('company reminders are for the company\'s administrators only', async () => {
    const own = await clients.administrator.get(`/v1/companies/${companyId}/register-reminders`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.ok(Array.isArray((own.body as { items: unknown[] }).items));
    const other = await clients.participant.get(`/v1/companies/${companyId}/register-reminders`);
    assert.equal(other.status, 404, JSON.stringify(other.body));
    const anonymous = await h.client().get(`/v1/companies/${companyId}/register-reminders`);
    assert.equal(anonymous.status, 401);
  });
});
