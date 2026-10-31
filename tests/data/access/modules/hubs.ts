import type { AccessInventory } from '../inventory.js';

/**
 * HUB-001 (packages/data/migrations/hubs): hub profiles, configuration versions and the current pointer, launch gates,
 * legal documents with counsel approvals and acceptances, provider credential references and the retention policy.
 */
export default {
  package: 'HUB-001',
  forcedTables: ['counsel_approval', 'hub_config_current', 'hub_config_version', 'hub_profile', 'launch_gate', 'legal_acceptance', 'legal_document_version', 'provider_credential_ref', 'retention_policy'],
  apiDefiners: [
    'hubs_create', 'hubs_update_profile', 'hubs_add_territory', 'hubs_remove_territory', 'hubs_draft_config', 'hubs_cancel_config', 'hubs_activate_config', 'hubs_check_gate',
    'hubs_invalidate_gate', 'hubs_transition', 'hubs_draft_legal_document', 'hubs_record_counsel_approval', 'hubs_activate_legal_document', 'hubs_accept_legal_document',
    'hubs_register_credential', 'hubs_activate_credential', 'hubs_retire_credential', 'hubs_staff_reader', 'hubs_version_current', 'hubs_transition_blockers',
    'hubs_gate_preconditions', 'hubs_public_config',
  ],
} satisfies AccessInventory;
