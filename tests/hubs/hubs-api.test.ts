import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION, HubSchema, LAUNCH_GATES, ConsoleCommandResultSchema } from '@trustwork/contracts';
import { LaunchChecklistSchema } from '../../packages/contracts/src/hub-core.js';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { HubsService } from '../../apps/api/src/modules/hubs/hubs.service.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, expectRefusal, PASSWORD, signIn } from '../admin/helpers.js';
import { actors, buildHubWorld, syncKernel, US_HUB, type HubWorld, type Key } from './helpers.js';

const h = await startHarness('hubs_api');
const emailOf = (key: Key) => `hubs-${key.toLowerCase()}@example.invalid`;
type Staff = 'operator' | 'owner' | 'officer' | 'moderator';
const STAFF: Staff[] = ['operator', 'owner', 'officer', 'moderator'];

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

/**
 * HUB-001 through the HTTP API on real PostgreSQL under the runtime role, with real sessions, TOTP and elevated
 * sessions: the reference hub (United States, San Diego, demo-only) gets its CFG-001 deployment settings as
 * configuration version 1, a sensitive domain goes through the second-person path of `/v1/admin/approvals`, and the
 * lifecycle refuses soft launch with open gates.
 */
test('hubs API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-us-reference')).hub_id;
  await a.assignSensitive({ personId: w.people.owner, role: 'hub-owner', scope: { kind: 'hub', hubId } });
  await a.assignSensitive({ personId: w.people.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId } });
  await a.assign({ personId: w.people.moderator, role: 'moderator', scope: { kind: 'hub', hubId } });
  await addLogins(h, ([...STAFF, 'outsider'] as const).map((k) => [w.people[k], emailOf(k)]));
  const app = await apiFor(h, hubId);
  t.after(async () => { await app.close(); await h.close(); });

  const clients = {} as Record<Staff | 'outsider', Client>;
  const secrets = {} as Record<Staff, Buffer>;
  for (const key of [...STAFF, 'outsider'] as const) {
    clients[key] = new Client(app);
    await signIn(clients[key], emailOf(key));
    if (key !== 'outsider') secrets[key] = await enrolNow(h, clients[key]);
  }
  const elevate = async (key: Staff) => {
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const command = (key: Staff | 'outsider', url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const idempotencyKey = `hub-${randomUUID()}`;
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic hub console action', ...body }, { idempotencyKey });
  };
  const ok = (response: Response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body as Record<string, unknown> & { result: { outcome: string; approvalRequestId: string | null; objectId: string; revision: number } };
  };
  const base = `/v1/admin/hubs/${hubId}`;

  await t.test('negative: anonymous, participants and unelevated staff never reach the hub console', async () => {
    expectRefusal(await new Client(app).get(base), 401, 'auth.session_invalid');
    expectRefusal(await clients.outsider.get(base), 403, 'access.forbidden', 'staff');
    expectRefusal(await command('outsider', `${base}/config`, { domain: 'identity', payload: { schemaVersion: 1 } }), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.owner.get(base), 403, 'access.forbidden', 'elevation');
    expectRefusal(await command('owner', `${base}/config`, { domain: 'identity', payload: { schemaVersion: 1 } }), 403, 'access.forbidden', 'elevation');
  });

  for (const key of STAFF) await elevate(key);

  await t.test('the reference hub reads as a contract hub: United States, San Diego, English first, a draft with every gate open', async () => {
    const view = ok(await clients.owner.get(base)) as unknown as { hub: unknown };
    const hub = HubSchema.parse(view.hub);
    assert.equal(hub.lifecycle, 'draft');
    assert.deepEqual(hub.territories.map((x) => x.code), ['US', 'US-CA', 'US-CA:san-diego']);
    assert.equal(hub.defaultLocale, 'en');
    assert.equal(hub.currency, 'USD');
    const checklist = LaunchChecklistSchema.parse(ok(await clients.owner.get(`${base}/launch`)));
    assert.equal(checklist.gates.filter((g) => g.state === 'open').length, LAUNCH_GATES.length);
    assert.ok(checklist.blockers.soft_launch.includes('modes:demo_data_only_before_soft_launch'), 'a demo hub never soft-launches');
  });

  await t.test('creating hubs: node staff only, restricted territories refused with the refused place', async () => {
    const body = { slug: 'synthetic-second-hub', ...US_HUB, territories: [{ level: 'country', code: 'US' }, { level: 'region', code: 'UA-43' }] };
    expectRefusal(await command('owner', '/v1/admin/hubs', body), 403, 'access.forbidden', 'forbidden');
    const refused = await command('operator', '/v1/admin/hubs', body);
    expectRefusal(refused, 422, 'validation.schema', 'restricted_place');
    assert.deepEqual((refused.body as { details: { items: string[] } }).details.items, ['UA-43']);
    const created = ok(await command('operator', '/v1/admin/hubs', { ...body, territories: [{ level: 'country', code: 'MX' }], slug: 'synthetic-mexico-demo', currency: 'MXN', timeZone: 'America/Mexico_City' }), 201);
    ConsoleCommandResultSchema.parse(created.result);
    assert.equal(created.result.outcome, 'applied');
    const audit = (await h.db.admin.query("SELECT scope_kind, actor_person_id FROM trustwork.admin_audit_event WHERE action = 'hub.created' AND object_id = $1", [created.result.objectId])).rows;
    assert.deepEqual(audit, [{ scope_kind: 'node', actor_person_id: w.people.operator }]);
  });

  await t.test('CFG-001 deployment settings become configuration version 1 of identity and country, once', async () => {
    const deployment = { schemaVersion: 1, countries: { default: 'US', offered: 'all', featured: ['US'] }, languages: { default: 'en', enabled: ['en', 'es'], byCountry: { US: 'en' } }, brand: { overlay: null }, dataDir: './data' };
    expectRefusal(await command('owner', `${base}/config/import-deployment`, { deployment: { ...deployment, countries: { default: 'RU' } } }), 422, 'validation.schema', 'restricted_place');
    const imported = ok(await command('owner', `${base}/config/import-deployment`, { deployment }), 201) as unknown as { versions: Array<{ domain: string; version: number; status: string; source: string; payload: Record<string, unknown> }> };
    assert.deepEqual(imported.versions.map((v) => [v.domain, v.version, v.status, v.source]), [['identity', 1, 'active', 'deployment_import'], ['country', 1, 'active', 'deployment_import']]);
    assert.deepEqual(imported.versions[0]!.payload, { schemaVersion: 1, languages: deployment.languages, brand: deployment.brand });
    assert.deepEqual(imported.versions[1]!.payload, { schemaVersion: 1, countries: deployment.countries });
    expectRefusal(await command('owner', `${base}/config/import-deployment`, { deployment }), 409, 'validation.revision_conflict', 'already_configured');
    // The runtime loader reads the active settings without a principal.
    const settings = await app.app.get(HubsService).deploymentSettings(hubId);
    assert.deepEqual(settings.country, { schemaVersion: 1, countries: deployment.countries });
  });

  await t.test('a sensitive domain is activated by another person than its drafter, under a second person\'s approval through the approvals route', async () => {
    const drafted = ok(await command('owner', `${base}/config`, { domain: 'residency', payload: { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] } }), 201) as unknown as { version: { id: string; revision: number; activation: { secondPersonAction: string; actionDigest: string } } };
    const v = drafted.version;
    assert.equal(v.activation.secondPersonAction, 'hub.change_residency');
    expectRefusal(await command('owner', `${base}/config/${v.id}/activate`, { expectedRevision: v.revision, approvalId: null }), 403, 'access.second_approver_required', 'self_approval');
    const pending = ok(await command('officer', `${base}/config/${v.id}/activate`, { expectedRevision: v.revision, approvalId: null }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    const approvalId = pending.result.approvalRequestId as string;
    // The requester never approves; the drafter may.
    expectRefusal(await command('officer', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: v.activation.actionDigest }), 403, 'access.second_approver_required');
    expectRefusal(await command('owner', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: 'f'.repeat(64) }), 409, 'access.approval_digest_mismatch');
    ok(await command('owner', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: v.activation.actionDigest }));
    const applied = ok(await command('officer', `${base}/config/${v.id}/activate`, { expectedRevision: v.revision, approvalId }));
    assert.equal(applied.result.outcome, 'applied');
    const current = ok(await clients.owner.get(`${base}/config/current`)) as unknown as { items: Array<{ domain: string; status: string; activatedBy: string; approvalId: string | null }> };
    assert.deepEqual(current.items.find((x) => x.domain === 'residency'), { ...current.items.find((x) => x.domain === 'residency'), status: 'active', activatedBy: w.people.officer, approvalId });
  });

  await t.test('payloads: access-widening keys, restricted places and malformed domains are refused; nothing is stored', async () => {
    const before = (await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.hub_config_version')).rows[0].n;
    expectRefusal(await command('owner', `${base}/config`, { domain: 'matching', payload: { policy: { staffReadPrivate: true } } }), 422, 'validation.schema', 'payload_invalid');
    expectRefusal(await command('owner', `${base}/config`, { domain: 'identity', payload: { schemaVersion: 1, languages: { byCountry: { CU: 'es' } } } }), 422, 'validation.schema', 'restricted_place');
    expectRefusal(await command('owner', `${base}/config`, { domain: 'residency', payload: { hostingCountry: 'US' } }), 422, 'validation.schema', 'payload_invalid');
    expectRefusal(await command('owner', `${base}/config`, { domain: 'privacy', payload: { retention: [{ class: 'accounting', minPeriod: 'P7Y', maxPeriod: 'P1Y', packFactRef: null, disclosureTextKey: null }] } }), 422, 'validation.schema', 'payload_invalid');
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.hub_config_version')).rows[0].n, before);
  });

  await t.test('staff without the permission are refused by the database and the attempt is audited as denied', async () => {
    expectRefusal(await command('moderator', `${base}/config`, { domain: 'identity', payload: { schemaVersion: 1 } }), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await command('moderator', `${base}/lifecycle`, { to: 'preparing', expectedRevision: 1, approvalId: null }), 403, 'access.forbidden', 'forbidden');
    const denied = (await h.db.admin.query("SELECT action, outcome FROM trustwork.admin_audit_event WHERE actor_person_id = $1 AND outcome = 'denied' ORDER BY sequence", [w.people.moderator])).rows;
    assert.deepEqual(denied.map((r) => r.action), ['hub.config_drafted', 'hub.lifecycle_changed']);
  });

  await t.test('the lifecycle: preparing by one person; soft launch refused with the open gates and no approval is requested', async () => {
    const hub = (ok(await clients.owner.get(base)) as unknown as { hub: { revision: number } }).hub;
    const preparing = ok(await command('owner', `${base}/lifecycle`, { to: 'preparing', expectedRevision: hub.revision, approvalId: null }));
    assert.equal(preparing.result.outcome, 'applied');
    const approvalsBefore = (await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.second_person_approval')).rows[0].n;
    const refused = await command('owner', `${base}/lifecycle`, { to: 'soft_launch', expectedRevision: preparing.result.revision, approvalId: null });
    expectRefusal(refused, 422, 'validation.schema', 'launch_gate_open');
    assert.ok((refused.body as { details: { items: string[] } }).details.items.includes('gate:legal_documents_counsel_approved'));
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.second_person_approval')).rows[0].n, approvalsBefore, 'no approval request for an impossible transition');
    expectRefusal(await command('owner', `${base}/lifecycle`, { to: 'public', expectedRevision: preparing.result.revision, approvalId: null }), 422, 'validation.schema', 'launch_gate_open');
    expectRefusal(await command('owner', `${base}/launch/check`, { gate: 'demo_data_purged', evidenceRef: randomUUID() }), 422, 'validation.schema', 'gate_precondition');
    const fine = ok(await command('owner', `${base}/launch/check`, { gate: 'data_residency_configured', evidenceRef: randomUUID() }));
    assert.equal((fine as unknown as { gate: { state: string } }).gate.state, 'passed');
  });

  await t.test('participants: no legal text of a hub before launch', async () => {
    expectRefusal(await clients.outsider.post(`/v1/hubs/${hubId}/legal/${randomUUID()}/accept`, { context: 'signup' }, { idempotencyKey: `acc-${randomUUID()}` }), 404, 'access.not_found');
    assert.deepEqual((await clients.outsider.get(`/v1/hubs/${hubId}/legal`)).body, { documents: [] });
  });
});
