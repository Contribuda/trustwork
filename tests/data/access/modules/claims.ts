import type { AccessInventory } from '../inventory.js';

/**
 * CLM-001 (packages/data/migrations/claims): company claims, disputes, hand-overs and claim settings.
 */
export default {
  package: 'CLM-001',
  forcedTables: ['claim_dispute', 'claims_settings', 'company_claim', 'company_handover'],
  apiDefiners: [
    'claims_submit', 'claims_withdraw', 'claims_decide', 'claims_propose_dispute', 'claims_confirm_dispute', 'claims_revoke', 'claims_set_settings', 'claims_staff_reader',
    'claims_cooling', 'claims_planned_deliveries', 'claims_active_recipes',
  ],
  workerDefiners: [],
} satisfies AccessInventory;
