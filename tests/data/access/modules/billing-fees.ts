import type { AccessInventory } from '../inventory.js';
export default {
  package: 'BILL-003',
  forcedTables: ['price_sale_terms', 'price_sale_activation', 'referral_terms_version', 'billing_fee_legacy_source', 'billing_fee_scope', 'billing_fee_disclosure', 'billing_fee_confirmation', 'billing_fee_binding', 'billing_consultation_origin', 'billing_task_origin'],
  apiDefiners: ['billing_sale_price_draft', 'billing_sale_price_activate', 'billing_sale_price_list', 'billing_sale_price_staff_list', 'billing_fee_staff_list', 'billing_referral_draft', 'billing_referral_activate', 'billing_referral_withdraw', 'billing_referral_list', 'billing_referral_staff_list', 'billing_fee_draft', 'billing_fee_activate', 'billing_fee_list', 'billing_fee_hub_available', 'billing_fee_disclose', 'billing_fee_confirm', 'billing_fee_bind', 'billing_consultation_origin', 'billing_consultation_quote', 'billing_consultation_proposed', 'billing_consultation_confirm', 'billing_task_origin', 'billing_task_disclose', 'billing_task_confirm', 'billing_task_legacy_proceeds'],
  workerDefiners: [],
  internalDefiners: ['billing_consultation_confirm_versioned', 'billing_consultation_agreement_guard', 'billing_consultation_booking_guard', 'billing_task_agreement_guard'],
} satisfies AccessInventory;
