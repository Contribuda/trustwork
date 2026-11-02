import type { AccessInventory } from '../inventory.js';

/**
 * ADM-004 (packages/data/migrations/staff-lifecycle): the staff directory and the effective-access read. Part 1 adds no
 * table.
 */
export default {
  package: 'ADM-004',
  forcedTables: [],
  apiDefiners: ['staff_require_hub_staff', 'staff_directory', 'staff_effective_assignments'],
  workerDefiners: [],
} satisfies AccessInventory;
