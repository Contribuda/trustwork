import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-003',
  forcedTables: ['agent_policy_version', 'agent_policy_current', 'agent_authz_epoch', 'agent_job_request', 'agent_job_schedule', 'agent_job_fire', 'agent_job_deadline', 'agent_serving_hub', 'agent_job_provenance', 'agent_mandate_usage'],
  apiDefiners: ['agent_modules_bind_request', 'agent_modules_staff_reader', 'agent_modules_dispatch_refusal', 'agent_modules_preview_counts', 'agent_modules_record_draft', 'agent_modules_request_run'],
  workerDefiners: ['agent_modules_due_jobs', 'agent_modules_record_fire', 'agent_modules_sync_goal_deadlines'],
  internalDefiners: [
    'agent_modules_on_kill_switch', 'agent_modules_on_participant_stop', 'agent_modules_on_representative', 'agent_modules_on_connection', 'agent_modules_on_policy_activation',
    'agent_modules_on_proposal', 'agent_modules_goal_progress_event', 'agent_modules_invalidate_deadlines', 'agent_modules_record_usage',
  ],
} satisfies AccessInventory;
