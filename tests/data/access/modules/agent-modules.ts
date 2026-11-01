import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-003',
  forcedTables: ['agent_mandate_provenance', 'agent_run_provenance', 'agent_intent_provenance', 'agent_job_occurrence', 'agent_occurrence_signal', 'agent_policy_version', 'agent_policy_current', 'agent_authz_epoch', 'agent_job_request', 'agent_job_schedule', 'agent_job_fire', 'agent_job_deadline', 'agent_serving_hub', 'agent_job_provenance', 'agent_mandate_usage'],
  apiDefiners: ['agent_modules_bind_mandate', 'agent_modules_preview_snapshot', 'agent_modules_bind_run', 'agents_own_goal_report_sections', 'agent_modules_request_occurrence', 'agent_modules_bind_request', 'agent_modules_staff_reader', 'agent_modules_dispatch_refusal', 'agent_modules_preview_counts', 'agent_modules_record_draft', 'agent_modules_request_run'],
  workerDefiners: ['agent_modules_consume_schedule', 'agent_modules_start_occurrence', 'agent_modules_execute_occurrence', 'agent_modules_consume_signal', 'agent_modules_deadline_tick', 'agent_modules_due_jobs', 'agent_modules_record_fire', 'agent_modules_sync_goal_deadlines'],
  internalDefiners: ['agent_modules_dispatch_refusal_internal', 'agent_modules_occurrence_run_provenance', 'agent_modules_intent_provenance', 'agent_modules_begin_proven_attempt', 'agent_modules_source_signal',
    'agent_modules_on_kill_switch', 'agent_modules_on_participant_stop', 'agent_modules_on_representative', 'agent_modules_on_connection', 'agent_modules_on_policy_activation',
    'agent_modules_on_proposal', 'agent_modules_goal_progress_event', 'agent_modules_invalidate_deadlines', 'agent_modules_record_usage',
  ],
} satisfies AccessInventory;
