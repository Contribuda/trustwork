import type { AccessInventory } from '../inventory.js';

/** SUP-001 (packages/data/migrations/support): support access records, account servicing actions and diagnostic snapshots. */
export default {
  package: 'SUP-001',
  forcedTables: ['account_service_action', 'support_access_record', 'support_diagnostic_snapshot'],
  apiDefiners: ['support_lookup', 'support_account_card', 'support_explain_inputs', 'support_request_action', 'support_activate_action', 'support_execute_action',
    'support_cancel_action', 'support_cancel_own_action', 'support_action_addresses', 'support_action_masked_email', 'support_own_access_records', 'support_share_diagnostics'],
} satisfies AccessInventory;
