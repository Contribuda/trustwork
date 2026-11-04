/**
 * Agent parity (ADR 010 decision 23) for this module: every HTTP operation names the capability registry entry it
 * serves. The entries of `packages/contracts/src/supply/capabilities.ts` (PRC-000) are served as they are; the operations
 * the design table does not list yet are proposed below for PRC-023, which registers capabilities in the runtime
 * registry. The interface and the agent call the same use case with the same checks.
 */
export interface SourcingOperation {
  route: string;
  /** Registry entry declared by PRC-000, or null when proposed below. */
  capabilityId: string | null;
  proposed?: string;
}

export const SOURCING_CAPABILITY_OPERATIONS: readonly SourcingOperation[] = [
  { route: 'GET /v1/sourcing/rfqs/:id', capabilityId: null, proposed: 'sourcing_desk.view_event' },
  { route: 'POST /v1/sourcing/rfqs/:id/eligibility', capabilityId: null, proposed: 'sourcing_desk.set_eligibility' },
  { route: 'GET /v1/sourcing/rfqs/:id/candidates', capabilityId: null, proposed: 'sourcing_desk.list_candidates' },
  { route: 'GET /v1/sourcing/rfqs/:id/level-sheet/template', capabilityId: 'sourcing_desk.level_bids' },
  { route: 'POST /v1/sourcing/rfqs/:id/level-sheet/versions', capabilityId: 'sourcing_desk.level_bids' },
  { route: 'GET /v1/sourcing/level-sheet-versions/:id', capabilityId: null, proposed: 'sourcing_desk.view_event' },
  { route: 'POST /v1/sourcing/level-sheet-versions/:id', capabilityId: 'sourcing_desk.level_bids' },
  { route: 'POST /v1/sourcing/level-sheet-versions/:id/freeze', capabilityId: 'sourcing_desk.propose_award' },
];

/** Registry entries to add (PRC-023): kind, mandate action and default confirmation, in the vocabulary of the supply table. */
export const PROPOSED_SOURCING_CAPABILITIES = [
  { id: 'sourcing_desk.view_event', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/sourcing' },
  { id: 'sourcing_desk.set_eligibility', kind: 'draft', mandateAction: 'prepare', confirmation: 'none', route: '/app/sourcing' },
  { id: 'sourcing_desk.list_candidates', kind: 'read', mandateAction: null, confirmation: 'none', route: '/app/sourcing' },
] as const;
