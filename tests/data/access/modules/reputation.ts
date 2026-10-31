import type { AccessInventory } from '../inventory.js';

/** REP-001 (packages/data/migrations/reputation): the reputation builder. */
export default {
  package: 'REP-001',
  forcedTables: ['automated_limitation', 'confirmation_request', 'confirmation_response', 'contribution_record', 'credential_check', 'portfolio_entry', 'professional_credential',
    'relation_declaration', 'timeliness_observation'],
  apiDefiners: ['reputation_appeal_limitation', 'reputation_appeal_states', 'reputation_derive', 'reputation_file_appeal', 'reputation_public_credentials', 'reputation_public_portfolio',
    'reputation_request_refusal', 'reputation_response_refusal', 'reputation_took_part'],
} satisfies AccessInventory;
