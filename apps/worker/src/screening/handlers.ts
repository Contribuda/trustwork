import { jobs, type DataPool } from '@trustwork/data';
import { SCREENING_TRIGGER_EVENTS, ScreeningSubjectRefSchema, ScreeningTriggerSchema, type ScreeningSubjectRef, type ScreeningTrigger, type ScreeningTriggerEvent } from '../../../../packages/contracts/src/sanctions.js';
import { screeningWorker } from '../../../../packages/data/src/repositories/screening.js';
import { inTransaction } from '../db.js';
import { PermanentJobError, type HandlerRegistry, type OutboxEventEnvelope, type TransactionalContext } from '../handlers.js';
import type { Logger } from '../log.js';
import type { Metrics } from '../metrics.js';
import type { ScheduledTask } from '../scheduler.js';
import type { ScreeningConfig } from './config.js';
import { screenSubject } from './screen.js';

/**
 * The screening engine in the worker (SANC-003). See README.md.
 *
 * - Outbox handlers for the trigger events (`SCREENING_TRIGGER_EVENTS`): registration, sign-in (only when newer list
 *   versions are active or the names changed since the last screening), company creation, renames and ownership
 *   declaration changes enqueue one `screening.screen_subject` job per subject (never a second while one waits).
 * - `screening.screen_subject` (transactional job, `{ subject, trigger }`): one screening, recorded in the job's
 *   transaction; a failure rolls back and retries, and never becomes "clear".
 * - `screening.names_sweep` (nightly): the safety net for missed events: subjects never screened, renamed since their
 *   last screening, or whose last screening could not run.
 */
export const SCREENING_JOB_KIND = 'screening.screen_subject';
export const SCREENING_SWEEP_TASK = 'screening.names_sweep';
export const SCREENING_JOB_ATTEMPTS = 8;
export const SCREENING_METRICS = {
  results: ['trustwork_screening_results_total', 'Screening results by subject kind, trigger and outcome.'],
  opened: ['trustwork_screening_matches_opened_total', 'Possible matches opened or re-opened for review.'],
  swept: ['trustwork_screening_sweep_enqueued_total', 'Subjects enqueued by the nightly names-digest sweep.'],
} as const;

export interface ScreeningRuntime {
  pool: DataPool;
  config: ScreeningConfig;
  log: Logger;
  metrics: Metrics;
}

interface ScreenPayload { subject: ScreeningSubjectRef; trigger: ScreeningTrigger }
function parseScreenPayload(payload: unknown): ScreenPayload {
  const p = payload as { subject?: unknown; trigger?: unknown } | null;
  const subject = ScreeningSubjectRefSchema.safeParse(p?.subject);
  const trigger = ScreeningTriggerSchema.safeParse(p?.trigger);
  if (!subject.success || !trigger.success) throw new PermanentJobError('expected { subject: { kind, id }, trigger }');
  return { subject: subject.data, trigger: trigger.data };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The subject of a trigger event: the aggregate (a person for identity events, a company for company events). */
export function subjectOfEvent(event: Pick<OutboxEventEnvelope, 'type' | 'aggregateKind' | 'aggregateId'>): ScreeningSubjectRef {
  const kind = event.type.startsWith('identity.') ? 'person' : 'company';
  if (event.aggregateKind !== kind || !UUID.test(event.aggregateId)) throw new PermanentJobError(`malformed ${event.type} event: expected a ${kind} aggregate`);
  return { kind, id: event.aggregateId };
}

/** Enqueues one screening of the subject unless one waits (and, for sign-in, unless nothing changed). */
export async function requestScreening(context: TransactionalContext, subject: ScreeningSubjectRef, trigger: ScreeningTrigger, force: boolean): Promise<boolean> {
  if (!(await screeningWorker.shouldScreen(context.trx, subject, force))) return false;
  await context.enqueue({ kind: SCREENING_JOB_KIND, payload: { subject, trigger } satisfies ScreenPayload, maxAttempts: SCREENING_JOB_ATTEMPTS });
  return true;
}

export function registerScreening(registry: HandlerRegistry, runtime: ScreeningRuntime): void {
  for (const [type, trigger] of Object.entries(SCREENING_TRIGGER_EVENTS) as [ScreeningTriggerEvent, ScreeningTrigger][]) {
    registry.onOutbox({
      name: `screening.on_${type.replace(/[^a-z0-9]+/g, '_')}`,
      type,
      handle: async (event, context) => {
        await requestScreening(context, subjectOfEvent(event), trigger, type !== 'identity.session_started');
      },
    });
  }
  registry.onJob<ScreenPayload>({
    kind: SCREENING_JOB_KIND,
    mode: 'transactional',
    parse: parseScreenPayload,
    run: async (context) => {
      const result = await screenSubject(context.trx, context.payload.subject, context.payload.trigger, runtime.config);
      runtime.metrics.inc(...SCREENING_METRICS.results, { kind: context.payload.subject.kind, trigger: context.payload.trigger, outcome: result.outcome });
      if (result.opened > 0) runtime.metrics.inc(...SCREENING_METRICS.opened, {}, result.opened);
      // Identifiers and outcomes only: never a name, a list entry or a matched key.
      runtime.log(result.outcome === 'clear' ? 'info' : 'warn', 'screening recorded', { resultId: result.resultId, kind: context.payload.subject.kind, trigger: context.payload.trigger, outcome: result.outcome, opened: result.opened });
    },
  });
}

/** The nightly names-digest sweep: enqueues a screening for every due subject (a batch per run). */
export function screeningSweepTask(runtime: Pick<ScreeningRuntime, 'pool' | 'config' | 'metrics'>, intervalSeconds = 86_400): ScheduledTask {
  return {
    name: SCREENING_SWEEP_TASK,
    intervalSeconds,
    run: () => inTransaction(runtime.pool, async (trx) => {
      const due = await screeningWorker.sweepDue(trx, runtime.config.sweepBatch);
      for (const subject of due) await jobs.enqueue(trx, { kind: SCREENING_JOB_KIND, payload: { subject, trigger: 'scheduled' } satisfies ScreenPayload, max_attempts: SCREENING_JOB_ATTEMPTS });
      if (due.length) runtime.metrics.inc(...SCREENING_METRICS.swept, {}, due.length);
      return { enqueued: due.length };
    }),
  };
}
