import type { AccessInventory } from '../inventory.js';

/**
 * MINE-001 (packages/data/migrations/datasets): datasets, operator licences, records with provenance, the
 * do-not-collect list and tombstones.
 */
export default {
  package: 'MINE-001',
  forcedTables: ['dataset', 'dataset_do_not_collect', 'dataset_licence', 'dataset_record', 'dataset_tombstone', 'entity_distinct_pair', 'entity_link_batch', 'entity_link_proposal'],
  apiDefiners: [
    'datasets_propose', 'datasets_activate', 'datasets_set_status', 'datasets_record_licence', 'datasets_set_contact_use', 'datasets_mark_contact',
    'datasets_add_do_not_collect', 'datasets_ingest', 'datasets_staff_reader', 'datasets_contact_points', 'datasets_resolve', 'datasets_propose_link', 'datasets_decide_link',
    'datasets_mark_distinct', 'datasets_batch_decide',
  ],
  workerDefiners: ['datasets_worker_ingest', 'datasets_sweep', 'datasets_worker_resolve'],
} satisfies AccessInventory;
