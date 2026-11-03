import type { AccessInventory } from '../inventory.js';

/** PRC-004 (packages/data/migrations/sourcing): sealed-until-deadline RFQs. */
export default {
  package: 'PRC-004',
  forcedTables: [],
  apiDefiners: ['sourcing_sealed_until', 'sourcing_sealed', 'sourcing_round_closed'],
} satisfies AccessInventory;
