import type { AccessInventory } from '../inventory.js';
export default {
  package: 'PAY-001',
  forcedTables: ['payment_source', 'payment_rail', 'payment_intent', 'payment_operation', 'payment_receipt', 'payment_source_registration', 'payment_adapter_activation', 'payment_source_challenge',
    'payment_identity_link_version', 'payment_participant_binding_version', 'payment_account_evidence', 'payment_account_binding_version',
    'payment_binding_review', 'payment_authorization_version', 'payment_authorization_acceptance', 'payment_source_version', 'payment_source_current'],
  apiDefiners: ['payments_request', 'payments_read', 'payments_action', 'payments_source_challenge', 'payments_source_own_bindings', 'payments_source_review_material',
    'payments_accept_source_binding', 'payments_authorization_view', 'payments_draft_authorization', 'payments_accept_authorization', 'payments_revoke_source', 'payments_staff_revoke_source'],
  internalDefiners: ['payments_receipt', 'payments_source_verifier_registration', 'payments_source_record_assertion', 'payments_propose_source_adapter', 'payments_activate_source_adapter'],
  workerDefiners: ['payments_expire_customer_action', 'payments_attach_job', 'payments_instruction', 'payments_begin', 'payments_dispatch_guard', 'payments_reconcile_due', 'payments_reconcile_recorded'],
} satisfies AccessInventory;
