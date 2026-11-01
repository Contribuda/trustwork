import type { AccessInventory } from '../inventory.js';

/**
 * SRC-001 (packages/data/migrations/sources): the hub source registry, crawl policies, the sponsored content policy,
 * import batches and items, sourced record fields, record link proposals, takedowns and tombstones.
 */
export default {
  package: 'SRC-001',
  forcedTables: ['crawl_policy', 'import_batch', 'record_link_proposal', 'source', 'source_item', 'source_takedown', 'source_tombstone', 'sourced_record_field', 'sponsored_content_policy'],
  apiDefiners: [
    'sources_prepare_policy_check', 'sources_prepare_assist',
    'sources_register', 'sources_set_terms', 'sources_record_terms', 'sources_record_robots', 'sources_record_rsl', 'sources_set_status', 'sources_takedown', 'sources_stage_batch',
    'sources_decide_batch', 'sources_item_egress', 'sources_record_assist', 'sources_decide_item', 'sources_propose_link', 'sources_decide_link', 'sources_set_sponsored_policy',
    'sources_staff_reader', 'sources_item_effective_uses', 'sources_public_provenance', 'sources_sponsored_slot',
  ],
  workerDefiners: ['sources_recommendable_items', 'sources_peer_export'],
} satisfies AccessInventory;
