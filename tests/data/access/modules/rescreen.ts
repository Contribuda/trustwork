import type { AccessInventory } from '../inventory.js';

/** SANC-005 (packages/data/migrations/rescreen): re-screening runs and their items. */
export default {
  package: 'SANC-005',
  forcedTables: ['screening_rescreen_item', 'screening_rescreen_run'],
  apiDefiners: ['screening_rescreen_request_manual'],
  workerDefiners: ['screening_rescreen_request', 'screening_rescreen_promote', 'screening_rescreen_lock', 'screening_rescreen_subjects', 'screening_rescreen_versions',
    'screening_rescreen_entries', 'screening_rescreen_record_delta', 'screening_rescreen_record_items', 'screening_rescreen_advance', 'screening_rescreen_fail',
    'screening_rescreen_watch', 'screening_rescreen_progress'],
} satisfies AccessInventory;
