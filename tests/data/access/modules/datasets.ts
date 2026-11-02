import type { AccessInventory } from '../inventory.js';

/**
 * MINE-001 (packages/data/migrations/datasets): datasets, operator licences, records with provenance, the
 * do-not-collect list and tombstones.
 */
export default {
  package: 'MINE-001',
  forcedTables: ['dataset', 'dataset_do_not_collect', 'dataset_licence', 'dataset_record', 'dataset_tombstone'],
  apiDefiners: [
    'datasets_propose', 'datasets_activate', 'datasets_set_status', 'datasets_record_licence', 'datasets_set_contact_use', 'datasets_mark_contact',
    'datasets_add_do_not_collect', 'datasets_ingest', 'datasets_staff_reader', 'datasets_contact_points',
  ],
  workerDefiners: ['datasets_worker_ingest', 'datasets_sweep'],
} satisfies AccessInventory;
