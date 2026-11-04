import type { AccessInventory } from '../inventory.js';

/** PRC-004 (packages/data/migrations/sourcing): sealed RFQs, levelling sheets and eligibility rules. */
export default {
  package: 'PRC-004',
  forcedTables: ['bid_level_sheet', 'bid_level_sheet_version', 'sourcing_eligibility_rule_set'],
  apiDefiners: ['sourcing_sealed_until', 'sourcing_sealed', 'sourcing_round_closed', 'sourcing_rfq_reader', 'sourcing_rfq_runner', 'sourcing_open_draft', 'sourcing_save_draft', 'sourcing_freeze_sheet', 'sourcing_save_eligibility'],
} satisfies AccessInventory;
