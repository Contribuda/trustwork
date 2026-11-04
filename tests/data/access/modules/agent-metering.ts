import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-004',
  forcedTables: ['metered_subject', 'metered_cost_record', 'metered_price_term', 'agent_quota_window', 'metered_step', 'agent_charge_period', 'agent_quota_notice', 'agent_credit_lot', 'agent_credit_use', 'agent_abuse_signal'],
  apiDefiners: [
    'billing_metered_record_cost', 'billing_metered_draft', 'billing_metered_activate', 'billing_metered_cancel', 'billing_metered_staff_list', 'billing_metered_public',
    'billing_plan_draft', 'billing_plan_activate',
    'billing_meter_admit', 'billing_meter_finish', 'billing_meter_estimate', 'billing_agent_plan_key', 'billing_agent_module_allowed', 'billing_meter_action_stop', 'billing_meter_reconcile', 'billing_agent_usage_stats', 'billing_abuse_list', 'billing_abuse_open_case',
  ],
  workerDefiners: ['billing_meter_sweep', 'billing_credit_notice_sweep', 'billing_abuse_sweep'],
  internalDefiners: ['billing_meter_intent_queued', 'billing_meter_intent_closed', 'billing_meter_model_begin', 'billing_meter_model_closed'],
} satisfies AccessInventory;
