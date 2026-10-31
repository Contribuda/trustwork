import test from 'node:test';
import assert from 'node:assert/strict';
import { inbox, outbox } from '@trustwork/data';
import { HandlerRegistry, Worker } from '@trustwork/worker';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, sleep, tx, waitFor } from './helpers/worker-db.js';

const env = await provisionWorkerDatabase('worker_concurrency');

const EVENTS = 60;
const JOBS = 60;

test('two workers on one database: every outbox event and every job is processed exactly once (SKIP LOCKED, fencing)', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());

  // Effects observed per worker: an in-memory provider log (external) and inbox receipts (database, unique per key).
  const external: { worker: string; effectKey: string }[] = [];
  const handled: { worker: string; eventId: string }[] = [];
  const build = (name: string) => {
    const registry = new HandlerRegistry()
      .onOutbox({
        name: 'fanout.audit', type: 'test.fanout',
        handle: async (event, context) => {
          handled.push({ worker: name, eventId: event.id });
          await inbox.record(context.trx, { provider: 'relay', account: 'fanout', event_id: event.id });
          await context.enqueue({ kind: 'test.transactional', payload: { n: event.aggregateId } });
        },
      })
      .onJob<{ n: string }>({
        kind: 'test.transactional', mode: 'transactional',
        run: async (context) => {
          await sleep(Math.random() * 5);
          const { fresh } = await inbox.record(context.trx, { provider: 'job', account: 'transactional', event_id: context.payload.n });
          assert.ok(fresh, `transactional effect ${context.payload.n} applied once`);
        },
      })
      .onJob<{ n: number }>({
        kind: 'test.external', mode: 'external',
        run: async (context) => {
          await sleep(Math.random() * 5);
          external.push({ worker: name, effectKey: context.effectKey });
        },
      });
    return new Worker({ pool: env.workerPool(10), registry, config: { workerId: name, concurrency: 6, relayBatchSize: 7, pollIntervalMs: 20, leaseSeconds: 30 } });
  };
  const a = build('worker-a');
  const b = build('worker-b');

  await tx(env.apiPool, async (trx) => {
    for (let i = 0; i < EVENTS; i++) await outbox.append(trx, { aggregate_kind: 'test', aggregate_id: `e-${i}`, revision: 1, type: 'test.fanout', payload: { i } });
  });
  await tx(env.db.admin, async (trx) => {
    for (let i = 0; i < JOBS; i++) await trx.insertInto('job').values({ kind: 'test.external', payload: JSON.stringify({ n: i }) }).execute();
  });

  a.start();
  b.start();
  await waitFor(async () => {
    const { rows } = await env.db.admin.query<{ open: number; unpublished: number }>(
      "SELECT (SELECT count(*) FROM trustwork.job WHERE state NOT IN ('succeeded'))::int AS open, (SELECT count(*) FROM trustwork.outbox_event WHERE published_at IS NULL)::int AS unpublished",
    );
    return rows[0]?.open === 0 && rows[0]?.unpublished === 0;
  }, 30_000, 'both workers to drain the outbox and the queue');
  await Promise.all([a.stop(5_000), b.stop(5_000)]);

  assert.equal(handled.length, EVENTS, 'each event handled once across both relays');
  assert.equal(new Set(handled.map((h) => h.eventId)).size, EVENTS);
  assert.equal(external.length, JOBS, 'each external job executed once');
  assert.equal(new Set(external.map((e) => e.effectKey)).size, JOBS);
  const receipts = await env.db.admin.query<{ provider: string; n: number }>('SELECT provider, count(*)::int AS n FROM trustwork.inbox_receipt GROUP BY provider ORDER BY provider');
  assert.deepEqual(receipts.rows, [{ provider: 'job', n: EVENTS }, { provider: 'relay', n: EVENTS }]);
  const states = await env.db.admin.query<{ kind: string; state: string; attempts: number; n: number }>('SELECT kind, state, max(attempt)::int AS attempts, count(*)::int AS n FROM trustwork.job GROUP BY kind, state ORDER BY kind');
  assert.deepEqual(states.rows, [{ kind: 'test.external', state: 'succeeded', attempts: 1, n: JOBS }, { kind: 'test.transactional', state: 'succeeded', attempts: 1, n: EVENTS }]);
  const byWorker = (name: string) => handled.filter((h) => h.worker === name).length + external.filter((e) => e.worker === name).length;
  t.diagnostic(`share of work: worker-a ${byWorker('worker-a')}, worker-b ${byWorker('worker-b')}`);
  assert.ok(byWorker('worker-a') > 0 && byWorker('worker-b') > 0, 'both workers took part');
  for (const w of [a, b]) assert.equal(w.metrics.value('trustwork_worker_loop_errors_total', { component: 'job' }) ?? 0, 0);

  // Scheduled maintenance ran once per slot across the two workers.
  const schedule = await env.db.admin.query<{ task: string; run_count: string }>('SELECT task, run_count FROM trustwork.worker_schedule ORDER BY task');
  for (const row of schedule.rows) if (row.task !== 'jobs.expire_leases') assert.equal(row.run_count, '1', `${row.task} ran once`);
});
