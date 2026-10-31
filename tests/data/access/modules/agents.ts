import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-001',
  forcedTables: [
    'goal', 'goal_progress', 'job_subscription', 'agent_report', 'company_representative', 'representative_accountability', 'company_mandate', 'negotiation_session',
    'agent_envelope', 'agent_envelope_sender', 'agent_envelope_receipt', 'agent_escalation',
  ],
  apiDefiners: [
    'agents_confirm_goal', 'agents_set_goal_status', 'agents_share_report', 'agents_configure_representative', 'agents_accept_representative', 'agents_suspend_representative',
    'agents_resume_representative', 'agents_disable_representative', 'agents_grant_company_mandate', 'agents_reconfirm_company_mandate', 'agents_revoke_company_mandate',
    'agents_resolve_escalation', 'agents_deliver_envelope',
  ],
  workerDefiners: ['agents_lapse_reconfirmations', 'agents_expire_sessions'],
  internalDefiners: ['agents_membership_changed'],
} satisfies AccessInventory;
