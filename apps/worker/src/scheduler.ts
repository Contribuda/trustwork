import { jobs, maintenance, type DataPool } from '@trustwork/data';
import type { WorkerConfig } from './config.js';
import { inTransaction } from './db.js';
import type { HandlerRegistry } from './handlers.js';
import { describeError, type Logger } from './log.js';
import { M, type Metrics } from './metrics.js';
import { reconcileJob } from './reconcile.js';

export interface ScheduledTask {
  /** Row key in trustwork.worker_schedule. */
  name: string;
  intervalSeconds: number;
  run(): Promise<Record<string, number>>;
}

interface SchedulerDeps { pool: DataPool; registry: HandlerRegistry; config: WorkerConfig; metrics: Metrics; log: Logger }

/**
 * Lease expiry: expired leases become outcome_unknown (never replayed). In the same transaction, jobs of
 * transactional kinds are reconciled back to queued automatically: their effect and completion share one transaction,
 * so a lease that expired without completion proves the effect rolled back. External kinds stay parked for the
 * explicit reconciliation command.
 */
export function expireLeasesTask(deps: SchedulerDeps): ScheduledTask {
  return {
    name: 'jobs.expire_leases',
    intervalSeconds: deps.config.schedule.expireLeasesSeconds,
    run: () => inTransaction(deps.pool, async (trx) => {
      const parked = await jobs.expireLeases(trx);
      let autoReconciled = 0;
      for (const job of parked) {
        deps.metrics.inc(...M.leaseExpirations);
        deps.metrics.inc(...M.unknownOutcomes, { kind: job.kind, reason: 'lease_expired' });
        if (!deps.registry.isTransactional(job.kind)) {
          deps.log('warn', 'expired lease parked for reconciliation', { jobId: job.id, kind: job.kind, fencingToken: job.fencing_token });
          continue;
        }
        await reconcileJob(trx, { jobId: job.id, outcome: 'queued', reference: `auto:transactional-rollback:${job.fencing_token}`, mode: 'auto' });
        deps.metrics.inc(...M.reconciliations, { mode: 'auto', outcome: 'queued' });
        autoReconciled += 1;
      }
      return { parked: parked.length, autoReconciled };
    }),
  };
}

/** Bounded tables, with the intervals fixed inside trustwork.worker_sweep_expired (includes idempotency cleanup). */
export function sweepTask(deps: SchedulerDeps): ScheduledTask {
  return {
    name: 'maintenance.sweep_expired',
    intervalSeconds: deps.config.schedule.sweepSeconds,
    run: async () => {
      const report = await inTransaction(deps.pool, (trx) => maintenance.sweepScheduled(trx));
      for (const [table, rows] of Object.entries(report)) if (rows > 0) deps.metrics.inc(...M.sweptRows, { table }, rows);
      return { ...report };
    },
  };
}

/** Monthly partitions of audit_event and outbox_event, created three months ahead. */
export function partitionsTask(deps: SchedulerDeps): ScheduledTask {
  return {
    name: 'maintenance.monthly_partitions',
    intervalSeconds: deps.config.schedule.partitionsSeconds,
    run: async () => {
      const created = await inTransaction(deps.pool, (trx) => maintenance.ensureMonthlyPartitions(trx));
      if (created.length) {
        deps.metrics.inc(...M.partitionsCreated, {}, created.length);
        deps.log('info', 'monthly partitions created', { partitions: created.join(',') });
      }
      return { created: created.length };
    },
  };
}

/**
 * Durable scheduler: each task has a row in trustwork.worker_schedule; a worker claims a due slot by moving `next_at`
 * forward in one UPDATE (database clock), so several workers never run the same slot twice. Tasks are idempotent; a
 * crash during a run simply leaves the next slot due. A failure brings the next attempt forward to one minute.
 */
export class Scheduler {
  readonly tasks: ScheduledTask[];

  constructor(private readonly deps: SchedulerDeps, tasks?: ScheduledTask[]) {
    this.tasks = tasks ?? [expireLeasesTask(deps), sweepTask(deps), partitionsTask(deps)];
  }

  /** Runs every due task once; returns the names of the tasks this worker ran. */
  async tick(): Promise<string[]> {
    const { pool, config, metrics, log } = this.deps;
    const ran: string[] = [];
    for (const task of this.tasks) {
      const claimed = await inTransaction(pool, (trx) => maintenance.claimScheduledTask(trx, task.name, task.intervalSeconds, config.workerId));
      if (!claimed) continue;
      ran.push(task.name);
      try {
        const report = await task.run();
        await inTransaction(pool, (trx) => maintenance.finishScheduledTask(trx, task.name, 'succeeded', null, 0));
        metrics.inc(...M.scheduleRuns, { task: task.name, outcome: 'succeeded' });
        if (Object.values(report).some((n) => n > 0)) log('info', 'scheduled task ran', { task: task.name, ...report });
      } catch (error) {
        const message = describeError(error);
        await inTransaction(pool, (trx) => maintenance.finishScheduledTask(trx, task.name, 'failed', message, Math.min(60, task.intervalSeconds))).catch(() => undefined);
        metrics.inc(...M.scheduleRuns, { task: task.name, outcome: 'failed' });
        log('error', 'scheduled task failed', { task: task.name, error: message });
      }
    }
    return ran;
  }
}
