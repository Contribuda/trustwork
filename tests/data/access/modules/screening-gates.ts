import type { AccessInventory } from '../inventory.js';

/** SANC-004 (packages/data/migrations/screening-gates): the money and commitment gates' read and own-place declarations. No table. */
export default {
  package: 'SANC-004',
  forcedTables: [],
  apiDefiners: ['screening_gate_check', 'screening_gate_declare_place'],
  workerDefiners: [],
} satisfies AccessInventory;
