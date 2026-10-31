import { jobs, type DataPool } from '@trustwork/data';
import { screeningFreshness, screeningListWorker } from '../../../../packages/data/src/repositories/screening-lists.js';
import { inTransaction } from '../db.js';
import { PermanentJobError, type HandlerRegistry } from '../handlers.js';
import type { Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';
import type { ScreeningListsConfig } from './config.js';
import { rangeTableAge } from './geolocation.js';
import { ingestList, type IngestReport } from './ingest.js';
import { fakeListSource, fileListSource, liveListSource, type ListFetcher, type ListSource, type LiveActivation } from './sources.js';
import type { LockedScreeningList } from '../../../../packages/data/src/repositories/screening-lists.js';

/**
 * Screening lists in the worker (SANC-002). See README.md.
 *
 * - `screening.list_ingest` (transactional job, `{ listId }`): one ingestion of one list (`ingestList`). Reading the
 *   export, staging, activation, the outbox event and the attempt record share the job's transaction, so a crash or a
 *   lost lease rolls everything back and the job runs again; there is no external effect to reconcile.
 * - `screening.lists_due` (every 15 minutes): enqueues one ingestion job per list whose cadence elapsed and that has no
 *   ingestion job queued or running.
 * - `screening.lists_freshness` (hourly): freshness gauges, a warning per list past its warning age, an error while a
 *   baseline list is missing or stale (screening unavailable, money and commitment gates refuse).
 * - `jurisdiction.ranges_age` (daily, the package asks at least monthly): warns when the geolocation range table is
 *   older than two months.
 */
export const SCREENING_LIST_INGEST_KIND = 'screening.list_ingest';
export const SCREENING_LISTS_DUE_TASK = 'screening.lists_due';
export const SCREENING_FRESHNESS_TASK = 'screening.lists_freshness';
export const RANGES_AGE_TASK = 'jurisdiction.ranges_age';
export const SCREENING_INGEST_ATTEMPTS = 5;

export const SCREENING_METRICS = {
  ingestions: ['trustwork_screening_list_ingestions_total', 'Screening list ingestion attempts by list and outcome.'],
  available: ['trustwork_screening_available', '1 while every baseline screening list is fresh or in its warning period, 0 otherwise.'],
  age: ['trustwork_screening_list_age_seconds', 'Seconds since the active content of each screening list was last confirmed from its source.'],
  state: ['trustwork_screening_list_state', 'Freshness state of each screening list (1 for the current state).'],
  rangesAge: ['trustwork_geolocation_table_age_months', 'Whole months since the month of the geolocation range table (-1 when unreadable).'],
} as const;

export interface ScreeningListsRuntime {
  pool: DataPool;
  config: ScreeningListsConfig;
  log: Logger;
  metrics: Metrics;
  /** KEYS-001: the egress fetcher and the provider activation of live lists. Without them `live` refuses. */
  live?: { fetcher: ListFetcher | null; activation: (list: LockedScreeningList) => Promise<LiveActivation | null> | LiveActivation | null };
  /** Replaces the sources (tests). */
  sources?: Partial<Record<'fake' | 'file' | 'live', ListSource>>;
  now?: () => Date;
}

export function screeningListSources(runtime: ScreeningListsRuntime): Record<'fake' | 'file' | 'live', ListSource> {
  const now = runtime.now ?? (() => new Date());
  return {
    file: runtime.sources?.file ?? fileListSource({ dir: runtime.config.listsDir, maxBytes: runtime.config.maxExportBytes, now }),
    live: runtime.sources?.live ?? liveListSource({ fetcher: runtime.live?.fetcher ?? null, activation: runtime.live?.activation ?? (() => null), maxBytes: runtime.config.maxExportBytes, now }),
    fake: runtime.sources?.fake ?? fakeListSource({ production: runtime.config.production, now }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function parseIngestPayload(payload: unknown): { listId: string } {
  const listId = (payload as { listId?: unknown } | null)?.listId;
  if (typeof listId !== 'string' || !UUID.test(listId)) throw new PermanentJobError('expected { listId: uuid }');
  return { listId };
}

function report(runtime: ScreeningListsRuntime, result: IngestReport): void {
  runtime.metrics.inc(...SCREENING_METRICS.ingestions, { list: result.code ?? 'unknown', outcome: result.outcome });
  const fields = { listId: result.listId, list: result.code ?? 'unknown', outcome: result.outcome, ...(result.versionId ? { versionId: result.versionId } : {}), ...(result.error ? { reason: result.error } : {}) };
  if (result.outcome === 'activated' || result.outcome === 'unchanged') runtime.log('info', 'screening list ingested', fields);
  else runtime.log('warn', 'screening list not activated', fields);
}

export function registerScreeningLists(registry: HandlerRegistry, runtime: ScreeningListsRuntime): void {
  const sources = screeningListSources(runtime);
  registry.onJob<{ listId: string }>({
    kind: SCREENING_LIST_INGEST_KIND,
    mode: 'transactional',
    parse: parseIngestPayload,
    run: async (context) => {
      report(runtime, await ingestList(context.trx, context.payload.listId, { sources }, context.signal));
    },
  });
}

/** Enqueues an ingestion job for every due list (at most 20 per run). */
export function screeningListsDueTask(runtime: Pick<ScreeningListsRuntime, 'pool'>, intervalSeconds = 900): ScheduledTask {
  return {
    name: SCREENING_LISTS_DUE_TASK,
    intervalSeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const due = await screeningListWorker.due(trx, 20);
      for (const listId of due) await jobs.enqueue(trx, { kind: SCREENING_LIST_INGEST_KIND, payload: { listId }, max_attempts: SCREENING_INGEST_ATTEMPTS });
      return { enqueued: due.length };
    }),
  };
}

/** Freshness gauges and warnings; an error log while screening is unavailable. */
export function screeningFreshnessTask(runtime: Pick<ScreeningListsRuntime, 'pool' | 'log' | 'metrics' | 'now'>, intervalSeconds = 3600): ScheduledTask {
  return {
    name: SCREENING_FRESHNESS_TASK,
    intervalSeconds,
    run: async () => {
      const at = runtime.now?.();
      const availability = await inTransaction(runtime.pool, (trx) => screeningFreshness.availability(trx, at));
      runtime.metrics.resetGauge(...SCREENING_METRICS.age);
      runtime.metrics.resetGauge(...SCREENING_METRICS.state);
      let warnings = 0;
      for (const list of availability.lists) {
        if (list.ageSeconds !== null) runtime.metrics.set(...SCREENING_METRICS.age, list.ageSeconds, { list: list.code });
        runtime.metrics.set(...SCREENING_METRICS.state, 1, { list: list.code, state: list.state });
        if (list.state === 'warning' || list.state === 'stale' || list.state === 'missing') {
          warnings += 1;
          runtime.log('warn', 'screening list is not fresh', { list: list.code, state: list.state, baseline: list.baseline, ageSeconds: list.ageSeconds ?? -1 });
        }
      }
      runtime.metrics.set(...SCREENING_METRICS.available, availability.available ? 1 : 0);
      if (!availability.available) runtime.log('error', 'screening unavailable: money and commitment gates refuse', { reasons: availability.reasons.map((r) => (r.code ? `${r.reason}:${r.code}` : r.reason)).join(',') });
      return { lists: availability.lists.length, notFresh: warnings, unavailable: availability.available ? 0 : 1 };
    },
  };
}

/** Warns when the geolocation range table of a `ranges_file` gate is older than two months. */
export function rangesAgeTask(runtime: { env: Readonly<Record<string, string | undefined>>; log: Logger; metrics: Metrics; now?: () => Date; readJson?: (path: string) => unknown }, intervalSeconds = 86_400): ScheduledTask {
  return {
    name: RANGES_AGE_TASK,
    intervalSeconds,
    run: async () => {
      const age = rangeTableAge(runtime.env, runtime.now?.() ?? new Date(), runtime.readJson);
      if (age.state === 'not_applicable') return { checked: 0 };
      if (age.state === 'unreadable') {
        runtime.metrics.set(...SCREENING_METRICS.rangesAge, -1);
        runtime.log('error', 'geolocation range table cannot be read', { reason: age.reason });
        return { checked: 1, overdue: 0, unreadable: 1 };
      }
      runtime.metrics.set(...SCREENING_METRICS.rangesAge, age.ageMonths);
      if (age.state === 'overdue') runtime.log('warn', 'geolocation range table is older than two months: regenerate it from a fresh dataset', { dataset: age.dataset, month: age.month, ageMonths: age.ageMonths });
      return { checked: 1, overdue: age.state === 'overdue' ? 1 : 0, unreadable: 0 };
    },
  };
}
