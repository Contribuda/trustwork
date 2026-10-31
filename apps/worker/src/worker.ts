import { outbox, type DataPool } from '@trustwork/data';
import { defaultWorkerConfig, type WorkerConfig } from './config.js';
import { PermanentJobError, HandlerRegistry } from './handlers.js';
import { describeError, silentLogger, type Logger } from './log.js';
import { collectQueueGauges, M, Metrics } from './metrics.js';
import { envelopeOf, OutboxRelay, REDELIVER_KIND, type RedeliverPayload } from './relay.js';
import { JobRunner } from './runner.js';
import { Scheduler, type ScheduledTask } from './scheduler.js';

export interface WorkerOptions {
  pool: DataPool;
  registry?: HandlerRegistry;
  config?: Partial<WorkerConfig>;
  metrics?: Metrics;
  log?: Logger;
  /** Replaces the default maintenance tasks (tests). */
  tasks?: (deps: { pool: DataPool; registry: HandlerRegistry; config: WorkerConfig; metrics: Metrics; log: Logger }) => ScheduledTask[];
  /** Jitter source for retry delays (tests pass a constant). */
  random?: () => number;
}

export interface IterationReport { scheduled: string[]; relayed: number; leased: number; errors: number }

function parseRedeliver(payload: unknown): RedeliverPayload {
  const value = payload as Partial<RedeliverPayload> | null;
  if (!value || typeof value.eventId !== 'string' || !/^\d+$/.test(value.eventId) || typeof value.handler !== 'string') throw new Error('expected { eventId, handler }');
  return { eventId: value.eventId, handler: value.handler };
}

/**
 * The worker process: scheduler, outbox relay and job runner in one loop. Several workers may run against the same
 * database; coordination is entirely in PostgreSQL (SKIP LOCKED, fencing tokens, schedule slots).
 */
export class Worker {
  readonly config: WorkerConfig;
  readonly registry: HandlerRegistry;
  readonly metrics: Metrics;
  readonly relay: OutboxRelay;
  readonly runner: JobRunner;
  readonly scheduler: Scheduler;
  private readonly pool: DataPool;
  private readonly log: Logger;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.pool = options.pool;
    this.config = defaultWorkerConfig(options.config);
    this.registry = options.registry ?? new HandlerRegistry();
    this.metrics = options.metrics ?? new Metrics();
    this.log = options.log ?? silentLogger;
    const deps = { pool: this.pool, registry: this.registry, config: this.config, metrics: this.metrics, log: this.log };
    this.registerRedelivery();
    this.relay = new OutboxRelay(deps);
    this.runner = new JobRunner({ ...deps, ...(options.random ? { random: options.random } : {}) });
    this.scheduler = new Scheduler(deps, options.tasks?.(deps));
  }

  /** Built-in transactional job that re-runs one failed outbox handler for one event (retries, then dead letter). */
  private registerRedelivery(): void {
    if (this.registry.jobHandler(REDELIVER_KIND)) return;
    this.registry.onJob<RedeliverPayload>({
      kind: REDELIVER_KIND,
      mode: 'transactional',
      parse: parseRedeliver,
      run: async (context) => {
        const handler = this.registry.outboxHandler(context.payload.handler);
        if (!handler) throw new PermanentJobError(`outbox handler ${context.payload.handler} is not registered`);
        const event = await outbox.getById(context.trx, context.payload.eventId);
        if (!event) throw new PermanentJobError(`outbox event ${context.payload.eventId} not found`);
        await handler.handle(envelopeOf(event, handler), context);
      },
    });
  }

  /** One iteration: due maintenance, one relay batch, then lease into the free job slots. */
  async runOnce(options: { rethrow?: boolean } = {}): Promise<IterationReport> {
    const report: IterationReport = { scheduled: [], relayed: 0, leased: 0, errors: 0 };
    const guard = async <T>(component: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (options.rethrow) throw error;
        report.errors += 1;
        this.metrics.inc(...M.loopErrors, { component });
        this.log('error', 'worker iteration step failed', { component, error: describeError(error) });
        return fallback;
      }
    };
    report.scheduled = await guard('schedule', () => this.scheduler.tick(), []);
    report.relayed = await guard('relay', () => this.relay.relayOnce(), 0);
    report.leased = await guard('lease', () => this.runner.tick(), 0);
    return report;
  }

  /** Waits for the jobs started by previous iterations (tests). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  /** Starts the background loop; sleeps `pollIntervalMs` after an iteration that found nothing to do. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.log('info', 'worker started', { workerId: this.config.workerId, kinds: this.registry.jobKinds().join(','), concurrency: this.config.concurrency });
    this.loop = (async () => {
      while (!this.stopping) {
        const report = await this.runOnce();
        const busy = report.relayed > 0 || report.leased > 0;
        if (!busy && !this.stopping) await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, report.errors ? this.config.pollIntervalMs * 5 : this.config.pollIntervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    })();
  }

  /** Graceful stop: no new leases or relay batches; in-flight jobs finish within the grace period or are released/parked. */
  async stop(graceMs = this.config.shutdownGraceMs): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
    await this.runner.drain(graceMs);
    this.log('info', 'worker stopped', { workerId: this.config.workerId });
  }

  /** Prometheus text: queue gauges read now from the database plus this process's counters. */
  async renderMetrics(): Promise<string> {
    await collectQueueGauges(this.pool, this.metrics);
    return this.metrics.render();
  }
}
