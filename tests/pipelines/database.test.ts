import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { withMaintenance, type Transaction } from '@trustwork/data';
import { pipelines, pipelineWorker } from '../../packages/data/src/repositories/pipelines.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { buildPipelinesWorld, scheduleInput, versionInput, ZERO_COUNTS, type PipelinesWorld } from './helpers.js';

/**
 * PIPE-001 on real PostgreSQL under the runtime role: staff authority and separation of duties for versions, schedules
 * and runs; the run state machine; dry runs that commit nothing; the effect ledger that never repeats an effect whose
 * outcome is unknown, not even in a retry run; kill switches and per-role caps; windows; source-change pauses; and
 * concurrency. Every person, hub and source is synthetic.
 */
const db = await provisionTestDatabase('pipelines_db');

test('pipeline engine persistence under the restricted runtime role', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const w: PipelinesWorld = await buildPipelinesWorld(db.admin, db.app);
  const p = w.people;
  const worker = <T>(fn: (trx: Transaction) => Promise<T>) => withMaintenance(db.admin, fn);
  const count = async (table: string) => Number((await db.admin.query(`SELECT count(*)::int AS n FROM trustwork.${table}`)).rows[0].n);
  const engage = (pipelineId: string) => db.admin.query("INSERT INTO trustwork.kill_switch (scope_kind, hub_id, pipeline_id, engaged_by, reason) VALUES ('pipeline', $1, $2, $3, 'Synthetic incident') RETURNING id",
    [w.hubId, pipelineId, w.admin.people.owner]).then((r) => r.rows[0].id as string);

  /** A pipeline drafted by A and activated by B, optionally with a schedule. */
  const activePipeline = async (opts: { role?: string; schedule?: boolean; concurrency?: number } = {}) => {
    const pipeline = await w.cmd(p.stewardA, (trx, ctx) => pipelines.create(trx, ctx, w.hubId, 'source_ingestion', 'Synthetic ingestion'));
    const version = await w.cmd(p.stewardA, (trx, ctx) => pipelines.draftVersion(trx, ctx, pipeline.id, versionInput(opts.role ? { role: opts.role } : {})));
    const active = await w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, version.id));
    const schedule = opts.schedule || opts.concurrency ? await w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, 0, scheduleInput({ concurrency: opts.concurrency ?? 1 }))) : null;
    return { pipeline, version: active, schedule };
  };
  const leaseFor = async (runId: string) => {
    for (let i = 0; i < 20; i++) {
      const leased = await worker((trx) => pipelineWorker.lease(trx, 'synthetic-worker', 60));
      if (!leased) break;
      if (leased.id === runId) return leased;
      await worker((trx) => pipelineWorker.finish(trx, leased.id, leased.lease_token, 'succeeded', ZERO_COUNTS, null));
    }
    throw new Error('run not leased');
  };

  await t.test('only staff of the hub create, read and edit pipelines; outsiders read nothing', async () => {
    await rejects(w.cmd(p.viewer, (trx, ctx) => pipelines.create(trx, ctx, w.hubId, 'source_ingestion', 'Synthetic')), '42501');
    await rejects(w.cmd(p.otherSteward, (trx, ctx) => pipelines.create(trx, ctx, w.hubId, 'source_ingestion', 'Synthetic')), '42501');
    const { pipeline } = await activePipeline();
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.list(trx, w.hubId))).some((x) => x.id === pipeline.id), true);
    assert.deepEqual(await w.act.as(p.viewer, (trx) => pipelines.list(trx, w.hubId)), []);
    assert.deepEqual(await w.act.as(p.otherSteward, (trx) => pipelines.list(trx, w.hubId)), []);
    await rejects(w.act.as(p.stewardA, (trx) => sql`INSERT INTO trustwork.pipeline (hub_id, kind, name, created_by) VALUES (${w.hubId}::uuid, 'source_ingestion', 'Raw', ${p.stewardA}::uuid)`.execute(trx)), '42501');
    const audit = await db.admin.query("SELECT count(*)::int AS n FROM trustwork.admin_audit_event WHERE action LIKE 'pipeline.%' AND object_id = $1", [pipeline.id]);
    assert.equal(audit.rows[0].n, 1, 'creation is audited');
  });

  await t.test('editing creates a new version; the drafter never activates; activation supersedes and needs a cap', async () => {
    const pipeline = await w.cmd(p.stewardA, (trx, ctx) => pipelines.create(trx, ctx, w.hubId, 'source_ingestion', 'Synthetic versions'));
    const v1 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.draftVersion(trx, ctx, pipeline.id, versionInput()));
    await rejects(w.cmd(p.stewardA, (trx, ctx) => pipelines.activateVersion(trx, ctx, v1.id)), '42501', 'admin.self_approval');
    const noCap = await w.cmd(p.stewardA, (trx, ctx) => pipelines.draftVersion(trx, ctx, pipeline.id, versionInput({ budgetId: null })));
    await rejects(w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, noCap.id)), '23514', 'pipelines.cap_required');
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, v1.id));
    const v3 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.draftVersion(trx, ctx, pipeline.id, versionInput({ name: 'Synthetic v3' })));
    assert.equal(v3.version, 3);
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, v3.id));
    const versions = await w.act.as(p.stewardA, (trx) => pipelines.versions(trx, pipeline.id));
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[3, 'active'], [2, 'draft'], [1, 'superseded']]);
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.pipeline_version SET name = 'Edited in place' WHERE id = ${v3.id}::uuid`.execute(trx)), '23514', 'pipelines.version_immutable');
    await rejects(w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, v1.id)), '23514', 'pipelines.not_draft');
  });

  await t.test('schedules keep revisions; pause records who and why; stale revisions refuse', async () => {
    const { pipeline } = await activePipeline();
    const s1 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, 0, scheduleInput()));
    await rejects(w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, 0, scheduleInput())), '40001', 'validation.revision_conflict');
    const s2 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, s1.revision, scheduleInput({ cron: '0 3 * * *' })));
    assert.equal(s2.revision, 2);
    const paused = await w.cmd(p.stewardB, (trx, ctx) => pipelines.pauseSchedule(trx, ctx, s2.id, 2, true, 'Waiting for the publisher reply'));
    assert.deepEqual([paused.paused, paused.paused_by, paused.paused_reason], [true, p.stewardB, 'Waiting for the publisher reply']);
    assert.equal(await worker((trx) => pipelineWorker.enqueueScheduled(trx, s2.id, new Date('2026-11-02T09:00:00Z'), true)), null, 'a paused schedule queues nothing');
    await rejects(w.cmd(p.viewer, (trx, ctx) => pipelines.pauseSchedule(trx, ctx, s2.id, 3, false, null)), '42501');
  });

  await t.test('scheduled runs: one per due time; outside every window recorded skipped_window, never executed', async () => {
    const { schedule } = await activePipeline({ schedule: true });
    const due = new Date('2026-11-02T08:15:00Z');
    const first = await worker((trx) => pipelineWorker.enqueueScheduled(trx, schedule!.id, due, true));
    const again = await worker((trx) => pipelineWorker.enqueueScheduled(trx, schedule!.id, due, true));
    assert.equal(first!.id, again!.id, 'idempotent per due time');
    const skipped = await worker((trx) => pipelineWorker.enqueueScheduled(trx, schedule!.id, new Date('2026-11-02T20:15:00Z'), false));
    assert.equal(skipped!.state, 'skipped_window');
    assert.ok(skipped!.finished_at && !skipped!.started_at, 'never started');
  });

  await t.test('a dry run commits nothing: no effect, no charge, effects_committed false', async () => {
    const { pipeline, version } = await activePipeline({ role: 'writer' });
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.setRoleCap(trx, ctx, w.hubId, 'writer', 'USD', '1000'));
    await rejects(w.cmd(p.viewer, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'dry_run', null)), '42501');
    const run = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'dry_run', null));
    assert.deepEqual([run.trigger, run.dry_run, run.triggered_by], ['dry_run', true, p.stewardA]);
    const before = { effects: await count('pipeline_effect'), spent: (await db.admin.query("SELECT spent_minor FROM trustwork.pipeline_role_cap WHERE hub_id = $1 AND role = 'writer'", [w.hubId])).rows[0].spent_minor };
    const leased = await leaseFor(run.id);
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, run.id, leased.lease_token, 'notify:synthetic:1', 'notification')), 'dry');
    assert.equal(await worker((trx) => pipelineWorker.chargeRole(trx, run.id, leased.lease_token, 'writer', '500')), 'dry');
    const done = await worker((trx) => pipelineWorker.finish(trx, run.id, leased.lease_token, 'succeeded', { ...ZERO_COUNTS, fetched: 3, proposed: 2 }, null));
    assert.deepEqual([done.state, done.effects_committed], ['succeeded', false]);
    assert.equal(await count('pipeline_effect'), before.effects);
    assert.equal((await db.admin.query("SELECT spent_minor FROM trustwork.pipeline_role_cap WHERE hub_id = $1 AND role = 'writer'", [w.hubId])).rows[0].spent_minor, before.spent);
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.pipeline_run SET effects_committed = true WHERE id = ${run.id}::uuid`.execute(trx)), '23514');
    void pipeline;
  });

  await t.test('an effect with an unknown outcome is never repeated, not even by a retry run', async () => {
    const { pipeline, version } = await activePipeline({ schedule: true });
    const run = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
    const leased = await leaseFor(run.id);
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, run.id, leased.lease_token, 'touch:synthetic-co:intro:1', 'outreach_touch')), 'proceed');
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, run.id, leased.lease_token, 'touch:synthetic-co:intro:1', 'outreach_touch')), 'skip', 'not twice in one run');
    // The worker dies after sending: the lease expires, the run fails, the touch stays unknown.
    await db.admin.query("UPDATE trustwork.pipeline_run SET leased_until = now() - interval '1 second' WHERE id = $1", [run.id]);
    assert.equal(await worker((trx) => pipelineWorker.expireLeases(trx)), 1);
    const failed = await w.act.as(p.stewardA, (trx) => pipelines.run(trx, run.id));
    assert.deepEqual([failed!.state, failed!.error_code, failed!.effects_committed], ['failed', 'pipelines.lease_expired', true]);
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.effects(trx, run.id)))[0]!.outcome, 'unknown');
    await rejects(worker((trx) => pipelineWorker.settleEffect(trx, run.id, leased.lease_token, 'touch:synthetic-co:intro:1', 'succeeded', '0')), '40001', 'pipelines.stale_lease');
    const candidates = await worker((trx) => pipelineWorker.retryCandidates(trx));
    assert.ok(candidates.some((c) => c.run_id === run.id));
    const retry = await worker((trx) => pipelineWorker.queueRetry(trx, run.id));
    assert.deepEqual([retry!.trigger, retry!.retry_of, retry!.attempt], ['retry', run.id, 2]);
    assert.equal(await worker((trx) => pipelineWorker.queueRetry(trx, run.id)), null, 'one retry per failed run');
    const leasedRetry = await leaseFor(retry!.id);
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, retry!.id, leasedRetry.lease_token, 'touch:synthetic-co:intro:1', 'outreach_touch')), 'skip');
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, retry!.id, leasedRetry.lease_token, 'touch:synthetic-co:intro:2', 'outreach_touch')), 'proceed');
    await worker((trx) => pipelineWorker.settleEffect(trx, retry!.id, leasedRetry.lease_token, 'touch:synthetic-co:intro:2', 'succeeded', '0'));
    await worker((trx) => pipelineWorker.finish(trx, retry!.id, leasedRetry.lease_token, 'succeeded', ZERO_COUNTS, null));
    await rejects(withMaintenance(db.admin, (trx) => sql`UPDATE trustwork.pipeline_run SET state = 'failed' WHERE id = ${retry!.id}::uuid`.execute(trx)), '23514', 'pipelines.run_finished');
    await rejects(withMaintenance(db.admin, (trx) => sql`DELETE FROM trustwork.pipeline_effect WHERE run_id = ${run.id}::uuid`.execute(trx)), '23514', 'pipelines.effect_immutable');
    void pipeline;
  });

  await t.test('a kill switch stops queued runs before any step and running runs at the next boundary', async () => {
    const { pipeline, version } = await activePipeline({ concurrency: 2 });
    const running = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
    const leased = await leaseFor(running.id);
    const queued = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
    const kill = await engage(pipeline.id);
    assert.equal(await worker((trx) => pipelineWorker.reserveEffect(trx, running.id, leased.lease_token, 'notify:synthetic:k', 'notification')), 'stop');
    assert.equal(await worker((trx) => pipelineWorker.stepBoundary(trx, running.id, leased.lease_token, 60)), 'stop');
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.run(trx, running.id)))!.state, 'stopped_by_kill_switch');
    await worker((trx) => pipelineWorker.lease(trx, 'synthetic-worker', 60));
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.run(trx, queued.id)))!.state, 'stopped_by_kill_switch');
    // Releasing the switch needs a second person's approval (admin kill switches); it stays engaged for this pipeline.
    assert.ok(kill);
  });

  await t.test('an exhausted role cap skips queued runs of that role while other roles keep running', async () => {
    const editorial = await activePipeline({ role: 'translator' });
    const other = await activePipeline({ role: 'researcher' });
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.setRoleCap(trx, ctx, w.hubId, 'translator', 'USD', '100'));
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.setRoleCap(trx, ctx, w.hubId, 'researcher', 'USD', '100'));
    const first = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, editorial.version.id, 'manual', null));
    const leased = await leaseFor(first.id);
    assert.equal(await worker((trx) => pipelineWorker.chargeRole(trx, first.id, leased.lease_token, 'translator', '100')), 'charged');
    assert.equal(await worker((trx) => pipelineWorker.chargeRole(trx, first.id, leased.lease_token, 'translator', '1')), 'exhausted');
    await worker((trx) => pipelineWorker.finish(trx, first.id, leased.lease_token, 'skipped_budget', ZERO_COUNTS, 'pipelines.role_cap_exhausted'));
    const blocked = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, editorial.version.id, 'manual', null));
    const fine = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, other.version.id, 'manual', null));
    const leasedFine = await leaseFor(fine.id);
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.run(trx, blocked.id)))!.state, 'skipped_budget');
    assert.equal(leasedFine.state, 'running');
    await worker((trx) => pipelineWorker.finish(trx, fine.id, leasedFine.lease_token, 'succeeded', ZERO_COUNTS, null));
    assert.ok((await w.act.as(p.stewardA, (trx) => pipelines.alerts(trx, w.hubId))).some((a) => a.pipeline_id === editorial.pipeline.id && a.rule === 'budget_exhausted'));
  });

  await t.test('a source change pauses every schedule that reads it, with an alert; a person resumes', async () => {
    const { pipeline, schedule } = await activePipeline({ schedule: true });
    const sourceId = '00000000-0000-4000-8000-0000000000aa';
    assert.ok(await worker((trx) => pipelineWorker.sourceChanged(trx, sourceId, 'robots')) >= 1);
    const paused = await w.act.as(p.stewardA, (trx) => pipelines.schedule(trx, pipeline.id));
    assert.deepEqual([paused!.paused, paused!.paused_automatically, paused!.paused_by], [true, true, null]);
    assert.ok((await w.act.as(p.stewardA, (trx) => pipelines.alerts(trx, w.hubId))).some((a) => a.pipeline_id === pipeline.id && a.rule === 'source_changed'));
    const resumed = await w.cmd(p.stewardB, (trx, ctx) => pipelines.pauseSchedule(trx, ctx, schedule!.id, paused!.revision, false, null));
    assert.equal(resumed.paused, false);
  });

  await t.test('failure and empty-run streaks raise alerts; a person acknowledges and resolves them', async () => {
    const { pipeline, version } = await activePipeline({ schedule: true });
    for (let i = 0; i < 2; i++) {
      const run = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
      const leased = await leaseFor(run.id);
      await worker((trx) => pipelineWorker.finish(trx, run.id, leased.lease_token, 'succeeded', ZERO_COUNTS, null));
    }
    const alert = (await w.act.as(p.stewardA, (trx) => pipelines.alerts(trx, w.hubId))).find((a) => a.pipeline_id === pipeline.id && a.rule === 'zero_items_streak');
    assert.ok(alert);
    await rejects(w.cmd(p.viewer, (trx, ctx) => pipelines.decideAlert(trx, ctx, alert.id, 'acknowledged')), '42501');
    const resolved = await w.cmd(p.stewardB, (trx, ctx) => pipelines.decideAlert(trx, ctx, alert.id, 'resolved'));
    assert.deepEqual([resolved.state, resolved.resolved_by], ['resolved', p.stewardB]);
  });

  await t.test('concurrency: one lease per run, one reservation per effect key, cancellation fences the worker', async () => {
    const { version } = await activePipeline({ concurrency: 1 });
    const run = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
    const run2 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, version.id, 'manual', null));
    const leases = await Promise.all([1, 2, 3].map(() => worker((trx) => pipelineWorker.lease(trx, 'synthetic-worker', 60))));
    const mine = leases.filter((l) => l && (l.id === run.id || l.id === run2.id));
    assert.equal(mine.length, 1, 'concurrency 1: one run of the pipeline at a time');
    const leased = mine[0]!;
    const reservations = await Promise.all([1, 2, 3, 4].map(() => worker((trx) => pipelineWorker.reserveEffect(trx, leased.id, leased.lease_token, 'touch:synthetic-race:1', 'outreach_touch'))));
    assert.deepEqual(reservations.filter((r) => r === 'proceed').length, 1);
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.cancelRun(trx, ctx, leased.id));
    await rejects(worker((trx) => pipelineWorker.stepBoundary(trx, leased.id, leased.lease_token, 60)), '40001', 'pipelines.stale_lease');
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.effects(trx, leased.id)))[0]!.outcome, 'unknown', 'a cancelled run leaves its reserved touch unknown');
    for (const l of leases) if (l && l.id !== leased.id) await worker((trx) => pipelineWorker.finish(trx, l.id, l.lease_token, 'succeeded', ZERO_COUNTS, null));
  });

  await t.test('grants: the runtime role cannot call worker functions and the worker role cannot call staff commands', async () => {
    const { rows } = await db.admin.query(`SELECT has_function_privilege('trustwork_app', 'trustwork.pipelines_lease_run(text, integer)', 'EXECUTE') AS app_lease,
      has_function_privilege('trustwork_worker', 'trustwork.pipelines_lease_run(text, integer)', 'EXECUTE') AS worker_lease,
      has_function_privilege('trustwork_worker', 'trustwork.pipelines_start_run(jsonb, uuid, text, timestamptz)', 'EXECUTE') AS worker_start,
      has_function_privilege('trustwork_app', 'trustwork.pipelines_start_run(jsonb, uuid, text, timestamptz)', 'EXECUTE') AS app_start`);
    assert.deepEqual(rows[0], { app_lease: false, worker_lease: true, worker_start: false, app_start: true });
  });
});
