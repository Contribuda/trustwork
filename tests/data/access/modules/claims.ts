import type { AccessInventory } from '../inventory.js';

/**
 * CLM-001 (packages/data/migrations/claims): company claims, disputes, hand-overs and claim settings.
 */
export default {
  package: 'CLM-001',
  forcedTables: [
    'claim_dispute', 'claims_settings', 'company_branch', 'company_claim', 'company_claim_evidence', 'company_handover', 'company_identifier', 'company_profile', 'company_registration',
    'company_verification', 'tax_registration',
  ],
  apiDefiners: [
    'claims_submit', 'claims_withdraw', 'claims_decide', 'claims_propose_dispute', 'claims_confirm_dispute', 'claims_revoke', 'claims_set_settings', 'claims_staff_reader',
    'claims_cooling', 'claims_planned_deliveries', 'claims_active_recipes', 'claims_bind_evidence', 'claims_recheck', 'claims_public_badges',
    'claims_record_add', 'claims_record_retire', 'claims_set_profile', 'claims_staff_record_add', 'claims_verify_identifier', 'claims_public_records', 'claims_company_records', 'claims_staff_records',
  ],
  workerDefiners: ['claims_run_expiry'],
  internalDefiners: ['claims_membership_ended', 'claims_legacy_identifiers'],
} satisfies AccessInventory;
