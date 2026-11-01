import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  PipelineAlertRow, PipelineCountsJson, PipelineEffectRow, PipelineRoleCapRow, PipelineRow, PipelineRunRow, PipelineScheduleRow, PipelineStepJson, PipelineVersionRow,
} from '../schema/pipelines.js';
import type { CommandContext } from './admin.js';
import '../schema/pipelines.js';

/**
 * Pipeline engine and scheduler (PIPE-001, migration packages/data/migrations/pipelines).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (a live elevation, a request id and a reason): each
 *   calls one `pipelines_*` SECURITY DEFINER command that checks the permission at the hub (`admin.pipelines.*`),
 *   separation of duties (the drafter never activates) and writes the admin audit row in the same transaction.
 * - **Reads** under row-level security: staff with a pipelines permission at the hub read everything of its pipelines.
 * - **Worker entry points** (trustwork_worker): enqueueing scheduled runs, leasing, step boundaries, the effect ledger,
 *   role caps, finishing, lease expiry, retries and source-change pauses, all fenced by the run's lease token.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const json = (v: unknown): string => JSON.stringify(v);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}
async function maybe<T>(query: RawBuilder<T>, trx: Transaction): Promise<T | null> {
  const { rows } = await query.execute(trx);
  const row = rows[0] as (T & { id?: string | null }) | undefined;
  return row && row.id !== null && row.id !== undefined ? row : null;
}
async function scalar<T>(query: RawBuilder<{ v: T }>, trx: Transaction): Promise<T> {
  const { rows } = await query.execute(trx);
  return rows[0]!.v;
}

export interface DraftPipelineVersionInput {
  name: string;
  sourceIds: string[];
  datasetId: string | null;
  steps: PipelineStepJson[];
  automationLevel: 'manual' | 'assisted' | 'supervised_autonomous';
  budgetId: string | null;
}
export interface PipelineScheduleInput {
  cron: string;
  timeZone: string;
  windows: { days: string[]; from: string; to: string }[];
  jitterSeconds: number;
  quotas: PipelineScheduleRow['quotas'];
  retry: PipelineScheduleRow['retry'];
  concurrency: number;
  alerts: { kind: string; threshold: number; notify: string }[];
}
export type EffectReservation = 'proceed' | 'skip' | 'dry' | 'stop';
export type RoleCharge = 'charged' | 'exhausted' | 'dry';

export const pipelines = {
  create(trx: Transaction, ctx: CommandContext, hubId: string, kind: string, name: string): Promise<PipelineRow> {
    return one(sql<PipelineRow>`SELECT * FROM trustwork.pipelines_create(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${kind}::text, ${name}::text)`, trx, 'pipelines_create');
  },
  draftVersion(trx: Transaction, ctx: CommandContext, pipelineId: string, input: DraftPipelineVersionInput): Promise<PipelineVersionRow> {
    return one(sql<PipelineVersionRow>`SELECT * FROM trustwork.pipelines_draft_version(${ctxJson(ctx)}::jsonb, ${pipelineId}::uuid, ${json(input)}::jsonb)`, trx, 'pipelines_draft_version');
  },
  activateVersion(trx: Transaction, ctx: CommandContext, versionId: string): Promise<PipelineVersionRow> {
    return one(sql<PipelineVersionRow>`SELECT * FROM trustwork.pipelines_activate_version(${ctxJson(ctx)}::jsonb, ${versionId}::uuid)`, trx, 'pipelines_activate_version');
  },
  setSchedule(trx: Transaction, ctx: CommandContext, pipelineId: string, expectedRevision: number, input: PipelineScheduleInput): Promise<PipelineScheduleRow> {
    return one(sql<PipelineScheduleRow>`SELECT * FROM trustwork.pipelines_set_schedule(${ctxJson(ctx)}::jsonb, ${pipelineId}::uuid, ${expectedRevision}::int, ${json(input)}::jsonb)`,
      trx, 'pipelines_set_schedule');
  },
  pauseSchedule(trx: Transaction, ctx: CommandContext, scheduleId: string, expectedRevision: number, pause: boolean, reason: string | null): Promise<PipelineScheduleRow> {
    return one(sql<PipelineScheduleRow>`SELECT * FROM trustwork.pipelines_pause_schedule(${ctxJson(ctx)}::jsonb, ${scheduleId}::uuid, ${expectedRevision}::int, ${pause}::boolean, ${reason}::text)`,
      trx, 'pipelines_pause_schedule');
  },
  setRoleCap(trx: Transaction, ctx: CommandContext, hubId: string, role: string, currency: string, dailyCapMinor: string): Promise<PipelineRoleCapRow> {
    return one(sql<PipelineRoleCapRow>`SELECT * FROM trustwork.pipelines_set_role_cap(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${role}::text, ${currency}::text, ${dailyCapMinor}::bigint)`,
      trx, 'pipelines_set_role_cap');
  },
  startRun(trx: Transaction, ctx: CommandContext, versionId: string, trigger: 'manual' | 'dry_run' | 'backfill', backfillFrom: string | null): Promise<PipelineRunRow> {
    return one(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_start_run(${ctxJson(ctx)}::jsonb, ${versionId}::uuid, ${trigger}::text, ${backfillFrom}::timestamptz)`, trx, 'pipelines_start_run');
  },
  cancelRun(trx: Transaction, ctx: CommandContext, runId: string): Promise<PipelineRunRow> {
    return one(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_cancel_run(${ctxJson(ctx)}::jsonb, ${runId}::uuid)`, trx, 'pipelines_cancel_run');
  },
  decideAlert(trx: Transaction, ctx: CommandContext, alertId: string, state: 'acknowledged' | 'resolved'): Promise<PipelineAlertRow> {
    return one(sql<PipelineAlertRow>`SELECT * FROM trustwork.pipelines_decide_alert(${ctxJson(ctx)}::jsonb, ${alertId}::uuid, ${state}::text)`, trx, 'pipelines_decide_alert');
  },

  /* ---------- Reads (row-level security: staff of the hub) ---------- */
  list(trx: Transaction, hubId: string): Promise<PipelineRow[]> {
    return trx.selectFrom('pipeline').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  get(trx: Transaction, pipelineId: string): Promise<PipelineRow | undefined> {
    return trx.selectFrom('pipeline').selectAll().where('id', '=', pipelineId).executeTakeFirst();
  },
  versions(trx: Transaction, pipelineId: string): Promise<PipelineVersionRow[]> {
    return trx.selectFrom('pipeline_version').selectAll().where('pipeline_id', '=', pipelineId).orderBy('version', 'desc').execute();
  },
  version(trx: Transaction, versionId: string): Promise<PipelineVersionRow | undefined> {
    return trx.selectFrom('pipeline_version').selectAll().where('id', '=', versionId).executeTakeFirst();
  },
  schedule(trx: Transaction, pipelineId: string): Promise<PipelineScheduleRow | undefined> {
    return trx.selectFrom('pipeline_schedule').selectAll().where('pipeline_id', '=', pipelineId).executeTakeFirst();
  },
  runs(trx: Transaction, pipelineId: string, limit = 50): Promise<PipelineRunRow[]> {
    return trx.selectFrom('pipeline_run').selectAll().where('pipeline_id', '=', pipelineId).orderBy('queued_at', 'desc').orderBy('id').limit(Math.min(Math.max(limit, 1), 200)).execute();
  },
  run(trx: Transaction, runId: string): Promise<PipelineRunRow | undefined> {
    return trx.selectFrom('pipeline_run').selectAll().where('id', '=', runId).executeTakeFirst();
  },
  effects(trx: Transaction, runId: string): Promise<PipelineEffectRow[]> {
    return trx.selectFrom('pipeline_effect').selectAll().where('run_id', '=', runId).orderBy('reserved_at').orderBy('id').execute();
  },
  alerts(trx: Transaction, hubId: string): Promise<PipelineAlertRow[]> {
    return trx.selectFrom('pipeline_alert').selectAll().where('hub_id', '=', hubId).orderBy('last_at', 'desc').orderBy('id').execute();
  },
  roleCaps(trx: Transaction, hubId: string): Promise<PipelineRoleCapRow[]> {
    return trx.selectFrom('pipeline_role_cap').selectAll().where('hub_id', '=', hubId).orderBy('role').execute();
  },
};

/** Worker entry points (trustwork_worker). Every call after leasing is fenced by the run's lease token. */
export const pipelineWorker = {
  dueSchedules(trx: Transaction): Promise<PipelineScheduleRow[]> {
    return sql<PipelineScheduleRow>`SELECT * FROM trustwork.pipelines_due_schedules()`.execute(trx).then((r) => r.rows);
  },
  enqueueScheduled(trx: Transaction, scheduleId: string, dueAt: Date, inWindow: boolean): Promise<PipelineRunRow | null> {
    return maybe(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_enqueue_scheduled(${scheduleId}::uuid, ${dueAt.toISOString()}::timestamptz, ${inWindow}::boolean)`, trx);
  },
  lease(trx: Transaction, owner: string, leaseSeconds: number): Promise<PipelineRunRow | null> {
    return maybe(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_lease_run(${owner}::text, ${leaseSeconds}::int)`, trx);
  },
  runVersion(trx: Transaction, runId: string, token: string): Promise<PipelineVersionRow> {
    return one(sql<PipelineVersionRow>`SELECT * FROM trustwork.pipelines_run_version(${runId}::uuid, ${token}::bigint)`, trx, 'pipelines_run_version');
  },
  stepBoundary(trx: Transaction, runId: string, token: string, leaseSeconds: number): Promise<'continue' | 'stop'> {
    return scalar(sql<{ v: 'continue' | 'stop' }>`SELECT trustwork.pipelines_step_boundary(${runId}::uuid, ${token}::bigint, ${leaseSeconds}::int) AS v`, trx);
  },
  reserveEffect(trx: Transaction, runId: string, token: string, effectKey: string, kind: 'outreach_touch' | 'notification' | 'model_call' | 'other'): Promise<EffectReservation> {
    return scalar(sql<{ v: EffectReservation }>`SELECT trustwork.pipelines_reserve_effect(${runId}::uuid, ${token}::bigint, ${effectKey}::text, ${kind}::text) AS v`, trx);
  },
  settleEffect(trx: Transaction, runId: string, token: string, effectKey: string, outcome: 'succeeded' | 'failed' | 'unknown', costMinor: string): Promise<void> {
    return sql`SELECT trustwork.pipelines_settle_effect(${runId}::uuid, ${token}::bigint, ${effectKey}::text, ${outcome}::text, ${costMinor}::bigint)`.execute(trx).then(() => undefined);
  },
  chargeRole(trx: Transaction, runId: string, token: string, role: string, amountMinor: string): Promise<RoleCharge> {
    return scalar(sql<{ v: RoleCharge }>`SELECT trustwork.pipelines_charge_role(${runId}::uuid, ${token}::bigint, ${role}::text, ${amountMinor}::bigint) AS v`, trx);
  },
  finish(trx: Transaction, runId: string, token: string, state: 'succeeded' | 'partially_succeeded' | 'failed' | 'skipped_budget', counts: PipelineCountsJson, errorCode: string | null): Promise<PipelineRunRow> {
    return one(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_finish_run(${runId}::uuid, ${token}::bigint, ${state}::text, ${json(counts)}::jsonb, ${errorCode}::text)`, trx, 'pipelines_finish_run');
  },
  expireLeases(trx: Transaction): Promise<number> {
    return scalar(sql<{ v: number }>`SELECT trustwork.pipelines_expire_leases() AS v`, trx);
  },
  queueRetry(trx: Transaction, runId: string): Promise<PipelineRunRow | null> {
    return maybe(sql<PipelineRunRow>`SELECT * FROM trustwork.pipelines_queue_retry(${runId}::uuid)`, trx);
  },
  sourceChanged(trx: Transaction, sourceId: string, reason: 'robots' | 'terms' | 'licence' | 'error_streak' | 'takedown'): Promise<number> {
    return scalar(sql<{ v: number }>`SELECT trustwork.pipelines_source_changed(${sourceId}::uuid, ${reason}::text) AS v`, trx);
  },
  /** Failed real runs still within their retry policy, oldest first, with the policy for the backoff. */
  retryCandidates(trx: Transaction, limit = 20): Promise<{ run_id: string; finished_at: Date; attempt: number; retry: PipelineScheduleRow['retry'] | null }[]> {
    return sql<{ run_id: string; finished_at: Date; attempt: number; retry: PipelineScheduleRow['retry'] | null }>`SELECT * FROM trustwork.pipelines_retry_candidates(${limit}::int)`.execute(trx).then((r) => r.rows);
  },
};
