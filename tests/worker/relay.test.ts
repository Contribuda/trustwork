import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDelegation, type Delegation } from '@trustwork/contracts';
import { outbox } from '@trustwork/data';
import { HandlerRegistry, PermanentJobError, REDELIVER_KIND, RetryableJobError, Worker } from '@trustwork/worker';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from './helpers/worker-db.js';

const env = await provisionWorkerDatabase('worker_relay');

interface MembershipInvited { companyId: string }
const parseInvited = (payload: unknown): MembershipInvited => {
  const value = payload as Partial<MembershipInvited> | null;
  if (!value || typeof value.companyId !== 'string') throw new Error('companyId required');
  return { companyId: value.companyId };
};

/** Fake provider (ADR 004): records calls, deduplicates by effect key like a provider idempotency key would. */
class FakeNotifier {
  readonly calls: { effectKey: string; attemptId: string; companyId: string }[] = [];
  readonly delivered = new Set<string>();
  send(effectKey: string, attemptId: string, companyId: string): void {
    this.calls.push({ effectKey, attemptId, companyId });
    this.delivered.add(effectKey);
  }
}

test('outbox relay and job runner consume real outbox rows written by the API role (replaces npm run worker:demo)', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const job = (id: string) => env.db.admin.query<{ state: string; attempt: number; max_attempts: number; last_error: string | null; next_at: Date; delay: number }>(
    // delay: the backoff the worker scheduled, measured from the failure (updated_at, set with next_at in the same
    // statement) rather than from this query's now(), so a slow machine between failure and check cannot shrink it.
    'SELECT state, attempt, max_attempts, last_error, next_at, extract(epoch FROM next_at - updated_at)::float8 AS delay FROM trustwork.job WHERE id = $1', [id]).then((r) => r.rows[0]!);
  const jobsOfKind = (kind: string) => env.db.admin.query<{ id: string; state: string; payload: Record<string, unknown> }>('SELECT id, state, payload FROM trustwork.job WHERE kind = $1 ORDER BY created_at, id', [kind]).then((r) => r.rows);

  await t.test('a membership.invited row appended by the API role is relayed to its typed handler, which enqueues a provider job that runs once', async () => {
    const notifier = new FakeNotifier();
    const registry = new HandlerRegistry()
      .onOutbox<MembershipInvited>({
        name: 'notify.membership_invited', type: 'membership.invited', parse: parseInvited,
        handle: async (event, context) => {
          assert.equal(event.payload.companyId, 'company-1', 'typed payload');
          await context.enqueue({ kind: 'notify.send', payload: { eventId: event.id, companyId: event.payload.companyId } });
        },
      })
      .onJob<{ eventId: string; companyId: string }>({
        kind: 'notify.send', mode: 'external',
        run: async (context) => notifier.send(context.effectKey, context.attemptId, context.payload.companyId),
      });
    const worker = new Worker({ pool: env.workerPool(), registry, config: { workerId: 'relay-a', retryJitter: 0 } });
    // The API's write path: aggregate change + outbox intent in one transaction, append-only for the API role.
    await tx(env.apiPool, (trx) => outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: 'm-1', revision: 1, type: 'membership.invited', payload: { companyId: 'company-1' } }));
    await tx(env.apiPool, (trx) => outbox.append(trx, { aggregate_kind: 'project', aggregate_id: 'p-1', revision: 1, type: 'project.created', payload: {} }));

    const first = await worker.runOnce({ rethrow: true });
    assert.equal(first.relayed, 2);
    assert.equal(first.leased, 1, 'the job enqueued by the handler is due in the same iteration');
    await worker.idle();
    const published = await env.db.admin.query<{ type: string; published: boolean }>('SELECT type, published_at IS NOT NULL AS published FROM trustwork.outbox_event ORDER BY id');
    assert.deepEqual(published.rows, [{ type: 'membership.invited', published: true }, { type: 'project.created', published: true }]);
    const [sent] = await jobsOfKind('notify.send');
    assert.equal(sent?.state, 'succeeded');
    assert.deepEqual(notifier.calls.map((c) => c.companyId), ['company-1']);
    assert.equal(notifier.calls[0]?.effectKey, `job:${sent!.id}`);
    assert.equal(worker.metrics.value('trustwork_worker_outbox_events_total', { result: 'handled' }), 1);
    assert.equal(worker.metrics.value('trustwork_worker_outbox_events_total', { result: 'unhandled' }), 1, 'an event type without handlers is published and counted');
    assert.equal(worker.metrics.value('trustwork_worker_jobs_total', { kind: 'notify.send', result: 'succeeded' }), 1);

    const again = await worker.runOnce({ rethrow: true });
    await worker.idle();
    assert.deepEqual([again.relayed, again.leased, notifier.calls.length], [0, 0, 1], 'nothing is delivered twice');

    // The policy check the old demo printed still holds for the worker's callers (delegation is denied, no effect).
    const grant: Delegation = { actions: ['prepare'], contextId: 'fixture-project', expiresAt: '2099-01-01T00:00:00Z', revoked: false, ceiling: { currency: 'USD', minorUnits: '0' } };
    assert.equal(evaluateDelegation(grant, { action: 'place_order', contextId: 'fixture-project', amount: { currency: 'USD', minorUnits: '100' } }, new Date()), 'deny');
  });

  await t.test('a failing handler rolls back to its savepoint and becomes a redelivery job with backoff; other handlers and events are unaffected', async () => {
    let failures = 2;
    const seen: string[] = [];
    const registry = new HandlerRegistry()
      .onOutbox({
        name: 'flaky.projection', type: 'project.published',
        handle: async (event, context) => {
          await context.enqueue({ kind: 'noop', payload: { marker: `flaky-${event.id}` } }); // effect inside the savepoint
          if (failures-- > 0) throw new Error('projection store unavailable');
          seen.push(`flaky:${event.aggregateId}`);
        },
      })
      .onOutbox({ name: 'steady.projection', type: 'project.published', handle: async (event) => void seen.push(`steady:${event.aggregateId}`) })
      .onJob({ kind: 'noop', mode: 'transactional', run: async () => {} });
    const worker = new Worker({ pool: env.workerPool(), registry, config: { workerId: 'relay-b', retryJitter: 0, retry: { maxAttempts: 5, backoff: 'exponential', baseSeconds: 1, maxDelaySeconds: 60, retryOn: ['server_error'] } } });
    await tx(env.apiPool, (trx) => outbox.append(trx, { aggregate_kind: 'project', aggregate_id: 'p-7', revision: 2, type: 'project.published', payload: {} }));
    await worker.runOnce({ rethrow: true });
    await worker.idle();
    assert.deepEqual(seen, ['steady:p-7']);
    const noopMarkers = (await jobsOfKind('noop')).map((j) => j.payload.marker);
    assert.deepEqual(noopMarkers, [], 'the failed handler left no effect (savepoint rolled back)');
    const [redelivery] = await jobsOfKind(REDELIVER_KIND);
    assert.ok(redelivery);
    assert.equal(redelivery.payload.handler, 'flaky.projection');
    const waiting = await job(redelivery.id);
    assert.deepEqual([waiting.state, waiting.attempt], ['queued', 0]);
    assert.ok(waiting.delay > 0.5 && waiting.delay <= 1.5, `the first redelivery waits one backoff step (${waiting.delay})`);
    // Redelivery: the first retry fails again (backoff 1 s computed by the database), the second succeeds.
    await env.db.admin.query("UPDATE trustwork.job SET next_at = now() WHERE id = $1", [redelivery.id]);
    await worker.runOnce({ rethrow: true });
    await worker.idle();
    const retried = await job(redelivery.id);
    assert.equal(retried.state, 'queued');
    assert.equal(retried.attempt, 1);
    assert.ok(retried.delay > 0.5 && retried.delay <= 1.5, `retry delay comes from the database clock (${retried.delay})`);
    await env.db.admin.query('UPDATE trustwork.job SET next_at = now() WHERE id = $1', [redelivery.id]);
    await worker.runOnce({ rethrow: true });
    await worker.idle();
    assert.equal((await job(redelivery.id)).state, 'succeeded');
    assert.deepEqual(seen, ['steady:p-7', 'flaky:p-7']);
    assert.equal((await jobsOfKind('noop')).length, 1, 'exactly one effect from the successful redelivery');
  });

  await t.test('retryable failures back off exponentially and dead-letter after max_attempts; permanent failures and invalid payloads dead-letter at once', async () => {
    const registry = new HandlerRegistry()
      .onJob({ kind: 'provider.flaky', mode: 'external', run: async () => { throw new RetryableJobError('rate limited before acceptance'); } })
      .onJob({ kind: 'provider.rejects', mode: 'external', run: async () => { throw new PermanentJobError('recipient rejected'); } })
      .onJob<{ n: number }>({ kind: 'typed.payload', mode: 'transactional', parse: (p) => { if (typeof (p as { n?: unknown }).n !== 'number') throw new Error('n must be a number'); return p as { n: number }; }, run: async () => {} });
    const worker = new Worker({ pool: env.workerPool(), registry, config: { workerId: 'relay-c', retryJitter: 0, retry: { maxAttempts: 3, backoff: 'exponential', baseSeconds: 2, maxDelaySeconds: 5, retryOn: ['rate_limited'] } } });
    const [flaky, rejects, invalid] = await tx(env.db.admin, async (trx) => [
      (await trx.insertInto('job').values({ kind: 'provider.flaky', payload: '{}', max_attempts: 3 }).returning('id').executeTakeFirstOrThrow()).id,
      (await trx.insertInto('job').values({ kind: 'provider.rejects', payload: '{}' }).returning('id').executeTakeFirstOrThrow()).id,
      (await trx.insertInto('job').values({ kind: 'typed.payload', payload: JSON.stringify({ n: 'x' }) }).returning('id').executeTakeFirstOrThrow()).id,
    ]);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await env.db.admin.query("UPDATE trustwork.job SET next_at = now() WHERE id = $1 AND state = 'queued'", [flaky]);
      await worker.runOnce({ rethrow: true });
      await worker.idle();
      const row = await job(flaky);
      if (row.state === 'queued') delays.push(Math.round(row.delay));
    }
    assert.deepEqual(delays, [2, 4], 'exponential backoff 2 s, 4 s (capped at 5 s)');
    const dead = await job(flaky);
    assert.equal(dead.state, 'dead', 'dead letter after the third attempt');
    assert.match(dead.last_error ?? '', /RetryableJobError: rate limited/);
    assert.equal((await job(rejects)).state, 'dead');
    assert.equal((await job(rejects)).attempt, 1);
    assert.equal((await job(invalid)).state, 'dead');
    assert.match((await job(invalid)).last_error ?? '', /invalid payload for typed.payload/);
    assert.equal(worker.metrics.value('trustwork_worker_jobs_total', { kind: 'provider.flaky', result: 'retried' }), 2);
    assert.equal(worker.metrics.value('trustwork_worker_jobs_total', { kind: 'provider.flaky', result: 'dead' }), 1);
  });
});
