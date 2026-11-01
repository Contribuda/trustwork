import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentJobWorker } from '../../packages/data/src/repositories/agent-modules.js';
import { inTransaction } from '@trustwork/worker';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, fails, workerLogin } from '../assistant/helpers.js';
import { GoalOccurrenceFeed } from '../../apps/api/src/modules/agent-modules/goal-feed.js';
import { sql } from 'kysely';
import { goals } from '../../packages/data/src/repositories/agents.js';
import { setTimeout as delay } from 'node:timers/promises';
import { activatePolicy, buildAgentWorld, ok } from './helpers.js';
import { runtimeHubPolicy } from './fixtures.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const h = await startHarness('agent_modules_feeds');
test('persisted source hub cannot be replaced by an API or worker argument', { skip: h ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  await activatePolicy(h, world, runtimeHubPolicy(world.hubId));
  const client = h.client();
  await login(client, 'petr');
  const proposed = ok<{ request: { id: string }; confirmation: { proposalId: string; digest: unknown } }>(await client.post('/v1/assistant/jobs', {
    actingFor: 'self', moduleKey: 'project_planner', templateKey: 'weekly_plan_review', trigger: null,
    validUntil: new Date(Date.now() + 86_400_000 * 90).toISOString(),
  }), 201);
  ok(await client.post(`/v1/assistant/mandate-proposals/${proposed.confirmation.proposalId}/confirm`, { digest: proposed.confirmation.digest }));
  const row = (await h.db.admin.query<{ job_subscription_id: string; first_due_at: Date }>(
    'SELECT job_subscription_id, first_due_at FROM trustwork.agent_job_request WHERE id = $1', [proposed.request.id],
  )).rows[0]!;
  const pool = worker.pool(2);
  const fire = (hubId: string | null) => inTransaction(pool, (trx) => agentJobWorker.recordFire(trx, {
    subscriptionId: row.job_subscription_id, cause: 'schedule', dueAt: row.first_due_at, nextDueAt: null, hubId,
  }));
  for (const hub of [randomUUID(), null]) {
    await assert.rejects(fire(hub), (e: unknown) => (e as { hint?: string }).hint === 'agents.hub_mismatch');
  }
  assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_fire WHERE job_subscription_id = $1', [row.job_subscription_id])).rowCount, 0);
  assert.equal(await fire(world.hubId), 'due');
  await assert.rejects(fire(randomUUID()), (e: unknown) => (e as { hint?: string }).hint === 'agents.hub_mismatch', 'even a duplicate cannot bypass provenance validation');

  const feed = new GoalOccurrenceFeed();
  const draft = runtimeHubPolicy(world.hubId);
  draft.jobTemplates[0]!.triggerKinds = ['schedule', 'request', 'event', 'goal', 'deadline'];
  await activatePolicy(h, world, draft);
  const goal = ok<{ goal: { id: string }; confirmation: { digest: unknown } }>(await client.post('/v1/assistant/goals', {
    onBehalfOf: null, text: 'Synthetic goal source', successCriteria: ['A verified local draft'], needs: [], budgetRange: null,
    horizon: new Date(Date.now() + 30 * 86_400_000).toISOString(), reportCadence: 'none',
  }), 201);
  const confirmedGoal = ok<{ revision: number }>(await client.post(`/v1/assistant/goals/${goal.goal.id}/confirm`, { digest: goal.confirmation.digest }));
  const subscribe = async (trigger: unknown) => {
    const proposal = ok<{ request: { id: string }; confirmation: { proposalId: string; digest: unknown } }>(await client.post('/v1/assistant/jobs', {
      actingFor: 'self', moduleKey: 'project_planner', templateKey: 'weekly_plan_review', trigger, goalContextIds: [goal.goal.id],
      validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    }), 201);
    ok(await client.post(`/v1/assistant/mandate-proposals/${proposal.confirmation.proposalId}/confirm`, { digest: proposal.confirmation.digest }));
    return (await h.db.admin.query<{ job_subscription_id: string }>('SELECT job_subscription_id FROM trustwork.agent_job_request WHERE id = $1', [proposal.request.id])).rows[0]!.job_subscription_id;
  };
  const deadlineSub = await subscribe({ kind: 'deadline', contextKind: 'goal', offsetsDays: [40, 7, 1, 0] });
  const eventSub = await subscribe({ kind: 'event', eventType: 'agents.goal_progress' });
  const goalSub = await subscribe({ kind: 'goal', goalId: goal.goal.id });
  const sync = () => inTransaction(pool, (trx) => agentJobWorker.syncGoalDeadlines(trx, deadlineSub));

  await t.test('real owner projections and explicit goal contexts expose every deadline offset only to their owner', async () => {
    assert.equal((await as(h, seed.people.petr, (trx) => feed.deadlines(trx, deadlineSub))).length, 1);
    for (const personId of [seed.people.carl, world.w.people.owner]) {
      assert.deepEqual(await as(h, personId, (trx) => feed.deadlines(trx, deadlineSub)), []);
    }
    assert.equal(await sync(), 4);
    assert.equal(await sync(), 0, 'restart does not duplicate offsets');
    const rows = (await h.db.admin.query<{ offset_days: number; state: string }>('SELECT offset_days, state FROM trustwork.agent_job_deadline WHERE job_subscription_id = $1 ORDER BY offset_days', [deadlineSub])).rows;
    assert.deepEqual(rows, [{ offset_days: 0, state: 'pending' }, { offset_days: 1, state: 'pending' }, { offset_days: 7, state: 'pending' }, { offset_days: 40, state: 'elapsed' }]);
    await as(h, world.w.people.owner, async (trx) => assert.equal((await trx.selectFrom('agent_job_deadline').selectAll().execute()).length, 0));
    await inTransaction(pool, (trx) => fails(sql`SELECT * FROM trustwork.goal`.execute(trx), '42501'));
    await as(h, seed.people.petr, (trx) => fails(sql`SELECT trustwork.agent_modules_sync_goal_deadlines(${deadlineSub}::uuid)`.execute(trx), '42501'));
  });

  await t.test('stored evidence creates a typed reference; event and goal feeds reauthorize without exposing private payloads', async () => {
    const progress = ok<{ id: string }>(await client.post(`/v1/assistant/goals/${goal.goal.id}/progress`, { evidenceRefs: [{ kind: 'goal', id: goal.goal.id }], code: 'source_verified' }), 201);
    const events = (await h.db.admin.query<{ payload: unknown }>("SELECT payload FROM trustwork.outbox_event WHERE type = 'agents.goal_progress' AND aggregate_id = $1", [progress.id])).rows;
    assert.deepEqual(events, [{ payload: { progressId: progress.id } }]);
    for (const subscriptionId of [eventSub, goalSub]) {
      assert.equal((await as(h, seed.people.petr, (trx) => feed.progress(trx, subscriptionId, progress.id)))?.goalId, goal.goal.id);
      assert.equal(await as(h, seed.people.carl, (trx) => feed.progress(trx, subscriptionId, progress.id)), null);
      assert.equal(await as(h, world.w.people.owner, (trx) => feed.progress(trx, subscriptionId, progress.id)), null);
    }
    const before = (await h.db.admin.query("SELECT id FROM trustwork.outbox_event WHERE type = 'agents.goal_progress'")).rowCount;
    ok(await client.post(`/v1/assistant/goals/${goal.goal.id}/report`, {}), 201);
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.outbox_event WHERE type = 'agents.goal_progress'")).rowCount, before, 'generated report cannot recursively trigger itself');
    const paused = ok<{ revision: number }>(await client.post(`/v1/assistant/goals/${goal.goal.id}/status`, { status: 'paused', outcome: null, expectedRevision: confirmedGoal.revision }));
    assert.equal(await as(h, seed.people.petr, (trx) => feed.progress(trx, eventSub, progress.id)), null);
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rowCount, 0, 'the owner command invalidates without a scheduler tick');
    assert.equal(await sync(), 0);
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rowCount, 0);
    ok(await client.post(`/v1/assistant/goals/${goal.goal.id}/status`, { status: 'active', outcome: null, expectedRevision: paused.revision }));
    assert.equal(await sync(), 4, 'a new resource revision gets all offsets, preserving old rows');
    assert.equal(await sync(), 0);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_deadline WHERE job_subscription_id = $1', [deadlineSub])).rowCount, 8);
  });

  await t.test('calendar changes invalidate old offsets and never replay elapsed offsets', async () => {
    await activatePolicy(h, world, { ...draft, calendar: { ...draft.calendar, timeZone: 'America/Los_Angeles' } });
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rowCount, 0);
    assert.equal(await sync(), 4);
    const pending = (await h.db.admin.query<{ hour: number }>("SELECT extract(hour FROM due_at AT TIME ZONE 'America/Los_Angeles')::integer AS hour FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rows;
    assert.deepEqual(pending, [{ hour: 9 }, { hour: 9 }, { hour: 9 }]);
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'elapsed'")).rowCount, 3);
  });

  await t.test('a source pause committed before discovery invalidates old rows after the row lock wait', async () => {
    const release = deferred<void>();
    const paused = deferred<void>();
    const pidReady = deferred<number>();
    const pause = as(h, seed.people.petr, async (trx) => {
      const current = await goals.get(trx, goal.goal.id);
      await goals.setStatus(trx, goal.goal.id, current!.revision, 'paused', null);
      paused.resolve();
      await release.promise;
    });
    await paused.promise;
    const discovery = inTransaction(pool, async (trx) => {
      pidReady.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid);
      return agentJobWorker.syncGoalDeadlines(trx, deadlineSub);
    });
    try {
      const pid = await pidReady.promise;
      let blocked = false;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        blocked = (await h.db.admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]!.blocked;
        if (blocked) break;
        await delay(20);
      }
      assert.equal(blocked, true, 'the real worker waits for the owning goal command');
    } finally { release.resolve(); }
    await pause;
    assert.equal(await discovery, 0);
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rowCount, 0);
  });

  await t.test('discovery committed first is invalidated by the waiting owner pause in the same transaction', async () => {
    await as(h, seed.people.petr, async (trx) => {
      const current = await goals.get(trx, goal.goal.id);
      await goals.setStatus(trx, goal.goal.id, current!.revision, 'active', null);
    });
    const release = deferred<void>();
    const discovered = deferred<void>();
    const pidReady = deferred<number>();
    const discovery = inTransaction(pool, async (trx) => {
      assert.equal(await agentJobWorker.syncGoalDeadlines(trx, deadlineSub), 4);
      discovered.resolve();
      await release.promise;
    });
    await discovered.promise;
    const pause = as(h, seed.people.petr, async (trx) => {
      const current = await goals.get(trx, goal.goal.id);
      pidReady.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid);
      await goals.setStatus(trx, goal.goal.id, current!.revision, 'paused', null);
    });
    try {
      const pid = await pidReady.promise;
      let blocked = false;
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        blocked = (await h.db.admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]!.blocked;
        if (blocked) break;
        await delay(20);
      }
      assert.equal(blocked, true, 'the real owner command waits for discovery');
    } finally { release.resolve(); }
    await discovery;
    await pause;
    assert.equal((await h.db.admin.query("SELECT id FROM trustwork.agent_job_deadline WHERE state = 'pending'")).rowCount, 0, 'no scheduler tick is needed');
  });
});
