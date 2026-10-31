import { DIGEST_ALGORITHM, pickFields, QuotePrivateConstraintSchema, QuoteSchema, QuoteVersionSchema, toSharedQuoteVersion, type QuoteVersion } from '../../deps/contracts.js';
import { iso } from './common.js';
import {
  AmendmentRequestSchema, BuyerQuoteViewSchema, NegotiationRoundSchema, QuoteEnvelopeSchema, SellerQuoteViewSchema,
  type AmendmentRequest, type AmendmentRequestRow, type BuyerQuoteView, type NegotiationRound, type NegotiationRoundRow, type QuotePrivateConstraintRow, type QuoteRow,
  type QuoteVersionRow, type SellerQuoteView,
} from './deps.js';

/* Serializers: explicit allowlists, then re-validated by the strict contract schemas. */

const digest = (value: string) => ({ algorithm: DIGEST_ALGORITHM, value });
export const sellerOf = (row: Pick<QuoteRow, 'seller_person_id' | 'seller_company_id'>) =>
  row.seller_person_id ? { kind: 'person' as const, id: row.seller_person_id } : { kind: 'company' as const, id: row.seller_company_id as string };
export const buyerOf = (row: Pick<QuoteRow, 'buyer_person_id' | 'buyer_company_id'>) =>
  row.buyer_person_id ? { kind: 'person' as const, id: row.buyer_person_id } : { kind: 'company' as const, id: row.buyer_company_id as string };

export function quoteContract(row: QuoteRow) {
  return QuoteSchema.parse({
    id: row.id, rfqId: row.rfq_id, seller: sellerOf(row), buyer: buyerOf(row), status: row.status, staleReason: row.stale_reason, currentVersion: row.current_version, revision: row.revision,
    createdAt: iso(row.created_at),
  });
}
export function quoteVersionContract(row: QuoteVersionRow): QuoteVersion {
  const payload = row.payload as { validity: { until: string } };
  return QuoteVersionSchema.parse({
    id: row.id, quoteId: row.quote_id, version: row.version, rfqVersion: { id: row.rfq_version_id, version: row.rfq_version, digest: digest(row.rfq_version_digest) }, status: row.status,
    payload: row.payload, digest: row.digest ? digest(row.digest) : null, sentAt: row.sent_at ? iso(row.sent_at) : null,
    sentBy: row.sent_by_person_id ? { personId: row.sent_by_person_id, mandateId: row.sent_by_mandate_id } : null,
    // Mirrors the frozen payload string exactly (the database checks that both name the same instant).
    validUntil: row.valid_until ? payload.validity.until : null, staleReason: row.stale_reason, revalidatedFrom: row.revalidated_from,
  });
}
export function quotePrivateContract(row: QuotePrivateConstraintRow) {
  return QuotePrivateConstraintSchema.parse({
    quoteId: row.quote_id, ownerParty: row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id },
    floorPrices: row.floor_prices, marginTargets: row.margin_targets, costBasis: row.cost_basis, negotiationNotes: row.negotiation_notes, revision: row.revision,
  });
}
export function roundContract(row: NegotiationRoundRow): NegotiationRound {
  return NegotiationRoundSchema.parse({
    roundNo: row.round_no, proposal: { kind: row.proposal_kind, id: row.proposal_id },
    proposer: row.proposer_person_id ? { kind: 'person', id: row.proposer_person_id } : { kind: 'company', id: row.proposer_company_id }, createdAt: iso(row.created_at),
  });
}
export function amendmentRequestContract(row: AmendmentRequestRow, versions: readonly QuoteVersionRow[]): AmendmentRequest {
  const answer = row.answered_by_version_id ? versions.find((v) => v.id === row.answered_by_version_id) : undefined;
  return AmendmentRequestSchema.parse({
    id: row.id, quoteId: row.quote_id, quoteVersionId: row.quote_version_id,
    requester: row.requester_person_id ? { kind: 'person', id: row.requester_person_id } : { kind: 'company', id: row.requester_company_id },
    changes: row.changes, targetTotal: row.target_total_minor !== null && row.target_total_currency !== null ? { minorUnits: String(row.target_total_minor), currency: row.target_total_currency } : null,
    status: row.status, answeredByVersion: answer?.version ?? null, revision: row.revision, createdAt: iso(row.created_at),
  });
}

export function sellerQuoteView(input: { quote: QuoteRow; versions: QuoteVersionRow[]; privateRow: QuotePrivateConstraintRow; rounds: NegotiationRoundRow[]; requests: AmendmentRequestRow[] }): SellerQuoteView {
  return SellerQuoteViewSchema.parse({
    projection: 'owner_private',
    quote: QuoteEnvelopeSchema.parse({ ...quoteContract(input.quote), invitationId: input.quote.invitation_id, updatedAt: iso(input.quote.updated_at) }),
    versions: input.versions.map(quoteVersionContract),
    privateConstraint: quotePrivateContract(input.privateRow),
    rounds: input.rounds.map(roundContract),
    amendmentRequests: input.requests.map((r) => amendmentRequestContract(r, input.versions)),
  });
}
/** shared_party for the buyer side: sent versions only, through `toSharedQuoteVersion`; nothing private, no drafts, no sender. */
export function buyerQuoteView(input: { quote: QuoteRow; versions: QuoteVersionRow[]; rounds: NegotiationRoundRow[]; requests: AmendmentRequestRow[] }): BuyerQuoteView {
  const envelope = quoteContract(input.quote);
  return BuyerQuoteViewSchema.parse({
    projection: 'shared_party',
    quote: pickFields(envelope, ['id', 'rfqId', 'seller', 'buyer', 'status', 'staleReason', 'currentVersion', 'revision']),
    versions: input.versions.filter((v) => v.status !== 'draft').map((v) => toSharedQuoteVersion({ version: quoteVersionContract(v) })).filter((v) => v !== null),
    rounds: input.rounds.map(roundContract),
    amendmentRequests: input.requests.map((r) => amendmentRequestContract(r, input.versions)),
  });
}
