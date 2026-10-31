import { jobs, type DataPool, type Job } from '@trustwork/data';
import { retryDelaySeconds } from './backoff.js';
import type { WorkerConfig } from './config.js';
import { inTransaction } from './db.js';
import { PermanentJobError, RetryableJobError, type ExternalJobHandler, type HandlerRegistry, type JobContext, type JobHandler, type TransactionalJobHandler } from './handlers.js';
import { describeError, type Logger } from './log.js';
import { M, type Metrics } from './metrics.js';
import { transactionalContext } from './relay.js';

export class LeaseLostError extends Error {
  constructor() {
    super('job lease lost (expired, parked or re-leased)');
    this.name = 'LeaseLostError';
  }
}
export class ShutdownError extends Error {
  constructor() {
    super('worker is shutting down');
    this.name = 'ShutdownError';
  }
}
export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`external job exceeded ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}
/** Completion refused by the fencing check: another lease or a reconciliation owns the job now. */
class FencedOutError extends Error {
  constructor() {
    super('completion refused by the fencing token');
    this.name = 'FencedOutError';
  }
}

interface InFlight { job: Job; handler: JobHandler; abort: AbortController; pid: number | null; promise: Promise<void> }

export type JobResult = 'succeeded' | 'retried' | 'dead' | 'outcome_unknown' | 'fenced_out' | 'released';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Durable job loop: leases due jobs of the registered kinds (trustwork.lease_jobs: SKIP LOCKED, fencing token, bounded
 * lease), keeps the lease alive with a heartbeat, and records every outcome with a fencing-checked update. See
 * handlers.ts for the transactional and external contracts.
 */
export class JobRunner {
  private readonly inFlight = new Map<string, InFlight>();
  private stopping = false;

  constructor(private readonly deps: { pool: DataPool; registry: HandlerRegistry; config: WorkerConfig; metrics: Metrics; log: Logger; random?: () => number }) {}

  get activeJobs(): number {
    return this.inFlight.size;
  }

  /** Leases up to the free concurrency slots and starts them in the background; returns the number started. */
  async tick(): Promise<number> {
    const { pool, registry, config } = this.deps;
    const free = config.concurrency - this.inFlight.size;
    const kinds = registry.jobKinds();
    if (this.stopping || free <= 0 || kinds.length === 0) return 0;
    const leased = await inTransaction(pool, (trx) => jobs.lease(trx, kinds, config.workerId, config.leaseSeconds, free));
    for (const job of leased) this.start(job);
    return leased.length;
  }

  /** Resolves when no job is executing (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
  }

  /**
   * Graceful shutdown: no new leases; in-flight jobs get `graceMs` to finish. After that, external jobs are parked as
   * outcome_unknown (the call may have reached the provider) and transactional jobs are cancelled, rolled back and
   * released without consuming an attempt.
   */
  async drain(graceMs: number): Promise<void> {
    this.stopping = true;
    const finished = this.idle().then(() => true);
    if (await Promise.race([finished, sleep(graceMs).then(() => false)])) return;
    const { pool, metrics, log } = this.deps;
    for (const entry of this.inFlight.values()) {
      entry.abort.abort(new ShutdownError());
      if (entry.handler.mode === 'transactional') {
        if (entry.pid !== null) await pool.query('SELECT pg_cancel_backend($1)', [entry.pid]).catch(() => undefined);
        continue;
      }
      const parked = await inTransaction(pool, (trx) => jobs.markOutcomeUnknown(trx, entry.job.id, entry.job.fencing_token, 'worker shut down during an external call; awaiting reconciliation')).catch(() => false);
      if (parked) {
        metrics.inc(...M.unknownOutcomes, { kind: entry.job.kind, reason: 'shutdown' });
        log('warn', 'external job parked at shutdown', { jobId: entry.job.id, kind: entry.job.kind });
      }
    }
    await Promise.race([this.idle(), sleep(Math.min(5000, Math.max(500, graceMs)))]);
  }

  private start(job: Job): void {
    const handler = this.deps.registry.jobHandler(job.kind);
    const abort = new AbortController();
    const entry: InFlight = { job, handler: handler!, abort, pid: null, promise: Promise.resolve() };
    entry.promise = this.execute(entry)
      .then((result) => this.deps.metrics.inc(...M.jobs, { kind: job.kind, result }))
      .catch((error: unknown) => {
        this.deps.metrics.inc(...M.loopErrors, { component: 'job' });
        this.deps.log('error', 'job outcome not recorded; the lease will expire and park it', { jobId: job.id, kind: job.kind, error: describeError(error) });
      })
      .finally(() => this.inFlight.delete(job.id));
    this.inFlight.set(job.id, entry);
  }

  private async execute(entry: InFlight): Promise<JobResult> {
    const { pool, config, log } = this.deps;
    const { job, abort } = entry;
    const heartbeat = setInterval(() => {
      inTransaction(pool, (trx) => jobs.heartbeat(trx, job.id, job.fencing_token, config.leaseSeconds)).then(
        (alive) => {
          if (!alive && !abort.signal.aborted) abort.abort(new LeaseLostError());
        },
        (error: unknown) => log('warn', 'heartbeat failed; the lease may expire', { jobId: job.id, error: describeError(error) }),
      );
    }, config.heartbeatMs);
    try {
      return entry.handler.mode === 'transactional' ? await this.runTransactional(entry, entry.handler) : await this.runExternal(entry, entry.handler);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private context(entry: InFlight, payload: unknown): JobContext {
    return { job: entry.job, payload, attemptId: `${entry.job.id}:${entry.job.attempt}`, effectKey: `job:${entry.job.id}`, signal: entry.abort.signal };
  }

  private async runTransactional(entry: InFlight, handler: TransactionalJobHandler): Promise<JobResult> {
    const { pool, config, log } = this.deps;
    const { job, abort } = entry;
    try {
      await inTransaction(pool, async (trx, handle) => {
        entry.pid = handle.pid;
        const payload = parsePayload(handler, job);
        await handler.run({ ...this.context(entry, payload), ...transactionalContext(trx, config) });
        if (abort.signal.aborted) throw abort.signal.reason;
        if (!(await jobs.complete(trx, job.id, job.fencing_token))) throw new FencedOutError();
      });
      return 'succeeded';
    } catch (error) {
      entry.pid = null;
      // The transaction rolled back: no database effect happened.
      if (error instanceof FencedOutError || abort.signal.reason instanceof LeaseLostError) {
        log('warn', 'transactional job fenced out; effect rolled back', { jobId: job.id, kind: job.kind });
        return 'fenced_out';
      }
      if (abort.signal.reason instanceof ShutdownError) {
        const released = await inTransaction(pool, (trx) => jobs.release(trx, job.id, job.fencing_token));
        return released ? 'released' : 'fenced_out';
      }
      return this.recordFailure(job, error);
    }
  }

  private async runExternal(entry: InFlight, handler: ExternalJobHandler): Promise<JobResult> {
    const { pool, config, metrics, log } = this.deps;
    const { job, abort } = entry;
    const timeoutMs = handler.timeoutMs ?? config.externalTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    let outcome: { kind: 'succeeded' } | { kind: 'failed'; error: unknown } | { kind: 'unknown'; reason: string; error: unknown };
    try {
      const payload = parsePayload(handler, job);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new JobTimeoutError(timeoutMs);
          abort.abort(error);
          reject(error);
        }, timeoutMs);
      });
      await Promise.race([handler.run(this.context(entry, payload)), timeout]);
      outcome = { kind: 'succeeded' };
    } catch (error) {
      if (error instanceof RetryableJobError || error instanceof PermanentJobError) outcome = { kind: 'failed', error };
      else outcome = { kind: 'unknown', reason: error instanceof JobTimeoutError ? 'timeout' : 'ambiguous_error', error };
    } finally {
      clearTimeout(timer);
    }
    if (outcome.kind === 'succeeded') {
      const done = await inTransaction(pool, (trx) => jobs.complete(trx, job.id, job.fencing_token));
      if (!done) log('warn', 'external job finished after losing its lease; awaiting reconciliation of the parked job', { jobId: job.id, kind: job.kind });
      return done ? 'succeeded' : 'fenced_out';
    }
    if (outcome.kind === 'failed') return this.recordFailure(job, outcome.error);
    const message = `${outcome.reason}: ${describeError(outcome.error)}; awaiting reconciliation`;
    const parked = await inTransaction(pool, (trx) => jobs.markOutcomeUnknown(trx, job.id, job.fencing_token, message));
    if (!parked) return 'fenced_out';
    metrics.inc(...M.unknownOutcomes, { kind: job.kind, reason: outcome.reason });
    log('warn', 'external job outcome unknown; parked for reconciliation', { jobId: job.id, kind: job.kind, reason: outcome.reason });
    return 'outcome_unknown';
  }

  /** Failure with proof of no effect: dead-letter when permanent or out of attempts, otherwise retry with backoff. */
  private async recordFailure(job: Job, error: unknown): Promise<JobResult> {
    const { pool, config, log } = this.deps;
    const message = describeError(error);
    if (error instanceof PermanentJobError) {
      const dead = await inTransaction(pool, (trx) => jobs.deadLetter(trx, job.id, job.fencing_token, message));
      log('warn', 'job dead-lettered', { jobId: job.id, kind: job.kind, error: message });
      return dead ? 'dead' : 'fenced_out';
    }
    const delay = retryDelaySeconds(config.retry, job.attempt, config.retryJitter, this.deps.random);
    const recorded = await inTransaction(pool, (trx) => jobs.failWithBackoff(trx, job.id, job.fencing_token, message, delay));
    if (!recorded) return 'fenced_out';
    const willRetry = job.attempt < job.max_attempts;
    log('warn', willRetry ? 'job failed; retry scheduled' : 'job failed; attempts exhausted, dead-lettered', { jobId: job.id, kind: job.kind, attempt: job.attempt, delaySeconds: willRetry ? delay : null, error: message });
    return willRetry ? 'retried' : 'dead';
  }
}

function parsePayload(handler: JobHandler, job: Job): unknown {
  if (!handler.parse) return job.payload;
  try {
    return handler.parse(job.payload);
  } catch (error) {
    throw new PermanentJobError(`invalid payload for ${job.kind}: ${describeError(error)}`, { cause: error });
  }
}
