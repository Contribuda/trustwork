import type { AccessInventory } from '../inventory.js';
export default {
  package: 'SANC-007',
  forcedTables: ['screening_appeal_assignment'],
  internalDefiners: ['screening_route_appeal', 'screening_hold_notice', 'screening_match_notice'],
} satisfies AccessInventory;
