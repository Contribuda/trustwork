import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEvents, jobs, outbox } from '@trustwork/data';
import { assertWorkerRole, WORKER_ROLE, WorkerRoleError } from '@trustwork/worker';
import { WORKER_ROLE as DATA_WORKER_ROLE } from '../../packages/data/src/config.js';
import { SKIP_REASON, sqlState } from '../data/helpers/postgres.js';
import { seedFixtures } from '../data/helpers/seed.js';
import { provisionWorkerDatabase, tx } from './helpers/worker-db.js';

const env = await provisionWorkerDatabase('worker_roles');

const denied = async (promise: Promise<unknown>, label: string) => {
  const error = await promise.then(() => null, (e: unknown) => e);
  assert.equal(sqlState(error), '42501', `${label}: expected permission denied, got ${error === null ? 'success' : String(error)}`);
};

/** Party tables (forced RLS for the API role) plus private bookkeeping the worker never needs. */
const PARTY_TABLES = ['person', 'email_binding', 'credential', 'session', 'auth_token', 'login_failure', 'company', 'company_private', 'membership', 'permission_grant',
  'object_participation', 'project', 'ownership_transfer', 'leadership_assignment', 'idempotency_record', 'principal_key', 'admission_scope', 'admission_lease', 'revocation_event', 'migration_ledger'];

test('REL-001 roles: the worker role is confined to its tables; the API role appends audit and outbox rows without reading them', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  await seedFixtures(env.db.admin);
  const worker = env.workerPool(2);

  await t.test('the worker group role is the one the runner bootstrap creates', async () => {
    assert.equal(WORKER_ROLE, DATA_WORKER_ROLE);
    const { rows } = await env.db.admin.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; app: boolean; owner: boolean }>(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, pg_has_role($1, 'trustwork_app', 'MEMBER') AS app, pg_has_role($1, 'trustwork_owner', 'MEMBER') AS owner FROM pg_roles r WHERE r.rolname = 'trustwork_worker'`,
      [env.workerLoginRole],
    );
    assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: false, app: false, owner: false });
    assert.equal(await assertWorkerRole(worker), env.workerLoginRole);
  });

  await t.test('the worker login cannot read or change any party table', async () => {
    for (const table of PARTY_TABLES) {
      await denied(worker.query(`SELECT * FROM trustwork.${table} LIMIT 1`), `SELECT ${table}`);
      await denied(worker.query(`DELETE FROM trustwork.${table}`), `DELETE ${table}`);
    }
    await denied(worker.query("INSERT INTO trustwork.person (display_name) VALUES ('x')"), 'INSERT person');
    const companies = await env.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.company');
    assert.ok((companies.rows[0]?.n ?? 0) > 0, 'the fixtures contain party rows the worker cannot see');
  });

  await t.test('the worker login cannot use identity or account functions, nor read audit rows', async () => {
    await denied(worker.query("SELECT trustwork.set_principal('11111111-1111-4111-8111-111111111111'::uuid, 1)"), 'set_principal');
    await denied(worker.query('SELECT * FROM trustwork.auth_lookup_session($1)', [Buffer.alloc(32)]), 'auth_lookup_session');
    await denied(worker.query("SELECT trustwork.sweep_expired(interval '0', interval '0', interval '0')"), 'caller-chosen sweep intervals');
    await denied(worker.query('SELECT * FROM trustwork.audit_event'), 'SELECT audit_event');
    await denied(worker.query('TRUNCATE trustwork.outbox_event'), 'TRUNCATE outbox_event');
    await denied(worker.query('DELETE FROM trustwork.outbox_event'), 'DELETE outbox_event');
    await denied(worker.query("UPDATE trustwork.outbox_event SET type = 'x'"), 'UPDATE outbox_event.type');
    await denied(worker.query('UPDATE trustwork.job SET fencing_token = fencing_token + 1'), 'move the fencing token');
    await denied(worker.query('UPDATE trustwork.job SET attempt = 0'), 'reset attempts');
    await denied(worker.query('SET ROLE trustwork_owner'), 'SET ROLE owner');
    await denied(worker.query('SET ROLE trustwork_app'), 'SET ROLE app');
    // What it may do: append audit rows, read and publish the outbox, run its maintenance entry points.
    await tx(worker, (trx) => auditEvents.append(trx, { action: 'job.reconciled', object_kind: 'job', object_id: 'probe' }));
    await tx(worker, (trx) => outbox.claimUnpublished(trx, 1));
    const swept = await worker.query('SELECT * FROM trustwork.worker_sweep_expired()');
    assert.equal(swept.rowCount, 1);
  });

  await t.test('the API role cannot read audit or outbox rows and cannot run worker maintenance', async () => {
    await tx(env.apiPool, async (trx) => {
      await auditEvents.append(trx, { action: 'probe.append', object_kind: 'probe', object_id: 'p-1' });
      await outbox.append(trx, { aggregate_kind: 'probe', aggregate_id: 'p-1', revision: 1, type: 'probe.appended', payload: {} });
    });
    const stored = await env.db.admin.query<{ audit: number; outbox: number }>("SELECT (SELECT count(*) FROM trustwork.audit_event WHERE action = 'probe.append')::int AS audit, (SELECT count(*) FROM trustwork.outbox_event WHERE type = 'probe.appended')::int AS outbox");
    assert.deepEqual(stored.rows[0], { audit: 1, outbox: 1 });
    await denied(env.apiPool.query('SELECT * FROM trustwork.audit_event'), 'API SELECT audit_event');
    await denied(env.apiPool.query('SELECT actor_person_id, basis FROM trustwork.audit_event'), 'API SELECT audit columns');
    await denied(env.apiPool.query('SELECT count(*) FROM trustwork.audit_event'), 'API count audit_event');
    await denied(env.apiPool.query('SELECT * FROM trustwork.outbox_event'), 'API SELECT outbox_event');
    await denied(env.apiPool.query('UPDATE trustwork.outbox_event SET published_at = now()'), 'API publish outbox');
    await denied(tx(env.apiPool, (trx) => outbox.claimUnpublished(trx, 1)), 'API claim outbox');
    await denied(tx(env.apiPool, (trx) => auditEvents.listForObject(trx, 'probe', 'p-1')), 'API list audit');
    // Partitions are not a side door: no grant exists on them.
    const partition = (await env.db.admin.query<{ name: string }>("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relispartition AND c.relname LIKE 'audit_event_%' ORDER BY 1 LIMIT 1")).rows[0]?.name;
    assert.ok(partition);
    await denied(env.apiPool.query(`SELECT * FROM trustwork.${partition}`), 'API SELECT audit partition');
    await denied(worker.query(`SELECT * FROM trustwork.${partition}`), 'worker SELECT audit partition');
    for (const fn of ['trustwork.worker_sweep_expired()', 'trustwork.ensure_monthly_partitions()', "trustwork.release_job('11111111-1111-4111-8111-111111111111'::uuid, 1)"]) {
      await denied(env.apiPool.query(`SELECT ${fn}`), `API ${fn}`);
    }
    await denied(env.apiPool.query('SELECT * FROM trustwork.worker_schedule'), 'API worker_schedule');
    // The API keeps what it uses: job enqueue for future commands, idempotency, inbox.
    await tx(env.apiPool, (trx) => jobs.enqueue(trx, { kind: 'probe.job' }));
  });

  await t.test('assertWorkerRole refuses the API login and the superuser connection', async () => {
    await assert.rejects(assertWorkerRole(env.apiPool), (e: unknown) => e instanceof WorkerRoleError && /trustwork_app/.test(String(e)));
    await assert.rejects(assertWorkerRole(env.db.admin), (e: unknown) => e instanceof WorkerRoleError && /superuser/.test(String(e)));
  });
});
