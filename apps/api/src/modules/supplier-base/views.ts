import {
  ExternalCounterpartySchema, SupplierAssessmentSchema, SupplierRecordSchema,
  type ExternalCounterparty, type ExternalCounterpartyRow, type SharedAssessmentRow, type SupplierAssessment, type SupplierAssessmentRow, type SupplierRecord, type SupplierRecordRow,
} from './deps.js';
import { SharedAssessmentViewSchema, type SharedAssessmentView } from './schemas.js';

/**
 * Row -> contract projections. Every view is parsed by its frozen contract schema, so a drift fails loudly. Views of
 * the buyer's own records carry the layer marker `party_private`, which the federation backstop (`payloadProblems`)
 * refuses, so none of them can cross a node boundary even by mistake.
 */
const iso = (d: Date | string): string => new Date(d).toISOString();
/** `date` columns arrive as a Date at local midnight (no type parser) or as text. */
export function dateText(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function recordContract(row: SupplierRecordRow): SupplierRecord {
  return SupplierRecordSchema.parse({
    id: row.id, ownerCompanyId: row.owner_company_id, linkedCompanyId: row.linked_company_id, linkedSourcedCompanyId: row.linked_sourced_company_id,
    externalCounterpartyId: row.external_counterparty_id, status: row.status, categories: row.categories, regions: row.regions, internalNotes: row.internal_notes,
    defaultPaymentTerms: row.default_payment_terms, onboarding: row.onboarding, revision: row.revision,
  });
}

export function counterpartyContract(row: ExternalCounterpartyRow): ExternalCounterparty {
  return ExternalCounterpartySchema.parse({
    id: row.id, ownerCompanyId: row.owner_company_id, name: row.name, identifiers: row.identifiers, contacts: row.contacts, source: row.source,
    claimedCompanyId: row.claimed_company_id, revision: row.revision,
  });
}

/** The contract assessment plus its state; a draft's `assessedAt` is its creation time until it is recorded. */
export type AssessmentView = SupplierAssessment & { state: 'draft' | 'recorded'; revision: number };
export function assessmentView(row: SupplierAssessmentRow): AssessmentView {
  const core = SupplierAssessmentSchema.parse({
    id: row.id, supplierRecordId: row.supplier_record_id, period: { from: dateText(row.period_from), to: dateText(row.period_to) }, criteriaVersion: row.criteria_version,
    scores: row.scores, assessedByPersonId: row.assessed_by_person_id, sharedWithSupplier: row.shared_with_supplier, supplierResponse: row.supplier_response,
    reputationInput: row.reputation_input, assessedAt: iso(row.assessed_at ?? row.created_at),
  });
  return { ...core, state: row.status, revision: row.revision };
}

export function sharedAssessmentView(row: SharedAssessmentRow): SharedAssessmentView {
  return SharedAssessmentViewSchema.parse({
    audience: 'shared_party', id: row.id, buyerCompanyId: row.buyer_company_id, period: { from: dateText(row.period_from), to: dateText(row.period_to) },
    criteriaVersion: row.criteria_version, scores: row.scores, supplierResponse: row.supplier_response, respondedAt: row.responded_at ? iso(row.responded_at) : null,
    assessedAt: iso(row.assessed_at), revision: row.revision,
  });
}

/** Envelope of every buyer-side read: the layer marker first. */
export function privateView<T extends object>(body: T): { audience: 'party_private' } & T {
  return { audience: 'party_private', ...body };
}
