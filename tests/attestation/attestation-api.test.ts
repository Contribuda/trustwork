import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { computeDigest } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../apps/api/src/app.js';
import { AttestationService } from '../../apps/api/src/modules/jurisdiction/attestation/attestation.service.js';
import { deploymentAttestationStatement, type DeploymentAttestationStatus, type DeploymentLocationAttestation } from '../../packages/contracts/src/sanctions-attestation.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../backend/helpers/app.js';
import { codeNow } from '../backend/second-factor/helpers.js';
import { addLogins, enrolNow, expectRefusal, PASSWORD, signIn } from '../admin/helpers.js';
import { actors, buildAttestationWorld, syncRestrictedPlaces, type AttestationWorld, type Key } from './helpers.js';

const h = await startHarness('attestation_api');
const DAY = 86_400_000;
const URL_ = '/v1/admin/jurisdiction/attestation';
const emailOf = (key: Key) => `attestation-${key.toLowerCase()}@example.invalid`;
type Staff = 'founder' | 'operator' | 'hubOwner' | 'auditor';
const STAFF: Staff[] = ['founder', 'operator', 'hubOwner', 'auditor'];

function apiFor(harness: Harness, w: AttestationWorld, gate: string | null): Promise<CreatedApp> {
  return createApp({
    env: {
      API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '5000', AUTH_LOCKOUT_THRESHOLD: '50', TRUSTWORK_HUB_ID: w.hubId,
      MAIL_SECRET_KEY: randomBytes(32).toString('hex'), ...(gate ? { TRUSTWORK_JURISDICTION_GATE: gate } : {}),
    },
    pool: harness.pool, clock: harness.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
}

const statement = (overrides: Record<string, unknown> = {}) => ({
  operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate', supersedes: null,
  statementVersion: 'deployment-location-1', confirmed: true, reason: 'Synthetic setup wizard attestation', ...overrides,
});

/**
 * SANC-009 through the HTTP API on real PostgreSQL under the runtime role, with real sessions, TOTP and elevated
 * sessions: the setup wizard's attestation step reads the status and attests or renews; the database decides who may
 * attest, refuses restricted places, serialises concurrent attestations and audits with the person and the elevation.
 */
test('deployment-location attestation API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const w = await buildAttestationWorld(h.db.admin);
  await actors(h.db.admin, h.pool, w).assignRoles();
  await syncRestrictedPlaces(h.db.admin);
  await addLogins(h, (['founder', 'operator', 'hubOwner', 'auditor', 'outsider'] as const).map((k) => [w.people[k], emailOf(k)]));
  const app = await apiFor(h, w, 'upstream_gate');
  t.after(async () => { await app.close(); await h.close(); });

  const clients = {} as Record<Staff | 'outsider', Client>;
  const secrets = {} as Record<Staff, Buffer>;
  const elevations = {} as Record<Staff, string>;
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
    elevations[key] = (response.body as { elevationId: string }).elevationId;
  };
  const attest = (key: Staff, body: Record<string, unknown>, idempotencyKey = `att-${randomUUID()}`): Promise<Response> => clients[key].post(URL_, body, { idempotencyKey });
  const status = async (key: Staff): Promise<DeploymentAttestationStatus> => {
    const response = await clients[key].get(URL_);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as DeploymentAttestationStatus;
  };

  await t.test('negative: anonymous, participants and unelevated staff never reach the attestation', async () => {
    expectRefusal(await new Client(app).get(URL_), 401, 'auth.session_invalid');
    expectRefusal(await clients.outsider.get(URL_), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.outsider.post(URL_, statement(), { idempotencyKey: `att-${randomUUID()}` }), 403, 'access.forbidden', 'staff');
    expectRefusal(await clients.operator.get(URL_), 403, 'access.forbidden', 'elevation');
    expectRefusal(await attest('operator', statement()), 403, 'access.forbidden', 'elevation');
  });

  for (const key of STAFF) await elevate(key);

  await t.test('before the first attestation the status is missing and keeps the launch gate open', async () => {
    const s = await status('operator');
    assert.equal(s.state, 'missing');
    assert.equal(s.attestation, null);
    assert.deepEqual(s.launchGate, { gate: 'sanctions_screening_configured', contribution: 'open' });
    assert.deepEqual(s.reminder, { kind: 'attest', dueAt: null });
  });

  await t.test('negative: staff of the hub (not the node) and staff without an attesting permission are refused by the database', async () => {
    expectRefusal(await attest('hubOwner', statement()), 403, 'access.forbidden', 'admin.forbidden');
    expectRefusal(await attest('auditor', statement()), 403, 'access.forbidden', 'admin.forbidden');
    expectRefusal(await attest('operator', { ...statement(), confirmed: false }), 422, 'validation.schema');
    expectRefusal(await attest('operator', { ...statement(), gateMode: 'fake' }), 422, 'validation.schema');
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation')).rows[0].n, 0);
  });

  await t.test('a restricted entity or hosting place is refused with the refused fields, and the attempt is audited as denied', async () => {
    const crimea = await attest('operator', statement({ hostingCountry: 'UA', hostingRegion: 'UA-43' }));
    expectRefusal(crimea, 422, 'validation.schema', 'restricted_place');
    assert.deepEqual((crimea.body as { details: { refusals: unknown } }).details.refusals, [{ field: 'hosting_region', place: 'UA-43', reason: 'restricted' }]);
    const russia = await attest('operator', statement({ operatorEntityCountry: 'RU', operatorEntityRegion: null }));
    expectRefusal(russia, 422, 'validation.schema', 'restricted_place');
    assert.deepEqual((russia.body as { details: { refusals: unknown } }).details.refusals, [{ field: 'operator_entity_country', place: 'RU', reason: 'restricted' }]);
    expectRefusal(await attest('operator', statement({ hostingCountry: 'UA', hostingRegion: null })), 422, 'validation.schema', 'region_required');
    const { rows } = await h.db.admin.query("SELECT actor_person_id, session_elevation_id, reason_code, outcome FROM trustwork.admin_audit_event WHERE action = 'jurisdiction.location_refused' ORDER BY sequence");
    assert.deepEqual(rows.map((r) => r.reason_code), ['denied_restricted_place', 'denied_restricted_place', 'denied_region_required']);
    for (const row of rows) {
      assert.equal(row.outcome, 'denied');
      assert.equal(row.actor_person_id, w.people.operator);
      assert.equal(row.session_elevation_id, elevations.operator);
    }
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation')).rows[0].n, 0, 'nothing attested');
  });

  let first: DeploymentLocationAttestation;
  await t.test('the node operator attests; the record names the person, role, permission and elevation, binds them in the digest and is audited', async () => {
    const key = `att-${randomUUID()}`;
    const response = await attest('operator', statement(), key);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const body = response.body as { attestation: DeploymentLocationAttestation; status: DeploymentAttestationStatus };
    first = body.attestation;
    assert.equal(first.attestedBy, w.people.operator);
    assert.equal(first.attesterRole, 'node-operator');
    assert.equal(first.permission, 'admin.node.hubs.manage');
    assert.equal(first.sessionElevationId, elevations.operator);
    assert.equal(first.basis, 'operator_statement');
    assert.equal(computeDigest(deploymentAttestationStatement(first)).value, first.statementDigest);
    assert.equal(body.status.state, 'valid');
    assert.equal(body.status.launchGate.contribution, 'satisfied');
    const replay = await attest('operator', statement(), key);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, response.body, 'a retry with the same key replays the response');
    const audit = await h.db.admin.query("SELECT actor_person_id, actor_role, permission, session_elevation_id, outcome FROM trustwork.admin_audit_event WHERE object_type = 'deployment_location_attestation'");
    assert.deepEqual(audit.rows, [{ actor_person_id: w.people.operator, actor_role: 'node-operator', permission: 'admin.node.hubs.manage', session_elevation_id: elevations.operator, outcome: 'applied' }]);
  });

  await t.test('reads: node staff see the history with the attesting person; hub staff see the status without it', async () => {
    const history = await clients.auditor.get(`${URL_}/history`);
    assert.equal(history.status, 200);
    assert.deepEqual((history.body as { items: DeploymentLocationAttestation[] }).items.map((a) => a.attestedBy), [w.people.operator]);
    assert.deepEqual((await clients.hubOwner.get(`${URL_}/history`)).body, { items: [] });
    const s = await status('hubOwner');
    assert.equal(s.state, 'valid');
    assert.equal(s.attestation?.id, first.id);
    assert.ok(s.attestation && !('attestedBy' in s.attestation), 'the status carries no attesting person');
  });

  await t.test('concurrency: two staff renew the same attestation at once; exactly one renewal is recorded, the other is a revision conflict', async () => {
    const [a, b] = await Promise.all([
      attest('operator', statement({ supersedes: first.id, hostingCountry: 'DE', hostingRegion: 'DE-HE' })),
      attest('founder', statement({ supersedes: first.id })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`);
    const loser = a.status === 409 ? a : b;
    expectRefusal(loser, 409, 'validation.revision_conflict', 'stale');
    const { rows } = await h.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.deployment_location_attestation WHERE supersedes_id = $1', [first.id]);
    assert.equal(rows[0]?.n, 1);
  });

  await t.test('clock: the renewal reminder starts 30 days before expiry and an attestation older than a year is expired and reopens the gate', async () => {
    const service = app.app.get(AttestationService);
    const current = (await service.currentStatus()).attestation;
    assert.ok(current);
    const offset = Date.parse(current.attestedAt) - h.clock.now().getTime();
    h.clock.advance(offset + 336 * DAY);
    const due = await service.currentStatus();
    assert.equal(due.state, 'renewal_due');
    assert.deepEqual(due.reminder, { kind: 'renew', dueAt: current.expiresAt });
    assert.equal(due.launchGate.contribution, 'satisfied');
    h.clock.advance(30 * DAY);
    const expired = await service.currentStatus();
    assert.equal(expired.state, 'expired');
    assert.deepEqual(expired.launchGate, { gate: 'sanctions_screening_configured', contribution: 'invalidated' });
    // The console reads the same through HTTP: the sessions of a year ago are gone, so the operator signs in again.
    const client = new Client(app);
    const login = await client.post('/v1/auth/login', { email: emailOf('operator'), password: PASSWORD }, { idempotencyKey: null });
    assert.equal((login.body as { status?: string }).status, 'second_factor_required', JSON.stringify(login.body));
    h.clock.advance(30_000);
    assert.equal((await client.post('/v1/auth/second-factor', { proof: { method: 'totp', code: codeNow(h, secrets.operator) } }, { idempotencyKey: null })).status, 200);
    h.clock.advance(30_000);
    assert.equal((await client.post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
    assert.equal((await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets.operator) } }, { idempotencyKey: null })).status, 200);
    const viaHttp = (await client.get(URL_)).body as DeploymentAttestationStatus;
    assert.equal(viaHttp.state, 'expired');
    assert.equal(viaHttp.launchGate.contribution, 'invalidated');
    assert.deepEqual(viaHttp.reminder, { kind: 'reattest', dueAt: null });
    h.clock.reset();
  });

  await t.test('a process whose configured gate differs from the attested one reports the attestation contradicted', async () => {
    const unconfigured = await apiFor(h, w, null);
    const edge = await createApp({
      env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', TRUSTWORK_HUB_ID: w.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex'),
        TRUSTWORK_JURISDICTION_GATE: 'edge_header', TRUSTWORK_JURISDICTION_COUNTRY_HEADER: 'X-Synthetic-Country' },
      pool: h.pool, clock: h.clock, logSink: () => undefined,
    });
    try {
      assert.equal((await app.app.get(AttestationService).currentStatus()).state, 'valid', 'the attested mode matches this process');
      for (const other of [unconfigured, edge]) {
        const s = await other.app.get(AttestationService).currentStatus();
        assert.equal(s.state, 'contradicted');
        assert.deepEqual(s.problems, ['gate_mode_changed']);
        assert.equal(s.launchGate.contribution, 'invalidated');
      }
    } finally {
      await unconfigured.close();
      await edge.close();
    }
  });
});
