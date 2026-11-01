import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { bindTransaction, createPool, withMaintenance, withPrincipal, type DataPool, type Transaction } from '@trustwork/data';
import { CONSOLE_PERMISSIONS, SETUP_STEPS } from '@trustwork/contracts';
import { FOUNDING_NODE_OPERATOR_PERMISSIONS } from '../../../packages/contracts/src/hub-setup.js';
import { setupRuns } from '../../../packages/data/src/repositories/setup.js';
import { hubs } from '../../../packages/data/src/repositories/hubs.js';
import { deploymentAttestations } from '../../../packages/data/src/repositories/attestation.js';
import { sessionElevations } from '../../../packages/data/src/repositories/identity.js';
import type { CommandContext } from '../../../packages/data/src/repositories/admin.js';
import { setupTokenHash, newSetupToken } from '../../../apps/api/src/modules/hubs/setup/token.js';
import { provisionTestDatabase, SKIP_REASON } from '../../data/helpers/postgres.js';
import { principalFor } from '../../data/helpers/seed.js';
import { rejects, settle, syncKernel } from '../helpers.js';
import { ANSWERS, enrolSecondFactor, person } from './helpers.js';

// Weight 2: two people race for the founding administrator on the runtime pool.
const db = await provisionTestDatabase('hubs_setup', { weight: 2 });

/**
 * HUB-004 on real PostgreSQL under the runtime role: the setup token (owner-run issuance, hash, expiry, replacement,
 * single setup), the ordered and resumable steps, restricted places at every level, the founding administrator (second
 * factor and recovery codes, the claimed account, a race between two people, DATA-002's guard), and finishing (founding
 * administrator only, second factor, an attestation in force, a draft hub; the token dies and no second setup starts).
 * Every refusal is the database's own; every person and answer is synthetic.
 */
test('setup wizard: token, ordered steps, restricted places, founding administrator and finish', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 8 });
  t.after(async () => { await runtime.end(); await db.close(); });

  const anonymous = async <T>(fn: (trx: Transaction) => Promise<T>): Promise<T> => {
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(bindTransaction(client));
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const as = async <T>(personId: string, fn: (trx: Transaction) => Promise<T>): Promise<T> => withPrincipal(runtime, await principalFor(db.admin, personId), fn);
  const issue = (token: string, expiresAt = new Date(Date.now() + 3_600_000)) => withMaintenance(db.admin, (trx) => setupRuns.issueToken(trx, setupTokenHash(token), expiresAt));
  const count = async (query: string, params: unknown[] = []) => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
  /** A session of the person's own and a live elevation of it, as BE-004 writes them after a verified factor. */
  const elevated = async (personId: string): Promise<CommandContext> => {
    const session = await withMaintenance(db.admin, (trx) => trx.insertInto('session').values({
      person_id: personId, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password',
    }).returning('id').executeTakeFirstOrThrow());
    const elevation = await as(personId, (trx) => sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
    return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic setup test' };
  };

  await t.test('vocabularies match the contracts', async () => {
    assert.deepEqual((await db.admin.query('SELECT trustwork.setup_steps() AS v')).rows[0].v, [...SETUP_STEPS]);
    const founding = (await db.admin.query('SELECT trustwork.setup_founding_permissions() AS v')).rows[0].v as string[];
    assert.deepEqual(founding, [...FOUNDING_NODE_OPERATOR_PERMISSIONS]);
    for (const p of founding) assert.ok((CONSOLE_PERMISSIONS as readonly string[]).includes(p), p);
  });

  let token = newSetupToken();
  await t.test('the token: owner-run issuance, only the hash stored, replacement, expiry; the runtime role never reads the run', async () => {
    await rejects(runtime.query('SELECT * FROM trustwork.setup_issue_token($1, $2)', [setupTokenHash(token), new Date(Date.now() + 3_600_000)]), '42501');
    await rejects(runtime.query('SELECT * FROM trustwork.setup_run'), '42501');
    await rejects(withMaintenance(db.admin, (trx) => setupRuns.issueToken(trx, 'not-a-hash', new Date(Date.now() + 3_600_000))), '22023', 'setup.token_invalid');
    await rejects(issue(token, new Date(Date.now() + 8 * 86_400_000)), '22023', 'setup.token_invalid');
    const first = await issue(token);
    assert.equal(first.token_hash, setupTokenHash(token));
    assert.equal(await count('SELECT 1 FROM trustwork.setup_run WHERE token_hash = $1', [token]), 0, 'the token itself is never stored');
    assert.ok(await anonymous((trx) => setupRuns.open(trx, setupTokenHash(token))));
    assert.equal(await anonymous((trx) => setupRuns.open(trx, setupTokenHash(newSetupToken()))), null, 'an unknown token opens nothing');

    const replaced = token;
    token = newSetupToken();
    const second = await issue(token);
    assert.equal(second.id, first.id, 'the same run resumes with the new token');
    assert.equal(await anonymous((trx) => setupRuns.open(trx, setupTokenHash(replaced))), null, 'the replaced token stops working at once');
    await rejects(anonymous((trx) => setupRuns.save(trx, setupTokenHash(replaced), 'install_check', { clientTime: new Date().toISOString(), checks: [] })), 'P0002', 'setup.not_found');

    await withMaintenance(db.admin, (trx) => trx.updateTable('setup_run').set({ token_issued_at: new Date(Date.now() - 7_200_000), token_expires_at: new Date(Date.now() - 3_600_000) }).execute());
    assert.equal(await anonymous((trx) => setupRuns.open(trx, setupTokenHash(token))), null, 'an expired token opens nothing');
    await rejects(anonymous((trx) => setupRuns.save(trx, setupTokenHash(token), 'install_check', { clientTime: new Date().toISOString(), checks: [] })), 'P0002', 'setup.not_found');
    token = newSetupToken();
    await issue(token);

    // Two installers replacing the token at once: both commit in turn and exactly the last token works.
    const a = newSetupToken();
    const b = newSetupToken();
    await Promise.all([issue(a), issue(b)]);
    const open = await Promise.all([a, b].map((x) => anonymous((trx) => setupRuns.open(trx, setupTokenHash(x)))));
    assert.equal(open.filter(Boolean).length, 1, 'exactly one of two simultaneous tokens works');
    token = open[0] ? a : b;
  });

  const hash = () => setupTokenHash(token);
  const save = (step: string, answer: Record<string, unknown>) => anonymous((trx) => setupRuns.save(trx, hash(), step, answer));

  await t.test('steps are saved in order; a failed install check blocks; restricted places are refused at every level', async () => {
    const out = await rejects(save('node_identity', ANSWERS.node_identity), '23514', 'setup.step_out_of_order');
    assert.equal(out.detail, 'install_check');
    await rejects(save('first_admin', {}), '22023', 'setup.step_invalid');
    await rejects(save('review', {}), '22023', 'setup.step_invalid');
    await rejects(save('install_check', { ...ANSWERS.install_check(), checks: [{ id: 'address', state: 'fail', reason: 'https_required' }, { id: 'worker', state: 'warn', reason: null }] }), '23514', 'setup.install_check_failed');
    const run = await save('install_check', { ...ANSWERS.install_check(), checks: [{ id: 'address', state: 'pass', reason: null }, { id: 'worker', state: 'warn', reason: null }] });
    assert.deepEqual(run.completed, ['install_check']);

    // Fail closed before the restricted list is synced: every place counts as restricted.
    await rejects(save('node_identity', ANSWERS.node_identity), '23514', 'setup.restricted_place');
    await syncKernel(db.admin);
    for (const jurisdiction of ['RU', 'IR', 'KP', 'CU']) await rejects(save('node_identity', { ...ANSWERS.node_identity, jurisdiction }), '23514', 'setup.restricted_place');
    await save('node_identity', ANSWERS.node_identity);
    await rejects(save('operator', ANSWERS.operator), '23514', 'setup.step_out_of_order');

    for (const [country, territories] of [
      ['RU', [{ level: 'country', code: 'RU' }]],
      ['UA', [{ level: 'region', code: 'UA-43' }]],
      ['UA', [{ level: 'place', code: 'UA-43:simferopol' }]],
      ['UA', [{ level: 'country', code: 'UA' }, { level: 'region', code: 'UA-09' }]],
      ['IR', [{ level: 'country', code: 'IR' }]],
    ] as const) {
      const refused = await rejects(save('hub_identity', { ...ANSWERS.hub_identity, country, territories: [...territories] }), '23514', 'setup.restricted_place');
      assert.ok(refused.detail?.length, 'the refused places are named');
    }
    await rejects(save('hub_identity', { ...ANSWERS.hub_identity, territories: [{ level: 'region', code: 'US-ZZ' }] }), '23514', 'setup.jurisdiction_unknown');
    await rejects(save('hub_identity', { ...ANSWERS.hub_identity, country: 'FR', territories: [{ level: 'country', code: 'FR' }], startingPoint: 'pack' }), '23514', 'setup.pack_unknown');
    await save('hub_identity', { ...ANSWERS.hub_identity, startingPoint: 'pack' });
    await save('hub_identity', ANSWERS.hub_identity);

    for (const statement of [{ hostingCountry: 'RU' }, { entityCountry: 'IR', entityRegion: null }, { hostingCountry: 'UA', hostingRegion: 'UA-43' }, { hostingCountry: 'UA', hostingRegion: null }]) {
      await rejects(save('operator', { ...ANSWERS.operator, ...statement }), '23514', 'setup.restricted_place');
    }
    const regionRequired = await rejects(save('operator', { ...ANSWERS.operator, hostingCountry: 'UA', hostingRegion: null }), '23514', 'setup.restricted_place');
    assert.match(regionRequired.detail ?? '', /hostingRegion:region_required/);
    await save('operator', ANSWERS.operator);
    const resumed = await anonymous((trx) => setupRuns.open(trx, hash()));
    assert.deepEqual(resumed?.completed, ['install_check', 'node_identity', 'hub_identity', 'operator'], 'the run resumes where it stopped');
    await rejects(save('storage_residency', ANSWERS.storage_residency), '23514', 'setup.step_out_of_order');
  });

  const people = { first: '', second: '', rival: '', plain: '' };
  await t.test('the founding administrator: a session, an authenticator app and recovery codes; the claimed account; one person wins a race', async () => {
    people.first = await person(db.admin, 'Synthetic Founding Administrator', 'founder@example.org');
    people.second = await person(db.admin, 'Synthetic Second Person', 'second@example.org');
    people.rival = await person(db.admin, 'Synthetic Rival', 'rival@example.org');
    people.plain = await person(db.admin, 'Synthetic Without Factor', 'plain@example.org');
    await rejects(anonymous((trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp')), '42501', 'access.no_principal');
    await rejects(as(people.plain, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp')), '23514', 'setup.second_factor_required');
    await enrolSecondFactor(db.admin, people.plain, false);
    await rejects(as(people.plain, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp')), '23514', 'setup.second_factor_required');
    for (const id of [people.first, people.second, people.rival]) await enrolSecondFactor(db.admin, id);
    await rejects(as(people.first, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'webauthn')), '23514', 'setup.second_factor_unavailable');

    await anonymous((trx) => setupRuns.claimAdmin(trx, hash(), 'Founder@Example.org'));
    await rejects(as(people.second, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp')), '42501', 'setup.admin_account_mismatch');
    assert.equal(await count('SELECT 1 FROM trustwork.staff_role_assignment'), 0, 'nothing was assigned');

    // Two eligible people at once (the claim reset through maintenance): exactly one becomes the founding administrator.
    await withMaintenance(db.admin, (trx) => trx.updateTable('setup_run').set({ admin_email: null }).execute());
    const race = await Promise.all([people.second, people.rival].map((id) => settle(as(id, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp')))));
    assert.equal(race.filter((e) => e === null).length, 1, 'one bootstrap commits');
    assert.equal(race.find((e) => e !== null)?.hint, 'setup.first_admin_only', 'the other is told the setup belongs to someone else');
    const winner = race[0] === null ? people.second : people.rival;
    const loser = winner === people.second ? people.rival : people.second;
    assert.equal(await count("SELECT 1 FROM trustwork.staff_role_assignment WHERE setup_bootstrap AND role = 'node-operator' AND scope_kind = 'node'"), 1);
    people.first = winner;
    people.second = loser;
    const again = await as(winner, (trx) => setupRuns.bootstrapAdmin(trx, hash(), 'totp'));
    assert.equal(again.first_admin_person_id, winner, 'binding again as the same person is idempotent');
    assert.equal(await count('SELECT 1 FROM trustwork.staff_role_assignment'), 1);
    const def = (await db.admin.query("SELECT permissions, scopes FROM trustwork.staff_role_definition_version WHERE role = 'node-operator'")).rows[0];
    assert.deepEqual(def.permissions, [...FOUNDING_NODE_OPERATOR_PERMISSIONS]);
    assert.deepEqual(def.scopes, ['node']);
    assert.equal((await db.admin.query('SELECT label FROM trustwork.admin_node')).rows[0].label, ANSWERS.node_identity.nodeName);
    await rejects(anonymous((trx) => setupRuns.claimAdmin(trx, hash(), 'late@example.org')), '23514', 'setup.first_admin_bound');
  });

  await t.test('DATA-002 guard: no founding assignment outside a maintenance session or the setup bootstrap', async () => {
    const node = (await db.admin.query('SELECT id FROM trustwork.admin_node')).rows[0].id as string;
    await rejects(runtime.query("INSERT INTO trustwork.staff_role_assignment (person_id, role, scope_kind, node_id, definition_version, reason, setup_bootstrap) VALUES ($1, 'node-operator', 'node', $2, 1, 'x', true)", [people.second, node]), '42501');
    assert.equal((await db.admin.query('SELECT trustwork.setup_bootstrap_authorized($1, $2, $3) AS v', [people.first, 'node-operator', 'node'])).rows[0].v, false, 'the bootstrap path lives only in its own transaction');
  });

  await t.test('after binding only the founding administrator continues; the node identity is fixed', async () => {
    await rejects(save('storage_residency', ANSWERS.storage_residency), '42501', 'setup.first_admin_only');
    await rejects(as(people.second, (trx) => setupRuns.save(trx, hash(), 'storage_residency', ANSWERS.storage_residency)), '42501', 'setup.first_admin_only');
    await rejects(as(people.first, (trx) => setupRuns.save(trx, hash(), 'node_identity', { ...ANSWERS.node_identity, nodeName: 'Renamed' })), '23514', 'setup.node_fixed');
    await as(people.first, (trx) => setupRuns.save(trx, hash(), 'node_identity', ANSWERS.node_identity));
    await rejects(as(people.first, (trx) => setupRuns.save(trx, hash(), 'storage_residency', { ...ANSWERS.storage_residency, personalDataCountry: 'KP' })), '23514', 'setup.restricted_place');
    await as(people.first, (trx) => setupRuns.save(trx, hash(), 'storage_residency', ANSWERS.storage_residency));
  });

  await t.test('finishing: founding administrator only, every step, a second factor, an attestation in force and a draft hub; then no second setup', async () => {
    const finish = (personId: string, hubId: string) => as(personId, (trx) => setupRuns.finish(trx, hash(), hubId));
    await rejects(finish(people.second, randomUUID()), '42501', 'setup.first_admin_only');
    await rejects(anonymous((trx) => setupRuns.finish(trx, hash(), randomUUID())), '42501', 'setup.first_admin_only');
    await rejects(finish(people.first, randomUUID()), '23514', 'setup.step_out_of_order');
    await as(people.first, (trx) => setupRuns.save(trx, hash(), 'providers', ANSWERS.providers));
    await as(people.first, (trx) => setupRuns.save(trx, hash(), 'modes', ANSWERS.modes));

    await withMaintenance(db.admin, (trx) => trx.updateTable('recovery_code').set({ revoked_at: new Date() }).where('person_id', '=', people.first).execute());
    await rejects(finish(people.first, randomUUID()), '23514', 'setup.second_factor_required');
    await withMaintenance(db.admin, async (trx) => {
      const batch = randomUUID();
      for (let i = 0; i < 10; i += 1) await trx.insertInto('recovery_code').values({ person_id: people.first, batch_id: batch, code_hash: randomBytes(32) }).execute();
    });
    await rejects(finish(people.first, randomUUID()), '23514', 'setup.attestation_required');

    const ctx = await elevated(people.first);
    await as(people.first, (trx) => deploymentAttestations.attest(trx, ctx, {
      operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate', supersedes: null, statementVersion: 'deployment-location-1',
    }));
    await rejects(finish(people.first, randomUUID()), '23514', 'setup.hub_required');
    const done = await as(people.first, async (trx) => {
      const profile = await hubs.create(trx, ctx, { slug: 'synthetic-us', name: ANSWERS.hub_identity.name, defaultLocale: 'en', locales: ['en', 'es'], timeZone: 'America/Los_Angeles', currency: 'USD', countryPack: null, territories: [...ANSWERS.hub_identity.territories] });
      return setupRuns.finish(trx, hash(), profile.hub_id);
    });
    assert.ok(done.finished_at);
    assert.equal(done.token_hash, null, 'finishing invalidates the token');
    assert.deepEqual(done.completed, [...SETUP_STEPS]);
    assert.equal(await anonymous((trx) => setupRuns.open(trx, hash())), null);
    await rejects(save('modes', ANSWERS.modes), 'P0002', 'setup.not_found');
    await rejects(issue(newSetupToken()), '23514', 'setup.finished');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('setup_run').set({ answers: {} }).execute()), '23514', 'setup.finished');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('setup_run').execute()), '23000', 'audit.append_only');
  });
});
