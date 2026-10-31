import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { auditEvents, outbox } from '@trustwork/data';
import { HandlerRegistry, startMetricsServer, Worker, type ScheduledTask } from '@trustwork/worker';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from './helpers/worker-db.js';

const env = await provisionWorkerDatabase('worker_scheduler');

const get = (port: number, path: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }));
  });
  req.on('error', reject);
  req.end();
});

test('scheduled maintenance (sweep, idempotency cleanup, monthly partitions, lease expiry) and exported metrics', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const partitions = async () => (await env.db.admin.query<{ parent: string; name: string; bound: string }>(
    `SELECT p.relname AS parent, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'trustwork' AND p.relname IN ('audit_event', 'outbox_event') ORDER BY p.relname, c.relname`)).rows;

  await t.test('the migration partitions audit_event and outbox_event by month with a DEFAULT partition and four months ahead', async () => {
    const kinds = await env.db.admin.query<{ relname: string; relkind: string }>("SELECT relname, relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND relname IN ('audit_event', 'outbox_event') ORDER BY relname");
    assert.deepEqual(kinds.rows, [{ relname: 'audit_event', relkind: 'p' }, { relname: 'outbox_event', relkind: 'p' }]);
    const now = new Date();
    const months = [0, 1, 2, 3].map((k) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
      return `y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    const live = await partitions();
    for (const parent of ['audit_event', 'outbox_event']) {
      const names = live.filter((p) => p.parent === parent).map((p) => p.name);
      assert.deepEqual(names.sort(), [`${parent}_default`, ...months.map((m) => `${parent}_${m}`)].sort());
      assert.equal(live.find((p) => p.name === `${parent}_default`)?.bound, 'DEFAULT');
    }
    const owners = await env.db.admin.query("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'trustwork'");
    assert.deepEqual(owners.rows, [{ tableowner: 'trustwork_owner' }], 'partitions are owned by the owner role');
    await tx(env.apiPool, async (trx) => {
      await auditEvents.append(trx, { action: 'probe.partition', object_kind: 'probe', object_id: 'p' });
      await outbox.append(trx, { aggregate_kind: 'probe', aggregate_id: 'p', revision: 1, type: 'probe.partition', payload: {} });
    });
    const routed = await env.db.admin.query<{ t: string }>("SELECT tableoid::regclass::text AS t FROM trustwork.audit_event WHERE action = 'probe.partition' UNION ALL SELECT tableoid::regclass::text FROM trustwork.outbox_event WHERE type = 'probe.partition'");
    assert.deepEqual(routed.rows.map((r) => r.t.replace(/^trustwork\./, '')).sort(), [`audit_event_${months[0]}`, `outbox_event_${months[0]}`]);
    // Append-only still holds on every partition, for the owner too.
    await assert.rejects(env.db.admin.query("UPDATE trustwork.audit_event SET reason = 'x' WHERE action = 'probe.partition'"), /append-only/);
    await assert.rejects(env.db.admin.query(`DELETE FROM trustwork.audit_event_${months[0]}`), /append-only/);
  });

  await t.test('two workers run each due maintenance slot once; the sweep uses fixed intervals and removes expired idempotency records', async () => {
    await tx(env.db.admin, async (trx) => {
      await trx.insertInto('idempotency_record').values([
        { principal_id: 'p', action: 'a', context_id: 'c', key: 'expired', payload_digest: 'a'.repeat(64), expires_at: new Date(Date.now() - 60_000) },
        { principal_id: 'p', action: 'a', context_id: 'c', key: 'live', payload_digest: 'a'.repeat(64), expires_at: new Date(Date.now() + 3_600_000) },
      ]).execute();
    });
    const a = new Worker({ pool: env.workerPool(), config: { workerId: 'sched-a' } });
    const b = new Worker({ pool: env.workerPool(), config: { workerId: 'sched-b' } });
    const [ra, rb] = await Promise.all([a.runOnce({ rethrow: true }), b.runOnce({ rethrow: true })]);
    const ran = [...ra.scheduled, ...rb.scheduled].sort();
    assert.deepEqual(ran, ['jobs.expire_leases', 'maintenance.monthly_partitions', 'maintenance.sweep_expired']);
    const keys = await env.db.admin.query<{ key: string }>('SELECT key FROM trustwork.idempotency_record ORDER BY key');
    assert.deepEqual(keys.rows.map((r) => r.key), ['live']);
    const swept = (a.metrics.value('trustwork_worker_swept_rows_total', { table: 'idempotency_records' }) ?? 0) + (b.metrics.value('trustwork_worker_swept_rows_total', { table: 'idempotency_records' }) ?? 0);
    assert.equal(swept, 1);
    const again = await a.runOnce({ rethrow: true });
    assert.deepEqual(again.scheduled, [], 'not due again before its interval');
    const rows = await env.db.admin.query<{ task: string; run_count: string; last_outcome: string; due_in: number }>('SELECT task, run_count, last_outcome, extract(epoch FROM next_at - now())::float8 AS due_in FROM trustwork.worker_schedule ORDER BY task');
    assert.deepEqual(rows.rows.map((r) => [r.task, r.run_count, r.last_outcome]), [['jobs.expire_leases', '1', 'succeeded'], ['maintenance.monthly_partitions', '1', 'succeeded'], ['maintenance.sweep_expired', '1', 'succeeded']]);
    assert.ok(rows.rows.find((r) => r.task === 'maintenance.sweep_expired')!.due_in > 3500, 'next sweep in an hour');
  });

  await t.test('partition maintenance is idempotent and serialised; a failing task is recorded and retried within a minute', async () => {
    const created = await Promise.all([1, 2, 3].map(() => env.workerPool(1).query<{ name: string }>('SELECT name FROM trustwork.ensure_monthly_partitions() AS name')));
    assert.deepEqual(created.map((r) => r.rowCount), [0, 0, 0], 'all months already exist');
    const failing: ScheduledTask = { name: 'probe.failing', intervalSeconds: 3600, run: async () => { throw new Error('maintenance target unavailable'); } };
    const worker = new Worker({ pool: env.workerPool(), tasks: () => [failing] });
    assert.deepEqual((await worker.runOnce({ rethrow: true })).scheduled, ['probe.failing']);
    const row = await env.db.admin.query<{ last_outcome: string; last_error: string; failure_count: string; due_in: number }>("SELECT last_outcome, last_error, failure_count, extract(epoch FROM next_at - now())::float8 AS due_in FROM trustwork.worker_schedule WHERE task = 'probe.failing'");
    assert.equal(row.rows[0]?.last_outcome, 'failed');
    assert.match(row.rows[0]!.last_error, /maintenance target unavailable/);
    assert.equal(row.rows[0]?.failure_count, '1');
    assert.ok(row.rows[0]!.due_in <= 60, 'a failed slot is retried within a minute, not after the full interval');
    assert.equal(worker.metrics.value('trustwork_worker_schedule_runs_total', { task: 'probe.failing', outcome: 'failed' }), 1);
  });

  await t.test('metrics: outbox age, queue depth, lease expirations and unknown outcomes over HTTP in Prometheus text format', async () => {
    await env.db.admin.query("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload, created_at) VALUES ('probe', 'old', 1, 'probe.old', '{}', now() - interval '90 seconds')");
    await env.db.admin.query("INSERT INTO trustwork.job (kind, state, leased_until, leased_by, fencing_token, attempt) VALUES ('metrics.ext', 'leased', now() - interval '5 seconds', 'gone', 1, 1), ('metrics.ext', 'queued', NULL, NULL, 0, 0), ('metrics.ext', 'queued', NULL, NULL, 0, 0)");
    const worker = new Worker({ pool: env.workerPool(), registry: new HandlerRegistry() });
    const expire = worker.scheduler.tasks.find((task) => task.name === 'jobs.expire_leases')!;
    // metrics.ext is not a transactional kind of this worker: the expired lease stays parked for manual reconciliation.
    const result = await expire.run();
    assert.deepEqual(result, { parked: 1, autoReconciled: 0 });
    const server = await startMetricsServer('127.0.0.1', 0, () => worker.renderMetrics());
    t.after(() => server.close());
    const scrape = await get(server.port, '/metrics');
    assert.equal(scrape.status, 200);
    assert.match(scrape.type, /^text\/plain; version=0\.0\.4/);
    const age = Number(/^trustwork_outbox_oldest_unpublished_age_seconds (\S+)$/m.exec(scrape.body)?.[1]);
    assert.ok(age >= 89 && age < 600, `oldest unpublished event age ${age}`);
    assert.match(scrape.body, /^trustwork_outbox_unpublished_events [1-9]\d*$/m);
    assert.match(scrape.body, /^trustwork_job_queue_depth\{kind="metrics.ext",state="queued"\} 2$/m);
    assert.match(scrape.body, /^trustwork_job_ready\{kind="metrics.ext"\} 2$/m);
    assert.match(scrape.body, /^trustwork_job_outcome_unknown\{kind="metrics.ext"\} 1$/m);
    assert.match(scrape.body, /^trustwork_job_outcome_unknown\{kind="_all"\} 1$/m);
    assert.match(scrape.body, /^trustwork_job_lease_expired_parked\{kind="metrics.ext"\} 1$/m);
    assert.match(scrape.body, /^# TYPE trustwork_job_queue_depth gauge$/m);
    assert.match(scrape.body, /^trustwork_worker_lease_expirations_total 1$/m);
    assert.match(scrape.body, /^# TYPE trustwork_worker_lease_expirations_total counter$/m);
    assert.match(scrape.body, /^trustwork_worker_unknown_outcomes_total\{kind="metrics.ext",reason="lease_expired"\} 1$/m);
    assert.deepEqual([(await get(server.port, '/health/live')).status, (await get(server.port, '/other')).status], [200, 404]);
  });
});
