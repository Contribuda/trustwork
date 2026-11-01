import type { AccessInventory } from '../inventory.js';

/** SANC-006 additive list authority; original SANC-002 objects remain in their existing inventory. */
export default {
  package: 'SANC-002',
  forcedTables: ['screening_list_proposal', 'screening_list_source'],
  apiDefiners: ['screening_list_decide', 'screening_list_propose'],
  workerDefiners: ['screening_list_source_current'],
} satisfies AccessInventory;
