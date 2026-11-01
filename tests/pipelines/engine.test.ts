import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelines } from '../../packages/data/src/repositories/pipelines.js';
import {
  PipelineStepError, PipelineStepRegistry, pipelineMaintenanceTask, pipelineScheduleTask, runOnePipeline, type PipelineRuntime, type StepHandler,
} from '../../apps/worker/src/pipelines/engine.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { buildPipelinesWorld, scheduleInput, versionInput } from './helpers.js';

/**
 * The PIPE-001 worker engine on real PostgreSQL under the worker login: steps run in order with their registered
 * implementations; an unimplemented step fails the run honestly; an effect whose outcome is unknown is never repeated
 * by a retry run; a dry run performs no effect and charges nothing; an exhausted role cap finishes the run
 * `skipped_budget`; a kill switch stops the run at the next boundary; the scheduler queues only the latest due time
 * and honours windows; retries wait for their backoff. Every person, hub and recipient is synthetic.
 */
const env = await provisionWorkerDatabase('pipelines_engine');

test('pipeline worker engine', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const db = env.db;
  const w = await buildPipelinesWorld(db.admin, db.app);
  const p = w.people;
  const pool = env.workerPool(4);
  const log = () => undefined;
  const sent: string[] = [];
  let failNextSend = false;
  const steps = new PipelineStepRegistry()
    .on('fetch', async (ctx) => { ctx.counts.fetched += 2; ctx.carry.set('items', ['synthetic-a', 'synthetic-b']); })
    .on('summarise', async (ctx) => { await ctx.charge('40'); ctx.counts.new += 2; })
    .on('propose_for_review', async (ctx) => {
      for (const item of ctx.carry.get('items') as string[]) {
        const result = await ctx.effect(`notify:${item}`, 'notification', async () => {
          if (failNextSend) { failNextSend = false; throw new Error('synthetic transport timeout'); }
          sent.push(item);
          return { outcome: 'succeeded' };
        });
        if (result.status !== 'skipped') ctx.counts.proposed += 1;
      }
    })
    .on('classify', async () => { throw new PipelineStepError('pipelines.synthetic_failure', 'synthetic'); });
  const runtime: PipelineRuntime = { pool, steps, log, workerId: 'synthetic-engine', leaseSeconds: 60 };
  const start = (versionId: string, trigger: 'manual' | 'dry_run' = 'manual') => w.cmd(p.stewardA, (trx, ctx) => pipelines.startRun(trx, ctx, versionId, trigger, null));
  const runRow = (id: string) => w.act.as(p.stewardA, (trx) => pipelines.run(trx, id));
  const pipelineWith = async (input = versionInput({ role: 'writer' }), schedule = true) => {
    const pipeline = await w.cmd(p.stewardA, (trx, ctx) => pipelines.create(trx, ctx, w.hubId, 'source_ingestion', 'Synthetic engine'));
    const version = await w.cmd(p.stewardA, (trx, ctx) => pipelines.draftVersion(trx, ctx, pipeline.id, input));
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.activateVersion(trx, ctx, version.id));
    const sched = schedule ? await w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, 0, scheduleInput())) : null;
    return { pipeline, version, schedule: sched };
  };
  await w.cmd(p.stewardB, (trx, ctx) => pipelines.setRoleCap(trx, ctx, w.hubId, 'writer', 'USD', '100'));

  await t.test('a run executes every step of its version and records counts and effects', async () => {
    const { version } = await pipelineWith();
    const run = await start(version.id);
    const result = await runOnePipeline(runtime);
    assert.deepEqual(result, { runId: run.id, state: 'succeeded' });
    const row = await runRow(run.id);
    assert.deepEqual([row!.counts.fetched, row!.counts.new, row!.counts.proposed, row!.effects_committed], [2, 2, 2, true]);
    assert.deepEqual(sent.splice(0), ['synthetic-a', 'synthetic-b']);
  });

  await t.test('an unimplemented step fails the run honestly; a failing step records its code', async () => {
    const missing = await pipelineWith(versionInput({ steps: [{ kind: 'discover', modelRouteId: null, modelJob: null, settings: {} }, { kind: 'notify_staff', modelRouteId: null, modelJob: null, settings: {} }] }));
    const run = await start(missing.version.id);
    assert.deepEqual(await runOnePipeline(runtime), { runId: run.id, state: 'failed' });
    assert.equal((await runRow(run.id))!.error_code, 'pipelines.step_unavailable');
    const failing = await pipelineWith(versionInput({ steps: [{ kind: 'classify', modelRouteId: null, modelJob: null, settings: {} }, { kind: 'propose_for_review', modelRouteId: null, modelJob: null, settings: {} }] }));
    const run2 = await start(failing.version.id);
    await runOnePipeline(runtime);
    assert.equal((await runRow(run2.id))!.error_code, 'pipelines.synthetic_failure');
  });

  await t.test('a retried outreach run never sends a second message for a touch whose first outcome is unknown', async () => {
    const { version } = await pipelineWith(versionInput({ role: 'writer' }));
    failNextSend = true;
    const run = await start(version.id);
    await runOnePipeline(runtime);
    const effects = await w.act.as(p.stewardA, (trx) => pipelines.effects(trx, run.id));
    assert.deepEqual(effects.map((e) => [e.effect_key, e.outcome]), [['notify:synthetic-a', 'unknown'], ['notify:synthetic-b', 'succeeded']]);
    assert.deepEqual(sent.splice(0), ['synthetic-b']);
    // A second run of the same pipeline (a retry or the next schedule) skips both keys.
    const again = await start(version.id);
    await runOnePipeline(runtime);
    assert.deepEqual(sent.splice(0), [], 'neither the unknown nor the delivered touch is sent again');
    assert.equal((await runRow(again.id))!.counts.proposed, 0);
  });

  await t.test('a dry run performs no effect and charges no cap', async () => {
    const { version } = await pipelineWith();
    const before = (await db.admin.query("SELECT spent_minor FROM trustwork.pipeline_role_cap WHERE hub_id = $1 AND role = 'writer'", [w.hubId])).rows[0].spent_minor;
    const effectsBefore = Number((await db.admin.query('SELECT count(*)::int AS n FROM trustwork.pipeline_effect')).rows[0].n);
    const run = await start(version.id, 'dry_run');
    assert.deepEqual(await runOnePipeline(runtime), { runId: run.id, state: 'succeeded' });
    assert.deepEqual(sent.splice(0), []);
    const row = await runRow(run.id);
    assert.deepEqual([row!.effects_committed, row!.counts.proposed], [false, 2], 'the preview counts what would be proposed');
    assert.equal(Number((await db.admin.query('SELECT count(*)::int AS n FROM trustwork.pipeline_effect')).rows[0].n), effectsBefore);
    assert.equal((await db.admin.query("SELECT spent_minor FROM trustwork.pipeline_role_cap WHERE hub_id = $1 AND role = 'writer'", [w.hubId])).rows[0].spent_minor, before);
  });

  await t.test('an exhausted role cap finishes the run skipped_budget before the paid call', async () => {
    await w.cmd(p.stewardB, (trx, ctx) => pipelines.setRoleCap(trx, ctx, w.hubId, 'editor', 'USD', '10'));
    const { version } = await pipelineWith(versionInput({ role: 'editor' }));
    const run = await start(version.id);
    assert.deepEqual(await runOnePipeline(runtime), { runId: run.id, state: 'skipped_budget' });
    assert.deepEqual(sent.splice(0), [], 'the steps after the refused charge never ran');
  });

  await t.test('a kill switch stops the run at the next step boundary', async () => {
    const { pipeline, version } = await pipelineWith();
    const blocking: StepHandler = async () => {
      await db.admin.query("INSERT INTO trustwork.kill_switch (scope_kind, hub_id, pipeline_id, engaged_by, reason) VALUES ('pipeline', $1, $2, $3, 'Synthetic incident')", [w.hubId, pipeline.id, w.admin.people.owner]);
    };
    const killing = new PipelineStepRegistry().on('fetch', blocking).on('summarise', async () => { throw new Error('must not run'); }).on('propose_for_review', async () => undefined);
    const run = await start(version.id);
    assert.deepEqual(await runOnePipeline({ ...runtime, steps: killing }), { runId: run.id, state: 'stopped_by_kill_switch' });
    assert.equal((await runRow(run.id))!.state, 'stopped_by_kill_switch');
  });

  await t.test('the scheduler queues only the latest due time and honours windows; retries wait for their backoff', async () => {
    const { pipeline, schedule } = await pipelineWith();
    // Every minute in UTC; the last due time since the last tick is queued once.
    const s2 = await w.cmd(p.stewardA, (trx, ctx) => pipelines.setSchedule(trx, ctx, pipeline.id, schedule!.revision,
      scheduleInput({ cron: '* * * * *', timeZone: 'UTC', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '01:00', to: '05:00' }] })));
    const monday = new Date('2026-11-02T02:30:30Z');
    const task = pipelineScheduleTask({ pool, log }, 300, () => monday);
    const first = await task.run();
    assert.equal(first.queued, 1);
    assert.deepEqual(await task.run(), { queued: 0, skipped: 0 }, 'the next tick sees no new due time and queues nothing twice');
    const runs = (await w.act.as(p.stewardA, (trx) => pipelines.runs(trx, pipeline.id))).filter((r) => r.trigger === 'schedule');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.due_at!.toISOString(), '2026-11-02T02:30:00.000Z');
    const evening = pipelineScheduleTask({ pool, log }, 300, () => new Date('2026-11-02T20:00:30Z'));
    assert.deepEqual(await evening.run(), { queued: 0, skipped: 1 });
    void s2;
    // Retries: a failed run gets a retry only after the backoff (exponential from 60 s).
    const failing = await pipelineWith(versionInput({ steps: [{ kind: 'classify', modelRouteId: null, modelJob: null, settings: {} }, { kind: 'propose_for_review', modelRouteId: null, modelJob: null, settings: {} }] }));
    const failed = await start(failing.version.id);
    while (true) { const r = await runOnePipeline(runtime); if (!r || r.runId === failed.id) break; }
    const finishedAt = (await runRow(failed.id))!.finished_at!;
    await pipelineMaintenanceTask({ pool, log }, 60, () => new Date(finishedAt.getTime() + 30_000)).run();
    assert.equal((await w.act.as(p.stewardA, (trx) => pipelines.runs(trx, failing.pipeline.id))).some((r) => r.retry_of === failed.id), false, 'not before the backoff');
    assert.ok((await pipelineMaintenanceTask({ pool, log }, 60, () => new Date(finishedAt.getTime() + 61_000)).run()).retried! >= 1, 'earlier failed runs of this file are retried too');
    const retry = (await w.act.as(p.stewardA, (trx) => pipelines.runs(trx, failing.pipeline.id))).find((r) => r.retry_of === failed.id);
    assert.equal(retry!.attempt, 2);
  });
});
