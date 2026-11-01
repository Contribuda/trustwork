import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { createApp, type CreatedApp } from '../../../../apps/api/src/app.js';
import { createApiConsolePort, type ConsoleApi } from '../../../../apps/web/app/admin/_data/api-adapter.js';
import { HUBS } from '../../../../apps/web/app/admin/_fixtures/hubs.js';
import { Client, SKIP_REASON, startHarness, type Harness, type Response } from '../../../backend/helpers/app.js';
import { codeNow } from '../../../backend/second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';
import { actors, buildHubWorld, syncKernel, type HubWorld, type Key } from '../../../hubs/helpers.js';

/**
 * HUBC-007 against the real API on real PostgreSQL (runtime role, real sessions, TOTP, elevated sessions): the console's
 * live adapter reads the viewer, the hub and its approvals, and decides a real second-person request, with negative
 * authorization (no staff role, no elevation, no approver permission, one's own request, another digest).
 */

const h = await startHarness('console_live_core');
const emailOf = (key: Key) => `live-core-${key.toLowerCase()}@example.invalid`;
type Staff = 'operator' | 'owner' | 'officer' | 'moderator';
const STAFF: Staff[] = ['operator', 'owner', 'officer', 'moderator'];

class Failure extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super(`API ${status} ${code ?? ''}`);
  }
}

/** The adapter's API over the harness client: the same contract as the web transport and the server POST helper. */
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
      return { status: r.status, code: (r.body as { code?: string } | null)?.code ?? null };
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

test('console live core against the API', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  await syncKernel(h.db.admin);
  const w: HubWorld = await buildHubWorld(h.db.admin);
  const a = actors(h.db.admin, h.pool, w);
  await a.assignSensitive({ personId: w.people.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
  const hubId = (await a.createHub('synthetic-live-core')).hub_id;
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
  const command = (key: Staff, url: string, body: Record<string, unknown> = {}): Promise<Response> => {
    const idempotencyKey = `live-${randomUUID()}`;
    return clients[key].post(url, { contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey, reason: 'Synthetic live console check', ...body }, { idempotencyKey });
  };
  const portOf = (key: Staff | 'outsider') => createApiConsolePort({ api: apiOf(clients[key]), siteHost: () => 'live-core.example.org', engineVersion: '0.1.0', now: () => h.clock.now() });
  const live = { demo: false } as const;
  const base = `/v1/admin/hubs/${hubId}`;

  await t.test('no staff role: no viewer; staff without an elevation: the gate; staff elevated: the viewer', async () => {
    assert.equal(await portOf('outsider').viewer(live), null);
    assert.deepEqual((await portOf('moderator').viewer(live))?.elevation, { state: 'required' });
    await elevate('owner');
    const viewer = await portOf('owner').viewer(live);
    assert.equal(viewer?.person.id, w.people.owner);
    assert.equal(viewer?.elevation.state, 'elevated');
  });

  await t.test('a hub appears once it has an active modes version; its record comes from the API only', async () => {
    assert.deepEqual(await portOf('owner').hubs(live), [], 'no modes version yet: nothing to show');
    const modes = HUBS[0]!.modes;
    const drafted = await command('owner', `${base}/config`, { domain: 'modes', payload: modes });
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
    const version = (drafted.body as { version: { id: string; revision: number } }).version;
    const activated = await command('owner', `${base}/config/${version.id}/activate`, { expectedRevision: version.revision, approvalId: null });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    const [record] = await portOf('owner').hubs(live);
    assert.equal(record?.hub.id, hubId);
    assert.equal(record?.synthetic, false);
    assert.equal(record?.example, null);
    assert.deepEqual(record?.modes, modes);
    assert.ok((record?.gates.length ?? 0) > 0, 'launch gates come from the checklist');
    assert.equal(await portOf('outsider').hub('synthetic-live-core', live), null, 'an outsider reads no hub');
    const viewer = (await portOf('owner').viewer(live))!;
    const access = await portOf('owner').access(viewer, { nodeId: record!.hub.nodeId, hubId });
    assert.ok(access.roles.includes('hub-owner'));
    assert.ok(access.permissions.includes('admin.hub.modes.edit'));
  });

  await t.test('a real second-person request: listed with its digest, never decided by its requester or with another digest, decided by another person', async () => {
    await elevate('officer');
    await elevate('moderator');
    const drafted = await command('owner', `${base}/config`, { domain: 'residency', payload: { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] } });
    assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
    const v = (drafted.body as { version: { id: string; revision: number; activation: { actionDigest: string } } }).version;
    const pending = await command('officer', `${base}/config/${v.id}/activate`, { expectedRevision: v.revision, approvalId: null });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    const requestId = (pending.body as { result: { approvalRequestId: string } }).result.approvalRequestId;

    const { requests } = await portOf('owner').approvals(hubId);
    const listed = requests.find((r) => r.id === requestId);
    assert.ok(listed, 'the owner sees the pending request');
    assert.equal(listed.actionDigest.value, v.activation.actionDigest);
    assert.equal(listed.requestedBy, w.people.officer);

    const decide = (digest: string) => ({ command: 'approvals.decide' as const, hubSlug: 'synthetic-live-core', setupToken: null, reason: 'Synthetic residency check', expectedRevision: null, fields: { requestId, decision: 'approve', digest } });
    const own = await portOf('officer').command(live, decide(v.activation.actionDigest));
    assert.equal(own.status === 'rejected' && own.code, 'own_request', 'the requester never approves');
    const moderator = await portOf('moderator').command(live, decide(v.activation.actionDigest));
    // Without an approver permission the API does not list the request to this person, so the console finds nothing to decide.
    assert.deepEqual(moderator, { status: 'not_found' }, 'no approver permission: the request is not even visible');
    assert.equal((await portOf('moderator').approvals(hubId)).requests.some((r) => r.id === requestId), false);
    const wrong = await portOf('owner').command(live, decide('f'.repeat(64)));
    assert.equal(wrong.status === 'rejected' && wrong.code, 'digest_mismatch');
    assert.deepEqual(await portOf('owner').command(live, decide(v.activation.actionDigest)), { status: 'applied' });

    const after = await portOf('owner').approvals(hubId);
    assert.equal(after.requests.some((r) => r.id === requestId), false, 'no longer pending');
    assert.deepEqual(after.decisions.filter((d) => d.requestId === requestId).map((d) => [d.decision, d.decidedBy]), [['approve', w.people.owner]]);
    const audited = (await h.db.admin.query('SELECT actor_person_id, outcome FROM trustwork.admin_audit_event WHERE object_id = $1 AND actor_person_id = $2', [requestId, w.people.owner])).rows;
    assert.ok(audited.some((r) => r.outcome === 'applied'), `the API recorded the decision: ${JSON.stringify(audited)}`);
  });
});
