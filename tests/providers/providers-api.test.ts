import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { computeDigest, ConsoleCommandResultSchema, HUB_CONSOLE_CONTRACT_VERSION, SecretRefSchema } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { FakeProviderAdapter, ProviderAdapterRegistry } from '../../apps/api/src/modules/providers/adapters.js';
import { ProviderCallGate } from '../../apps/api/src/modules/providers/gate.js';
import { ConnectionViewSchema, ProviderCallDecisionSchema, providerKillReleaseDigestInput, syntheticProbesFor } from '../../packages/contracts/src/providers.js';
import { Client, SKIP_REASON, startHarness, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, expectRefusal, PASSWORD, signIn } from '../admin/helpers.js';
import { activateResidency, actors, buildProvidersWorld, setUpHubs, syncKernel, VENDOR_US, type HubWorld } from './helpers.js';

const h = await startHarness('providers_api');
type Staff = 'owner' | 'officer' | 'moderator';
const STAFF: Staff[] = ['owner', 'officer', 'moderator'];
const emailOf = (key: string) => `providers-${key.toLowerCase()}@example.invalid`;

/** Canary secrets: key-shaped, unique per run, and searched for everywhere afterwards. */
const CANARY = `sk-canary-${randomBytes(20).toString('hex')}`;
const CANARY_ROTATED = `sk-canary-rotated-${randomBytes(20).toString('hex')}`;
const CANARIES = [CANARY, CANARY_ROTATED];
const encodings = (s: string) => [s, Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url')];

/**
 * KEYS-001 through the HTTP API on real PostgreSQL under the runtime role, with real sessions, TOTP and elevated
 * sessions. The headline check: seeded canary secrets go in through the write-only endpoint, reach the (fake) adapter
 * decrypted, and appear in no API response, log line, audit event, change-log row, outbox payload, idempotency record
 * or any other table of the database.
 */
test('providers API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildProvidersWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  const { hubA } = await setUpHubs(a, w, 'synthetic-providers-api');
  await activateResidency(a, w.people.owner, w.people.officer, hubA, ['US']);
  await addLogins(h, ([...STAFF, 'outsider', 'otherOwner'] as const).map((k) => [w.people[k], emailOf(k)]));
  const logs: string[] = [];
  const live = new FakeProviderAdapter('openai_compatible');
  const app: CreatedApp = await createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: hubA,
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'), TRUSTWORK_KEK: randomBytes(32).toString('hex'),
    },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { logs.push(line); if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  // The live adapter registered on the module's registry (LLM-001 registers its adapters the same way).
  app.app.get(ProviderAdapterRegistry).register(live);
  t.after(async () => { await app.close(); await h.close(); });

  const clients = {} as Record<Staff | 'outsider' | 'otherOwner', Client>;
  const totp = {} as Record<Staff, Buffer>;
  for (const key of [...STAFF, 'outsider', 'otherOwner'] as const) {
    clients[key] = new Client(app);
    await signIn(clients[key], emailOf(key));
    if (key !== 'outsider' && key !== 'otherOwner') totp[key] = await enrolNow(h, clients[key]);
  }
  const responses: Response[] = [];
  const record = (r: Response) => { responses.push(r); return r; };
  const elevate = async (key: Staff) => {
    h.clock.advance(30_000);
    assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    const response = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, totp[key]) } }, { idempotencyKey: null });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  const command = async (key: Staff | 'outsider', url: string, body: Record<string, unknown> = {}, idempotent = true): Promise<Response> => {
    const idempotencyKey = `prov-${randomUUID()}`;
    return record(await clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic providers console action', ...body }, { idempotencyKey: idempotent ? idempotencyKey : null }));
  };
  const get = async (key: Staff, url: string) => record(await clients[key].get(url));
  const ok = (response: Response, status = 200) => {
    assert.equal(response.status, status, JSON.stringify(response.body));
    return response.body as Record<string, unknown> & { result: { outcome: string; approvalRequestId: string | null; objectId: string; revision: number } };
  };
  const base = `/v1/admin/hubs/${hubA}/providers`;
  const connectionBody = { adapterId: 'openai_compatible', mode: 'live', label: 'Synthetic US model vendor', capabilities: ['llm'], endpoint: 'https://models.synthetic.example/v1', hosting: VENDOR_US, storageCountry: null, region: 'us-east-1', credentialRefId: null };

  await t.test('negative: anonymous, participants, unelevated and unpermitted staff never reach the providers console', async () => {
    expectRefusal(await new Client(app).get(`${base}/connections`), 401, 'auth.session_invalid');
    expectRefusal(await clients.outsider.get(`${base}/connections`), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.otherOwner.get(`${base}/connections`), 403, 'access.forbidden', 'staff');
    expectRefusal(await command('outsider', `${base}/connections`, connectionBody), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.owner.get(`${base}/connections`), 403, 'access.forbidden', 'elevation');
    for (const key of STAFF) await elevate(key);
    expectRefusal(await command('moderator', `${base}/connections`, connectionBody), 403, 'access.forbidden', 'forbidden');
    expectRefusal(await get('moderator', `${base}/connections`), 404, 'access.not_found');
    // A restricted place is refused with the place, before anything is saved.
    const refused = await command('owner', `${base}/connections`, { ...connectionBody, hosting: { ...VENDOR_US, country: 'IR' } });
    expectRefusal(refused, 422, 'validation.schema', 'restricted_place');
    assert.deepEqual((refused.body as { details: { items: string[] } }).details.items, ['IR']);
    expectRefusal(await command('owner', `${base}/connections`, { ...connectionBody, endpoint: `https://models.synthetic.example/v1?key=${CANARY}` }), 422, 'validation.schema');
    const denied = await h.db.admin.query("SELECT 1 FROM trustwork.admin_audit_event WHERE outcome = 'denied' AND actor_person_id = $1", [w.people.moderator]);
    assert.ok(denied.rowCount && denied.rowCount > 0, 'a refusal of authority leaves a denied audit row');
  });

  let connectionId = '';
  await t.test('a live connection: write-only secret, rotation, synthetic test, second-person enabling', async () => {
    const created = ok(await command('owner', `${base}/connections`, connectionBody), 201) as unknown as { result: { objectId: string }; connection: { id: string; revision: number } };
    ConsoleCommandResultSchema.parse(created.result);
    connectionId = created.connection.id;
    const { enable: _enable, ...viewOnly } = created.connection as unknown as Record<string, unknown>;
    void _enable;
    ConnectionViewSchema.parse(viewOnly);
    // The secret route: write-only, never idempotent-recorded, answers with a reference.
    // Staff without a providers permission do not even learn that the connection exists.
    expectRefusal(await command('moderator', `${base}/connections/${connectionId}/secret`, { connectionId, value: CANARY, expectedRevision: created.connection.revision, graceHours: 24 }, false), 404, 'access.not_found');
    expectRefusal(await command('owner', `${base}/connections/${connectionId}/secret`, { connectionId, value: `${CANARY}\nsecond line`, expectedRevision: created.connection.revision, graceHours: 24 }, false), 422, 'validation.schema');
    const written = ok(await command('owner', `${base}/connections/${connectionId}/secret`, { connectionId, value: CANARY, expectedRevision: created.connection.revision, graceHours: 24 }, false), 201) as unknown as { secretRef: unknown; connectionRevision: number };
    const ref = SecretRefSchema.parse(written.secretRef);
    assert.equal(ref.version, 1);
    // Rotation: the previous version stays in grace.
    const rotated = ok(await command('owner', `${base}/connections/${connectionId}/secret`, { connectionId, value: CANARY_ROTATED, expectedRevision: written.connectionRevision, graceHours: 24 }, false), 201) as unknown as { secretRef: { version: number; keyedFingerprint: string } };
    assert.equal(rotated.secretRef.version, 2);
    assert.notEqual(rotated.secretRef.keyedFingerprint, ref.keyedFingerprint);
    const view = ok(await get('owner', `${base}/connections/${connectionId}`)) as unknown as { connection: { secret: { versions: { status: string }[] }; status: string; revision: number } };
    assert.deepEqual(view.connection.secret.versions.map((v) => v.status), ['active', 'grace']);

    // A synthetic test: the adapter receives only the engine's probes and the decrypted current secret.
    const tested = ok(await command('owner', `${base}/connections/${connectionId}/test`, { connectionId, syntheticInputOnly: true })) as unknown as { test: { outcome: string; syntheticInputOnly: boolean }; connection: { revision: number; enable: { actionDigest: string } } };
    assert.equal(tested.test.outcome, 'ok');
    assert.equal(tested.test.syntheticInputOnly, true);
    const received = live.received.at(-1)!;
    assert.deepEqual(received.probes, syntheticProbesFor(['llm']));
    assert.equal(received.secret?.reveal(), CANARY_ROTATED, 'the envelope opens to the current version');
    assert.equal(JSON.stringify(received.secret), '"[secret]"');
    assert.equal(String(received.secret), '[secret]');

    // Enabling: the requester never approves; the second person restates the digest.
    const pending = ok(await command('owner', `${base}/connections/${connectionId}/enable`, { expectedRevision: tested.connection.revision, approvalId: null }));
    assert.equal(pending.result.outcome, 'pending_second_person');
    const approvalId = pending.result.approvalRequestId as string;
    expectRefusal(await command('owner', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: tested.connection.enable.actionDigest }), 403, 'access.second_approver_required');
    ok(await command('officer', `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: tested.connection.enable.actionDigest }));
    const enabled = ok(await command('owner', `${base}/connections/${connectionId}/enable`, { expectedRevision: tested.connection.revision, approvalId })) as unknown as { connection: { status: string } };
    assert.equal(enabled.connection.status, 'enabled');
  });

  await t.test('egress, a non-public route and the call gate: default deny, two people, the gate refuses without an allow cell', async () => {
    ok(await command('owner', `${base}/egress`, { connectionId, dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null }));
    const route = ok(await command('owner', `${base}/routes`, {
      job: 'agent_drafting', scope: { kind: 'module', moduleKey: 'negotiator' }, primary: { connectionId, modelId: 'model-a', modelRevision: 'rev-2026-09' }, fallbacks: [],
      allowedDataClasses: ['public', 'person_private'], limits: { maxInputTokens: 8000, maxOutputTokens: 1000, maxFileBytes: null, timeoutMs: 30_000 }, budgetId: null,
    }), 201) as unknown as { route: { id: string; revision: number; activation: { actionDigest: string } } };
    // The drafter alone cannot activate a route that may carry non-public data.
    expectRefusal(await command('owner', `${base}/routes/${route.route.id}/activate`, { expectedRevision: route.route.revision, approvalId: null }), 403, 'access.second_approver_required', 'drafter_cannot_activate');
    const pending = ok(await command('officer', `${base}/routes/${route.route.id}/activate`, { expectedRevision: route.route.revision, approvalId: null }));
    ok(await command('owner', `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: route.route.activation.actionDigest }));
    const active = ok(await command('officer', `${base}/routes/${route.route.id}/activate`, { expectedRevision: route.route.revision, approvalId: pending.result.approvalRequestId })) as unknown as { route: { status: string } };
    assert.equal(active.route.status, 'active');

    const explain = async (body: Record<string, unknown>) => ProviderCallDecisionSchema.parse((ok(await command('owner', `${base}/explain`, { job: 'agent_drafting', moduleKey: 'negotiator', extensionId: null, pipelineId: null, dataClasses: ['public'], estimatedCost: { minorUnits: '5', currency: 'USD' }, ...body }, false)) as unknown as { decision: unknown }).decision);
    assert.equal((await explain({})).allowed, true);
    assert.deepEqual(await explain({ dataClasses: ['person_private'] }), { allowed: false, reason: 'egress_denied', detail: 'no_rule' }, 'no allow cell, no private data');
    assert.deepEqual(await explain({ job: 'translation' }), { allowed: false, reason: 'no_active_route', detail: null });
    // The runtime gate (no principal) agrees and reserves; the secret opens only inside the callback.
    const gate = app.app.get(ProviderCallGate);
    const decision = await gate.authorize({ hubId: hubA, job: 'agent_drafting', moduleKey: 'negotiator', extensionId: null, pipelineId: null, dataClasses: ['public'], estimatedCost: { minorUnits: '5', currency: 'USD' }, requestRef: 'synthetic-run-1' });
    assert.equal(decision.allowed, true);
    if (decision.allowed) {
      const seen = await gate.withSecret(decision.decisionId, connectionId, async (secret) => secret?.reveal() === CANARY_ROTATED);
      assert.equal(seen, true);
      await gate.settle(decision.decisionId, { connectionId, modelId: 'model-a', outcome: 'succeeded', costMinorUnits: '3', inputTokens: 100, outputTokens: 20 });
    }
    const usage = ok(await get('owner', `${base}/usage?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${new Date(Date.now() + 86_400_000).toISOString()}`)) as unknown as { items: { calls: number; cost: { minorUnits: string } }[] };
    assert.deepEqual(usage.items.map((u) => [u.calls, u.cost.minorUnits]), [[1, '3']]);
  });

  await t.test('caps, cost records and kill switches through the API', async () => {
    const cap = ok(await command('owner', `${base}/caps`, { scope: { kind: 'agent_module', moduleKey: 'negotiator' }, period: 'day', limit: { minorUnits: '6', currency: 'USD' }, alertAtPercent: [50], onExhausted: 'deny_new' }), 201) as unknown as { cap: { state: string } };
    assert.equal(cap.cap.state, 'ok');
    const decision = (await command('owner', `${base}/explain`, { job: 'agent_drafting', moduleKey: 'negotiator', extensionId: null, pipelineId: null, dataClasses: ['public'], estimatedCost: { minorUnits: '7', currency: 'USD' } }, false)).body as { decision: { allowed: boolean; reason: string } };
    assert.deepEqual([decision.decision.allowed, decision.decision.reason], [false, 'cap_exhausted']);
    const pricing = ok(await command('owner', `${base}/pricing`, { connectionId, modelId: 'model-a', currency: 'USD', inputPerMillionTokens: '3.00', outputPerMillionTokens: '15.00', perImage: null, perAudioMinute: null, basis: 'provider_list', observedAt: new Date().toISOString(), sourceNote: null }), 201) as unknown as { pricing: { version: number; inputPerMillionTokens: string } };
    assert.deepEqual([pricing.pricing.version, pricing.pricing.inputPerMillionTokens], [1, '3']);
    const kill = ok(await command('owner', `${base}/kill-switches`, { target: { kind: 'connection', connectionId } }), 201) as unknown as { killSwitch: { id: string; state: string } };
    assert.equal(kill.killSwitch.state, 'engaged');
    const killed = ok(await get('owner', `${base}/connections/${connectionId}`)) as unknown as { connection: { status: string; killSwitchId: string } };
    assert.deepEqual([killed.connection.status, killed.connection.killSwitchId], ['killed', kill.killSwitch.id]);
    const note = 'Synthetic incident: provider outage reviewed';
    const pending = ok(await command('owner', `${base}/kill-switches/${kill.killSwitch.id}/release`, { approvalId: null, incidentNote: note }));
    ok(await command('officer', `/v1/admin/approvals/${pending.result.approvalRequestId}/approve`, { actionDigest: computeDigest(providerKillReleaseDigestInput({ killSwitchId: kill.killSwitch.id, incidentNote: note })).value }));
    const released = ok(await command('owner', `${base}/kill-switches/${kill.killSwitch.id}/release`, { approvalId: pending.result.approvalRequestId, incidentNote: note })) as unknown as { killSwitch: { state: string } };
    assert.equal(released.killSwitch.state, 'released');
    const changes = ok(await get('owner', `${base}/changes`)) as unknown as { items: { action: string; before: unknown; after: unknown; actorPersonId: string | null }[] };
    assert.ok(changes.items.some((c) => c.action === 'providers.cap_created' && c.after !== null));
    for (const path of ['connections', 'egress', 'routes', 'caps', 'pricing', 'kill-switches', 'changes']) ok(await get('owner', `${base}/${path}`));
  });

  await t.test('scan: no API response, log line, audit event, outbox payload or table row contains a secret value', async () => {
    assert.ok(responses.length > 20);
    for (const r of responses) {
      const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
      for (const c of CANARIES) for (const enc of encodings(c)) assert.ok(!text.includes(enc), `a response carries a secret (${r.status})`);
    }
    assert.ok(logs.length > 20, 'the API logged its requests');
    for (const line of logs) for (const c of CANARIES) for (const enc of encodings(c)) assert.ok(!line.includes(enc), 'a log line carries a secret');
    // Every table of the schema, every column, as text (bytea renders as hex).
    const tables = (await h.db.admin.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'trustwork' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
    assert.ok(tables.includes('admin_audit_event') && tables.includes('outbox_event') && tables.includes('provider_config_change') && tables.includes('secret_version'));
    for (const table of tables) {
      for (const c of CANARIES) {
        for (const enc of encodings(c)) {
          const found: { rows: { n: number }[] } = await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM trustwork."${table}" x WHERE position($1 IN x::text) > 0 OR position($2 IN x::text) > 0`, [enc, `\\x${Buffer.from(enc).toString('hex')}`]);
          assert.equal(found.rows[0]!.n, 0, `${table} holds a secret value`);
        }
      }
    }
    // The ciphertext is there, and it is not the value.
    const stored = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.secret_version v JOIN trustwork.secret_ref r ON r.id = v.secret_ref_id WHERE r.connection_id = $1', [connectionId]);
    assert.equal(stored.rows[0]!.n, 2);
    // The audit records "secret version written" with the fingerprint.
    const audit = await h.db.admin.query<{ action: string }>("SELECT action FROM trustwork.admin_audit_event WHERE action = 'providers.secret_written' AND hub_id = $1", [hubA]);
    assert.equal(audit.rowCount, 2);
  });
});
