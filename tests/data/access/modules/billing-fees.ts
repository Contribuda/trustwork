import type { AccessInventory } from '../inventory.js';
export default {
  package: 'BILL-003',
  forcedTables: ['billing_fee_scope', 'billing_fee_disclosure', 'billing_fee_confirmation', 'billing_fee_binding', 'billing_consultation_origin', 'billing_task_origin'],
  apiDefiners: ['billing_fee_draft', 'billing_fee_activate', 'billing_fee_list', 'billing_fee_hub_available', 'billing_fee_disclose', 'billing_fee_confirm', 'billing_fee_bind', 'billing_consultation_origin', 'billing_consultation_quote', 'billing_consultation_proposed', 'billing_consultation_confirm', 'billing_task_origin', 'billing_task_disclose', 'billing_task_confirm'],
  workerDefiners: [],
  internalDefiners: ['billing_consultation_booking_guard', 'billing_task_agreement_guard'],
} satisfies AccessInventory;
