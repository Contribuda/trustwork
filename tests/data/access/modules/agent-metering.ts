import type { AccessInventory } from '../inventory.js';

export default {
  package: 'AGT-004',
  forcedTables: ['metered_subject', 'metered_cost_record', 'metered_price_term'],
  apiDefiners: ['billing_metered_record_cost', 'billing_metered_draft', 'billing_metered_activate', 'billing_metered_cancel', 'billing_metered_staff_list', 'billing_metered_public'],
  workerDefiners: [],
  internalDefiners: [],
} satisfies AccessInventory;
