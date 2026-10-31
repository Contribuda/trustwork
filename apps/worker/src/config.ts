import { hostname } from 'node:os';
import { RetryPolicySchema } from '@trustwork/contracts';

/** Contract shape of a retry policy (RetryPolicySchema in packages/contracts/src/hub.ts). */
export type RetryPolicy = ReturnType<(typeof RetryPolicySchema)['parse']>;

/** Group role the worker's login must belong to; equals WORKER_ROLE in packages/data/src/config.ts (tested). */
export const WORKER_ROLE = 'trustwork_worker';

export interface ScheduleIntervals {
  /** Parks expired leases as outcome_unknown and auto-reconciles transactional jobs. */
  expireLeasesSeconds: number;
  /** trustwork.worker_sweep_expired(): bounded tables and expired idempotency records. */
  sweepSeconds: number;
  /** trustwork.ensure_monthly_partitions(): current month plus three for audit_event and outbox_event. */
  partitionsSeconds: number;
}

export interface WorkerConfig {
  /** Recorded in job.leased_by and worker_schedule.last_worker; no personal data. */
  workerId: string;
  /** Maximum jobs executing at once; the lease size is the number of free slots. */
  concurrency: number;
  /** Sleep between iterations that found no work. */
  pollIntervalMs: number;
  /** Lease length; renewed by a heartbeat every `heartbeatMs`. */
  leaseSeconds: number;
  heartbeatMs: number;
  /** Default time limit of an external job; a timeout parks the job as outcome_unknown. */
  externalTimeoutMs: number;
  relayBatchSize: number;
  /** On SIGTERM/SIGINT: stop leasing, then wait this long for in-flight work before releasing or parking it. */
  shutdownGraceMs: number;
  /** Backoff of retryable failures (contract RetryPolicySchema); `maxAttempts` is the default for enqueued jobs. */
  retry: RetryPolicy;
  /** Fraction of the delay added as random jitter (0 disables). */
  retryJitter: number;
  schedule: ScheduleIntervals;
  metrics: { host: string; port: number | null };
}

export const DEFAULT_RETRY: RetryPolicy = RetryPolicySchema.parse({ maxAttempts: 5, backoff: 'exponential', baseSeconds: 5, maxDelaySeconds: 3600, retryOn: ['network', 'rate_limited', 'server_error', 'timeout'] });

export function defaultWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const leaseSeconds = overrides.leaseSeconds ?? 60;
  return {
    workerId: `${hostname()}:${process.pid}`,
    concurrency: 4,
    pollIntervalMs: 1000,
    leaseSeconds,
    heartbeatMs: Math.max(250, Math.floor((leaseSeconds * 1000) / 3)),
    externalTimeoutMs: 30_000,
    relayBatchSize: 100,
    shutdownGraceMs: 25_000,
    retry: DEFAULT_RETRY,
    retryJitter: 0.1,
    schedule: { expireLeasesSeconds: 15, sweepSeconds: 3600, partitionsSeconds: 6 * 3600 },
    metrics: { host: '127.0.0.1', port: null },
    ...overrides,
  };
}

export interface WorkerEnv {
  WORKER_DATABASE_URL?: string | undefined;
  WORKER_ID?: string | undefined;
  WORKER_CONCURRENCY?: string | undefined;
  WORKER_POLL_MS?: string | undefined;
  WORKER_LEASE_SECONDS?: string | undefined;
  WORKER_EXTERNAL_TIMEOUT_MS?: string | undefined;
  WORKER_SHUTDOWN_GRACE_MS?: string | undefined;
  WORKER_METRICS_HOST?: string | undefined;
  WORKER_METRICS_PORT?: string | undefined;
}

function integer(env: WorkerEnv, key: keyof WorkerEnv, min: number, max: number): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

/**
 * Worker configuration from explicit environment values (nothing is read from `.env`). The database URL must name a
 * login that is a member of trustwork_worker; `assertWorkerRole` refuses anything else at start.
 */
export function workerConfigFromEnv(env: WorkerEnv): { databaseUrl: string; config: WorkerConfig } {
  if (!env.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required (a login role that is a member of trustwork_worker)');
  const leaseSeconds = integer(env, 'WORKER_LEASE_SECONDS', 5, 3600);
  const port = integer(env, 'WORKER_METRICS_PORT', 0, 65535);
  const id = env.WORKER_ID?.trim();
  if (id !== undefined && id !== '' && !/^[A-Za-z0-9._:-]{1,100}$/.test(id)) throw new Error('WORKER_ID must be 1-100 characters of [A-Za-z0-9._:-]');
  const base = defaultWorkerConfig(leaseSeconds === undefined ? {} : { leaseSeconds });
  const pick = <K extends keyof WorkerConfig>(key: K, value: WorkerConfig[K] | undefined): Partial<WorkerConfig> => (value === undefined ? {} : { [key]: value });
  return {
    databaseUrl: env.WORKER_DATABASE_URL,
    config: {
      ...base,
      ...(id ? { workerId: id } : {}),
      ...pick('concurrency', integer(env, 'WORKER_CONCURRENCY', 1, 64)),
      ...pick('pollIntervalMs', integer(env, 'WORKER_POLL_MS', 50, 60_000)),
      ...pick('externalTimeoutMs', integer(env, 'WORKER_EXTERNAL_TIMEOUT_MS', 100, 3_600_000)),
      ...pick('shutdownGraceMs', integer(env, 'WORKER_SHUTDOWN_GRACE_MS', 0, 600_000)),
      metrics: { host: env.WORKER_METRICS_HOST?.trim() || '127.0.0.1', port: port ?? null },
    },
  };
}
