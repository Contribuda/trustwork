import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Pipelines module (PIPE-001, packages/data/migrations/pipelines; docs/engine/hub-console/automation-and-scheduling.md):
 * versioned pipelines, their schedules, runs with leasing and fencing, the external-effect ledger that keeps a touch
 * with an unknown outcome from ever being sent twice, per-role daily caps and alerts. The runtime role reads under
 * row-level security (staff of the hub only) and writes only through the `pipelines_*` SECURITY DEFINER commands; the
 * worker uses the worker functions (repositories/pipelines.ts).
 */
export type PipelineRunState = 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled' | 'skipped_window' | 'skipped_budget' | 'stopped_by_kill_switch';
export type PipelineRunTrigger = 'schedule' | 'manual' | 'dry_run' | 'retry' | 'backfill' | 'event';
export type PipelineVersionStatus = 'draft' | 'active' | 'superseded' | 'paused';
export type PipelineEffectOutcome = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type PipelineCountsJson = { fetched: number; new: number; duplicates: number; skippedByLicence: number; skippedByRobots: number; proposed: number; failed: number };
export type PipelineStepJson = { kind: string; modelRouteId: string | null; modelJob: string | null; settings: Record<string, string | number | boolean> };

export interface PipelineTable {
  id: Generated<string>;
  hub_id: string;
  kind: string;
  name: string;
  created_by: string;
  created_at: Generated<Date>;
}
export type PipelineRow = Selectable<PipelineTable>;

export interface PipelineVersionTable {
  id: Generated<string>;
  pipeline_id: string;
  hub_id: string;
  version: number;
  name: string;
  source_ids: Generated<string[]>;
  dataset_id: string | null;
  steps: PipelineStepJson[];
  automation_level: 'manual' | 'assisted' | 'supervised_autonomous';
  budget_id: string | null;
  status: Generated<PipelineVersionStatus>;
  drafted_by: string;
  activated_by: string | null;
  activated_at: Date | null;
  created_at: Generated<Date>;
}
export type PipelineVersionRow = Selectable<PipelineVersionTable>;

export interface PipelineScheduleTable {
  id: Generated<string>;
  pipeline_id: string;
  hub_id: string;
  cron: string;
  time_zone: string;
  windows: Generated<{ days: string[]; from: string; to: string }[]>;
  jitter_seconds: Generated<number>;
  quotas: { maxItemsPerRun: number; maxRunsPerDay: number; maxCostPerRun: { minorUnits: string; currency: string } | null; maxRequestsPerMinutePerHost: number };
  retry: { maxAttempts: number; backoff: 'fixed' | 'exponential'; baseSeconds: number; maxDelaySeconds: number; retryOn: string[] };
  concurrency: Generated<number>;
  alerts: Generated<{ kind: string; threshold: number; notify: string }[]>;
  paused: Generated<boolean>;
  paused_by: string | null;
  paused_reason: string | null;
  paused_automatically: Generated<boolean>;
  last_due_at: Date | null;
  revision: Generated<number>;
  updated_by: string;
  updated_at: Generated<Date>;
}
export type PipelineScheduleRow = Selectable<PipelineScheduleTable>;

export interface PipelineRoleCapTable {
  id: Generated<string>;
  hub_id: string;
  role: string;
  currency: string;
  daily_cap_minor: string;
  spent_minor: Generated<string>;
  spent_day: Generated<Date>;
  updated_by: string;
}
export type PipelineRoleCapRow = Selectable<PipelineRoleCapTable>;

export interface PipelineRunTable {
  id: Generated<string>;
  hub_id: string;
  pipeline_id: string;
  pipeline_version_id: string;
  trigger: PipelineRunTrigger;
  dry_run: boolean;
  state: Generated<PipelineRunState>;
  attempt: Generated<number>;
  retry_of: string | null;
  triggered_by: string | null;
  schedule_id: string | null;
  due_at: Date | null;
  backfill_from: Date | null;
  queued_at: Generated<Date>;
  started_at: Date | null;
  finished_at: Date | null;
  counts: Generated<PipelineCountsJson>;
  cost_minor: Generated<string>;
  effects_committed: Generated<boolean>;
  error_code: string | null;
  lease_owner: string | null;
  lease_token: Generated<string>;
  leased_until: Date | null;
}
export type PipelineRunRow = Selectable<PipelineRunTable>;

export interface PipelineEffectTable {
  id: Generated<string>;
  hub_id: string;
  pipeline_id: string;
  run_id: string;
  effect_key: string;
  kind: 'outreach_touch' | 'notification' | 'model_call' | 'other';
  outcome: Generated<PipelineEffectOutcome>;
  cost_minor: Generated<string>;
  reserved_at: Generated<Date>;
  settled_at: Date | null;
}
export type PipelineEffectRow = Selectable<PipelineEffectTable>;

export interface PipelineAlertTable {
  id: Generated<string>;
  hub_id: string;
  pipeline_id: string;
  rule: 'failure_streak' | 'zero_items_streak' | 'cost_threshold' | 'duration_exceeded' | 'source_changed' | 'budget_exhausted';
  state: Generated<'open' | 'acknowledged' | 'resolved'>;
  detail: string;
  occurrences: Generated<number>;
  first_at: Generated<Date>;
  last_at: Generated<Date>;
  acknowledged_by: string | null;
  resolved_by: string | null;
}
export type PipelineAlertRow = Selectable<PipelineAlertTable>;

export interface PipelinesDatabase {
  pipeline: PipelineTable;
  pipeline_version: PipelineVersionTable;
  pipeline_schedule: PipelineScheduleTable;
  pipeline_role_cap: PipelineRoleCapTable;
  pipeline_run: PipelineRunTable;
  pipeline_effect: PipelineEffectTable;
  pipeline_alert: PipelineAlertTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends PipelinesDatabase {}
}

const columns = columnsOf<PipelinesDatabase>();
export const TABLE_COLUMNS: TableColumns<PipelinesDatabase> = {
  pipeline: columns('pipeline', ['id', 'hub_id', 'kind', 'name', 'created_by', 'created_at']),
  pipeline_version: columns('pipeline_version', [
    'id', 'pipeline_id', 'hub_id', 'version', 'name', 'source_ids', 'dataset_id', 'steps', 'automation_level', 'budget_id', 'status', 'drafted_by', 'activated_by', 'activated_at', 'created_at',
  ]),
  pipeline_schedule: columns('pipeline_schedule', [
    'id', 'pipeline_id', 'hub_id', 'cron', 'time_zone', 'windows', 'jitter_seconds', 'quotas', 'retry', 'concurrency', 'alerts', 'paused', 'paused_by', 'paused_reason',
    'paused_automatically', 'last_due_at', 'revision', 'updated_by', 'updated_at',
  ]),
  pipeline_role_cap: columns('pipeline_role_cap', ['id', 'hub_id', 'role', 'currency', 'daily_cap_minor', 'spent_minor', 'spent_day', 'updated_by']),
  pipeline_run: columns('pipeline_run', [
    'id', 'hub_id', 'pipeline_id', 'pipeline_version_id', 'trigger', 'dry_run', 'state', 'attempt', 'retry_of', 'triggered_by', 'schedule_id', 'due_at', 'backfill_from',
    'queued_at', 'started_at', 'finished_at', 'counts', 'cost_minor', 'effects_committed', 'error_code', 'lease_owner', 'lease_token', 'leased_until',
  ]),
  pipeline_effect: columns('pipeline_effect', ['id', 'hub_id', 'pipeline_id', 'run_id', 'effect_key', 'kind', 'outcome', 'cost_minor', 'reserved_at', 'settled_at']),
  pipeline_alert: columns('pipeline_alert', ['id', 'hub_id', 'pipeline_id', 'rule', 'state', 'detail', 'occurrences', 'first_at', 'last_at', 'acknowledged_by', 'resolved_by']),
};
