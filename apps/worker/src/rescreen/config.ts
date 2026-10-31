/**
 * Worker settings of re-screening (SANC-005). Hub settings inside engine bounds; until the hub schedule store carries
 * the `sanctions_rescreen` pipeline (HUB-001, HUBC-005), they come from the environment.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `RESCREEN_BATCH` | 500 | Subjects per batch job (50 to 5000); one batch of a run is in flight at a time |
 * | `RESCREEN_WINDOW_HOURS` | 6 | A run still unfinished this long after it started raises one `overdue` alert (1 to 168) |
 * | `RESCREEN_WEEKLY_DAYS` | 7 | Interval of the full safety-net run (1 to 7; ADR 014 open question 7 asks whether daily is needed) |
 * | `RESCREEN_RETRY_MINUTES` | 60 | A failed run resumes from its cursor this long after its last failure (5 to 1440) |
 * | `RESCREEN_YIELD_READY_JOBS` | 200 | Backpressure: when more jobs of other kinds are due than this, the next batch waits `RESCREEN_YIELD_SECONDS` |
 * | `RESCREEN_YIELD_SECONDS` | 5 | Pause before the next batch while the queue is busy (1 to 300) |
 * | `RESCREEN_BLOCKED_SECONDS` | 300 | Pause before trying again while screening is unavailable (missing or stale baseline; 30 to 3600) |
 */
export interface RescreenConfig {
  readonly batchSize: number;
  readonly windowSeconds: number;
  readonly weeklySeconds: number;
  readonly retryAfterSeconds: number;
  readonly yieldReadyJobs: number;
  readonly yieldSeconds: number;
  readonly blockedSeconds: number;
}

export class RescreenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RescreenConfigError';
  }
}

export const DEFAULT_RESCREEN_CONFIG: RescreenConfig = {
  batchSize: 500, windowSeconds: 6 * 3600, weeklySeconds: 7 * 86_400, retryAfterSeconds: 3600, yieldReadyJobs: 200, yieldSeconds: 5, blockedSeconds: 300,
};

function int(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RescreenConfigError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function rescreenConfigFromEnv(env: Readonly<Record<string, string | undefined>>): RescreenConfig {
  return {
    batchSize: int(env, 'RESCREEN_BATCH', DEFAULT_RESCREEN_CONFIG.batchSize, 50, 5000),
    windowSeconds: int(env, 'RESCREEN_WINDOW_HOURS', 6, 1, 168) * 3600,
    weeklySeconds: int(env, 'RESCREEN_WEEKLY_DAYS', 7, 1, 7) * 86_400,
    retryAfterSeconds: int(env, 'RESCREEN_RETRY_MINUTES', 60, 5, 1440) * 60,
    yieldReadyJobs: int(env, 'RESCREEN_YIELD_READY_JOBS', DEFAULT_RESCREEN_CONFIG.yieldReadyJobs, 1, 100_000),
    yieldSeconds: int(env, 'RESCREEN_YIELD_SECONDS', DEFAULT_RESCREEN_CONFIG.yieldSeconds, 1, 300),
    blockedSeconds: int(env, 'RESCREEN_BLOCKED_SECONDS', DEFAULT_RESCREEN_CONFIG.blockedSeconds, 30, 3600),
  };
}
