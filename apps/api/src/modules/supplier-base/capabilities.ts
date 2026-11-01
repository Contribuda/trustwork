/**
 * Agent parity (ADR 010 decision 23) for this module: every HTTP operation names the capability registry entry it
 * serves. The entries of `packages/contracts/src/supply/capabilities.ts` (PRC-000) are served as they are; the
 * operations the design table does not list yet are proposed below for PRC-023, which registers capabilities in the
 * runtime registry. The interface and the agent call the same use case with the same checks.
 */
export interface SupplierBaseOperation {
  route: string;
  /** Registry entry declared by PRC-000, or null when proposed below. */
  capabilityId: string | null;
  proposed?: string;
}

export const SUPPLIER_BASE_CAPABILITY_OPERATIONS: readonly SupplierBaseOperation[] = [
  { route: 'GET /v1/supplier-base/suppliers', capabilityId: 'procurement.list_documents' },
  { route: 'GET /v1/supplier-base/suppliers/:id', capabilityId: 'procurement.list_documents' },
  { route: 'GET /v1/supplier-base/suppliers/:id/card', capabilityId: null, proposed: 'procurement.view_supplier_card' },
  { route: 'POST /v1/supplier-base/suppliers', capabilityId: 'procurement.maintain_supplier' },
  { route: 'GET /v1/supplier-base/counterparties', capabilityId: null, proposed: 'procurement.list_counterparties' },
  { route: 'GET /v1/supplier-base/counterparties/:id', capabilityId: null, proposed: 'procurement.list_counterparties' },
  { route: 'POST /v1/supplier-base/counterparties', capabilityId: null, proposed: 'procurement.maintain_counterparty' },
  { route: 'POST /v1/supplier-base/counterparties/:id', capabilityId: null, proposed: 'procurement.maintain_counterparty' },
  { route: 'GET /v1/supplier-base/suppliers/:id/assessments', capabilityId: null, proposed: 'procurement.list_supplier_assessments' },
  { route: 'POST /v1/supplier-base/suppliers/:id/assessments', capabilityId: 'procurement.draft_supplier_assessment' },
  { route: 'POST /v1/supplier-base/assessments/:id/record', capabilityId: 'procurement.record_supplier_assessment' },
  { route: 'GET /v1/supplier-base/import/template', capabilityId: null, proposed: 'procurement.import_suppliers' },
  { route: 'POST /v1/supplier-base/import', capabilityId: null, proposed: 'procurement.import_suppliers' },
  { route: 'GET /v1/supplier-base/shared-assessments', capabilityId: null, proposed: 'sales.view_shared_assessments' },
  { route: 'POST /v1/supplier-base/shared-assessments/:id/respond', capabilityId: null, proposed: 'sales.respond_to_assessment' },
];

/** Registry entries to add (PRC-023): kind, mandate action and default confirmation, in the vocabulary of the supply table. */
export const PROPOSED_SUPPLIER_BASE_CAPABILITIES = [
  { id: 'procurement.view_supplier_card', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/suppliers' },
  { id: 'procurement.list_counterparties', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/suppliers' },
  { id: 'procurement.list_supplier_assessments', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/suppliers' },
  { id: 'procurement.maintain_counterparty', kind: 'commit', mandateAction: 'maintain_records', confirmation: 'mandate', route: '/app/suppliers' },
  { id: 'procurement.import_suppliers', kind: 'commit', mandateAction: 'maintain_records', confirmation: 'mandate', route: '/app/suppliers/import' },
  { id: 'sales.view_shared_assessments', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/sales/assessments' },
  { id: 'sales.respond_to_assessment', kind: 'commit', mandateAction: 'communicate', confirmation: 'mandate', route: '/app/sales/assessments' },
] as const;
