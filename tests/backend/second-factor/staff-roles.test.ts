import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp, type CreatedApp } from '../../../apps/api/src/app.js';
import { staffHubFromEnv } from '../../../apps/api/src/modules/identity/staff-roles.js';
import { staffAssignments } from '../../../packages/data/src/repositories/admin.js';
import { Client, expectError, SKIP_REASON, startHarness, type Response } from '../helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../helpers/personas.js';
import { actors, buildAdminWorld } from '../../data/admin/helpers.js';
import { untilDatabaseTimePasses } from '../../data/helpers/postgres.js';
import { elevate, enrol, nextCode, secondStep } from './helpers.js';

const h = await startHarness('staff_roles');

const required = (r: Response): string | undefined => (r.body as { details?: { required?: string } }).details?.required;

test('TRUSTWORK_HUB_ID is a uuid or unset', () => {
  assert.equal(staffHubFromEnv({}), null);
  assert.equal(staffHubFromEnv({ TRUSTWORK_HUB_ID: ' ' }), null);
  assert.equal(staffHubFromEnv({ TRUSTWORK_HUB_ID: '0198B1D0-0000-7000-8000-0000000000AA' }), '0198b1d0-0000-7000-8000-0000000000aa');
  assert.throws(() => staffHubFromEnv({ TRUSTWORK_HUB_ID: 'us-demo' }), /uuid/);
});

/**
 * BE-004 follow-up on real PostgreSQL: the default StaffRoleResolver reads DATA-002's staff_role_assignment. The app
 * under test is created like production (no injected resolver, `TRUSTWORK_HUB_ID` set to the hub it serves) on the
 * harness database; assignments are made through DATA-002's own commands by the founding administrators.
 */
test('staff roles come from active staff_role_assignment rows that cover this hub', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  const seed = await seedPersonas(h);
  const world = await buildAdminWorld(h.db.admin);
  const { as, elevate: elevateOwner, assign, assignSensitive } = actors(h.db.admin, h.pool, world);
  const live: CreatedApp = await createApp({
    env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '1000', AUTH_LOCKOUT_THRESHOLD: '5', TRUSTWORK_HUB_ID: world.hubId, MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
    pool: h.pool, clock: h.clock,
    logSink: (line) => { if (line.includes('"level":"error"')) console.error('[api]', line); },
  });
  t.after(async () => { await live.close(); await h.close(); });
  const hub = { kind: 'hub', hubId: world.hubId } as const;
  const signedIn = async (key: PersonaKey): Promise<Client> => {
    const client = new Client(live);
    await login(client, key);
    return client;
  };
  const staffOf = async (client: Client): Promise<string[]> => ((await client.get('/v1/me')).body as { principal: { staff: string[] } }).principal.staff;

  // petr: support lead in this hub (positive). anna: revoked. boris: expired. carl: another hub of the same node.
  // xenia: no assignment at all.
  const petrRole = await assign({ personId: seed.people.petr, role: 'support-lead', scope: hub });
  const annaRole = await assign({ personId: seed.people.anna, role: 'support-agent', scope: hub });
  const ownerCtx = await elevateOwner(world.people.owner);
  await as(world.people.owner, (trx) => staffAssignments.revoke(trx, ownerCtx, annaRole.id));
  const borisRole = await as(world.people.owner, async (trx) => staffAssignments.assign(trx, await elevateOwner(world.people.owner), { personId: seed.people.boris, role: 'support-agent', scope: hub, definitionVersion: 1, validForSeconds: 1 }));
  await untilDatabaseTimePasses(h.db.admin, borisRole.valid_until as Date);
  await assign({ personId: seed.people.carl, role: 'support-agent', scope: { kind: 'hub', hubId: world.otherHubId } });

  let petr: Client = new Client(live);
  let petrSecret: Buffer = Buffer.alloc(0);
  await t.test('positive: an active assignment in this hub makes a staff member who can elevate and reach a staff route', async () => {
    petr = await signedIn('petr');
    assert.deepEqual(await staffOf(petr), ['support-lead']);
    petrSecret = (await enrol(h, petr)).secret;
    await elevate(h, petr, petrSecret);
    const route = await petr.get('/v1/admin/session');
    assert.equal(route.status, 200, JSON.stringify(route.body));
    assert.deepEqual((route.body as { staffRoles: string[] }).staffRoles, ['support-lead']);
  });

  await t.test('negative: revoked, expired, other-hub and missing assignments grant no staff role', async () => {
    for (const key of ['anna', 'boris', 'carl', 'xenia'] as const) {
      const client = await signedIn(key);
      assert.deepEqual(await staffOf(client), [], `${key} has no staff role here`);
      const route = await client.get('/v1/admin/session');
      expectError(route, 403, 'access.forbidden');
      assert.equal(required(route), 'staff', key);
      expectError(await client.post('/v1/admin/session/elevate', { proof: { method: 'totp', code: '123456' } }, { idempotencyKey: null }), 403, 'access.forbidden');
    }
  });

  await t.test('a node-scoped role covers this hub, while the other-hub role still does not count', async () => {
    await assignSensitive({ personId: seed.people.carl, role: 'staff-admin', scope: { kind: 'node', nodeId: world.nodeId } });
    assert.deepEqual(await staffOf(await signedIn('carl')), ['staff-admin']);
  });

  await t.test('without TRUSTWORK_HUB_ID no hub-scoped role counts (fail closed)', async () => {
    const unscoped = await createApp({
      env: { API_HOST: '127.0.0.1', API_PORT: '0', PUBLIC_ORIGIN: 'https://trustwork.test', AUTH_RATE_LIMIT_PER_MINUTE: '1000', MAIL_SECRET_KEY: randomBytes(32).toString('hex') },
      pool: h.pool, clock: h.clock, logSink: () => undefined,
    });
    try {
      const client = new Client(unscoped);
      await login(client, 'carl');
      assert.deepEqual(await staffOf(client), ['staff-admin'], 'the node role still counts');
      const petrHere = new Client(unscoped);
      await login(petrHere, 'petr');
      assert.equal((await secondStep(petrHere, { method: 'totp', code: nextCode(h, petrSecret) })).status, 200);
      assert.deepEqual(await staffOf(petrHere), [], 'the hub role of petr does not count without a configured hub');
      expectError(await petrHere.get('/v1/admin/session'), 403, 'access.forbidden');
    } finally {
      await unscoped.close();
    }
  });

  await t.test('revoking the assignment ends staff access on the next request', async () => {
    assert.equal((await petr.get('/v1/admin/session')).status, 200, 'still elevated before the revocation');
    const ctx = await elevateOwner(world.people.owner);
    await as(world.people.owner, (trx) => staffAssignments.revoke(trx, ctx, petrRole.id));
    const after = await petr.get('/v1/admin/session');
    expectError(after, 403, 'access.forbidden');
    assert.equal(required(after), 'staff');
    assert.deepEqual(await staffOf(petr), []);
    const { rows } = await h.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.session_elevation WHERE person_id = $1 AND revoked_at IS NULL", [seed.people.petr]);
    assert.equal(rows[0]?.n, 0, 'DATA-002 also ends the elevations of a person who lost every role');
  });
});
