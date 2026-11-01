import type { AccessInventory } from '../inventory.js';

/**
 * HUB-004 (packages/data/migrations/setup): the setup run of the node. The runtime role reads and writes it only through
 * these commands; token issuance (`setup_issue_token`) is an invoker function for the owner's maintenance session.
 */
export default {
  package: 'HUB-004',
  forcedTables: ['setup_run'],
  apiDefiners: ['setup_open', 'setup_save', 'setup_claim_admin', 'setup_bootstrap_admin', 'setup_begin_finish', 'setup_finish', 'setup_screening_lists', 'setup_screening_candidates'],
} satisfies AccessInventory;
