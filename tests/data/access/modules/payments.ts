import type { AccessInventory } from '../inventory.js';
export default {
  package: 'PAY-001',
  forcedTables: ['payment_source', 'payment_rail', 'payment_intent', 'payment_operation', 'payment_receipt'],
  apiDefiners: ['payments_request', 'payments_read', 'payments_action'],
  workerDefiners: ['payments_attach_job', 'payments_instruction', 'payments_begin', 'payments_dispatch_guard', 'payments_receipt', 'payments_reconcile_due'],
} satisfies AccessInventory;
