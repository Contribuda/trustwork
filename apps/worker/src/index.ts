/** Programmatic surface of the worker (tests and future packages that register handlers). */
export { WORKER_ROLE, DEFAULT_RETRY, defaultWorkerConfig, workerConfigFromEnv, type WorkerConfig, type WorkerEnv, type ScheduleIntervals, type RetryPolicy } from './config.js';
export { assertWorkerRole, createWorkerPool, inTransaction, WorkerRoleError } from './db.js';
export { HandlerRegistry, PermanentJobError, RetryableJobError, type ExternalJobHandler, type JobContext, type JobHandler, type OutboxEventEnvelope, type OutboxHandler, type TransactionalContext, type TransactionalJobHandler, type EnqueueRequest } from './handlers.js';
export { retryDelaySeconds } from './backoff.js';
export { jsonLogger, silentLogger, describeError, type Logger, type LogLevel } from './log.js';
export { Metrics, M, collectQueueGauges, startMetricsServer, type MetricsServer } from './metrics.js';
export { OutboxRelay, REDELIVER_KIND } from './relay.js';
export { JobRunner, LeaseLostError, ShutdownError, JobTimeoutError, type JobResult } from './runner.js';
export { Scheduler, expireLeasesTask, sweepTask, partitionsTask, type ScheduledTask } from './scheduler.js';
export { reconcileJob, RECONCILE_OUTCOMES, type ReconcileInput, type ReconcileOutcome } from './reconcile.js';
export { runCli, type CliIo } from './cli.js';
export { Worker, type WorkerOptions, type IterationReport } from './worker.js';
export * as mail from './mail/index.js';
