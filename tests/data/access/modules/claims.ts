import type { AccessInventory } from '../inventory.js';

/**
 * CLM-001 (packages/data/migrations/claims): company claims, disputes, hand-overs and claim settings.
 */
export default {
  package: 'CLM-001',
  forcedTables: ['claim_dispute', 'claims_settings', 'company_claim', 'company_claim_evidence', 'company_handover', 'company_verification'],
  ],
  workerDefiners: ['claims_run_expiry'],
  internalDefiners: ['claims_membership_ended'],
} satisfies AccessInventory;
