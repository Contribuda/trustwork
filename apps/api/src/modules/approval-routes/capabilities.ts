/**
 * Agent parity (ADR 010 decision 23) for this module: every HTTP operation names the capability registry entry it
 * serves. The entries of `packages/contracts/src/supply/capabilities.ts` (PRC-000) are served as they are; the
 * operations the design table does not list yet are proposed below for PRC-023, which registers capabilities in the
 * runtime registry. The interface and the agent call the same use case with the same checks: deciding and activating
 * are human-only (`approve`), reachable from the agent surface only as the person's own decision card in the overlay.
 */
export interface ApprovalOperation {
  route: string;
  /** Registry entry declared by PRC-000, or null when proposed below. */
  capabilityId: string | null;
  proposed?: string;
}

export const APPROVAL_CAPABILITY_OPERATIONS: readonly ApprovalOperation[] = [
  { route: 'GET /v1/approvals/requests', capabilityId: 'procurement.list_documents' },
  { route: 'GET /v1/approvals/requests/:id', capabilityId: 'procurement.list_documents' },
  { route: 'GET /v1/approvals/requests/waiting', capabilityId: null, proposed: 'procurement.list_decisions_waiting' },
  { route: 'GET /v1/approvals/routes', capabilityId: null, proposed: 'procurement.list_routes' },
  { route: 'GET /v1/approvals/routes/:id', capabilityId: null, proposed: 'procurement.list_routes' },
  { route: 'GET /v1/approvals/templates', capabilityId: null, proposed: 'procurement.list_routes' },
  { route: 'POST /v1/approvals/routes', capabilityId: 'procurement.draft_route' },
  { route: 'POST /v1/approvals/routes/:id/activate', capabilityId: 'procurement.activate_route' },
  { route: 'POST /v1/approvals/requests/:id/decide', capabilityId: 'procurement.decide_approval' },
  { route: 'POST /v1/approvals/requests/:id/withdraw', capabilityId: null, proposed: 'procurement.withdraw_approval_request' },
  { route: 'GET /v1/approvals/delegations', capabilityId: null, proposed: 'procurement.list_delegations' },
  { route: 'POST /v1/approvals/delegations', capabilityId: 'procurement.delegate_approvals' },
  { route: 'POST /v1/approvals/delegations/:id/revoke', capabilityId: null, proposed: 'procurement.revoke_delegation' },
];

/** Registry entries to add (PRC-023): kind, mandate action and default confirmation, in the vocabulary of the supply table. */
export const PROPOSED_APPROVAL_CAPABILITIES = [
  { id: 'procurement.list_decisions_waiting', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/approvals' },
  { id: 'procurement.list_routes', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/approvals/routes' },
  { id: 'procurement.list_delegations', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/approvals/settings' },
  { id: 'procurement.withdraw_approval_request', kind: 'commit', mandateAction: 'maintain_records', confirmation: 'mandate', route: '/app/approvals' },
  { id: 'procurement.revoke_delegation', kind: 'commit', mandateAction: 'maintain_records', confirmation: 'mandate', route: '/app/approvals/settings' },
] as const;
