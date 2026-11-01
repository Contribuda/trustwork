import type { PipelineAlertRow, PipelineEffectRow, PipelineRoleCapRow, PipelineRow, PipelineRunRow, PipelineScheduleRow, PipelineVersionRow } from './deps.js';

/** Response projections of the pipeline routes: camelCase, timestamps as ISO strings, money as minor-unit strings. */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export const toPipeline = (r: PipelineRow) => ({ id: r.id, hubId: r.hub_id, kind: r.kind, name: r.name, createdBy: r.created_by, createdAt: iso(r.created_at) });
export const toVersion = (r: PipelineVersionRow) => ({
  id: r.id, pipelineId: r.pipeline_id, hubId: r.hub_id, version: r.version, name: r.name, sourceIds: r.source_ids, datasetId: r.dataset_id, steps: r.steps, automationLevel: r.automation_level,
  budgetId: r.budget_id, status: r.status, draftedBy: r.drafted_by, activatedBy: r.activated_by, activatedAt: iso(r.activated_at), createdAt: iso(r.created_at),
});
export const toSchedule = (r: PipelineScheduleRow) => ({
  id: r.id, pipelineId: r.pipeline_id, hubId: r.hub_id, cron: r.cron, timeZone: r.time_zone, windows: r.windows, jitterSeconds: r.jitter_seconds, quotas: r.quotas, retry: r.retry,
  concurrency: r.concurrency, alerts: r.alerts, paused: r.paused, pausedBy: r.paused_by, pausedReason: r.paused_reason, pausedAutomatically: r.paused_automatically,
  lastDueAt: iso(r.last_due_at), revision: r.revision, updatedAt: iso(r.updated_at),
});
export const toRun = (r: PipelineRunRow) => ({
  id: r.id, pipelineId: r.pipeline_id, pipelineVersionId: r.pipeline_version_id, hubId: r.hub_id, trigger: r.trigger, dryRun: r.dry_run, state: r.state, attempt: r.attempt,
  retryOf: r.retry_of, triggeredBy: r.triggered_by, scheduleId: r.schedule_id, dueAt: iso(r.due_at), backfillFrom: iso(r.backfill_from), queuedAt: iso(r.queued_at),
  startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), counts: r.counts, costMinor: String(r.cost_minor), effectsCommitted: r.effects_committed, errorCode: r.error_code,
});
export const toEffect = (r: PipelineEffectRow) => ({ id: r.id, effectKey: r.effect_key, kind: r.kind, outcome: r.outcome, costMinor: String(r.cost_minor), reservedAt: iso(r.reserved_at), settledAt: iso(r.settled_at) });
export const toAlert = (r: PipelineAlertRow) => ({
  id: r.id, pipelineId: r.pipeline_id, rule: r.rule, state: r.state, detail: r.detail, occurrences: r.occurrences, firstAt: iso(r.first_at), lastAt: iso(r.last_at),
  acknowledgedBy: r.acknowledged_by, resolvedBy: r.resolved_by,
});
export const toRoleCap = (r: PipelineRoleCapRow) => ({ id: r.id, role: r.role, currency: r.currency, dailyCapMinor: String(r.daily_cap_minor), spentMinor: String(r.spent_minor), spentDay: iso(r.spent_day)?.slice(0, 10) ?? null });
