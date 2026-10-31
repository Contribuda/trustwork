import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { sql } from 'kysely';
import { admission, admissionScopes, bindTransaction, createPool, jobs, participations, withMaintenance, withPrincipal, type Principal } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../../data/helpers/seed.js';

const db = await provisionTestDatabase('hardening_priv');

/**
 * BE-002 negative authorization on real PostgreSQL with the real runtime role: admission_revoke is scoped to the
 * caller's own scopes (or maintenance), auth_disable_password needs the owner's identity (or maintenance), and the
 * API role no longer holds what the worker owns (caller-chosen sweep, job lease, reconciliation, job updates).
 */
test('runtime-role privileges after BE-002', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  const runtime = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const principal = (id: string): Promise<Principal> => principalFor(db.admin, id);
  const code = async (promise: Promise<unknown>): Promise<string | null> => promise.then(() => 'ok', (e: unknown) => sqlState(e) ?? String(e));
  const revokeAs = async (personId: string, scope: string) => code(withPrincipal(runtime, await principal(personId), (trx) => admission.revoke(trx, scope, 'probe')));

  /** Anonymous runtime transaction that sets the maintenance flag itself (the flag alone must prove nothing). */
  const spoofed = async (statement: string, params: unknown[] = []): Promise<string | null> => {
    const client: pg.PoolClient = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      return await client.query(statement, params).then(() => 'ok', (e: unknown) => sqlState(e));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  await t.test('admission_revoke: no identity is refused, also with a self-set maintenance flag', async () => {
    assert.equal(await code(runtime.query("SELECT trustwork.admission_revoke('person:' || $1, 'anonymous')", [seed.people.anna])), '28000');
    assert.equal(await spoofed("SELECT trustwork.admission_revoke('person:' || $1, 'spoofed maintenance')", [seed.people.anna]), '28000');
  });

  await t.test('admission_revoke: other people, other companies and unmanaged resources are out of scope', async () => {
    assert.equal(await revokeAs(seed.people.petr, admissionScopes.person(seed.people.anna)), '42501', 'another person');
    assert.equal(await revokeAs(seed.people.boris, admissionScopes.company(seed.companies.mixed)), '42501', 'another company');
    assert.equal(await revokeAs(seed.people.xenia, admissionScopes.company(seed.companies.mixed)), '42501', 'former member');
    assert.equal(await revokeAs(seed.people.carl, admissionScopes.resource('project', seed.project)), '42501', 'a project the caller does not manage');
    assert.equal(await revokeAs(seed.people.petr, 'person:not-a-uuid'), '42501', 'malformed scope');
    const events = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.revocation_event WHERE reason = 'probe'");
    assert.equal(events.rows[0]?.n, 0, 'no refused revocation left an event');
  });

  await t.test('admission_revoke: own person scope, own company with members.manage and managed resources are allowed', async () => {
    assert.equal(await revokeAs(seed.people.anna, admissionScopes.person(seed.people.anna)), 'ok');
    assert.equal(await revokeAs(seed.people.boris, admissionScopes.company(seed.companies.supplier)), 'ok');
    assert.equal(await revokeAs(seed.people.petr, admissionScopes.resource('project', seed.project)), 'ok');
    assert.equal(await code(withMaintenance(db.admin, (trx) => admission.revoke(trx, admissionScopes.person(seed.people.anna), 'maintenance'))), 'ok');
  });

  await t.test('admission_revoke: a party scope is allowed only together with the revocation of its participation in the same transaction', async () => {
    const petr = await principal(seed.people.petr);
    const supplierScope = admissionScopes.company(seed.companies.supplier);
    assert.equal(await code(withPrincipal(runtime, petr, (trx) => admission.revoke(trx, supplierScope, 'no evidence'))), '42501');
    const result = await code(withPrincipal(runtime, petr, async (trx) => {
      const row = (await participations.listForResource(trx, 'project', seed.project)).find((r) => r.id === seed.participations.supplierOnPersonalProject);
      assert.ok(row && row.revoked_at === null);
      await participations.revoke(trx, row.id, row.revision, 'probe revoke');
      await admission.revoke(trx, supplierScope, 'participation revoked');
    }));
    assert.equal(result, 'ok');
    assert.equal(await code(withPrincipal(runtime, await principal(seed.people.petr), (trx) => admission.revoke(trx, supplierScope, 'stale evidence'))), '42501', 'evidence from an earlier transaction does not count');
  });

  await t.test('auth_disable_password: anonymous (also with a spoofed flag) and foreign addresses are refused; owner and maintenance may', async () => {
    await db.admin.query("INSERT INTO trustwork.email_binding (person_id, email_normalized, is_primary, verified_at) SELECT id, 'anna@example.invalid', true, now() FROM trustwork.person WHERE id = $1", [seed.people.anna]);
    await withMaintenance(db.admin, (trx) => trx.insertInto('credential').values({ person_id: seed.people.anna, kind: 'password', password_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' }).execute());
    assert.equal(await code(runtime.query("SELECT trustwork.auth_disable_password('anna@example.invalid')")), '28000');
    assert.equal(await spoofed("SELECT trustwork.auth_disable_password('anna@example.invalid')"), '28000');
    assert.equal(await code(withPrincipal(runtime, await principal(seed.people.petr), (trx) => sql`SELECT trustwork.auth_disable_password('anna@example.invalid')`.execute(trx))), '42501');
    const disabled = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.credential WHERE person_id = $1 AND disabled_at IS NOT NULL", [seed.people.anna]);
    assert.equal(disabled.rows[0]?.n, 0);
    const own = await withPrincipal(runtime, await principal(seed.people.anna), async (trx) => (await sql<{ ok: boolean }>`SELECT trustwork.auth_disable_password('anna@example.invalid') AS ok`.execute(trx)).rows[0]?.ok);
    assert.equal(own, true, 'the owner may disable their own password');
    await withMaintenance(db.admin, (trx) => trx.updateTable('credential').set({ disabled_at: null }).where('person_id', '=', seed.people.anna).execute());
    const maintained = await db.admin.query<{ ok: boolean }>("SELECT trustwork.auth_disable_password('anna@example.invalid') AS ok");
    assert.equal(maintained.rows[0]?.ok, true, 'a maintenance (owner-member) session may');
  });

  await t.test('the API role cannot sweep with chosen intervals, lease, reconcile or update jobs; it still enqueues', async () => {
    assert.equal(await code(runtime.query("SELECT * FROM trustwork.sweep_expired(interval '0', interval '0', interval '0')")), '42501');
    assert.equal(await spoofed("SELECT * FROM trustwork.sweep_expired(interval '0', interval '0', interval '0')"), '42501');
    assert.equal(await code(runtime.query("SELECT * FROM trustwork.lease_jobs(ARRAY['probe'], 'api', interval '30 seconds', 1)")), '42501');
    assert.equal(await code(runtime.query("SELECT * FROM trustwork.reconcile_job('11111111-1111-4111-8111-111111111111'::uuid, 'queued', 'ref')")), '42501');
    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      const job = await jobs.enqueue(bindTransaction(client), { kind: 'probe.job' });
      await client.query('COMMIT');
      assert.equal(await code(runtime.query("UPDATE trustwork.job SET state = 'dead' WHERE id = $1", [job.id])), '42501');
      assert.equal(await code(runtime.query('UPDATE trustwork.job SET next_at = now() WHERE id = $1', [job.id])), '42501');
    } finally {
      client.release();
    }
    const grants = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.column_privileges WHERE table_schema = 'trustwork' AND table_name = 'job' AND grantee = 'trustwork_app' AND privilege_type = 'UPDATE'");
    assert.equal(grants.rows[0]?.n, 0, 'no column-level UPDATE grant is left on job');
  });
});
