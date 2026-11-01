import type { AccessInventory } from '../inventory.js';

/**
 * PIPE-001 (packages/data/migrations/pipelines): pipelines, versions, schedules, per-role caps, runs, the external-effect
 * ledger and alerts.
 */
export default {
  package: 'PIPE-001',
  forcedTables: ['pipeline', 'pipeline_alert', 'pipeline_effect', 'pipeline_role_cap', 'pipeline_run', 'pipeline_schedule', 'pipeline_version'],
  apiDefiners: [
    'pipelines_create', 'pipelines_draft_version', 'pipelines_activate_version', 'pipelines_set_schedule', 'pipelines_pause_schedule', 'pipelines_set_role_cap',
    'pipelines_start_run', 'pipelines_cancel_run', 'pipelines_decide_alert', 'pipelines_reader',
  ],
  workerDefiners: [
    'pipelines_enqueue_scheduled', 'pipelines_lease_run', 'pipelines_step_boundary', 'pipelines_reserve_effect', 'pipelines_settle_effect', 'pipelines_charge_role',
    'pipelines_finish_run', 'pipelines_expire_leases', 'pipelines_queue_retry', 'pipelines_retry_candidates', 'pipelines_source_changed', 'pipelines_due_schedules',
    'pipelines_run_version',
  ],
} satisfies AccessInventory;
