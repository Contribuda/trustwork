import type { AccessInventory } from '../inventory.js';

/** PRC-003 (packages/data/migrations/supplier-base): external counterparties, supplier records and assessments. */
export default {
  package: 'PRC-003',
  forcedTables: ['external_counterparty', 'supplier_assessment', 'supplier_record'],
  apiDefiners: ['supplier_base_member', 'supplier_base_may_manage', 'supplier_base_create_counterparty', 'supplier_base_update_counterparty', 'supplier_base_create_record',
    'supplier_base_update_record', 'supplier_base_link_claimed', 'supplier_base_draft_assessment', 'supplier_base_record_assessment', 'supplier_base_shared_assessments',
    'supplier_base_respond'],
} satisfies AccessInventory;
