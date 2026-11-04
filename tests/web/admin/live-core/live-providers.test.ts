import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import { createApp, type CreatedApp } from '../../../../apps/api/src/app.js';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import type { CommandInput } from '../../../../apps/web/app/admin/_data/commands.js';
import { providerCommand } from '../../../../apps/web/app/admin/_data/live-providers.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { staffRoleDefinitions } from '../../../../packages/data/src/repositories/admin.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../../../backend/helpers/app.js';
import { codeNow } from '../../../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { actors, buildHubWorld, syncKernel, type HubWorld } from '../../../hubs/helpers.js';

/**
 * HC-100 Providers and HC-102 Egress through the console's live adapter on the real API and PostgreSQL: runtime role, real
 * sessions, TOTP, elevated sessions and approvals, fake adapters only, synthetic secrets only. No external call is made.
 */
const h = await startHarness('console_live_providers');
const SLUG = 'synthetic-live-providers';
type Who = 'owner' | 'officer' | 'moderator' | 'outsider';
const WHO: Who[] = ['owner', 'officer', 'moderator', 'outsider'];
const emailOf = (key: Who) => `live-providers-${key.toLowerCase()}@example.invalid`;
const PERMISSIONS = [
  'admin.hub.read', 'admin.hub.residency.edit', 'admin.hub.modes.edit', 'admin.hub.lifecycle.request', 'admin.config.edit', 'admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test',
  'admin.providers.toggle', 'admin.providers.kill', 'admin.providers.egress.edit', 'admin.providers.budget.edit',
];
/** A synthetic key, unique per run, searched for in everything the console reads. */
const CANARY = `synthetic-canary-${randomBytes(12).toString('hex')}`;
const CANARY_NEXT = `synthetic-canary-${randomBytes(12).toString('hex')}`;

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
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_KEK: randomBytes(32).toString('hex'),
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

test('HC-100 and HC-102 through the live adapter', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub(SLUG)).hub_id;
  await withMaintenance(h.db.admin, async (trx) => {
    const release = (role: 'data-steward' | 'ops-engineer' | 'support-agent', permissions: string[]) => staffRoleDefinitions.release(trx, { version: 1, role, scopes: ['hub'], permissions: permissions as never,
      caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await release('data-steward', PERMISSIONS);
    await release('ops-engineer', PERMISSIONS);
    await release('support-agent', ['admin.hub.read', 'admin.providers.read']);
  });
  const scope = { kind: 'hub' as const, hubId };
  await a.assign({ personId: w.people.owner, role: 'data-steward', scope });
  await a.assign({ personId: w.people.officer, role: 'ops-engineer', scope });
  await a.assign({ personId: w.people.moderator, role: 'support-agent', scope });
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
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic provider check', ...body }, { idempotencyKey });
  };
  const portOf = (key: Who) => createApiConsolePort({ api: apiOf(clients[key]), siteHost: () => 'live-providers.example.org', engineVersion: '0.1.0', now: () => h.clock.now() });
  const live = { demo: false } as const;
  const run = (key: Who, command: CommandInput['command'], fields: Record<string, string> = {}) =>
    portOf(key).command(live, { command, hubSlug: SLUG, setupToken: null, reason: 'Synthetic provider check', expectedRevision: null, fields });
  /** The API with the console's own checks stepped over: what a crafted request gets. */
  const direct = (key: Who, command: Parameters<typeof providerCommand>[0], fields: Record<string, string>) => providerCommand(command, fields, {
    hubId, viewerId: w.people[key], form: { currency: 'USD', now: h.clock.now() }, now: h.clock.now(),
    send: (path, rest) => staffPost(key, path, rest).then((r) => ({ status: r.status, code: (r.body as { code?: string } | null)?.code ?? null, body: r.body })),
    saveConfig: async () => ({ status: 'applied' }),
    read: () => portOf('owner').providers(hubId),
    approvals: async () => [],
  });
  const view = async (key: Who = 'owner') => {
    const v = await portOf(key).providers(hubId);
    assert.ok(v, 'the section reads');
    return v;
  };
  const connectionOf = async (adapter: string) => {
    const c = (await view()).connections.find((x) => x.adapterId === adapter);
    assert.ok(c, adapter);
    return c;
  };
  /** The write-only route exactly as `SecretEntry.tsx` calls it: no idempotency header, the value in the body once. */
  const writeSecret = (key: Who, connectionId: string, value: string, revision: number) => clients[key].post(`/v1/admin/hubs/${hubId}/providers/connections/${connectionId}/secret`, {
    contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: randomUUID(), reason: 'Synthetic key', connectionId, value, expectedRevision: revision, graceHours: 24,
  }, { idempotencyKey: null });
  const approveWith = async (digest: string, approver: Who) => {
    const { requests } = await portOf(approver).approvals(hubId);
    const request = requests.find((r) => r.actionDigest.value === digest);
    assert.ok(request, 'the second person sees the request');
    assert.deepEqual(await run(approver, 'approvals.decide', { requestId: request.id, decision: 'approve', digest }), { status: 'applied' });
  };

  for (const key of ['owner', 'officer', 'moderator'] as const) await elevate(key);
  const modes = await staffPost('owner', `/v1/admin/hubs/${hubId}/config`, { domain: 'modes', payload: HUBS[0]!.modes });
  assert.equal(modes.status, 201, JSON.stringify(modes.body));
  const modesVersion = (modes.body as { version: { id: string; revision: number } }).version;
  assert.equal((await staffPost('owner', `/v1/admin/hubs/${hubId}/config/${modesVersion.id}/activate`, { expectedRevision: modesVersion.revision, approvalId: null })).status, 200);

  const fake = { label: 'Synthetic fake', adapterId: 'synthetic_fake', mode: 'fake', 'cap.llm': 'on', hostingKind: 'self_hosted', hostingCountry: 'US' };
  const manual = { label: 'Synthetic manual', adapterId: 'synthetic_manual', mode: 'manual', 'cap.register_lookup': 'on', hostingKind: 'self_hosted', hostingCountry: 'US' };

  await t.test('who reads: staff with a providers permission; no one else', async () => {
    assert.deepEqual((await view('moderator')).connections, []);
    assert.equal(await portOf('outsider').providers(hubId), null);
    const port = createApiConsolePort({ api: apiOf(unelevated), siteHost: () => 'x', engineVersion: '0', now: () => h.clock.now() });
    assert.equal(await port.providers(hubId), null, 'a session without an elevation reads nothing');
  });

  await t.test('a fake connection: added, tested, enabled by one person, disabled; a reader is refused twice; no external call', async () => {
    const denied = await run('moderator', 'providers.connection_create', fake);
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    const api = await direct('moderator', 'providers.connection_create', fake);
    assert.equal(api.status === 'rejected' && api.code, 'denied', 'the API refuses a reader');
    const none = await run('owner', 'providers.connection_create', { ...fake, 'cap.llm': '' });
    assert.equal(none.status === 'rejected' && none.field, 'capabilities');
    const restricted = await run('owner', 'providers.connection_create', { ...fake, adapterId: 'synthetic_ru', hostingCountry: 'RU' });
    assert.deepEqual(restricted.status === 'rejected' && [restricted.code, restricted.detail], ['provider_reason', ['restricted_place']], JSON.stringify(restricted));
    assert.deepEqual(await run('owner', 'providers.connection_create', fake), { status: 'applied' });
    const c = await connectionOf('synthetic_fake');
    assert.deepEqual([c.status, c.mode, c.lastTest], ['draft', 'fake', null]);
    const fields = { connectionId: c.id };
    const untested = await run('owner', 'providers.connection_enable', fields);
    assert.deepEqual(untested.status === 'rejected' && [untested.code, untested.detail], ['provider_reason', ['test_required']], JSON.stringify(untested));
    assert.deepEqual(await run('owner', 'providers.connection_test', fields), { status: 'applied' });
    assert.equal((await connectionOf('synthetic_fake')).lastTest?.outcome, 'ok');
    assert.deepEqual(await run('owner', 'providers.connection_enable', fields), { status: 'applied' });
    assert.equal((await connectionOf('synthetic_fake')).status, 'enabled');
    assert.deepEqual(await run('officer', 'providers.connection_disable', fields), { status: 'applied' });
    assert.equal((await connectionOf('synthetic_fake')).status, 'disabled');
    const refused = await writeSecret('owner', c.id, CANARY, (await connectionOf('synthetic_fake')).revision);
    assert.equal((refused.body as { details?: { reason?: string } }).details?.reason, 'fake_holds_no_secret');
  });

  await t.test('a secret: written once through the route, never read back; a rotation keeps a fingerprint; a reader cannot write or revoke', async () => {
    assert.deepEqual(await run('owner', 'providers.connection_create', manual), { status: 'applied' });
    const c = await connectionOf('synthetic_manual');
    const denied = await writeSecret('moderator', c.id, CANARY, c.revision);
    assert.equal(denied.status, 403, 'a reader writes no key');
    const written = await writeSecret('owner', c.id, CANARY, c.revision);
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.ok(!JSON.stringify(written.body).includes(CANARY), 'the answer holds a reference, not the value');
    const first = await connectionOf('synthetic_manual');
    assert.deepEqual(first.secret.versions.map((v) => [v.ref.version, v.status]), [[1, 'active']]);
    assert.match(first.secret.versions[0]!.ref.keyedFingerprint, /^[a-f0-9]{12}$/);
    const rotated = await writeSecret('owner', c.id, CANARY_NEXT, first.revision);
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
    const second = await view('moderator');
    const text = JSON.stringify(second);
    assert.ok(!text.includes(CANARY) && !text.includes(CANARY_NEXT), 'no value in anything the console reads');
    assert.deepEqual(second.connections.find((x) => x.id === c.id)?.secret.versions.map((v) => v.status), ['active', 'grace']);
    const stale = await writeSecret('owner', c.id, CANARY, first.revision);
    assert.ok(stale.status >= 400, 'a key is refused against a revision the page no longer shows');
    const revoke = await direct('moderator', 'providers.secret_revoke', { connectionId: c.id });
    assert.equal(revoke.status === 'rejected' && revoke.code, 'denied');
  });

  await t.test('a connection that is not fake is enabled through a second person, by the person who asked, once', async () => {
    const c0 = await connectionOf('synthetic_manual');
    const fields = { connectionId: c0.id };
    assert.deepEqual(await run('owner', 'providers.connection_test', fields), { status: 'applied' });
    const c = await connectionOf('synthetic_manual');
    assert.ok(c.enable, 'a passing test gives a digest to approve');
    assert.deepEqual(await run('owner', 'providers.connection_enable', fields), { status: 'pending_second_person', secondPerson: 'providers.enable_non_fake' });
    const again = await run('owner', 'providers.connection_enable', fields);
    assert.equal(again.status === 'rejected' && again.code, 'second_person_pending', 'a waiting request is not doubled');
    const own = await run('owner', 'approvals.decide', { requestId: (await portOf('officer').approvals(hubId)).requests.find((r) => r.actionDigest.value === c.enable!.actionDigest)!.id, decision: 'approve', digest: c.enable.actionDigest });
    assert.equal(own.status === 'rejected' && own.code, 'own_request');
    await approveWith(c.enable.actionDigest, 'officer');
    const other = await run('officer', 'providers.connection_enable', fields);
    assert.equal(other.status === 'rejected' && other.code, 'second_person_pending', 'only the requester executes the approval');
    const answers = await Promise.all([run('owner', 'providers.connection_enable', fields), run('owner', 'providers.connection_enable', fields)]);
    assert.equal(answers.filter((r) => r.status === 'applied').length, 1, JSON.stringify(answers));
    assert.equal((await connectionOf('synthetic_manual')).status, 'enabled');
  });

  await t.test('a kill switch stops at once and is released through a second person with the same note', async () => {
    const c = await connectionOf('synthetic_manual');
    const reader = await run('moderator', 'providers.kill_engage', { connectionId: c.id });
    assert.equal(reader.status === 'rejected' && reader.code, 'denied');
    assert.deepEqual(await run('owner', 'providers.kill_engage', { connectionId: c.id }), { status: 'applied' });
    const killed = await connectionOf('synthetic_manual');
    assert.equal(killed.status, 'killed');
    const fields = { killSwitchId: killed.killSwitchId!, incidentNote: 'Synthetic incident' };
    assert.deepEqual(await run('owner', 'providers.kill_release', fields), { status: 'pending_second_person', secondPerson: 'kill_switch.release' });
    const twice = await run('owner', 'providers.kill_release', fields);
    assert.equal(twice.status === 'rejected' && twice.code, 'second_person_pending');
    const { requests } = await portOf('officer').approvals(hubId);
    const request = requests.find((r) => r.action === 'kill_switch.release')!;
    assert.deepEqual(await run('officer', 'approvals.decide', { requestId: request.id, decision: 'approve', digest: request.actionDigest.value }), { status: 'applied' });
    assert.equal((await connectionOf('synthetic_manual')).status, 'killed', 'approved is not released yet');
    const otherNote = await run('owner', 'providers.kill_release', { ...fields, incidentNote: 'Another synthetic note' });
    assert.equal(otherNote.status, 'pending_second_person', 'another note is another request');
    assert.deepEqual(await run('owner', 'providers.kill_release', fields), { status: 'applied' });
    assert.notEqual((await connectionOf('synthetic_manual')).status, 'killed');
  });

  await t.test('a credential holds a name, never a value, and a non-fake one is activated by two people', async () => {
    const reader = await run('moderator', 'providers.credential_register', { credProvider: 'synthetic_reg', credAdapter: 'synthetic_reg_api', credMode: 'live', credStore: 'env', credRef: 'env:SYNTHETIC_REG' });
    assert.equal(reader.status === 'rejected' && reader.code, 'denied');
    const value = await run('owner', 'providers.credential_register', { credProvider: 'synthetic_reg', credAdapter: 'synthetic_reg_api', credMode: 'live', credStore: 'env', credRef: `sk-${'a'.repeat(40)}` });
    assert.equal(value.status, 'rejected', 'a reference shaped like a key is refused');
    assert.deepEqual(await run('owner', 'providers.credential_register', { credProvider: 'synthetic_reg', credAdapter: 'synthetic_reg_api', credMode: 'live', credStore: 'env', credRef: 'env:SYNTHETIC_REG' }), { status: 'applied' });
    const credential = (await view()).credentials!.find((c) => c.provider === 'synthetic_reg')!;
    assert.deepEqual([credential.status, credential.secret], ['registered', { store: 'env', ref: 'env:SYNTHETIC_REG' }]);
    const fields = { credentialId: credential.id };
    assert.deepEqual(await run('owner', 'providers.credential_activate', fields), { status: 'pending_second_person', secondPerson: 'providers.enable_non_fake' });
    await approveWith(credential.activation!.actionDigest, 'officer');
    assert.deepEqual(await run('owner', 'providers.credential_activate', fields), { status: 'applied' });
    assert.equal((await view()).credentials!.find((c) => c.id === credential.id)?.status, 'active');
    assert.deepEqual(await run('officer', 'providers.credential_retire', fields), { status: 'applied' });
    assert.equal((await view()).credentials!.find((c) => c.id === credential.id)?.status, 'retired');
  });

  await t.test('a model cost is recorded and changes no price', async () => {
    const c = await connectionOf('synthetic_fake');
    const fields = { priceConnection: c.id, priceModel: 'synthetic-model-1', priceInput: '3', priceOutput: '', priceBasis: 'contract', priceNote: 'Synthetic' };
    const denied = await direct('moderator', 'providers.pricing_record', fields);
    assert.equal(denied.status === 'rejected' && denied.code, 'denied');
    const empty = await run('owner', 'providers.pricing_record', { ...fields, priceInput: '' });
    assert.equal(empty.status === 'rejected' && empty.field, 'priceInput');
    assert.deepEqual(await run('owner', 'providers.pricing_record', fields), { status: 'applied' });
    assert.deepEqual((await view()).costs?.map((r) => [r.modelId, r.inputPerMillionTokens, r.outputPerMillionTokens, r.version]), [['synthetic-model-1', '3', null, 1]]);
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.price_version')).rows[0].n, 0);
  });

  await t.test('egress: default deny; public by one person; non-public by two, never for a vendor that trains; the review reaches the launch gate', async () => {
    const c = await connectionOf('synthetic_manual');
    const gate = async () => ((await clients.owner.get(`/v1/admin/hubs/${hubId}/launch`)).body as { gates: Array<{ gate: string; engineConfirms: boolean }> }).gates.find((g) => g.gate === 'ai_egress_policy_reviewed')?.engineConfirms;
    assert.deepEqual((await view()).egress?.cells, [], 'a missing cell is a denial');
    const publicCell = { egressConnection: c.id, egressClass: 'public', egressDecision: 'allow' };
    const reader = await direct('moderator', 'providers.egress_set', publicCell);
    assert.equal(reader.status === 'rejected' && reader.code, 'denied');
    assert.deepEqual(await run('owner', 'providers.egress_set', publicCell), { status: 'applied' });
    assert.deepEqual((await view()).egress?.cells.map((r) => [r.dataClass, r.decision]), [['public', 'allow']]);

    const outside = await run('owner', 'providers.egress_set', { egressConnection: c.id, egressClass: 'company_private', egressDecision: 'allow' });
    assert.deepEqual(outside.status === 'rejected' && [outside.code, outside.detail], ['provider_reason', ['egress_not_in_residency']], JSON.stringify(outside));
    const drafted = await staffPost('owner', `/v1/admin/hubs/${hubId}/config`, { domain: 'residency', payload: { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] } });
    const version = (drafted.body as { version: { id: string; revision: number; activation: { actionDigest: string } } }).version;
    assert.equal((await staffPost('officer', `/v1/admin/hubs/${hubId}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: null })).status, 200);
    await approveWith(version.activation.actionDigest, 'owner');
    const request = (await portOf('officer').approvals(hubId)).ready?.find((r) => r.target.id === version.id);
    assert.ok(request);
    assert.equal((await staffPost('officer', `/v1/admin/hubs/${hubId}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: request.requestId })).status, 200);

    const privateCell = { egressConnection: c.id, egressClass: 'company_private', egressDecision: 'allow' };
    assert.deepEqual(await run('owner', 'providers.egress_set', privateCell), { status: 'pending_second_person', secondPerson: 'egress.allow_private_class' });
    const twice = await run('owner', 'providers.egress_set', privateCell);
    assert.equal(twice.status === 'rejected' && twice.code, 'second_person_pending');
    const { requests } = await portOf('officer').approvals(hubId);
    const open = requests.find((r) => r.action === 'egress.allow_private_class')!;
    assert.deepEqual(await run('officer', 'approvals.decide', { requestId: open.id, decision: 'approve', digest: open.actionDigest.value }), { status: 'applied' });
    assert.equal((await view()).egress?.cells.some((r) => r.dataClass === 'company_private'), false, 'approved is not applied yet');
    assert.deepEqual(await run('owner', 'providers.egress_set', privateCell), { status: 'applied' });
    assert.deepEqual((await view()).egress?.cells.find((r) => r.dataClass === 'company_private')?.decision, 'allow');

    assert.deepEqual(await run('owner', 'providers.connection_create', { label: 'Synthetic trainer', adapterId: 'synthetic_trainer', mode: 'manual', 'cap.llm': 'on', hostingKind: 'vendor', hostingCountry: 'US', trainsOnInputs: 'on' }), { status: 'applied' });
    const trainer = await connectionOf('synthetic_trainer');
    const trains = await run('owner', 'providers.egress_set', { egressConnection: trainer.id, egressClass: 'person_private', egressDecision: 'allow' });
    assert.deepEqual(trains.status === 'rejected' && [trains.code, trains.detail], ['provider_reason', ['egress_training']], JSON.stringify(trains));

    assert.equal(await gate(), false);
    assert.equal((await view()).egressReview, null);
    const signoff = await run('owner', 'providers.egress_signoff');
    assert.deepEqual(signoff, { status: 'draft_saved', secondPerson: 'egress.allow_private_class' });
    const waiting = (await portOf('officer').approvals(hubId)).waiting?.find((x) => x.target.label === 'egress');
    assert.ok(waiting, 'the drafted review waits in Approvals');
    assert.equal((await run('officer', 'approvals.request_activation', { targetId: waiting.target.id })).status, 'pending_second_person');
    const review = (await portOf('owner').approvals(hubId)).requests.find((r) => r.action === 'egress.allow_private_class')!;
    assert.deepEqual(await run('owner', 'approvals.decide', { requestId: review.id, decision: 'approve', digest: review.actionDigest.value }), { status: 'applied' });
    assert.deepEqual(await run('officer', 'approvals.apply', { requestId: review.id }), { status: 'applied' });
    assert.equal(await gate(), true);
    assert.deepEqual((await view()).egressReview, { version: 1 });
  });
});
