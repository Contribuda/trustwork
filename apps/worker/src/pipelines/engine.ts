import type { DataPool } from '@trustwork/data';
import { pipelineWorker } from '../../../../packages/data/src/repositories/pipelines.js';
import type { PipelineCountsJson, PipelineRunRow, PipelineStepJson, PipelineVersionRow } from '../../../../packages/data/src/schema/pipelines.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';
import { dueBetween, inWindow } from './cron.js';

/**
 * The pipeline run engine (PIPE-001). The worker leases one queued run at a time (fenced by the run's lease token),
 * executes the steps of the exact version it was queued with and reports every boundary, effect and the finish through
 * the `pipelines_*` worker functions. Step implementations register per step kind; a step kind without an
 * implementation fails the run honestly (`pipelines.step_unavailable`) instead of being skipped.
 *
 * - **Boundaries**: before every step the run's lease is extended and kill switches are checked; an engaged switch or a
 *   person's cancellation ends the run there.
 * - **Effects**: an external effect (an outreach touch, a notification, a paid model call) is reserved under a stable
 *   key and committed before it runs; a key already recorded is never run again, by this run or any retry. An effect
 *   whose outcome the step cannot confirm is settled `unknown` and stays that way.
 * - **Dry runs**: effects are not performed (`dry`), caps are not charged, nothing is committed.
 * - **Role caps**: a paid step charges its role first; an exhausted cap stops paid steps and finishes the run
 *   `skipped_budget`.
 */
export type EffectKind = 'outreach_touch' | 'notification' | 'model_call' | 'other';
export type EffectOutcome = { outcome: 'succeeded' | 'failed' | 'unknown'; costMinor?: string };

export class PipelineStop extends Error {
  constructor(readonly reason: 'kill_switch' | 'cancelled' | 'budget') { super(`pipeline run stopped: ${reason}`); }
}
/** A step failure with a stable error code (`pipelines.*` or the step's own `<module>.*`). */
export class PipelineStepError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface StepContext {
  run: PipelineRunRow;
  version: PipelineVersionRow;
  step: PipelineStepJson;
  index: number;
  dryRun: boolean;
  counts: PipelineCountsJson;
  /** Data carried from one step to the next within the run (items fetched, drafts prepared); never persisted. */
  carry: Map<string, unknown>;
  /**
   * Runs an external effect at most once per key. Returns `performed` with the outcome, `skipped` when the key was
   * already recorded, or `dry` in a dry run (the effect is described, not performed).
   */
  effect(key: string, kind: EffectKind, perform: () => Promise<EffectOutcome>): Promise<{ status: 'performed'; outcome: EffectOutcome['outcome'] } | { status: 'skipped' | 'dry' }>;
  /** Charges the step's role before a paid call; throws PipelineStop('budget') when the role's cap is exhausted. */
  charge(amountMinor: string): Promise<void>;
}
export type StepHandler = (context: StepContext) => Promise<void>;

export class PipelineStepRegistry {
  private readonly handlers = new Map<string, StepHandler>();
  on(kind: string, handler: StepHandler): this {
    if (this.handlers.has(kind)) throw new Error(`step ${kind} registered twice`);
    this.handlers.set(kind, handler);
    return this;
  }
  get(kind: string): StepHandler | undefined {
    return this.handlers.get(kind);
  }
}

export interface PipelineRuntime { pool: DataPool; steps: PipelineStepRegistry; log: Logger; workerId: string; leaseSeconds?: number }

const ZERO: PipelineCountsJson = { fetched: 0, new: 0, duplicates: 0, skippedByLicence: 0, skippedByRobots: 0, proposed: 0, failed: 0 };

/** Leases and executes one run. Returns the finished run's state, or null when nothing was queued. */
export async function runOnePipeline(runtime: PipelineRuntime): Promise<{ runId: string; state: string } | null> {
  const lease = runtime.leaseSeconds ?? 120;
  const run = await inTransaction(runtime.pool, (trx) => pipelineWorker.lease(trx, runtime.workerId, lease));
  if (!run) return null;
  const token = run.lease_token;
  const version = await inTransaction(runtime.pool, (trx) => pipelineWorker.runVersion(trx, run.id, token));
  const counts: PipelineCountsJson = { ...ZERO };
  const carry = new Map<string, unknown>();
  const finish = (state: 'succeeded' | 'partially_succeeded' | 'failed' | 'skipped_budget', error: string | null) =>
    inTransaction(runtime.pool, (trx) => pipelineWorker.finish(trx, run.id, token, state, counts, error)).then((r) => ({ runId: run.id, state: r.state }));
  try {
    for (const [index, step] of version.steps.entries()) {
      const boundary = await inTransaction(runtime.pool, (trx) => pipelineWorker.stepBoundary(trx, run.id, token, lease));
      if (boundary === 'stop') return { runId: run.id, state: 'stopped_by_kill_switch' };
      const handler = runtime.steps.get(step.kind);
      if (!handler) throw new PipelineStepError('pipelines.step_unavailable', `no implementation for step ${step.kind}`);
      const role = typeof step.settings.role === 'string' ? step.settings.role : null;
      await handler({
        run, version, step, index, dryRun: run.dry_run, counts, carry,
        effect: async (key, kind, perform) => {
          const reservation = await inTransaction(runtime.pool, (trx) => pipelineWorker.reserveEffect(trx, run.id, token, key, kind));
          if (reservation === 'stop') throw new PipelineStop('kill_switch');
          if (reservation === 'dry' || reservation === 'skip') return { status: reservation === 'dry' ? 'dry' : 'skipped' };
          let result: EffectOutcome;
          try {
            result = await perform();
          } catch (error) {
            // The effect may have happened: never retried, reconciled by a person.
            result = { outcome: 'unknown' };
            runtime.log('warn', 'pipeline effect outcome unknown', { runId: run.id, effectKey: key, error: error instanceof Error ? error.name : 'unknown' });
          }
          await inTransaction(runtime.pool, (trx) => pipelineWorker.settleEffect(trx, run.id, token, key, result.outcome, result.costMinor ?? '0'));
          return { status: 'performed', outcome: result.outcome };
        },
        charge: async (amountMinor) => {
          if (!role) throw new PipelineStepError('pipelines.step_without_role', `step ${step.kind} makes a paid call without a role`);
          const charge = await inTransaction(runtime.pool, (trx) => pipelineWorker.chargeRole(trx, run.id, token, role, amountMinor));
          if (charge === 'exhausted') throw new PipelineStop('budget');
        },
      });
    }
    return await finish(counts.failed > 0 ? 'partially_succeeded' : 'succeeded', null);
  } catch (error) {
    if (error instanceof PipelineStop && error.reason === 'budget') return finish('skipped_budget', 'pipelines.role_cap_exhausted');
    if (error instanceof PipelineStop) return { runId: run.id, state: 'stopped_by_kill_switch' };
    if (isStaleLease(error)) return { runId: run.id, state: 'cancelled' };
    const code = error instanceof PipelineStepError ? error.code : 'pipelines.step_failed';
    runtime.log('warn', 'pipeline run failed', { runId: run.id, code, error: error instanceof Error ? error.name : 'unknown' });
    try {
      return await finish('failed', code);
    } catch (finishError) {
      if (isStaleLease(finishError)) return { runId: run.id, state: 'cancelled' };
      throw finishError;
    }
  }
}

function isStaleLease(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { hint?: string }).hint === 'pipelines.stale_lease';
}

/**
 * Queues scheduled runs. For each active, unpaused schedule the due instants since its last due time are evaluated in
 * the schedule's time zone; only the latest one is queued (resuming never bursts missed runs), as `skipped_window`
 * when it falls outside every window. Jitter delays the run inside the worker, never the recorded due time.
 */
export function pipelineScheduleTask(runtime: Pick<PipelineRuntime, 'pool' | 'log'>, intervalSeconds = 60, now: () => Date = () => new Date()): ScheduledTask {
  return {
    name: 'pipelines.schedule',
    intervalSeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      let queued = 0; let skipped = 0;
      const at = now();
      for (const schedule of await pipelineWorker.dueSchedules(trx)) {
        const since = schedule.last_due_at ?? new Date(at.getTime() - intervalSeconds * 1000);
        const floor = new Date(Math.max(since.getTime(), at.getTime() - 24 * 3600_000));
        let due: Date[];
        try {
          due = dueBetween(schedule.cron, schedule.time_zone, floor, at);
        } catch {
          runtime.log('warn', 'pipeline schedule has an unreadable cron or time zone', { scheduleId: schedule.id });
          continue;
        }
        const latest = due.at(-1);
        if (!latest) continue;
        const run = await pipelineWorker.enqueueScheduled(trx, schedule.id, latest, inWindow(schedule.windows, schedule.time_zone, latest));
        if (run?.state === 'skipped_window') skipped += 1; else if (run) queued += 1;
      }
      return { queued, skipped };
    }),
  };
}

/** Executes queued runs (up to `perTick` per tick). */
export function pipelineRunTask(runtime: PipelineRuntime, intervalSeconds = 15, perTick = 5): ScheduledTask {
  return {
    name: 'pipelines.run',
    intervalSeconds,
    run: async () => {
      let ran = 0;
      for (; ran < perTick; ran += 1) if (!(await runOnePipeline(runtime))) break;
      return { ran };
    },
  };
}

/** Fails runs whose lease expired and queues retries of failed runs once their backoff has passed. */
export function pipelineMaintenanceTask(runtime: Pick<PipelineRuntime, 'pool' | 'log'>, intervalSeconds = 60, now: () => Date = () => new Date()): ScheduledTask {
  return {
    name: 'pipelines.maintenance',
    intervalSeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const expired = await pipelineWorker.expireLeases(trx);
      let retried = 0;
      for (const candidate of await pipelineWorker.retryCandidates(trx)) {
        if (!candidate.retry) continue;
        const exponent = candidate.retry.backoff === 'exponential' ? candidate.attempt - 1 : 0;
        const delay = Math.min(candidate.retry.baseSeconds * 2 ** exponent, candidate.retry.maxDelaySeconds) * 1000;
        if (now().getTime() - new Date(candidate.finished_at).getTime() < delay) continue;
        if (await pipelineWorker.queueRetry(trx, candidate.run_id)) retried += 1;
      }
      return { expired, retried };
    }),
  };
}
