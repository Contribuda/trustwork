/**
 * Integrator request (PRC-000 step 3): extensions of frozen contracts the suite needs. They are listed here, not made,
 * except the mandate verbs that ADR 012 decision 36 assigned to PRC-000 (applied in `agent-catalog.ts`).
 */
export const PROPOSED_FROZEN_CONTRACT_EXTENSIONS = [
  { contract: 'transactions', change: 'agreement terms_kind adds `framework` (rates and maximum quantities or value for a period); see FrameworkTermsSchema', owner: 'COM-002 with the integrator', state: 'requested' },
  { contract: 'billing', change: 'payment purpose adds `trade_invoice` (PaymentInstruction.paymentId points at it)', owner: 'PAY-001 with the integrator', state: 'requested' },
  { contract: 'agent-catalog', change: 'MandateActionV2 adds `approve` (human-only), `release_payment` (transaction budget) and `maintain_records` (no budget)', owner: 'PRC-000 (ADR 012 decision 36)', state: 'applied' },
  { contract: 'agent-catalog', change: 'ContextKindV2 adds `requisition`, `trade_invoice`, `payment_proposal`, `stock_location`; capabilities use `project`, `company`, `order` and `agreement` until then', owner: 'integrator', state: 'requested' },
  { contract: 'hub', change: 'hub_config_version domain adds `procurement` with ProcurementHubSettingsSchema as its payload (sensitive: second-person activation)', owner: 'HUBC-011 with the integrator', state: 'requested' },
  { contract: 'package', change: '`@trustwork/contracts` export `./supply` for packages/contracts/src/supply/index.ts, so slices import the suite without deep paths', owner: 'integrator', state: 'requested' },
] as const;
