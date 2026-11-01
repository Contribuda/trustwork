import type { AccessInventory } from '../inventory.js';
export default {
  package: 'SANC-007',
  forcedTables: ['screening_appeal_assignment', 'screening_notice_authority', 'screening_appeal_routing_history', 'screening_appeal_routing_current'],
  apiDefiners: ['screening_appeal_assignment_view', 'screening_reassign_appeal'],
  workerDefiners: ['screening_notice_allowed'],
  internalDefiners: ['screening_route_appeal', 'screening_hold_notice', 'screening_match_notice', 'screening_appeal_routing_init'],
} satisfies AccessInventory;
