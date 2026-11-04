import type { AccessInventory } from '../inventory.js';

/** PRC-004 (packages/data/migrations/sourcing): sealed RFQs, levelling sheets, eligibility rules, awards and outcome notices. */
export default {
  package: 'PRC-004',
  forcedTables: ['award_decision', 'bid_level_sheet', 'bid_level_sheet_version', 'bid_outcome_notice', 'sourcing_eligibility_rule_set'],
  apiDefiners: ['sourcing_sealed_until', 'sourcing_sealed', 'sourcing_round_closed', 'sourcing_rfq_reader', 'sourcing_rfq_runner', 'sourcing_open_draft', 'sourcing_save_draft', 'sourcing_freeze_sheet', 'sourcing_save_eligibility',
    'sourcing_sheet_approver', 'sourcing_award_required', 'sourcing_agreement_allowed', 'sourcing_propose_award', 'sourcing_award_enter_approval', 'sourcing_begin_execution', 'sourcing_complete_execution',
    'sourcing_cancel_award', 'sourcing_send_notices'],
} satisfies AccessInventory;
