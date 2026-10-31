import { jobs, type DataPool, type Transaction } from '@trustwork/data';
import { SCREENING_LIST_VERSION_ACTIVATED, ScreeningListVersionActivatedEventSchema } from '../../../../packages/contracts/src/sanctions.js';
import { rescreenWorker } from '../../../../packages/data/src/repositories/rescreen.js';
import { inTransaction } from '../db.js';
import { PermanentJobError, type EnqueueRequest, type HandlerRegistry } from '../handlers.js';
import type { Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';
import type { ScreeningConfig } from '../screening/config.js';
import { RESCREEN_BATCH_KIND, runBatch, type BatchReport } from './batch.js';
import type { RescreenConfig } from './config.js';
import { VersionCache } from './entries.js';

/**
 * Re-screening in the worker (SANC-005). See README.md.
 *
 * - `rescreen.on_screening_list_version_activated` (outbox handler): asks for the delta run of the activated version
 *   (one per version) and starts it when no run is running.
 * - `screening.rescreen_batch` (transactional job, `{ runId }`): one batch; enqueues the run's next batch in the same
 *   transaction, so exactly one batch of a run is in flight (backpressure) and a crash repeats only the open batch.
 * - `screening.rescreen_weekly` (task, weekly): asks for the full safety-net run.
 * - `screening.rescreen_tick` (task, every minute): the watchdog (lost batch chains fail, overdue runs alert), starts
 *   queued runs and resumes failed ones after the retry interval, and refreshes the cohort gauges.
 */
export const RESCREEN_TICK_TASK = 'screening.rescreen_tick';
export const RESCREEN_WEEKLY_TASK = 'screening.rescreen_weekly';
export const RESCREEN_BATCH_ATTEMPTS = 5;
export const RESCREEN_METRICS = {
  subjects: ['trustwork_rescreen_subjects_total', 'Subjects handled by re-screening batches, by run mode and method (full, delta, current, verified).'],
  results: ['trustwork_rescreen_results_total', 'Results recorded by re-screening, by run mode and outcome.'],
  opened: ['trustwork_rescreen_matches_opened_total', 'Possible matches opened or re-opened by re-screening.'],
  runs: ['trustwork_rescreen_runs_finished_total', 'Re-screening runs finished, by trigger.'],
  alerts: ['trustwork_rescreen_alerts_total', 'Re-screening alerts raised, by kind (failed, overdue).'],
  progress: ['trustwork_rescreen_run_progress_ratio', 'Share of subjects passed by the latest run of each trigger (0 to 1).'],
  duration: ['trustwork_rescreen_run_duration_seconds', 'Elapsed seconds of the latest run of each trigger (running or finished).'],
  rate: ['trustwork_rescreen_run_subjects_per_minute', 'Subjects per minute of the latest run of each trigger.'],
  runOpened: ['trustwork_rescreen_run_matches_opened', 'Possible matches opened by the latest run of each trigger.'],
  state: ['trustwork_rescreen_run_state', '1 for the state of the latest run of each trigger.'],
  overdue: ['trustwork_rescreen_run_overdue', '1 while the latest run of a trigger is past its window.'],
} as const;

export interface RescreenRuntime {
  pool: DataPool;
  config: RescreenConfig;
  screening: ScreeningConfig;
  log: Logger;
  metrics: Metrics;
  cache?: VersionCache;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseBatchPayload(payload: unknown): { runId: string } {
  const runId = (payload as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string' || !UUID.test(runId)) throw new PermanentJobError('expected { runId }');
  return { runId };
}

const batchRequest = (runId: string, delaySeconds = 0): EnqueueRequest => ({ kind: RESCREEN_BATCH_KIND, payload: { runId }, maxAttempts: RESCREEN_BATCH_ATTEMPTS, delaySeconds });

/** Starts the next run when none is running and makes sure the running run has its batch chain. */
export async function kickRescreen(trx: Transaction, enqueue: (request: EnqueueRequest) => Promise<unknown>, runtime: Pick<RescreenRuntime, 'config' | 'log'>): Promise<string | null> {
  const running = await rescreenWorker.promote(trx, runtime.config.retryAfterSeconds);
  if (!running) return null;
  if (running.needsBatch) await enqueue(batchRequest(running.runId));
  if (running.promoted) runtime.log('info', 'rescreen run started', { runId: running.runId });
  return running.runId;
}

const enqueueOn = (trx: Transaction) => (request: EnqueueRequest) => jobs.enqueue(trx, {
  kind: request.kind, payload: request.payload, ...(request.maxAttempts ? { max_attempts: request.maxAttempts } : {}), ...(request.delaySeconds ? { delay_seconds: request.delaySeconds } : {}),
});

function observe(runtime: RescreenRuntime, report: BatchReport): void {
  const mode = report.mode ?? 'unknown';
  for (const [method, n] of Object.entries(report.methods)) if (n > 0) runtime.metrics.inc(...RESCREEN_METRICS.subjects, { mode, method }, n);
  for (const [outcome, n] of Object.entries(report.outcomes)) if (n && n > 0) runtime.metrics.inc(...RESCREEN_METRICS.results, { mode, outcome }, n);
  if (report.counts.matchesOpened > 0) runtime.metrics.inc(...RESCREEN_METRICS.opened, {}, report.counts.matchesOpened);
  // Identifiers and counts only: never a name, a list entry or a matched key.
  if (report.kind === 'blocked') runtime.log('warn', 'rescreen run waits: screening is unavailable', { runId: report.runId });
  if (report.kind === 'done' && report.run) {
    const run = report.run;
    runtime.metrics.inc(...RESCREEN_METRICS.runs, { trigger: run.trigger });
    const seconds = run.started_at && run.finished_at ? Math.max(0, (run.finished_at.getTime() - run.started_at.getTime()) / 1000) : 0;
    runtime.log('info', 'rescreen run finished', {
      runId: run.id, trigger: run.trigger, mode: run.mode, subjects: run.subjects_done, full: run.screened_full + run.candidates_screened, delta: run.screened_delta,
      current: run.already_current, verified: run.verified, matchesOpened: run.matches_opened, seconds: Math.round(seconds),
    });
  }
}

export function registerRescreen(registry: HandlerRegistry, runtime: RescreenRuntime): void {
  const cache = runtime.cache ?? new VersionCache();
  registry.onOutbox({
    name: 'rescreen.on_screening_list_version_activated',
    type: SCREENING_LIST_VERSION_ACTIVATED,
    parse: (payload) => ScreeningListVersionActivatedEventSchema.parse(payload),
    handle: async (event, context) => {
      const { runId, created } = await rescreenWorker.request(context.trx, { trigger: 'list_version', listVersionId: event.payload.versionId, windowSeconds: runtime.config.windowSeconds });
      if (created) runtime.log('info', 'rescreen run queued', { runId, trigger: 'list_version', list: event.payload.listCode });
      await kickRescreen(context.trx, context.enqueue, runtime);
    },
  });
  registry.onJob<{ runId: string }>({
    kind: RESCREEN_BATCH_KIND,
    mode: 'transactional',
    parse: parseBatchPayload,
    run: async (context) => {
      const report = await runBatch(context.trx, { config: runtime.config, screening: runtime.screening, cache }, context.payload.runId);
      if (report.next) await context.enqueue(batchRequest(report.runId, report.next.delaySeconds));
      // The next queued or failed run starts as soon as this one is done.
      if (report.kind === 'done') await kickRescreen(context.trx, context.enqueue, runtime);
      observe(runtime, report);
    },
  });
}

/** The weekly full safety-net run (`sanctions_rescreen`); answers the unfinished full run when one exists. */
export function rescreenWeeklyTask(runtime: Pick<RescreenRuntime, 'pool' | 'config' | 'log'>): ScheduledTask {
  return {
    name: RESCREEN_WEEKLY_TASK,
    intervalSeconds: runtime.config.weeklySeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const { runId, created } = await rescreenWorker.request(trx, { trigger: 'scheduled', listVersionId: null, windowSeconds: runtime.config.windowSeconds });
      if (created) runtime.log('info', 'rescreen run queued', { runId, trigger: 'scheduled' });
      await kickRescreen(trx, enqueueOn(trx), runtime);
      return { queued: created ? 1 : 0 };
    }),
  };
}

/** The watchdog, the starter and the cohort gauges (every minute by default). */
export function rescreenTickTask(runtime: Pick<RescreenRuntime, 'pool' | 'config' | 'log' | 'metrics'>, intervalSeconds = 60): ScheduledTask {
  return {
    name: RESCREEN_TICK_TASK,
    intervalSeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const alerts = await rescreenWorker.watch(trx);
      for (const alert of alerts) {
        runtime.metrics.inc(...RESCREEN_METRICS.alerts, { kind: alert.alert });
        runtime.log('error', alert.alert === 'failed' ? 'rescreen run failed: it resumes from its cursor after the retry interval' : 'rescreen run is past its window', { runId: alert.runId, alert: alert.alert });
      }
      const running = await kickRescreen(trx, enqueueOn(trx), runtime);
      const progress = await rescreenWorker.progress(trx);
      const gauges: readonly (readonly [string, string])[] = [RESCREEN_METRICS.progress, RESCREEN_METRICS.duration, RESCREEN_METRICS.rate, RESCREEN_METRICS.runOpened, RESCREEN_METRICS.state, RESCREEN_METRICS.overdue];
      for (const [name, help] of gauges) runtime.metrics.resetGauge(name, help);
      for (const p of progress) {
        const labels = { trigger: p.trigger };
        const total = Math.max(p.subjectsTotal, p.subjectsDone);
        runtime.metrics.set(...RESCREEN_METRICS.progress, total === 0 ? (p.state === 'done' ? 1 : 0) : p.subjectsDone / total, labels);
        runtime.metrics.set(...RESCREEN_METRICS.duration, p.elapsedSeconds ?? 0, labels);
        runtime.metrics.set(...RESCREEN_METRICS.rate, p.elapsedSeconds ? Math.round((p.subjectsDone / (p.elapsedSeconds / 60)) * 10) / 10 : 0, labels);
        runtime.metrics.set(...RESCREEN_METRICS.runOpened, p.matchesOpened, labels);
        runtime.metrics.set(...RESCREEN_METRICS.state, 1, { ...labels, state: p.state });
        runtime.metrics.set(...RESCREEN_METRICS.overdue, p.overdue && p.state !== 'done' ? 1 : 0, labels);
      }
      return { alerts: alerts.length, running: running ? 1 : 0 };
    }),
  };
}
