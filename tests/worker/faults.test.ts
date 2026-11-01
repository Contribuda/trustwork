import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inbox, jobs, maintenance, outbox } from '@trustwork/data';
import { HandlerRegistry, RetryableJobError, runCli, Worker, type ScheduledTask } from '@trustwork/worker';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { gate, provisionWorkerDatabase, sleep, tx, waitFor } from './helpers/worker-db.js';

const env = await provisionWorkerDatabase('worker_faults');
const FIXTURE = fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url));

test('REL-001 fault injection on real PostgreSQL: crash, duplicate delivery, stale fencing token, clock skew, shutdown', { skip: env ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!env) return;
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-worker-faults-'));
  t.after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await env.close();
  });
  const ledger = join(dir, 'provider-ledger.txt');
  appendFileSync(ledger, '');
  const effects = () => readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
  const jobRow = (id: string) => env.db.admin.query<{ state: string; attempt: number; fencing_token: string; last_error: string | null; delay: number }>(
    // delay is measured from the failure (updated_at is set with next_at), not from this query, so load cannot shrink it.
    'SELECT state, attempt, fencing_token, last_error, extract(epoch FROM next_at - updated_at)::float8 AS delay FROM trustwork.job WHERE id = $1', [id]).then((r) => r.rows[0]!);
  const enqueue = (kind: string, payload: object = {}) => tx(env.db.admin, (trx) => trx.insertInto('job').values({ kind, payload: JSON.stringify(payload) }).returning('id').executeTakeFirstOrThrow()).then((r) => r.id);
  const receipts = (account: string) => env.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.inbox_receipt WHERE provider = 'crash' AND account = $1", [account]).then((r) => r.rows[0]!.n);
  const leaseExpired = (id: string) => waitFor(async () => (await env.db.admin.query("SELECT 1 FROM trustwork.job WHERE id = $1 AND state = 'leased' AND leased_until < now()", [id])).rowCount === 1, 15_000, 'lease expiry');

  /** The survivor: same handlers as the crashed child, plus the maintenance task that parks expired leases. */
  const survivorRegistry = new HandlerRegistry()
    .onJob({ kind: 'crash.external', mode: 'external', run: async (context) => appendFileSync(ledger, `effect ${context.effectKey} ${context.attemptId} pid=${process.pid}\n`) })
    .onJob<{ n: string }>({ kind: 'crash.transactional', mode: 'transactional', run: async (context) => void (await inbox.record(context.trx, { provider: 'crash', account: 'transactional', event_id: context.payload.n })) })
    .onOutbox({ name: 'crash.relay', type: 'crash.event', handle: async (event, context) => void (await inbox.record(context.trx, { provider: 'crash', account: 'relay', event_id: event.id })) });
  const survivor = new Worker({ pool: env.workerPool(), registry: survivorRegistry, config: { workerId: 'survivor', leaseSeconds: 30, retryJitter: 0 } });
  const expireTask = survivor.scheduler.tasks.find((task) => task.name === 'jobs.expire_leases') as ScheduledTask;

  const crashChild = async (mode: string) => {
    const ready = join(dir, `ready-${mode}-${Date.now()}`);
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], {
      env: { ...process.env, WORKER_DATABASE_URL: env.workerUrl, CRASH_MODE: mode, CRASH_LEDGER: ledger, CRASH_READY: ready },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
    await waitFor(() => existsSync(ready) || child.exitCode !== null, 30_000, `child ${mode} to reach the injection point`);
    assert.ok(existsSync(ready), `child ${mode} exited early: ${stderr.slice(-800)}`);
    return {
      async kill() {
        child.kill('SIGKILL');
        assert.equal(await exited, 'SIGKILL');
      },
    };
  };
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { WORKER_DATABASE_URL: env.workerUrl }, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };

  await t.test('killed after the provider effect, before completion: parked as outcome_unknown, never executed again until reconciled', async () => {
    const id = await enqueue('crash.external');
    const child = await crashChild('external-after-effect');
    assert.equal(effects().length, 1, 'the provider effect happened in the child');
    assert.equal((await survivor.relay.relayOnce()), 0);
    await child.kill();
    assert.equal((await jobRow(id)).state, 'leased', 'the dead worker still holds the lease');
    await survivor.runOnce({ rethrow: true });
    await survivor.idle();
    assert.equal(effects().length, 1, 'a live lease is never taken over');
    await leaseExpired(id);
    assert.deepEqual(await expireTask.run(), { parked: 1, autoReconciled: 0 });
    const parked = await jobRow(id);
    assert.deepEqual([parked.state, parked.last_error], ['outcome_unknown', 'lease expired; awaiting reconciliation']);
    for (let i = 0; i < 3; i++) {
      await survivor.runOnce({ rethrow: true });
      await survivor.idle();
    }
    assert.equal(effects().length, 1, 'no second effect without reconciliation');
    assert.equal(survivor.metrics.value('trustwork_worker_lease_expirations_total'), 1);
    const scrape = await survivor.renderMetrics();
    assert.match(scrape, /trustwork_job_outcome_unknown\{kind="crash.external"\} 1/);
    assert.match(scrape, /trustwork_job_lease_expired_parked\{kind="crash.external"\} 1/);

    const listed = await cli('parked');
    assert.equal(listed.code, 0);
    assert.equal(JSON.parse(listed.out[0]!).id, id);
    assert.equal((await cli('reconcile', id, 'succeeded')).code, 2, 'usage error without a reference');
    const done = await cli('reconcile', id, 'succeeded', 'provider-lookup:fake-ledger-line-1', '--operator', 'ops-drill');
    assert.deepEqual([done.code, JSON.parse(done.out[0]!).state], [0, 'succeeded']);
    assert.equal((await cli('reconcile', id, 'queued', 'again')).code, 1, 'a reconciled job is not parked any more');
    const audit = await env.db.admin.query<{ basis: { mode: string; outcome: string; reference: string; operator: string } }>("SELECT basis FROM trustwork.audit_event WHERE action = 'job.reconciled' AND object_id = $1", [id]);
    assert.deepEqual(audit.rows.map((r) => [r.basis.mode, r.basis.outcome, r.basis.reference, r.basis.operator]), [['manual', 'succeeded', 'provider-lookup:fake-ledger-line-1', 'ops-drill']]);
    await survivor.runOnce({ rethrow: true });
    await survivor.idle();
    assert.equal(effects().length, 1);
  });

  await t.test('killed before the effect: reconciliation with proof of no effect re-queues it and the effect happens once, with the same effect key', async () => {
    const id = await enqueue('crash.external');
    const before = effects().length;
    const child = await crashChild('external-before-effect');
    await child.kill();
    await leaseExpired(id);
    await expireTask.run();
    assert.equal((await jobRow(id)).state, 'outcome_unknown');
    const done = await cli('reconcile', id, 'queued', 'provider-lookup:no-such-effect');
    assert.equal(done.code, 0);
    await survivor.runOnce({ rethrow: true });
    await survivor.idle();
    const after = effects().slice(before);
    assert.equal(after.length, 1);
    assert.match(after[0]!, new RegExp(`^effect job:${id} ${id}:2 `), 'stable effect key, new attempt id');
    assert.equal((await jobRow(id)).state, 'succeeded');
  });

  await t.test('killed inside a transactional job: the effect rolled back, the expired lease is reconciled automatically and the job runs exactly once', async () => {
    const id = await enqueue('crash.transactional', { n: 'tx-1' });
    const child = await crashChild('transactional');
    await child.kill();
    assert.equal(await receipts('transactional'), 0, 'the uncommitted effect died with the connection');
    await leaseExpired(id);
    assert.deepEqual(await expireTask.run(), { parked: 1, autoReconciled: 1 });
    const audit = await env.db.admin.query<{ basis: { mode: string; reference: string } }>("SELECT basis FROM trustwork.audit_event WHERE action = 'job.reconciled' AND object_id = $1", [id]);
    assert.equal(audit.rows[0]?.basis.mode, 'auto');
    assert.match(audit.rows[0]!.basis.reference, /^auto:transactional-rollback:1$/);
    await survivor.runOnce({ rethrow: true });
    await survivor.idle();
    const row = await jobRow(id);
    assert.deepEqual([row.state, row.attempt, row.fencing_token], ['succeeded', 2, '2']);
    assert.equal(await receipts('transactional'), 1);
  });

  await t.test('duplicate delivery: a relay killed before COMMIT leaves the event unpublished and without effect; it is delivered again exactly once', async () => {
    await tx(env.apiPool, (trx) => outbox.append(trx, { aggregate_kind: 'crash', aggregate_id: 'c-1', revision: 1, type: 'crash.event', payload: {} }));
    const child = await crashChild('relay');
    assert.equal(await survivor.relay.relayOnce(), 0, 'rows locked by the first relay are skipped (SKIP LOCKED)');
    await child.kill();
    assert.equal(await receipts('relay'), 0);
    // The server ends the killed relay's backend (and its row lock) only once it notices the dropped connection, so
    // the survivor keeps skipping the row until then; it must still deliver it exactly once.
    let delivered = 0;
    await waitFor(async () => (delivered += await survivor.relay.relayOnce()) > 0, 15_000, 'the killed relay to release its row lock');
    assert.equal(delivered, 1);
    assert.equal(await survivor.relay.relayOnce(), 0);
    assert.equal(await receipts('relay'), 1);
    const unpublished = await env.db.admin.query("SELECT 1 FROM trustwork.outbox_event WHERE type = 'crash.event' AND published_at IS NULL");
    assert.equal(unpublished.rowCount, 0);
  });

  await t.test('duplicate delivery: the same logical event appended twice is absorbed by the handler receipt; the provider is called once', async () => {
    const calls: string[] = [];
    const registry = new HandlerRegistry()
      .onOutbox({
        name: 'dedupe.notify', type: 'dedupe.event',
        handle: async (event, context) => {
          const key = `${event.aggregateKind}:${event.aggregateId}:${event.revision}:${event.type}`;
          const { fresh } = await inbox.record(context.trx, { provider: 'outbox', account: 'dedupe.notify', event_id: key });
          if (fresh) await context.enqueue({ kind: 'dedupe.send', payload: { key } });
        },
      })
      .onJob<{ key: string }>({ kind: 'dedupe.send', mode: 'external', run: async (context) => void calls.push(context.payload.key) });
    const worker = new Worker({ pool: env.workerPool(), registry, config: { workerId: 'dedupe' }, tasks: () => [] });
    await tx(env.apiPool, async (trx) => {
      await outbox.append(trx, { aggregate_kind: 'order', aggregate_id: 'o-1', revision: 3, type: 'dedupe.event', payload: {} });
      await outbox.append(trx, { aggregate_kind: 'order', aggregate_id: 'o-1', revision: 3, type: 'dedupe.event', payload: {} });
    });
    await worker.runOnce({ rethrow: true });
    await worker.idle();
    assert.deepEqual(calls, ['order:o-1:3:dedupe.event']);
  });

  await t.test('stale fencing token: a stalled worker whose lease expired cannot complete; its transactional effect rolls back', async (st) => {
    const stalled = gate();
    st.after(() => stalled.open());
    const slow = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry().onJob<{ n: string }>({ kind: 'fence.tx', mode: 'transactional', run: async (context) => {
        await inbox.record(context.trx, { provider: 'fence', account: 'tx', event_id: context.payload.n });
        await stalled.promise;
      } }),
      config: { workerId: 'stalled', leaseSeconds: 1, heartbeatMs: 600_000 },
    });
    const fast = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry().onJob<{ n: string }>({ kind: 'fence.tx', mode: 'transactional', run: async (context) => void (await inbox.record(context.trx, { provider: 'fence', account: 'tx', event_id: context.payload.n })) }),
      config: { workerId: 'fast', leaseSeconds: 30 },
    });
    const id = await enqueue('fence.tx', { n: 'f-1' });
    assert.equal((await slow.runOnce({ rethrow: true })).leased, 1);
    await leaseExpired(id);
    // The expiry task auto-reconciles only kinds its registry declares transactional.
    const reconciler = new Worker({ pool: env.workerPool(), registry: new HandlerRegistry().onJob({ kind: 'fence.tx', mode: 'transactional', run: async () => {} }), config: { workerId: 'reconciler' } });
    const expire = reconciler.scheduler.tasks.find((task) => task.name === 'jobs.expire_leases')!;
    assert.deepEqual(await expire.run(), { parked: 1, autoReconciled: 1 });
    assert.equal((await fast.runOnce({ rethrow: true })).leased, 1, 'a new lease with fencing token 2');
    stalled.open();
    await slow.idle();
    await fast.idle();
    assert.equal(slow.metrics.value('trustwork_worker_jobs_total', { kind: 'fence.tx', result: 'fenced_out' }), 1);
    assert.equal(fast.metrics.value('trustwork_worker_jobs_total', { kind: 'fence.tx', result: 'succeeded' }), 1);
    const row = await jobRow(id);
    assert.deepEqual([row.state, row.fencing_token], ['succeeded', '2']);
    const n = await env.db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.inbox_receipt WHERE provider = 'fence'");
    assert.equal(n.rows[0]?.n, 1, 'exactly one database effect');
  });

  await t.test('stale fencing token: a stalled external call cannot overwrite the newer outcome; both calls carry the same effect key', async (st) => {
    const stalled = gate();
    st.after(() => stalled.open());
    const calls: string[] = [];
    const slow = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry().onJob({ kind: 'fence.ext', mode: 'external', run: async (context) => {
        await stalled.promise;
        calls.push(`slow ${context.effectKey}`);
      } }),
      config: { workerId: 'stalled-ext', leaseSeconds: 1, heartbeatMs: 600_000, externalTimeoutMs: 120_000 },
    });
    const fast = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry().onJob({ kind: 'fence.ext', mode: 'external', run: async (context) => void calls.push(`fast ${context.effectKey}`) }),
      config: { workerId: 'fast-ext' },
    });
    const id = await enqueue('fence.ext');
    await slow.runOnce({ rethrow: true });
    await leaseExpired(id);
    assert.deepEqual(await expireTask.run(), { parked: 1, autoReconciled: 0 });
    assert.equal((await cli('reconcile', id, 'queued', 'provider-lookup:not-received')).code, 0);
    await fast.runOnce({ rethrow: true });
    await fast.idle();
    stalled.open();
    await slow.idle();
    assert.deepEqual(calls, [`fast job:${id}`, `slow job:${id}`], 'local fencing cannot cancel an in-flight call: the provider deduplicates by the stable key');
    assert.equal(slow.metrics.value('trustwork_worker_jobs_total', { kind: 'fence.ext', result: 'fenced_out' }), 1);
    assert.equal((await jobRow(id)).state, 'succeeded');
  });

  await t.test('clock skew: decisions use the database clock, so a worker whose clock is hours off neither parks live leases nor mis-schedules retries', async (st) => {
    const held = gate();
    st.after(() => held.open());
    // Fresh schedule slots: earlier subtests ran the survivor's scheduler.
    await env.db.admin.query('DELETE FROM trustwork.worker_schedule');
    const live = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry().onJob({ kind: 'skew.hold', mode: 'transactional', run: async () => held.promise }),
      config: { workerId: 'live', leaseSeconds: 30 },
    });
    const holdId = await enqueue('skew.hold');
    await live.runOnce({ rethrow: true });
    const retryId = await enqueue('skew.retry');
    const skewed = new Worker({
      pool: env.workerPool(),
      registry: new HandlerRegistry()
        .onJob({ kind: 'skew.retry', mode: 'external', run: async () => { throw new RetryableJobError('upstream busy'); } })
        .onJob({ kind: 'skew.hold', mode: 'transactional', run: async () => {} }),
      config: { workerId: 'skewed', retryJitter: 0, retry: { maxAttempts: 5, backoff: 'fixed', baseSeconds: 10, maxDelaySeconds: 10, retryOn: ['server_error'] }, schedule: { expireLeasesSeconds: 3600, sweepSeconds: 3600, partitionsSeconds: 3600 } },
    });
    const scheduled: string[][] = [];
    for (const offsetHours of [3, -3, 3]) {
      st.mock.timers.enable({ apis: ['Date'], now: Date.now() + offsetHours * 3_600_000 });
      try {
        // Hazard check: an expiry computed from this host's clock would park the live lease.
        await assert.rejects(tx(env.workerPool(1), async (trx) => {
          const wouldPark = await jobs.expireLeases(trx, new Date());
          assert.equal(wouldPark.some((j) => j.id === holdId), offsetHours > 0, 'a host clock ahead would park the live lease');
          throw new Error('rollback');
        }), /rollback/);
        const report = await skewed.runOnce({ rethrow: true });
        await skewed.idle();
        assert.equal((await jobRow(holdId)).state, 'leased', `the live lease survives a worker clock ${offsetHours} h off`);
        scheduled.push(report.scheduled);
      } finally {
        st.mock.timers.reset();
      }
      const retry = await jobRow(retryId);
      assert.equal(retry.state, 'queued');
      assert.ok(Math.abs(retry.delay - 10) < 2, `retry at database now + 10 s (${retry.delay})`);
      await env.db.admin.query('UPDATE trustwork.job SET next_at = now() WHERE id = $1', [retryId]);
    }
    // Hourly slots: claimed once by the database clock; a host clock three hours ahead does not make them due again.
    assert.deepEqual(scheduled, [['jobs.expire_leases', 'maintenance.sweep_expired', 'maintenance.monthly_partitions'], [], []]);
    const slots = await tx(env.db.admin, (trx) => maintenance.listScheduledTasks(trx));
    assert.deepEqual(slots.map((s) => [s.task, s.run_count, s.last_outcome]), [['jobs.expire_leases', '1', 'succeeded'], ['maintenance.monthly_partitions', '1', 'succeeded'], ['maintenance.sweep_expired', '1', 'succeeded']]);
    held.open();
    await live.idle();
    assert.equal((await jobRow(holdId)).state, 'succeeded');
  });

  await t.test('graceful shutdown: stops leasing, finishes quick work, releases cancelled transactional work and parks an in-flight external call', async (st) => {
    const external = gate();
    st.after(() => external.open());
    const started = new Set<string>();
    const worker = new Worker({
      pool: env.workerPool(), tasks: () => [],
      registry: new HandlerRegistry()
        .onJob({ kind: 'grace.quick', mode: 'transactional', run: async () => { started.add('quick'); } })
        .onJob({ kind: 'grace.tx', mode: 'transactional', run: async (context) => {
          started.add('tx');
          await context.trx.selectNoFrom((eb) => eb.fn('pg_sleep', [eb.lit(30)]).as('slept')).execute();
        } })
        .onJob({ kind: 'grace.ext', mode: 'external', run: async () => {
          started.add('ext');
          await external.promise;
        } }),
      config: { workerId: 'graceful', concurrency: 4, pollIntervalMs: 20 },
    });
    const [quick, txJob, ext] = [await enqueue('grace.quick'), await enqueue('grace.tx'), await enqueue('grace.ext')];
    worker.start();
    await waitFor(() => started.size === 3, 10_000, 'all three jobs to start');
    await sleep(100);
    await worker.stop(300);
    assert.equal((await jobRow(quick)).state, 'succeeded');
    const released = await jobRow(txJob);
    assert.deepEqual([released.state, released.attempt], ['queued', 0], 'cancelled, rolled back and released without consuming an attempt');
    const parked = await jobRow(ext);
    assert.equal(parked.state, 'outcome_unknown');
    assert.match(parked.last_error ?? '', /shut down during an external call/);
    assert.equal(worker.metrics.value('trustwork_worker_unknown_outcomes_total', { kind: 'grace.ext', reason: 'shutdown' }), 1);
    const later = await enqueue('grace.quick');
    await sleep(200);
    assert.equal((await jobRow(later)).state, 'queued', 'a stopped worker leases nothing');
    external.open();
    await worker.idle();
    assert.equal((await jobRow(ext)).state, 'outcome_unknown', 'the late return of the parked call changes nothing');
  });
});
