import type { AccessInventory } from '../inventory.js';
export default {
  package: 'BILL-003',
  forcedTables: ['billing_fee_scope', 'billing_fee_disclosure', 'billing_fee_confirmation', 'billing_fee_binding'],
  apiDefiners: ['billing_fee_draft', 'billing_fee_activate', 'billing_fee_list', 'billing_fee_disclose', 'billing_fee_confirm', 'billing_fee_bind'],
  workerDefiners: [],
} satisfies AccessInventory;
