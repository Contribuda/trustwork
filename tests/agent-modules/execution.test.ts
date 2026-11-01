import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { jobs, withMaintenance } from '@trustwork/data';
import { HandlerRegistry, JobRunner, Metrics, OutboxRelay, inTransaction, workerConfigFromEnv } from '@trustwork/worker';
import { CORE_AGENT_MANIFEST } from '../../packages/contracts/src/agents.js';
import type { JobTrigger } from '../../packages/contracts/src/agent-catalog.js';
import { registerAgentOccurrences, agentOccurrencesTask } from '../../apps/worker/src/agent-modules/index.js';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { login, seedPersonas } from '../backend/helpers/personas.js';
import { as, fails, workerLogin } from '../assistant/helpers.js';
import { activatePolicy, buildAgentWorld, ok } from './helpers.js';
import { usHubPolicy } from './fixtures.js';

const h = await startHarness('agent_modules_execution');
test('durable occurrences execute private goal reports through real worker leases', { skip: h ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!h) return;
  const worker = await workerLogin(h);
  t.after(async () => { await worker.close(); await h.close(); });
  const world = await buildAgentWorld(h);
  const seed = await seedPersonas(h);
  const policy = usHubPolicy(world.hubId);
  const core = CORE_AGENT_MANIFEST;
  policy.policy.enabledModules.push({ moduleKey: core.key, moduleVersion: core.version, freeQuota: [], settings: {} });
  policy.modules.push({ ...policy.modules[0]!, moduleKey: core.key, limits: { ...policy.modules[0]!.limits, concurrentRuns: 20 }, actions: ['prepare'], capabilityIds: core.capabilities.map((c) => c.id), dataClasses: ['budgets'] });
  policy.participantSettings.approval.defaultMode = 'pre_authorized';
  policy.jobTemplates.push({ moduleKey: 'core', templateKey: 'goal_progress_report', labelKey: 'agents.report.goalProgress', actions: ['prepare'],
    triggerKinds: ['request', 'schedule', 'goal', 'event', 'deadline'], defaultTrigger: { kind: 'request' }, minIntervalMinutes: 60, onClosedDay: 'run' });
  await activatePolicy(h, world, policy);
  const client = h.client();
  await login(client, 'petr');
  const created = ok<{ goal: { id: string }; confirmation: { digest: unknown } }>(await client.post('/v1/assistant/goals', {
    onBehalfOf: null, text: 'Synthetic runtime goal', successCriteria: ['One private local report'], needs: [], budgetRange: null,
    horizon: new Date(Date.now() + 30 * 86_400_000).toISOString(), reportCadence: 'none',
  }), 201);
  const goalId = created.goal.id;
  ok(await client.post(`/v1/assistant/goals/${goalId}/confirm`, { digest: created.confirmation.digest }));
  const subscribe = async (trigger: JobTrigger) => {
    const p = ok<{ request: { id: string }; confirmation: { proposalId: string; digest: unknown } }>(await client.post('/v1/assistant/jobs', {
      actingFor: 'self', moduleKey: 'core', templateKey: 'goal_progress_report', trigger, goalContextIds: [goalId],
      validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    }), 201);
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_occurrence WHERE job_request_id = $1', [p.request.id])).rowCount, 0);
    ok(await client.post(`/v1/assistant/mandate-proposals/${p.confirmation.proposalId}/confirm`, { digest: p.confirmation.digest }));
    const s = (await h.db.admin.query<{ job_subscription_id: string }>('SELECT job_subscription_id FROM trustwork.agent_job_request WHERE id = $1', [p.request.id])).rows[0]!;
    return { requestId: p.request.id, id: s.job_subscription_id };
  };
  const request = await subscribe({ kind: 'request' });
  const schedule = await subscribe({ kind: 'schedule', rrule: 'FREQ=DAILY;BYHOUR=9', timeZone: 'America/New_York' });
  const goal = await subscribe({ kind: 'goal', goalId });
  const event = await subscribe({ kind: 'event', eventType: 'agents.goal_progress' });
  const deadline = await subscribe({ kind: 'deadline', contextKind: 'goal', offsetsDays: [7, 1, 0] });
  const pool = worker.pool(3);
  const registry = new HandlerRegistry();
  registerAgentOccurrences(registry);
  const config = workerConfigFromEnv({ WORKER_DATABASE_URL: 'postgresql://unused', WORKER_ID: 'synthetic-occurrences', WORKER_CONCURRENCY: '1' }).config;
  const errors: unknown[] = [];
  const deps = { pool, registry, config, metrics: new Metrics(), log: (level: string, message: string, detail?: unknown) => { if (level === 'error' || level === 'warn') errors.push({ message, detail }); } };
  const relay = new OutboxRelay(deps);
  const runner = new JobRunner(deps);
  const drain = async () => {
    for (let i = 0; i < 30 && await relay.relayOnce(); i++) { /* Bounded source delivery. */ }
    for (let i = 0; i < 30 && await runner.tick(); i++) await runner.idle();
    assert.deepEqual(errors, []);
  };

  await t.test('first-party request operation is idempotent and creates exactly one completed run', async () => {
    const key = randomUUID();
    const a = ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {}, { idempotencyKey: key }));
    assert.deepEqual(ok(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {}, { idempotencyKey: key })), a);
    await drain();
    const rows = (await h.db.admin.query('SELECT source_kind,state,run_id,report_id FROM trustwork.agent_job_occurrence WHERE id = $1', [a.occurrenceId])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'succeeded');
    assert.ok(rows[0]!.run_id && rows[0]!.report_id);
  });

  await t.test('schedule, event, goal and every deadline offset create distinct durable runs', async () => {
    // Move only synthetic source clocks. Production discovery still uses PostgreSQL time and owning rows.
    await withMaintenance(h.db.admin, async (trx) => {
      await sql`UPDATE trustwork.agent_job_schedule SET next_due_at = clock_timestamp() WHERE job_subscription_id = ${schedule.id}::uuid`.execute(trx);
    });
    ok(await client.post(`/v1/assistant/goals/${goalId}/progress`, { evidenceRefs: [{ kind: 'goal', id: goalId }], code: 'runtime_evidence' }), 201);
    await agentOccurrencesTask(pool).run();
    await withMaintenance(h.db.admin, (trx) => sql`UPDATE trustwork.agent_job_deadline SET due_at = clock_timestamp() - interval '1 second' WHERE job_subscription_id = ${deadline.id}::uuid`.execute(trx));
    await agentOccurrencesTask(pool).run();
    await drain();
    const rows = (await h.db.admin.query<{ source_kind: string; state: string; n: string }>('SELECT source_kind,state,count(*) AS n FROM trustwork.agent_job_occurrence GROUP BY source_kind,state ORDER BY source_kind')).rows;
    assert.deepEqual(rows, ['deadline', 'event', 'goal', 'request', 'schedule'].map((source_kind) => ({ source_kind, state: 'succeeded', n: source_kind === 'deadline' ? '3' : '1' })));
    assert.equal((await h.db.admin.query('SELECT count(DISTINCT run_id) AS n FROM trustwork.agent_job_occurrence')).rows[0]!.n, '7');
    await agentOccurrencesTask(pool).run();
    await drain();
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_occurrence')).rowCount, 7);
    assert.ok(goal.id && event.id);
  });

  await t.test('duplicate delivery and distinct same-time evidence keep stable independent source identities', async () => {
    const before = (await h.db.admin.query('SELECT id FROM trustwork.agent_job_occurrence')).rowCount!;
    await withMaintenance(h.db.admin, async (trx) => {
      for (let i = 0; i < 2; i++) await sql`INSERT INTO trustwork.goal_progress(goal_id,event_kind,evidence_refs,recorded_by_person_id,at)
        VALUES(${goalId}::uuid,'evidence','[]'::jsonb,${seed.people.petr}::uuid,now())`.execute(trx);
    });
    await drain();
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_occurrence')).rowCount, before + 4);
    const signals = (await h.db.admin.query<{ id: string }>("SELECT id FROM trustwork.agent_occurrence_signal WHERE kind = 'progress'")).rows;
    for (const signal of signals) await inTransaction(pool, (trx) => sql`SELECT trustwork.agent_modules_consume_signal(${signal.id}::uuid)`.execute(trx));
    await drain();
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_job_occurrence')).rowCount, before + 4);
  });

  await t.test('rollback, restart, duplicate starts and late stale callbacks preserve one run and report', async () => {
    const occurrence = ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {})).occurrenceId;
    const [job] = await inTransaction(pool, (trx) => jobs.lease(trx, ['agents.start_occurrence'], 'synthetic-crash', 30, 1));
    assert.ok(job);
    const start = (fence = job.fencing_token) => inTransaction(pool, (trx) => sql`SELECT trustwork.agent_modules_start_occurrence(${occurrence}::uuid,${job.id}::uuid,${fence}::bigint)`.execute(trx));
    await assert.rejects(inTransaction(pool, async (trx) => {
      await sql`SELECT trustwork.agent_modules_start_occurrence(${occurrence}::uuid,${job.id}::uuid,${job.fencing_token}::bigint)`.execute(trx);
      throw new Error('synthetic crash before commit');
    }), /synthetic crash/);
    assert.equal((await h.db.admin.query('SELECT run_id FROM trustwork.agent_job_occurrence WHERE id = $1', [occurrence])).rows[0]!.run_id, null);
    await assert.rejects(start(String(BigInt(job.fencing_token) + 1n)), (e: unknown) => (e as { code?: string }).code === '55P03');
    await start();
    await start(); // A committed start followed by a lost acknowledgement resumes the same run.
    await inTransaction(pool, (trx) => jobs.complete(trx, job.id, job.fencing_token));
    await drain();
    await assert.rejects(start(), (e: unknown) => (e as { code?: string }).code === '55P03');
    const result = (await h.db.admin.query('SELECT state,run_id,report_id FROM trustwork.agent_job_occurrence WHERE id = $1', [occurrence])).rows[0]!;
    assert.equal(result.state, 'succeeded');
    assert.equal((await h.db.admin.query('SELECT id FROM trustwork.agent_report WHERE run_id = $1', [result.run_id])).rowCount, 1);
  });

  await t.test('a resource revocation between run start and final effect refuses the effect', async () => {
    const occurrence = ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {})).occurrenceId;
    const [job] = await inTransaction(pool, (trx) => jobs.lease(trx, ['agents.start_occurrence'], 'synthetic-pause', 30, 1));
    assert.ok(job);
    await inTransaction(pool, async (trx) => {
      await sql`SELECT trustwork.agent_modules_start_occurrence(${occurrence}::uuid,${job.id}::uuid,${job.fencing_token}::bigint)`.execute(trx);
      assert.equal(await jobs.complete(trx, job.id, job.fencing_token), true);
    });
    const revision = (await h.db.admin.query('SELECT revision FROM trustwork.goal WHERE id = $1', [goalId])).rows[0]!.revision;
    const paused = ok<{ revision: number }>(await client.post(`/v1/assistant/goals/${goalId}/status`, { status: 'paused', outcome: null, expectedRevision: revision }));
    await drain();
    const result = (await h.db.admin.query('SELECT state,reason,report_id FROM trustwork.agent_job_occurrence WHERE id = $1', [occurrence])).rows[0]!;
    assert.deepEqual(result, { state: 'refused', reason: 'goal_changed', report_id: null });
    ok(await client.post(`/v1/assistant/goals/${goalId}/status`, { status: 'active', outcome: null, expectedRevision: paused.revision }));
    await drain();
    assert.equal((await h.db.admin.query('SELECT report_id FROM trustwork.agent_job_occurrence WHERE id = $1', [occurrence])).rows[0]!.report_id, null);
  });

  await t.test('a current capability policy denial blocks queued work before creating a run', async () => {
    const occurrence = ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {})).occurrenceId;
    await activatePolicy(h, world, { ...policy, capabilities: [{ capabilityId: 'core.generate_goal_report', offForHub: true, offForPrincipalKinds: [], offForPlans: [] }] });
    await drain();
    const result = (await h.db.admin.query('SELECT state,reason,run_id FROM trustwork.agent_job_occurrence WHERE id = $1', [occurrence])).rows[0]!;
    assert.deepEqual(result, { state: 'refused', reason: 'capability.off_for_hub', run_id: null });
  });

  await t.test('concurrent admissions share protection quotas and retries consume each measure once', async () => {
    const limited = structuredClone(policy);
    limited.modules.find(m => m.moduleKey === 'core')!.limits.concurrentRuns = 1;
    await activatePolicy(h, world, limited);
    const ids = [];
    for (let i = 0; i < 2; i++) ids.push(ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {})).occurrenceId);
    const leased = await inTransaction(pool, trx => jobs.lease(trx, ['agents.start_occurrence'], 'synthetic-quota-race', 60, 2));
    assert.equal(leased.length, 2);
    const started = await Promise.all(leased.map(job => inTransaction(pool, async trx => {
      const id = (job.payload as { occurrenceId: string }).occurrenceId;
      const result = await sql<{ value: { state: string; reason?: string } }>`SELECT trustwork.agent_modules_start_occurrence(${id}::uuid,${job.id}::uuid,${job.fencing_token}::bigint) AS value`.execute(trx);
      await sql`SELECT trustwork.agent_modules_start_occurrence(${id}::uuid,${job.id}::uuid,${job.fencing_token}::bigint)`.execute(trx);
      await jobs.complete(trx, job.id, job.fencing_token);
      return result.rows[0]!.value;
    })));
    assert.deepEqual(started.map(r => r.state).sort(), ['refused', 'running']);
    assert.equal(started.find(r => r.state === 'refused')?.reason, 'quota_concurrent');
    await drain();
    const usage = await h.db.admin.query<{ measure: string; n: string }>('SELECT measure,count(*) AS n FROM trustwork.agent_runtime_usage WHERE operation_id=ANY($1::uuid[]) GROUP BY measure ORDER BY measure', [ids]);
    assert.deepEqual(usage.rows, [{ measure: 'action', n: '1' }, { measure: 'run', n: '1' }]);
    for (const measure of ['run', 'action'] as const) {
      const narrowed = structuredClone(policy);
      narrowed.modules.find(m => m.moduleKey === 'core')!.limits[measure === 'run' ? 'runsPerDay' : 'actionsPerDay'] = 0;
      await activatePolicy(h, world, narrowed);
      const id = ok<{ occurrenceId: string }>(await client.post(`/v1/assistant/jobs/${request.requestId}/run`, {})).occurrenceId;
      await drain();
      const row: { state: string; reason: string; report_id: string | null } = (await h.db.admin.query('SELECT state,reason,report_id FROM trustwork.agent_job_occurrence WHERE id=$1', [id])).rows[0]!;
      assert.deepEqual(row, { state: 'refused', reason: `quota_${measure}_daily`, report_id: null });
    }
    await activatePolicy(h, world, policy);
  });

  await t.test('staff and another participant cannot read occurrences or dispatch a worker function', async () => {
    for (const person of [seed.people.carl, world.w.people.owner]) await as(h, person, async (trx) => {
      assert.equal((await trx.selectFrom('agent_job_occurrence').selectAll().execute()).length, 0);
      await fails(sql`SELECT trustwork.agent_modules_consume_signal(${randomUUID()}::uuid)`.execute(trx), '42501');
    });
    await inTransaction(pool, (trx) => fails(sql`SELECT * FROM trustwork.agent_job_occurrence`.execute(trx), '42501'));
  });
});
