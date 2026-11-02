import type { AccessInventory } from '../inventory.js';

/**
 * HUB-003 (packages/data/migrations/verification): verification providers, recipes and append-only check results.
 */
export default {
  package: 'HUB-003',
  forcedTables: ['verification_check', 'verification_provider', 'verification_recipe'],
  apiDefiners: [
    'verification_register_provider', 'verification_go_live', 'verification_draft_recipe', 'verification_activate_recipe', 'verification_record_check',
    'verification_record_screening', 'verification_evaluate', 'verification_staff_reader',
  ],
  workerDefiners: ['verification_due_rechecks'],
} satisfies AccessInventory;
