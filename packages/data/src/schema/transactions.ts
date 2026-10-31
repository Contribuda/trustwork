import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Commerce slice 2 (COM-002, packages/data/migrations/transactions): quotes and their immutable versions, the frozen
 * line projection and tax determinations, the seller-private constraint, amendment requests and negotiation rounds,
 * agreements with `terms_kind`, the two private halves, acceptance events, orders (`commercial_order`), order changes
 * and obligations. Every table is under FORCE RLS.
 */
export type QuoteStatusValue = 'draft' | 'sent' | 'superseded' | 'withdrawn' | 'expired' | 'accepted';
export type QuoteStaleReasonValue = 'rfq_amended' | 'rfq_closed';
export type DealVia = 'person' | 'agent';
export type TermsKindValue = 'rfq_quote' | 'task' | 'consultation';
export type AgreementStatusValue = 'proposed' | 'accepted_by_buyer' | 'accepted_by_both' | 'declined' | 'withdrawn' | 'superseded';
export type AcceptanceEventKindValue = 'buyer_selects' | 'buyer_accepts_terms' | 'seller_accepts_order' | 'seller_declines' | 'withdrawn';
export type OrderStatusValue = 'placed' | 'accepted' | 'changed' | 'cancelled' | 'fulfilled';
export type OrderChangeStatusValue = 'proposed' | 'accepted' | 'rejected' | 'withdrawn';
export type ObligationKindValue = 'deliver' | 'perform' | 'pay' | 'accept';
export type ObligationStatusValue = 'open' | 'fulfilled' | 'partially' | 'waived' | 'disputed';
export type TaxabilityValue = 'taxable' | 'exempt' | 'reverse_charge' | 'not_applicable';
export type TaxProviderValue = 'pack' | 'adapter' | 'seller_stated';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface QuoteTable {
  id: GeneratedUuid;
  rfq_id: string;
  seller_person_id: string | null;
  seller_company_id: string | null;
  /** Set by the guard from the RFQ owner. */
  buyer_person_id: ColumnType<string | null, string | null | undefined, never>;
  buyer_company_id: ColumnType<string | null, string | null | undefined, never>;
  invitation_id: string | null;
  creator_person_id: string;
  status: Generated<QuoteStatusValue>;
  stale_reason: QuoteStaleReasonValue | null;
  stale_at: Timestamp | null;
  current_version: number | null;
  current_version_id: string | null;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface QuoteVersionTable {
  id: GeneratedUuid;
  quote_id: string;
  version: number;
  rfq_id: string;
  rfq_version_id: string;
  rfq_version: number;
  rfq_version_digest: string;
  status: Generated<QuoteStatusValue>;
  payload: Jsonb;
  digest: string | null;
  drafted_by_person_id: string;
  sent_at: Timestamp | null;
  sent_by_person_id: string | null;
  sent_via: DealVia | null;
  sent_by_mandate_id: string | null;
  valid_until: Timestamp | null;
  stale_reason: QuoteStaleReasonValue | null;
  stale_at: Timestamp | null;
  revalidated_from: number | null;
  answers_amendment_request_id: string | null;
  superseded_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaxDeterminationTable {
  id: GeneratedUuid;
  quote_id: string;
  quote_version_id: string;
  line_id: string;
  jurisdiction: string | null;
  rule_ref: string;
  rate: string | null;
  included: boolean;
  taxability: TaxabilityValue;
  exemption_ref: string | null;
  provider: TaxProviderValue;
  determined_by_person_id: string;
  determined_at: GeneratedTimestamp;
}

export interface QuoteLineTable {
  quote_version_id: string;
  quote_id: string;
  position: number;
  line_id: string;
  rfq_line_id: string | null;
  kind: 'goods' | 'works' | 'services';
  spec_snapshot: Jsonb;
  offering_ref: string | null;
  offering_version: number | null;
  quantity_value: string;
  quantity_unit: string;
  currency: string;
  unit_price_minor: Int8;
  tax_determination_id: string;
  tax_amount_minor: Int8;
  line_total_minor: Int8;
  created_at: GeneratedTimestamp;
}

export interface QuotePrivateConstraintTable {
  quote_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  floor_prices: Jsonb;
  margin_targets: Jsonb;
  cost_basis: Jsonb;
  negotiation_notes: string;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AmendmentRequestTable {
  id: GeneratedUuid;
  quote_id: string;
  quote_version_id: string;
  requester_person_id: string | null;
  requester_company_id: string | null;
  requested_by_person_id: string;
  requested_via: DealVia;
  requested_mandate_id: string | null;
  line_refs: string[];
  changes: Jsonb;
  target_total_minor: Int8 | null;
  target_total_currency: string | null;
  status: Generated<'open' | 'answered' | 'withdrawn'>;
  answered_by_version_id: string | null;
  withdrawn_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NegotiationRoundTable {
  id: GeneratedUuid;
  rfq_id: string;
  quote_id: string;
  round_no: number;
  proposal_kind: 'quote_version' | 'amendment_request';
  proposal_id: string;
  proposer_person_id: string | null;
  proposer_company_id: string | null;
  proposed_by_person_id: string;
  proposed_via: DealVia;
  proposed_mandate_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface AgreementTable {
  id: GeneratedUuid;
  terms_kind: Generated<TermsKindValue>;
  buyer_person_id: string | null;
  buyer_company_id: string | null;
  seller_person_id: string | null;
  seller_company_id: string | null;
  rfq_id: string | null;
  quote_id: string | null;
  quote_version_id: string | null;
  rfq_version_id: string | null;
  offer_ref_id: string | null;
  request_ref_id: string | null;
  offer_version: number;
  offer_digest: string;
  request_version: number;
  request_digest: string;
  accepted_terms_digest: string;
  status: Generated<AgreementStatusValue>;
  supersedes_id: string | null;
  superseded_by: string | null;
  closed_reason: string | null;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AgreementBuyerPrivateTable {
  agreement_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  transaction_budget_id: string | null;
  approval_refs: string[];
  notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AgreementSellerPrivateTable {
  agreement_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  fulfilment_plan: Jsonb;
  notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AcceptanceEventTable {
  id: GeneratedUuid;
  agreement_id: string;
  kind: AcceptanceEventKindValue;
  terms_kind: TermsKindValue;
  quote_version_id: string | null;
  rfq_version_id: string | null;
  offer_version: number;
  offer_digest: string;
  request_version: number;
  request_digest: string;
  accepted_terms_digest: string;
  actor_person_id: string;
  on_behalf_person_id: string | null;
  on_behalf_company_id: string | null;
  via: DealVia;
  mandate_id: string | null;
  transaction_budget_id: string | null;
  reservation_id: string | null;
  platform_budget_id: string | null;
  e_records_required: boolean;
  e_records_disclosure_key: string | null;
  e_records_basis: Generated<string[]>;
  e_records_consented_at: Timestamp | null;
  reason: string | null;
  occurred_at: GeneratedTimestamp;
  idempotency_key: string;
}

export interface CommercialOrderTable {
  id: GeneratedUuid;
  agreement_id: string;
  accepted_terms_digest: string;
  status: Generated<OrderStatusValue>;
  context_kind: 'project' | 'rfq';
  context_id: string;
  external_reference: string | null;
  amount_minor: Int8;
  currency: string;
  transaction_budget_id: string;
  reservation_id: string | null;
  platform_budget_id: string | null;
  placed_by_person_id: string;
  placed_via: DealVia;
  placed_mandate_id: string | null;
  cancelled_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface OrderChangeTable {
  id: GeneratedUuid;
  order_id: string;
  previous_agreement_id: string;
  previous_terms_digest: string;
  new_quote_version_id: string;
  new_rfq_version_id: string;
  new_terms_digest: string;
  new_agreement_id: string | null;
  proposer_person_id: string | null;
  proposer_company_id: string | null;
  proposed_by_person_id: string;
  proposed_via: DealVia;
  proposed_mandate_id: string | null;
  status: Generated<OrderChangeStatusValue>;
  consents: Jsonb;
  delta_reservation_id: string | null;
  decided_by_person_id: string | null;
  decided_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ObligationTable {
  id: GeneratedUuid;
  agreement_id: string;
  position: number;
  obligor_person_id: string | null;
  obligor_company_id: string | null;
  kind: ObligationKindValue;
  due: Timestamp | null;
  amount_minor: Int8 | null;
  currency: string | null;
  scope_value: string | null;
  scope_unit: string | null;
  status: Generated<ObligationStatusValue>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type QuoteRow = Selectable<QuoteTable>;
export type QuoteVersionRow = Selectable<QuoteVersionTable>;
export type TaxDeterminationRow = Selectable<TaxDeterminationTable>;
export type QuoteLineRow = Selectable<QuoteLineTable>;
export type QuotePrivateConstraintRow = Selectable<QuotePrivateConstraintTable>;
export type AmendmentRequestRow = Selectable<AmendmentRequestTable>;
export type NegotiationRoundRow = Selectable<NegotiationRoundTable>;
export type AgreementRow = Selectable<AgreementTable>;
export type AgreementBuyerPrivateRow = Selectable<AgreementBuyerPrivateTable>;
export type AgreementSellerPrivateRow = Selectable<AgreementSellerPrivateTable>;
export type AcceptanceEventRow = Selectable<AcceptanceEventTable>;
export type CommercialOrderRow = Selectable<CommercialOrderTable>;
export type OrderChangeRow = Selectable<OrderChangeTable>;
export type ObligationRow = Selectable<ObligationTable>;

export interface TransactionsDatabase {
  quote: QuoteTable;
  quote_version: QuoteVersionTable;
  tax_determination: TaxDeterminationTable;
  quote_line: QuoteLineTable;
  quote_private_constraint: QuotePrivateConstraintTable;
  amendment_request: AmendmentRequestTable;
  negotiation_round: NegotiationRoundTable;
  agreement: AgreementTable;
  agreement_buyer_private: AgreementBuyerPrivateTable;
  agreement_seller_private: AgreementSellerPrivateTable;
  acceptance_event: AcceptanceEventTable;
  commercial_order: CommercialOrderTable;
  order_change: OrderChangeTable;
  obligation: ObligationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends TransactionsDatabase {}
}

const columns = columnsOf<TransactionsDatabase>();
export const TABLE_COLUMNS: TableColumns<TransactionsDatabase> = {
  quote: columns('quote', [
    'id', 'rfq_id', 'seller_person_id', 'seller_company_id', 'buyer_person_id', 'buyer_company_id', 'invitation_id', 'creator_person_id', 'status', 'stale_reason', 'stale_at',
    'current_version', 'current_version_id', 'withdrawn_reason', 'revision', 'created_at', 'updated_at',
  ]),
  quote_version: columns('quote_version', [
    'id', 'quote_id', 'version', 'rfq_id', 'rfq_version_id', 'rfq_version', 'rfq_version_digest', 'status', 'payload', 'digest', 'drafted_by_person_id', 'sent_at', 'sent_by_person_id', 'sent_via',
    'sent_by_mandate_id', 'valid_until', 'stale_reason', 'stale_at', 'revalidated_from', 'answers_amendment_request_id', 'superseded_at', 'revision', 'created_at', 'updated_at',
  ]),
  tax_determination: columns('tax_determination', [
    'id', 'quote_id', 'quote_version_id', 'line_id', 'jurisdiction', 'rule_ref', 'rate', 'included', 'taxability', 'exemption_ref', 'provider', 'determined_by_person_id', 'determined_at',
  ]),
  quote_line: columns('quote_line', [
    'quote_version_id', 'quote_id', 'position', 'line_id', 'rfq_line_id', 'kind', 'spec_snapshot', 'offering_ref', 'offering_version', 'quantity_value', 'quantity_unit', 'currency',
    'unit_price_minor', 'tax_determination_id', 'tax_amount_minor', 'line_total_minor', 'created_at',
  ]),
  quote_private_constraint: columns('quote_private_constraint', [
    'quote_id', 'owner_person_id', 'owner_company_id', 'floor_prices', 'margin_targets', 'cost_basis', 'negotiation_notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  amendment_request: columns('amendment_request', [
    'id', 'quote_id', 'quote_version_id', 'requester_person_id', 'requester_company_id', 'requested_by_person_id', 'requested_via', 'requested_mandate_id', 'line_refs', 'changes',
    'target_total_minor', 'target_total_currency', 'status', 'answered_by_version_id', 'withdrawn_reason', 'revision', 'created_at', 'updated_at',
  ]),
  negotiation_round: columns('negotiation_round', [
    'id', 'rfq_id', 'quote_id', 'round_no', 'proposal_kind', 'proposal_id', 'proposer_person_id', 'proposer_company_id', 'proposed_by_person_id', 'proposed_via', 'proposed_mandate_id', 'created_at',
  ]),
  agreement: columns('agreement', [
    'id', 'terms_kind', 'buyer_person_id', 'buyer_company_id', 'seller_person_id', 'seller_company_id', 'rfq_id', 'quote_id', 'quote_version_id', 'rfq_version_id', 'offer_ref_id',
    'request_ref_id', 'offer_version', 'offer_digest', 'request_version', 'request_digest', 'accepted_terms_digest', 'status', 'supersedes_id', 'superseded_by', 'closed_reason',
    'created_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  agreement_buyer_private: columns('agreement_buyer_private', [
    'agreement_id', 'owner_person_id', 'owner_company_id', 'transaction_budget_id', 'approval_refs', 'notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  agreement_seller_private: columns('agreement_seller_private', [
    'agreement_id', 'owner_person_id', 'owner_company_id', 'fulfilment_plan', 'notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  acceptance_event: columns('acceptance_event', [
    'id', 'agreement_id', 'kind', 'terms_kind', 'quote_version_id', 'rfq_version_id', 'offer_version', 'offer_digest', 'request_version', 'request_digest', 'accepted_terms_digest',
    'actor_person_id', 'on_behalf_person_id', 'on_behalf_company_id', 'via', 'mandate_id', 'transaction_budget_id', 'reservation_id', 'platform_budget_id', 'e_records_required',
    'e_records_disclosure_key', 'e_records_basis', 'e_records_consented_at', 'reason', 'occurred_at', 'idempotency_key',
  ]),
  commercial_order: columns('commercial_order', [
    'id', 'agreement_id', 'accepted_terms_digest', 'status', 'context_kind', 'context_id', 'external_reference', 'amount_minor', 'currency', 'transaction_budget_id', 'reservation_id',
    'platform_budget_id', 'placed_by_person_id', 'placed_via', 'placed_mandate_id', 'cancelled_reason', 'revision', 'created_at', 'updated_at',
  ]),
  order_change: columns('order_change', [
    'id', 'order_id', 'previous_agreement_id', 'previous_terms_digest', 'new_quote_version_id', 'new_rfq_version_id', 'new_terms_digest', 'new_agreement_id', 'proposer_person_id',
    'proposer_company_id', 'proposed_by_person_id', 'proposed_via', 'proposed_mandate_id', 'status', 'consents', 'delta_reservation_id', 'decided_by_person_id', 'decided_reason',
    'revision', 'created_at', 'updated_at',
  ]),
  obligation: columns('obligation', [
    'id', 'agreement_id', 'position', 'obligor_person_id', 'obligor_company_id', 'kind', 'due', 'amount_minor', 'currency', 'scope_value', 'scope_unit', 'status', 'revision', 'created_at', 'updated_at',
  ]),
};
