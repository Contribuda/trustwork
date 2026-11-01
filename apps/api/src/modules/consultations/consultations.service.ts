import { randomUUID } from 'node:crypto';
import { threads } from '../../../../../packages/data/src/repositories/communications.js';
import type { z } from 'zod';
import {
  computeAgreementDigest, computeDigest, DIGEST_ALGORITHM, OfferingVersionPayloadSchema, verifyDigest, type Digest, type Money, type Party, type Principal,
} from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { mapDealError } from '../sales/common.js';
import type { ElectronicRecordsConsent } from '../sales/deps.js';
import type { ElectronicRecordsPolicySource } from '../transactions/electronic-records.js';
import {
  acceptanceEvents, agreements, availabilityWindows, AvailabilityListSchema, AvailabilityWindowSchema, bookingCalendar, BookingListSchema, bookingTermsDigestInput, BookingTermsSchema,
  BookingViewSchema, buildConsultationBrief, CalendarFileSchema, cancellationCharge, checkBookingAcceptance, consultationAgreements, ConsultationAgreementSchema, consultationBookings,
  ConsultationBookingSchema, ConsultationBriefError, ConsultationBriefSchema, consultationCatalogue, consultationDeliverables, ConsultationDeliverableSchema, ConsultationOfferingListSchema,
  consultationOfferings, ConsultationOfferingSchema, ConsultationOfferingTermsSchema, consultationPrice, ConsultationPriceError, consultationProjects, consultationReminders,
  ConsultationReminderSchema, consultationRequestDigestInput, ConsultationRequestListSchema, consultationRequestPrivate, ConsultationRequestPrivateSchema, consultationRequests,
  ConsultationRequestSchema, ConsultationRequestTermsSchema, consultationSessions, ConsultationSessionSchema, ConsultationSiteSchema, CONSULTATION_EVENT_PAYLOAD_KEYS, CONSULTATION_PLAN_ITEM_KINDS, credentialStatus,
  deriveConsultationObligations, electronicRecordsSatisfied, EMPTY_REQUEST_PRIVATE, executionAgreements, executionClaims, executionConfirmations, ExpertRequestViewSchema, isoDate, isSyncMode,
  MentoringListSchema, mentoringRelationships, MentoringRelationshipSchema, obligations, paymentBlindOrder, planItemStates, planParts, plans, priceAmount,
  pricingSummary, projectLocations, proposalMisfits, PublicConsultationOfferingListSchema, PublicDeliverableSchema, reminderTimes, RequesterRequestViewSchema, rowToItem,
  statusAfterDecision, toLocation,
  type AcceptanceEventRow, type AcceptProposalCommandSchema, type AgreementRow, type AvailabilityWindowRow, type BookingTerms, type BookingView, type CancelBookingCommandSchema,
  type ChangeMentoringCommandSchema, type CloseAvailabilityCommandSchema, type ConfirmBookingCommandSchema, type ConsultationActorInput, type ConsultationAgreement, type ConsultationBookingRow,
  type ConsultationDeliverableRow, type ConsultationOffering, type ConsultationOfferingRow, type ConsultationPartyScope, type ConsultationRequestPrivateInput, type ConsultationRequestRow,
  type CreateAvailabilityCommandSchema, type CredentialCheckOutcome, type CreateConsultationRequestCommandSchema, type CredentialFactsRow, type CredentialLabel, type DeclineAgreementCommandSchema,
  type DeclineConsultationRequestCommandSchema, type DeclineProposalCommandSchema, type DecideDeliverableCommandSchema, type ExpertRequestView, type MentoringRelationshipRow,
  type ObligationRow, type ProposeConsultationCommandSchema, type ProposeMentoringCommandSchema, type PublicConsultationOfferingRow, type PublishDeliverableCommandSchema,
  type RecordDeliverableCommandSchema, type RecordSessionCommandSchema, type RegisterConsultationOfferingCommandSchema, type RequesterRequestView, type RespondMentoringCommandSchema,
  type SaveRequestPrivateCommandSchema, type UpdateConsultationOfferingCommandSchema, type WithdrawAcceptanceCommandSchema, type WithdrawConsultationRequestCommandSchema,
  type WithdrawProposalCommandSchema,
} from './deps.js';
import type { ConsultationMandateCheck, ConsultationMandatePort } from './mandates.js';
import type { ConsultationCommissionPort, ConsultationScreeningGate } from './ports.js';

type In<T extends z.ZodType> = z.infer<T>;
type EventPayload = Partial<Record<(typeof CONSULTATION_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;
interface ResolvedActor { via: 'person' | 'agent'; personId: string; mandateId: string | null }

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: Date | string): string => new Date(value).toISOString();
const digestOf = (value: string): Digest => ({ algorithm: DIGEST_ALGORITHM, value });
const partyOf = (person: string | null, company: string | null): Party => (person ? { kind: 'person', id: person } : { kind: 'company', id: company as string });
const columnsOf = (party: Party) => (party.kind === 'person' ? { person: party.id, company: null } : { person: null, company: party.id });
const money = (minor: string | null, currency: string | null): Money | null => (minor !== null && currency !== null ? { minorUnits: String(minor), currency } : null);

/** Database hints of the consultations guards, mapped to frozen contract codes (checked before the deal and commerce hints). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'consultations.licence_not_recorded': { code: 'validation.schema', reason: 'licence_not_recorded' },
  'consultations.licence_required': { code: 'validation.schema', reason: 'licence_required' },
  'consultations.offering_not_services': { code: 'validation.schema', reason: 'offering_not_services' },
  'consultations.offering_unavailable': { code: 'validation.schema', reason: 'offering_unavailable' },
  'consultations.kind_mismatch': { code: 'validation.schema', reason: 'kind_mismatch' },
  'consultations.item_not_in_baseline': { code: 'validation.schema', reason: 'item_not_in_baseline' },
  'consultations.site_needs_project': { code: 'validation.schema', reason: 'site_needs_project' },
  'consultations.mentoring_not_active': { code: 'validation.schema', reason: 'mentoring_not_active' },
  'consultations.mentoring_offering': { code: 'validation.schema', reason: 'mentoring_offering' },
  'consultations.request_not_open': { code: 'validation.revision_conflict', reason: 'request_not_open' },
  'consultations.proposal_open': { code: 'validation.revision_conflict', reason: 'proposal_open' },
  'consultations.proposal_mismatch': { code: 'validation.schema', reason: 'proposal_mismatch' },
  'consultations.mode_not_offered': { code: 'validation.schema', reason: 'mode_not_offered' },
  'consultations.slot_unavailable': { code: 'validation.revision_conflict', reason: 'slot_unavailable' },
  'consultations.capacity_exhausted': { code: 'validation.revision_conflict', reason: 'capacity_exhausted' },
  'consultations.slot_overlaps': { code: 'validation.revision_conflict', reason: 'slot_overlaps' },
  'consultations.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'consultations.window_in_past': { code: 'validation.schema', reason: 'window_in_past' },
  'consultations.session_not_recorded': { code: 'validation.schema', reason: 'session_not_recorded' },
  'consultations.not_deliverable': { code: 'validation.revision_conflict', reason: 'not_deliverable' },
  'consultations.decision_missing': { code: 'validation.schema', reason: 'decision_missing' },
  'consultations.cancellation_not_allowed': { code: 'validation.schema', reason: 'cancellation_not_allowed' },
  'consultations.claim_mismatch': { code: 'validation.schema', reason: 'claim_mismatch' },
  'consultations.deliverable_open': { code: 'validation.revision_conflict', reason: 'deliverable_open' },
  'consultations.not_author': { code: 'access.forbidden', reason: 'not_author' },
  'commerce.version_frozen': { code: 'commercial.version_immutable', reason: 'version_frozen' },
  'commerce.retained': { code: 'commercial.version_immutable', reason: 'retained' },
  'commerce.invalid_transition': { code: 'validation.schema', reason: 'invalid_transition' },
  'commerce.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'commerce.self_invitation': { code: 'validation.schema', reason: 'self_invitation' },
  'commerce.restricted_place': { code: 'validation.schema', reason: 'restricted_place' },
  'commerce.plan_item_path': { code: 'validation.schema', reason: 'plan_item_path' },
  'plans.item_path_taken': { code: 'validation.revision_conflict', reason: 'item_path_taken' },
  'execution.agreement_not_live': { code: 'validation.revision_conflict', reason: 'agreement_not_live' },
  'execution.claim_open': { code: 'validation.revision_conflict', reason: 'claim_open' },
  'execution.claim_not_open': { code: 'validation.revision_conflict', reason: 'claim_not_open' },
  'execution.obligation_fulfilled': { code: 'validation.revision_conflict', reason: 'obligation_fulfilled' },
  'execution.self_confirmation': { code: 'access.forbidden', reason: 'self_confirmation' },
};
function mapConsultationError(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDealError(error);
}
const CHECK_MESSAGES = {
  'commercial.quote_not_acceptable': 'only an open proposal is accepted',
  'commercial.quote_expired': 'the proposal validity has passed',
  'commercial.digest_mismatch': 'the accepted terms do not match the stored proposal',
  'commercial.rfq_version_mismatch': 'the request is not the one the proposal answers',
} as const;

/* ---------- Serializers (explicit allowlists, re-validated by the strict contract schemas) ---------- */

function credentialLabel(facts: CredentialFactsRow | undefined, today: string): CredentialLabel | null {
  if (!facts || facts.superseded) return null;
  const lastCheck = facts.last_outcome ? { outcome: facts.last_outcome as CredentialCheckOutcome, registerValidUntil: facts.register_valid_until ? isoDate(facts.register_valid_until) : null } : null;
  const status = credentialStatus({ validUntil: facts.valid_until ? isoDate(facts.valid_until) : null, lastCheck }, today);
  return { credentialId: facts.credential_id, status, jurisdiction: facts.jurisdiction, credentialType: facts.credential_type, checkedOn: status === 'checked' && facts.checked_at ? iso(facts.checked_at).slice(0, 10) : null };
}
function offeringTerms(row: ConsultationOfferingRow) {
  return ConsultationOfferingTermsSchema.parse({
    kind: row.kind, modes: row.modes, topics: row.topics, regions: row.regions, languages: row.languages, durationMinutes: row.duration_minutes, deliverableKind: row.deliverable_kind,
    pricing: row.pricing, cancellation: row.cancellation, licence: { required: row.licence_required, credentialId: row.licence_credential_id }, recordingOffered: row.recording_offered,
  });
}
function requestContract(row: ConsultationRequestRow) {
  return ConsultationRequestSchema.parse({
    id: row.id, requester: partyOf(row.requester_person_id, null), offeringId: row.offering_id, expert: partyOf(row.offering_owner_person_id, row.offering_owner_company_id),
    planItem: row.project_id ? { projectId: row.project_id, planId: row.plan_id, planVersionId: row.plan_version_id, itemKey: row.plan_item_key } : null,
    mentoringRelationshipId: row.mentoring_relationship_id, kind: row.kind, status: row.status, digest: digestOf(row.digest), closedReason: row.closed_reason, revision: row.revision,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}
function bookingContract(row: ConsultationBookingRow) {
  return ConsultationBookingSchema.parse({
    id: row.id, requestId: row.request_id, terms: row.terms, digest: digestOf(row.terms_digest), status: row.status, agreementId: row.agreement_id, recordingConsent: row.recording_consent,
    cancellation: row.cancellation_kind ? {
      kind: row.cancellation_kind, absentSide: row.cancellation_absent_side, reason: row.closed_reason ?? 'cancelled', charge: money(row.cancellation_charge_minor, row.cancellation_charge_currency),
      at: iso(row.cancelled_at as Date),
    } : null,
    bookedAt: row.booked_at ? iso(row.booked_at) : null, revision: row.revision, createdAt: iso(row.created_at),
  });
}
function obligationContract(row: ObligationRow) {
  return {
    party: partyOf(row.obligor_person_id, row.obligor_company_id), kind: row.kind, due: row.due ? iso(row.due) : null, amount: money(row.amount_minor === null ? null : String(row.amount_minor), row.currency),
    scope: row.scope_value !== null && row.scope_unit !== null ? { value: row.scope_value, unit: row.scope_unit } : null,
  };
}
function eventContract(row: AcceptanceEventRow) {
  return {
    id: row.id, kind: row.kind, acceptedTermsDigest: digestOf(row.accepted_terms_digest), onBehalfOf: partyOf(row.on_behalf_person_id, row.on_behalf_company_id),
    electronicRecords: row.e_records_disclosure_key ? { disclosureKey: row.e_records_disclosure_key, basis: row.e_records_basis } : null, occurredAt: iso(row.occurred_at),
  };
}
function deliverableContract(row: ConsultationDeliverableRow) {
  return ConsultationDeliverableSchema.parse({
    id: row.id, bookingId: row.booking_id, kind: row.kind, title: row.title, body: row.body, attachments: row.attachments, author: partyOf(row.seller_person_id, row.seller_company_id),
    claimId: row.claim_id, deliveredAt: iso(row.delivered_at), decision: row.decision, confirmationId: row.confirmation_id, decidedAt: row.decided_at ? iso(row.decided_at) : null,
    publishedAt: row.published_at ? iso(row.published_at) : null,
  });
}
function mentoringContract(row: MentoringRelationshipRow) {
  return MentoringRelationshipSchema.parse({
    id: row.id, mentor: partyOf(row.mentor_person_id, null), mentee: partyOf(row.mentee_person_id, null), proposedBy: partyOf(row.proposed_by_person_id, null), topics: row.topics,
    terms: row.terms, offeringId: row.offering_id, status: row.status, startedAt: row.started_at ? iso(row.started_at) : null, endedAt: row.ended_at ? iso(row.ended_at) : null,
    endedReason: row.ended_reason, revision: row.revision, createdAt: iso(row.created_at),
  });
}
function windowContract(row: AvailabilityWindowRow, booked: number) {
  return AvailabilityWindowSchema.parse({
    id: row.id, expertPersonId: row.expert_person_id, startsAt: iso(row.starts_at), endsAt: iso(row.ends_at), timeZone: row.time_zone, capacity: row.capacity, booked, status: row.status, revision: row.revision,
  });
}
const privateColumns = (input: ConsultationRequestPrivateInput) => ({ budget_ceiling_minor: input.budgetCeiling?.minorUnits ?? null, budget_ceiling_currency: input.budgetCeiling?.currency ?? null, requester_notes: input.requesterNotes });

/**
 * Consultations and mentoring from plan items (CONS-001). A requester (a person; for a plan item the project's person
 * owner) asks one expert's consultation offering, with a brief built field by field from the plan item and frozen with
 * its digest. The expert side proposes the exact terms (pinned catalogue version, price, the hub's commission, slot or
 * due date, cancellation terms, the licence label), frozen from that moment. The client accepts by id and digest (a
 * COM-002 agreement with terms_kind `consultation`); the expert confirms by stating the digest, which books the slot
 * against the window's capacity in the same transaction. Sessions, deliverables (EXE-001 claims and confirmations),
 * cancellation, reminders, calendar files and mentoring follow. Every route runs in one `withPrincipal` transaction
 * that also completes its idempotency record (BE-005); outbox events carry identifiers only.
 */
export class ConsultationsService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: ConsultationMandatePort,
    private readonly records: ElectronicRecordsPolicySource,
    private readonly commission: ConsultationCommissionPort,
    private readonly screening: ConsultationScreeningGate,
    /** Trusted served-hub context, captured only at authenticated confirmation; never request input. */
    private readonly sourceHubId: string | null = null,
  ) {}

  /* ---------- Plumbing ---------- */

  private now(): Date {
    return this.ctx.clock.now();
  }
  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapConsultationError);
  }
  private read<T>(state: RequestState, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return (state.principal ? this.principals.runAs(state, (trx) => fn(trx)) : withoutPrincipal(this.ctx.pool, fn)).catch(mapConsultationError);
  }
  /** A person acts for themself; a company through members holding the permission (deal managers by default). */
  private actsFor(principal: Principal, party: Party, permission = 'company.deals.manage'): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes(permission as never);
  }
  private scope(principal: Principal, permission = 'company.deals.manage'): ConsultationPartyScope {
    return { personId: principal.personId, companyId: principal.membership?.permissions.includes(permission as never) ? principal.membership.companyId : null };
  }
  private async actor(principal: Principal, input: ConsultationActorInput, action: ConsultationMandateCheck['action'], context: ConsultationMandateCheck['context'], amount: Money | null = null): Promise<ResolvedActor> {
    if (input.via === 'person') return { via: 'person', personId: principal.personId, mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, action, context, amount, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this object`);
    return { via: 'agent', personId: principal.personId, mandateId: input.mandateId };
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  /** Identifiers only (CONSULTATION_EVENT_PAYLOAD_KEYS): notifications read the projection under the recipient's authority. */
  private async event(trx: Transaction, aggregateKind: string, aggregateId: string, revision: number, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(CONSULTATION_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision, type, payload });
  }
  private consent(input: ElectronicRecordsConsent | null): { required: boolean; disclosureKey: string | null; basis: string[]; at: Date | null } {
    const policy = this.records.current();
    if (!electronicRecordsSatisfied(policy, input)) {
      throw new ApiError('validation.schema', 'acceptance needs consent to electronic records for the current disclosure', { reason: 'electronic_records_consent_required', disclosureKey: policy.disclosureKey });
    }
    return input ? { required: policy.required, disclosureKey: input.disclosureKey, basis: [...policy.basis], at: this.now() } : { required: false, disclosureKey: null, basis: [], at: null };
  }
  private expertParty(row: { offering_owner_person_id: string | null; offering_owner_company_id: string | null }): Party {
    return partyOf(row.offering_owner_person_id, row.offering_owner_company_id);
  }
  private sellerParty(row: { seller_person_id: string | null; seller_company_id: string | null }): Party {
    return partyOf(row.seller_person_id, row.seller_company_id);
  }

  /* ---------- Views ---------- */

  private async offeringView(trx: Transaction, row: ConsultationOfferingRow): Promise<ConsultationOffering> {
    const [facts, current] = await Promise.all([consultationOfferings.credential(trx, row.offering_id), consultationOfferings.currentVersion(trx, row.offering_id)]);
    const payload = current ? OfferingVersionPayloadSchema.parse(current.payload) : null;
    return ConsultationOfferingSchema.parse({
      offeringId: row.offering_id, owner: partyOf(row.owner_person_id, row.owner_company_id), expertPersonId: row.expert_person_id, terms: offeringTerms(row), status: row.status,
      credential: credentialLabel(facts, this.today()),
      currentVersion: current && payload ? { id: current.version_id, version: current.version, title: payload.title, listPrice: payload.listPrice, unit: payload.unit } : null,
      revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    });
  }
  private async agreementView(trx: Transaction, row: AgreementRow): Promise<ConsultationAgreement> {
    const [events, obligationRows] = await Promise.all([acceptanceEvents.listFor(trx, row.id), obligations.listFor(trx, row.id)]);
    return ConsultationAgreementSchema.parse({
      id: row.id, termsKind: 'consultation', buyer: partyOf(row.buyer_person_id, row.buyer_company_id), seller: partyOf(row.seller_person_id, row.seller_company_id),
      booking: { id: row.offer_ref_id, version: row.offer_version, digest: digestOf(row.offer_digest) }, request: { id: row.request_ref_id, version: row.request_version, digest: digestOf(row.request_digest) },
      acceptedTermsDigest: digestOf(row.accepted_terms_digest), status: row.status, closedReason: row.closed_reason, events: events.map(eventContract),
      obligations: obligationRows.map(obligationContract), revision: row.revision, createdAt: iso(row.created_at),
    });
  }
  private async agreementsFor(trx: Transaction, bookings: readonly ConsultationBookingRow[]): Promise<ConsultationAgreement[]> {
    const rows = await consultationAgreements.listForBookings(trx, bookings.map((b) => b.id));
    return Promise.all(rows.map((a) => this.agreementView(trx, a)));
  }
  private async requesterView(trx: Transaction, request: ConsultationRequestRow): Promise<RequesterRequestView> {
    const [privateRow, bookings, windows] = await Promise.all([
      consultationRequestPrivate.get(trx, request.id), consultationBookings.listForRequest(trx, request.id), availabilityWindows.freeFor(trx, request.id),
    ]);
    if (!privateRow) throw new Error(`consultation request ${request.id} has no private half`);
    return RequesterRequestViewSchema.parse({
      projection: 'owner_private', request: requestContract(request), brief: ConsultationBriefSchema.parse(request.brief),
      privateConstraint: ConsultationRequestPrivateSchema.parse({ budgetCeiling: money(privateRow.budget_ceiling_minor, privateRow.budget_ceiling_currency), requesterNotes: privateRow.requester_notes, revision: privateRow.revision }),
      bookings: bookings.map(bookingContract), agreements: await this.agreementsFor(trx, bookings),
      freeWindows: windows.map((w) => ({ id: w.window_id, startsAt: iso(w.starts_at), endsAt: iso(w.ends_at), timeZone: w.time_zone, remaining: Number(w.remaining) })),
    });
  }
  /** shared_party for the expert side: the brief and the proposals; never the requester's private half. */
  private async expertRequestView(trx: Transaction, request: ConsultationRequestRow): Promise<ExpertRequestView> {
    const bookings = await consultationBookings.listForRequest(trx, request.id);
    return ExpertRequestViewSchema.parse({
      projection: 'shared_party', request: requestContract(request), brief: ConsultationBriefSchema.parse(request.brief), bookings: bookings.map(bookingContract),
      agreements: await this.agreementsFor(trx, bookings),
    });
  }
  private async bookingView(trx: Transaction, p: Principal, row: ConsultationBookingRow): Promise<BookingView> {
    const side = row.client_person_id === p.personId ? 'client' : 'expert';
    const agreement = row.agreement_id ? await consultationAgreements.get(trx, row.agreement_id) : undefined;
    const [session, deliverables, reminders, site] = await Promise.all([
      consultationSessions.get(trx, row.id), consultationDeliverables.listFor(trx, row.id), consultationReminders.listFor(trx, row.id), consultationBookings.site(trx, row.id),
    ]);
    return BookingViewSchema.parse({
      projection: 'shared_party', side, booking: bookingContract(row), agreement: agreement ? await this.agreementView(trx, agreement) : null,
      session: session ? ConsultationSessionSchema.parse({
        bookingId: session.booking_id, startedAt: session.started_at ? iso(session.started_at) : null, endedAt: session.ended_at ? iso(session.ended_at) : null,
        siteAddressRevealedAt: session.site_address_revealed_at ? iso(session.site_address_revealed_at) : null, meetingLinkRef: session.meeting_link_ref,
      }) : null,
      deliverables: deliverables.map(deliverableContract),
      reminders: reminders.map((r) => ConsultationReminderSchema.parse({ id: r.id, remindAt: iso(r.remind_at), offsetMinutes: r.offset_minutes, status: r.status })),
      threadContext: agreement && agreement.status === 'accepted_by_both' ? { kind: 'agreement', id: agreement.id } : null,
      site: site ? ConsultationSiteSchema.parse({ regionCode: site.region_code, address: site.address ?? null, siteContact: site.site_contact ?? null, siteAccessNotes: site.site_access_notes }) : null,
    });
  }

  /* ---------- Loading ---------- */

  private async ownRequest(trx: Transaction, p: Principal, id: string): Promise<ConsultationRequestRow> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = await consultationRequests.lock(trx, id);
    if (!row || row.requester_person_id !== p.personId) throw new ApiError('access.not_found');
    return row;
  }
  private async expertRequest(trx: Transaction, p: Principal, id: string): Promise<ConsultationRequestRow> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = await consultationRequests.get(trx, id);
    if (!row || !this.actsFor(p, this.expertParty(row))) throw new ApiError('access.not_found');
    return row;
  }
  private async partyBooking(trx: Transaction, p: Principal, id: string, lock: boolean): Promise<{ row: ConsultationBookingRow; side: 'client' | 'expert' }> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = lock ? await consultationBookings.lock(trx, id) : await consultationBookings.get(trx, id);
    if (!row) throw new ApiError('access.not_found');
    if (row.client_person_id === p.personId) return { row, side: 'client' };
    if (this.actsFor(p, this.sellerParty(row))) return { row, side: 'expert' };
    throw new ApiError('access.not_found');
  }
  private terms(row: ConsultationBookingRow): BookingTerms {
    return BookingTermsSchema.parse(row.terms);
  }

  /* ---------- Plan item path ---------- */

  /** The plan item records the path `consultation` with this request and becomes `requested` (the request is sent at once). */
  private async linkPlanItem(trx: Transaction, p: Principal, planId: string, projectId: string, itemKey: string, requestId: string): Promise<void> {
    let current = await planItemStates.get(trx, planId, itemKey);
    if (!current) {
      current = await planItemStates.insert(trx, { plan_id: planId, project_id: projectId, item_key: itemKey, status: 'accepted', path: 'consultation', link_kind: 'consultation_request', link_id: requestId, blocked_from: null, actual_start: null, actual_end: null, updated_by_person_id: p.personId });
    } else {
      if (current.status === 'proposed') {
        current = await planItemStates.update(trx, planId, itemKey, current.revision, { status: 'accepted', path: 'consultation', link_kind: 'consultation_request', link_id: requestId, blocked_from: null, updated_by_person_id: p.personId, actual_start: isoDate(current.actual_start), actual_end: isoDate(current.actual_end) });
        if (!current) throw new ApiError('validation.revision_conflict');
      }
    }
    const saved = await planItemStates.update(trx, planId, itemKey, current.revision, {
      status: 'requested', path: 'consultation', link_kind: 'consultation_request', link_id: requestId, blocked_from: null, updated_by_person_id: p.personId,
      actual_start: isoDate(current.actual_start), actual_end: isoDate(current.actual_end),
    });
    if (!saved) throw new ApiError('validation.revision_conflict');
  }
  /** Completion: the linked plan item moves requested -> in_progress -> done (the requester's own transaction). */
  private async completePlanItem(trx: Transaction, p: Principal, request: ConsultationRequestRow): Promise<void> {
    if (!request.plan_id || !request.plan_item_key) return;
    let current = await planItemStates.get(trx, request.plan_id, request.plan_item_key);
    if (!current || current.link_id !== request.id) return;
    const steps: ('in_progress' | 'done')[] = current.status === 'requested' ? ['in_progress', 'done'] : current.status === 'in_progress' ? ['done'] : [];
    for (const status of steps) {
      const saved = await planItemStates.update(trx, request.plan_id, request.plan_item_key, current.revision, {
        status, path: 'consultation', link_kind: 'consultation_request', link_id: request.id, blocked_from: null, updated_by_person_id: p.personId,
        actual_start: status === 'in_progress' ? isoDate(this.now()) : isoDate(current.actual_start), actual_end: status === 'done' ? isoDate(this.now()) : isoDate(current.actual_end),
      });
      if (!saved) return;
      current = saved;
    }
  }

  /* ---------- Expert: offerings ---------- */

  async registerOffering(input: In<typeof RegisterConsultationOfferingCommandSchema>, state: RequestState): Promise<ConsultationOffering> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(input.offeringId)) throw new ApiError('access.not_found');
      const catalogue = await consultationCatalogue.offering(trx, input.offeringId);
      if (!catalogue || !this.actsFor(p, partyOf(catalogue.owner_person_id, catalogue.owner_company_id), 'company.catalogue.edit')) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'catalogue_offering', id: input.offeringId });
      if (catalogue.kind !== 'services' || catalogue.status !== 'active') throw new ApiError('validation.schema', 'a consultation is an active services offering', { reason: 'offering_not_services' });
      await this.checkLicence(trx, input.terms, p.personId);
      const row = await consultationOfferings.insert(trx, {
        offering_id: input.offeringId, owner_person_id: catalogue.owner_person_id, owner_company_id: catalogue.owner_company_id, expert_person_id: p.personId, created_by_person_id: p.personId,
        ...this.offeringColumns(input.terms),
      });
      await this.commission.origin?.(trx, 'offering', row.offering_id);
      await this.audit(trx, p, state, 'consultation.offering_registered', 'consultation_offering', row.offering_id, { kind: row.kind, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_offering', row.offering_id, row.revision, 'consultation.offering_registered', { offeringId: row.offering_id, kind: row.kind, via: actor.via });
      return this.offeringView(trx, row);
    });
  }
  private offeringColumns(terms: In<typeof ConsultationOfferingTermsSchema>) {
    return {
      kind: terms.kind, modes: terms.modes, topics: terms.topics, regions: terms.regions, languages: terms.languages, duration_minutes: terms.durationMinutes, deliverable_kind: terms.deliverableKind,
      pricing: terms.pricing, cancellation: terms.cancellation, licence_required: terms.licence.required, licence_credential_id: terms.licence.credentialId, recording_offered: terms.recordingOffered,
    };
  }
  /** Licence-requiring advice names a usable recorded licence of the expert (self-declared until CLM-001, and labelled so). */
  private async checkLicence(trx: Transaction, terms: In<typeof ConsultationOfferingTermsSchema>, expertPersonId: string): Promise<void> {
    if (terms.licence.credentialId === null) return;
    if (!UUID.test(terms.licence.credentialId) || !(await consultationOfferings.licenceUsable(trx, terms.licence.credentialId, expertPersonId))) {
      throw new ApiError('validation.schema', 'the licence is not a current recorded licence of the expert', { reason: 'licence_not_recorded' });
    }
  }

  async updateOffering(offeringId: string, input: In<typeof UpdateConsultationOfferingCommandSchema>, state: RequestState): Promise<ConsultationOffering> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(offeringId)) throw new ApiError('access.not_found');
      const row = await consultationOfferings.lock(trx, offeringId);
      if (!row || !this.actsFor(p, partyOf(row.owner_person_id, row.owner_company_id), 'company.catalogue.edit')) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'publish', { kind: 'catalogue_offering', id: offeringId });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (input.terms.kind !== row.kind) throw new ApiError('validation.schema', 'the kind of an offering never changes', { reason: 'kind_immutable' });
      if (row.status === 'retired') throw new ApiError('commercial.version_immutable', 'a retired offering stays retired', { reason: 'retired' });
      await this.checkLicence(trx, input.terms, row.expert_person_id);
      const columns: Partial<ReturnType<ConsultationsService['offeringColumns']>> = this.offeringColumns(input.terms);
      delete columns.kind;
      const saved = await consultationOfferings.update(trx, offeringId, input.expectedRevision, { ...(columns as Omit<ReturnType<ConsultationsService['offeringColumns']>, 'kind'>), status: input.status });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.offering_updated', 'consultation_offering', offeringId, { status: saved.status, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_offering', offeringId, saved.revision, 'consultation.offering_updated', { offeringId, status: saved.status, via: actor.via });
      return this.offeringView(trx, saved);
    });
  }

  async listOfferings(state: RequestState): Promise<z.infer<typeof ConsultationOfferingListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await consultationOfferings.listOwned(trx, this.scope(p, 'company.catalogue.edit'));
      return ConsultationOfferingListSchema.parse({ offerings: await Promise.all(rows.map((r) => this.offeringView(trx, r))) });
    });
  }

  /** Export enumeration is not the bounded scheduling UI; all values still use the owning projections. */
  privacyInventory(state: RequestState, subject: Party) {
    return this.run(state, async (trx, p) => {
      if (!this.actsFor(p, subject, 'company.catalogue.edit')) throw new ApiError('access.not_found');
      const offerings = [];
      for (const row of await trx.selectFrom('consultation_offering').selectAll()
        .where(subject.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', subject.id).orderBy('offering_id').execute()) {
        offerings.push(await this.offeringView(trx, row));
      }
      const availability = []; const mentoring = [];
      if (subject.kind === 'person') {
        for (const row of await trx.selectFrom('availability_window').selectAll().where('expert_person_id', '=', subject.id).orderBy('starts_at').orderBy('id').execute()) {
          availability.push(windowContract(row, await availabilityWindows.booked(trx, row.id)));
        }
        for (const row of await trx.selectFrom('mentoring_relationship').selectAll()
          .where((eb) => eb.or([eb('mentor_person_id', '=', subject.id), eb('mentee_person_id', '=', subject.id)])).orderBy('id').execute()) mentoring.push(mentoringContract(row));
      }
      return { offerings, availability, mentoring: { relationships: mentoring } };
    });
  }

  /** Public: active offerings of one owner with their terms, public catalogue fields and the licence label; anonymous too. */
  async publicOfferings(owner: Party, state: RequestState): Promise<z.infer<typeof PublicConsultationOfferingListSchema>> {
    if (!UUID.test(owner.id)) throw new ApiError('access.not_found');
    return this.read(state, async (trx) => {
      const rows = await consultationOfferings.publicList(trx, owner.kind === 'person' ? { ownerPersonId: owner.id } : { ownerCompanyId: owner.id });
      const items = [];
      for (const row of rows) items.push({ id: row.offering_id, at: iso(row.created_at), value: await this.publicOffering(trx, row) });
      return PublicConsultationOfferingListSchema.parse({ offerings: paymentBlindOrder(items).map((x) => x.value) });
    });
  }
  private async publicOffering(trx: Transaction, row: PublicConsultationOfferingRow) {
    const label = row.credential_id ? credentialLabel(await consultationOfferings.credential(trx, row.offering_id), this.today()) : null;
    return {
      offeringId: row.offering_id, owner: partyOf(row.owner_person_id, row.owner_company_id), kind: row.kind, modes: row.modes, topics: row.topics, regions: row.regions, languages: row.languages,
      durationMinutes: row.duration_minutes, deliverableKind: row.deliverable_kind, pricing: row.pricing, title: row.title, listPrice: (row.list_price as Money | null) ?? null,
      credential: label ? { status: label.status, jurisdiction: label.jurisdiction, credentialType: label.credentialType, checkedOn: label.checkedOn } : null,
    };
  }

  /* ---------- Expert: availability ---------- */

  async openWindow(input: In<typeof CreateAvailabilityCommandSchema>, state: RequestState): Promise<z.infer<typeof AvailabilityWindowSchema>> {
    return this.run(state, async (trx, p) => {
      const actor = await this.actor(p, input.actor, 'schedule', { kind: 'profile', id: p.personId });
      if (Date.parse(input.endsAt) <= this.now().getTime()) throw new ApiError('validation.schema', 'a window opens for future time', { reason: 'window_in_past' });
      const row = await availabilityWindows.insert(trx, { expert_person_id: p.personId, starts_at: input.startsAt, ends_at: input.endsAt, time_zone: input.timeZone, capacity: input.capacity });
      await this.audit(trx, p, state, 'consultation.window_opened', 'availability_window', row.id, { capacity: row.capacity, via: actor.via, mandateId: actor.mandateId });
      return windowContract(row, 0);
    });
  }

  async closeWindow(id: string, input: In<typeof CloseAvailabilityCommandSchema>, state: RequestState): Promise<z.infer<typeof AvailabilityWindowSchema>> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(id)) throw new ApiError('access.not_found');
      const row = await availabilityWindows.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'schedule', { kind: 'profile', id: p.personId });
      const saved = await availabilityWindows.close(trx, id, input.expectedRevision);
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.window_closed', 'availability_window', id, { via: actor.via, mandateId: actor.mandateId });
      return windowContract(saved, await availabilityWindows.booked(trx, id));
    });
  }

  async listWindows(state: RequestState): Promise<z.infer<typeof AvailabilityListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await availabilityWindows.listOwn(trx, p.personId, this.now());
      const windows = [];
      for (const row of rows) windows.push(windowContract(row, await availabilityWindows.booked(trx, row.id)));
      return AvailabilityListSchema.parse({ windows });
    });
  }

  /* ---------- Requester: requests ---------- */

  async createRequest(input: In<typeof CreateConsultationRequestCommandSchema>, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(input.offeringId)) throw new ApiError('access.not_found');
      const source = input.source;
      const actor = await this.actor(p, input.actor, 'communicate', source.kind === 'plan_item' && UUID.test(source.projectId) ? { kind: 'project', id: source.projectId } : { kind: 'catalogue_offering', id: input.offeringId });
      const facts = await consultationOfferings.facts(trx, input.offeringId);
      if (!facts) throw new ApiError('access.not_found');
      if (facts.status !== 'active') throw new ApiError('validation.schema', 'the offering is not open for requests', { reason: 'offering_unavailable' });
      if (facts.expert_person_id === p.personId || (facts.owner_person_id === p.personId)) throw new ApiError('validation.schema', 'nobody asks itself', { reason: 'self_invitation' });
      if (input.terms.kind !== facts.kind) throw new ApiError('validation.schema', 'the request asks for the kind the offering gives', { reason: 'kind_mismatch' });
      if (!input.terms.preferredModes.some((m) => facts.modes.includes(m))) throw new ApiError('validation.schema', 'none of the preferred modes is offered', { reason: 'mode_not_offered' });
      if (input.terms.licenceRequired && !(facts.licence_credential_id && await consultationOfferings.licenceUsable(trx, facts.licence_credential_id, facts.expert_person_id))) {
        throw new ApiError('validation.schema', 'this expert has no recorded licence for advice that needs one', { reason: 'licence_required' });
      }
      if ((input.terms.kind === 'mentoring') !== (input.mentoringRelationshipId !== null)) throw new ApiError('validation.schema', 'mentoring sessions name their relationship', { reason: 'mentoring_not_active' });
      if (input.mentoringRelationshipId !== null && !UUID.test(input.mentoringRelationshipId)) throw new ApiError('validation.schema', 'unknown relationship', { reason: 'mentoring_not_active' });

      let planRef: { projectId: string; planId: string; planVersionId: string; itemKey: string } | null = null;
      let brief;
      const requestId = randomUUID();
      try {
        if (source.kind === 'plan_item') {
          if (!UUID.test(source.projectId)) throw new ApiError('access.not_found');
          const project = await consultationProjects.owner(trx, source.projectId);
          if (!project) throw new ApiError('access.not_found');
          // ADR 012 decision 37: inside a company every purchase, advice included, starts as a requisition.
          if (project.owner_company_id !== null) throw new ApiError('validation.schema', 'a company buys plan items through requisitions', { reason: 'requisition_required' });
          if (project.owner_person_id !== p.personId) throw new ApiError('access.not_found');
          const plan = await plans.getByProject(trx, source.projectId);
          if (!plan || !plan.current_version_id) throw new ApiError('validation.schema', 'the project has no approved plan', { reason: 'item_not_in_baseline' });
          const items = (await planParts.items(trx, plan.current_version_id)).map(rowToItem);
          const item = items.find((i) => i.key === source.itemKey);
          if (!item) throw new ApiError('validation.schema', 'the item is not in the approved plan', { reason: 'item_not_in_baseline' });
          if (!(CONSULTATION_PLAN_ITEM_KINDS as readonly string[]).includes(item.kind)) throw new ApiError('validation.schema', 'advice is asked about works, decisions, permits and purchases', { reason: 'plan_item_kind' });
          const itemState = await planItemStates.get(trx, plan.id, source.itemKey);
          if (itemState?.path) throw new ApiError('validation.revision_conflict', 'the item already took a path', { reason: 'item_path_taken' });
          if (itemState && itemState.status !== 'proposed' && itemState.status !== 'accepted') throw new ApiError('validation.schema', 'the item is no longer open', { reason: 'invalid_item_transition' });
          const location = await projectLocations.get(trx, source.projectId);
          if (input.terms.kind === 'site_visit' && !location?.address) throw new ApiError('validation.schema', 'a site visit needs the project site', { reason: 'site_location_missing' });
          brief = buildConsultationBrief({ item, location: location ? toLocation(location) : null, terms: input.terms, timeZone: plan.time_zone ?? 'UTC' });
          planRef = { projectId: source.projectId, planId: plan.id, planVersionId: plan.current_version_id, itemKey: source.itemKey };
        } else {
          if (input.terms.kind === 'site_visit') throw new ApiError('validation.schema', 'a site visit is asked about a project item', { reason: 'site_needs_project' });
          brief = buildConsultationBrief({ item: null, location: null, terms: input.terms, timeZone: 'UTC' });
        }
      } catch (error) {
        if (error instanceof ConsultationBriefError) throw new ApiError('validation.schema', 'the brief does not fit the plan item', { reason: error.reason });
        throw error;
      }
      const digest = computeDigest(consultationRequestDigestInput({ requestId, brief }));
      const row = await consultationRequests.insert(trx, {
        id: requestId, requester_person_id: p.personId, offering_id: input.offeringId, project_id: planRef?.projectId ?? null, plan_id: planRef?.planId ?? null,
        plan_version_id: planRef?.planVersionId ?? null, plan_item_key: planRef?.itemKey ?? null, mentoring_relationship_id: input.mentoringRelationshipId, kind: input.terms.kind,
        licence_required: input.terms.licenceRequired, terms: input.terms, brief, digest: digest.value, sent_via: actor.via, sent_mandate_id: actor.mandateId,
      });
      await this.commission.origin?.(trx, 'request', row.id);
      await consultationRequestPrivate.insert(trx, { request_id: row.id, requester_person_id: p.personId, ...privateColumns(input.privateConstraint ?? EMPTY_REQUEST_PRIVATE), updated_by_person_id: p.personId });
      if (planRef) await this.linkPlanItem(trx, p, planRef.planId, planRef.projectId, planRef.itemKey, row.id);
      // Audit names the fields shared, never the question, the materials or any private value.
      await this.audit(trx, p, state, 'consultation.requested', 'consultation_request', row.id, { offeringId: input.offeringId, kind: row.kind, fields: brief.fields, digest: digest.value, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_request', row.id, row.revision, 'consultation.requested', { requestId: row.id, offeringId: input.offeringId, kind: row.kind, via: actor.via });
      return this.requesterView(trx, row);
    });
  }

  async setRequestPrivate(id: string, input: In<typeof SaveRequestPrivateCommandSchema>, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const { expectedRevision, ...fields } = input;
      const saved = await consultationRequestPrivate.update(trx, id, expectedRevision, { ...privateColumns(fields), updated_by_person_id: p.personId });
      if (!saved) throw new ApiError('validation.revision_conflict');
      // Audit names the change only; private values never enter audit, outbox or logs.
      await this.audit(trx, p, state, 'consultation.private_saved', 'consultation_request', id, { revision: saved.revision });
      return this.requesterView(trx, request);
    });
  }

  /** The requester withdraws: an open proposal without a pending acceptance is declined first, then the request closes. */
  async withdrawRequest(id: string, input: In<typeof WithdrawConsultationRequestCommandSchema>, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'consultation', id });
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (request.status !== 'requested' && request.status !== 'offered') throw new ApiError('validation.schema', `a ${request.status} request is not withdrawn`, { reason: 'invalid_transition' });
      const open = (await consultationBookings.listForRequest(trx, id)).find((b) => b.status === 'proposed');
      if (open) {
        if (open.agreement_id) throw new ApiError('validation.revision_conflict', 'withdraw the pending acceptance first', { reason: 'agreement_live' });
        const declined = await consultationBookings.setStatus(trx, open.id, { revision: open.revision, status: 'proposed' }, { status: 'declined', closed_reason: input.reason });
        if (!declined) throw new ApiError('validation.revision_conflict');
      }
      const fresh = (await consultationRequests.get(trx, id)) as ConsultationRequestRow;
      const saved = await consultationRequests.close(trx, id, fresh.revision, { status: 'withdrawn', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.request_withdrawn', 'consultation_request', id, { reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_request', id, saved.revision, 'consultation.request_withdrawn', { requestId: id, status: 'withdrawn', via: actor.via });
      return this.requesterView(trx, saved);
    });
  }

  /** The requester: the requester view; the expert side: the brief; everyone else: not found. */
  async getRequest(id: string, state: RequestState): Promise<RequesterRequestView | ExpertRequestView> {
    if (!state.principal || !UUID.test(id)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const row = await consultationRequests.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      if (row.requester_person_id === p.personId) return this.requesterView(trx, row);
      if (this.actsFor(p, this.expertParty(row))) return this.expertRequestView(trx, row);
      throw new ApiError('access.not_found');
    });
  }

  async listRequests(state: RequestState): Promise<z.infer<typeof ConsultationRequestListSchema>> {
    return this.run(state, async (trx, p) => {
      const [mine, addressed] = await Promise.all([consultationRequests.listForRequester(trx, p.personId), consultationRequests.listForExpert(trx, this.scope(p))]);
      const items = [
        ...mine.map((r) => ({ id: r.id, at: iso(r.updated_at), value: { id: r.id, side: 'requester' as const, kind: r.kind, status: r.status, counterparty: this.expertParty(r), updatedAt: iso(r.updated_at) } })),
        ...addressed.filter((r) => r.requester_person_id !== p.personId).map((r) => ({ id: r.id, at: iso(r.updated_at), value: { id: r.id, side: 'expert' as const, kind: r.kind, status: r.status, counterparty: partyOf(r.requester_person_id, null), updatedAt: iso(r.updated_at) } })),
      ];
      return ConsultationRequestListSchema.parse({ requests: paymentBlindOrder(items).map((x) => x.value) });
    });
  }

  /* ---------- Expert: answering ---------- */

  async declineRequest(id: string, input: In<typeof DeclineConsultationRequestCommandSchema>, state: RequestState): Promise<ExpertRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.expertRequest(trx, p, id);
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'consultation', id });
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (request.status !== 'requested' && request.status !== 'offered') throw new ApiError('validation.schema', `a ${request.status} request is not declined`, { reason: 'invalid_transition' });
      const open = (await consultationBookings.listForRequest(trx, id)).find((b) => b.status === 'proposed');
      if (open) {
        if (open.agreement_id) throw new ApiError('validation.revision_conflict', 'answer the pending acceptance first', { reason: 'agreement_live' });
        const withdrawn = await consultationBookings.setStatus(trx, open.id, { revision: open.revision, status: 'proposed' }, { status: 'withdrawn', closed_reason: input.reason });
        if (!withdrawn) throw new ApiError('validation.revision_conflict');
      }
      const fresh = (await consultationRequests.get(trx, id)) as ConsultationRequestRow;
      const saved = await consultationRequests.close(trx, id, fresh.revision, { status: 'declined', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.request_declined', 'consultation_request', id, { reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_request', id, saved.revision, 'consultation.request_declined', { requestId: id, status: 'declined', via: actor.via });
      return this.expertRequestView(trx, saved);
    });
  }

  /**
   * The expert side proposes the exact terms: the current published catalogue version (by id and digest), the price it
   * gives, the hub's commission, a slot in an open window of the expert (or a due date for an async review), the
   * cancellation terms and the licence label, frozen and digest-bound from this moment.
   */
  async propose(requestId: string, input: In<typeof ProposeConsultationCommandSchema>, state: RequestState): Promise<ExpertRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.expertRequest(trx, p, requestId);
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (request.status !== 'requested') throw new ApiError('validation.revision_conflict', 'the request is not waiting for a proposal', { reason: request.status === 'offered' ? 'proposal_open' : 'request_not_open' });
      const offering = await consultationOfferings.get(trx, request.offering_id);
      if (!offering) throw new ApiError('access.not_found');
      if (offering.status !== 'active') throw new ApiError('validation.schema', 'the offering is not active', { reason: 'offering_unavailable' });
      const terms = offeringTerms(offering);
      const brief = ConsultationBriefSchema.parse(request.brief);
      const current = await consultationOfferings.currentVersion(trx, offering.offering_id);
      if (!current) throw new ApiError('validation.schema', 'the catalogue offering has no published version', { reason: 'offering_unavailable' });
      const catalogue = OfferingVersionPayloadSchema.parse(current.payload);
      const now = this.now();
      if (Date.parse(input.validUntil) <= now.getTime()) throw new ApiError('validation.schema', 'the proposal is valid in the future', { reason: 'validity_in_past' });
      if (isSyncMode(input.mode) !== (input.slot !== null) || isSyncMode(input.mode) === (input.deliverableDue !== null)) {
        throw new ApiError('validation.schema', 'synchronous modes book a slot; async reviews name a due date', { reason: 'slot_shape' });
      }
      let window: { window_id: string; starts_at: Date; ends_at: Date; time_zone: string; status: string; expert_person_id: string } | undefined;
      let slot: { start: string; end: string } | null = null;
      if (input.slot) {
        if (!UUID.test(input.slot.windowId)) throw new ApiError('validation.schema', 'unknown window', { reason: 'slot_unavailable' });
        window = await availabilityWindows.facts(trx, input.slot.windowId);
        if (!window || window.expert_person_id !== offering.expert_person_id || window.status !== 'open') throw new ApiError('validation.revision_conflict', 'the slot lies in an open window of the expert', { reason: 'slot_unavailable' });
        slot = { start: new Date(input.slot.start).toISOString(), end: new Date(Date.parse(input.slot.start) + terms.durationMinutes * 60_000).toISOString() };
      }
      const label = credentialLabel(await consultationOfferings.credential(trx, offering.offering_id), this.today());
      const misfits = proposalMisfits({
        brief, offering: terms, mode: input.mode, slot, window: window ? { startsAt: iso(window.starts_at), endsAt: iso(window.ends_at) } : null, deliverableDue: input.deliverableDue,
        credential: label, now,
      });
      if (misfits.length > 0) throw new ApiError('validation.schema', 'the proposal does not fit the request and the offering', { reason: misfits[0], reasons: misfits });
      let price;
      try {
        price = consultationPrice({ pricing: terms.pricing, listPrice: catalogue.listPrice, unit: catalogue.unit, minutes: terms.durationMinutes });
      } catch (error) {
        if (error instanceof ConsultationPriceError) throw new ApiError('validation.schema', 'the catalogue version does not give this price', { reason: error.reason });
        throw error;
      }
      const amount = priceAmount(price);
      const expert = this.expertParty(request);
      const commission = await this.commission.quote(trx, { kind: terms.kind, price: amount, expert, at: now, requestId });
      const pricing = pricingSummary(price, commission);
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'consultation', id: requestId }, pricing.clientTotal);
      await this.screening.requireTransactable(trx, [{ party: expert, self: true }, { party: { kind: 'person', id: p.personId }, self: true }, { party: { kind: 'person', id: request.requester_person_id }, self: false }], 'consultation.propose', now);
      const bookingTerms = BookingTermsSchema.parse({
        request: { id: request.id, version: 1, digest: digestOf(request.digest) },
        offering: { offeringId: offering.offering_id, version: { id: current.version_id, version: current.version, digest: digestOf(current.digest) }, title: catalogue.title },
        expert: { party: expert, personId: offering.expert_person_id }, client: partyOf(request.requester_person_id, null), kind: terms.kind, mode: input.mode, slot,
        windowId: window?.window_id ?? null, durationMinutes: terms.durationMinutes, deliverableKind: terms.deliverableKind, deliverableDue: input.deliverableDue, pricing,
        cancellation: terms.cancellation, recordingOffered: terms.recordingOffered, credential: label, timeZone: window?.time_zone ?? brief.timeZone, validUntil: input.validUntil, note: input.note,
      });
      const bookingId = randomUUID();
      const digest = computeDigest(bookingTermsDigestInput({ bookingId, terms: bookingTerms }));
      const sellerCols = columnsOf(expert);
      const row = await consultationBookings.insert(trx, {
        id: bookingId, request_id: request.id, offering_id: offering.offering_id, offering_version_id: current.version_id, offering_version: current.version, offering_version_digest: current.digest,
        expert_person_id: offering.expert_person_id, seller_person_id: sellerCols.person, seller_company_id: sellerCols.company, client_person_id: request.requester_person_id, kind: terms.kind,
        mode: input.mode, window_id: window?.window_id ?? null, slot_start: slot?.start ?? null, slot_end: slot?.end ?? null, deliverable_due: input.deliverableDue, terms: bookingTerms,
        terms_digest: digest.value, valid_until: input.validUntil, proposed_by_person_id: p.personId, proposed_via: actor.via, proposed_mandate_id: actor.mandateId,
      });
      await this.commission.proposed?.(trx, row.id);
      await this.audit(trx, p, state, 'consultation.proposed', 'consultation_booking', row.id, { requestId, digest: digest.value, offeringVersion: current.version, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_booking', row.id, row.revision, 'consultation.proposed', { requestId, bookingId: row.id, via: actor.via });
      return this.expertRequestView(trx, (await consultationRequests.get(trx, requestId)) as ConsultationRequestRow);
    });
  }

  async withdrawProposal(bookingId: string, input: In<typeof WithdrawProposalCommandSchema>, state: RequestState): Promise<ExpertRequestView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.partyBooking(trx, p, bookingId, true);
      if (side !== 'expert') throw new ApiError('access.forbidden', 'the expert side withdraws its proposal', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, 'send_quote', { kind: 'consultation', id: row.request_id });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'proposed') throw new ApiError('validation.schema', `a ${row.status} booking is not withdrawn`, { reason: 'invalid_transition' });
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: 'proposed' }, { status: 'withdrawn', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.proposal_withdrawn', 'consultation_booking', row.id, { reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, 'consultation.proposal_withdrawn', { requestId: row.request_id, bookingId: row.id, status: 'withdrawn', via: actor.via });
      return this.expertRequestView(trx, (await consultationRequests.get(trx, row.request_id)) as ConsultationRequestRow);
    });
  }

  /* ---------- Agreement ---------- */

  private async recordEvent(trx: Transaction, p: Principal, row: AgreementRow, kind: AcceptanceEventRow['kind'], party: Party, actor: ResolvedActor, key: string, extra: { consent?: ReturnType<ConsultationsService['consent']>; reason?: string | null } = {}): Promise<AcceptanceEventRow> {
    const cols = columnsOf(party);
    return acceptanceEvents.insert(trx, {
      agreement_id: row.id, kind, terms_kind: 'consultation', quote_version_id: null, rfq_version_id: null, offer_version: row.offer_version, offer_digest: row.offer_digest, request_version: row.request_version,
      request_digest: row.request_digest, accepted_terms_digest: row.accepted_terms_digest, actor_person_id: p.personId, on_behalf_person_id: cols.person, on_behalf_company_id: cols.company,
      via: actor.via, mandate_id: actor.mandateId, transaction_budget_id: null, reservation_id: null, platform_budget_id: null, e_records_required: extra.consent?.required ?? false,
      e_records_disclosure_key: extra.consent?.disclosureKey ?? null, e_records_basis: extra.consent?.basis ?? [], e_records_consented_at: extra.consent?.at ?? null, reason: extra.reason ?? null, idempotency_key: key,
    });
  }

  /** Both stored digests recomputed from their frozen content (tamper check), then the agreement digest from the two refs. */
  private verified(request: ConsultationRequestRow, booking: ConsultationBookingRow): { bookingRef: { id: string; version: number; digest: Digest }; requestRef: { id: string; version: number; digest: Digest }; digest: Digest } {
    const requestRef = { id: request.id, version: 1, digest: digestOf(request.digest) };
    const bookingRef = { id: booking.id, version: 1, digest: digestOf(booking.terms_digest) };
    const requestOk = verifyDigest(consultationRequestDigestInput({ requestId: request.id, brief: ConsultationBriefSchema.parse(request.brief) }), requestRef.digest);
    const bookingOk = verifyDigest(bookingTermsDigestInput({ bookingId: booking.id, terms: this.terms(booking) }), bookingRef.digest);
    if (!requestOk || !bookingOk) throw new ApiError('commercial.digest_mismatch', 'a stored record no longer reproduces its digest', { reason: 'digest_mismatch' });
    return { bookingRef, requestRef, digest: computeAgreementDigest(bookingRef, requestRef, 'consultation') };
  }

  /**
   * The client accepts the exact proposal against its own request, by id and digest (a person's decision; an agent
   * needs a place_order mandate and never goes above the private budget ceiling). Both parties pass the screening gate.
   * The request row is locked and the database allows one pending acceptance per request.
   */
  async acceptProposal(requestId: string, input: In<typeof AcceptProposalCommandSchema>, key: string, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      const request = await this.ownRequest(trx, p, requestId);
      if (!UUID.test(input.booking.id)) throw new ApiError('access.not_found');
      const booking = await consultationBookings.lock(trx, input.booking.id);
      if (!booking || booking.request_id !== requestId) throw new ApiError('access.not_found');
      const terms = this.terms(booking);
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'consultation', id: requestId }, terms.pricing.clientTotal);
      if (request.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (actor.via === 'agent' && terms.pricing.clientTotal) {
        const own = await consultationRequestPrivate.get(trx, requestId);
        const ceiling = money(own?.budget_ceiling_minor ?? null, own?.budget_ceiling_currency ?? null);
        if (ceiling && (ceiling.currency !== terms.pricing.clientTotal.currency || BigInt(terms.pricing.clientTotal.minorUnits) > BigInt(ceiling.minorUnits))) {
          throw new ApiError('access.mandate_scope', 'the agent acts only within the requester\'s private limits', { reason: 'outside_private_constraints' });
        }
      }
      if (input.request.id !== request.id || input.request.version !== 1) throw new ApiError('commercial.rfq_version_mismatch', CHECK_MESSAGES['commercial.rfq_version_mismatch'], { reason: 'rfq_version_mismatch' });
      const check = checkBookingAcceptance({
        booking: { id: booking.id, status: booking.status, digest: booking.terms_digest, validUntil: iso(booking.valid_until), agreementId: booking.agreement_id }, bookingRef: input.booking,
        request: { id: request.id, status: request.status, digest: request.digest }, requestRefDigest: input.request.digest.value, now: this.now(),
      });
      if (check !== 'ok') throw new ApiError(check, CHECK_MESSAGES[check], { reason: check.slice('commercial.'.length) });
      if (input.recordingConsent && !terms.recordingOffered) throw new ApiError('validation.schema', 'recording is not offered for this consultation', { reason: 'recording_not_offered' });
      await this.screening.requireTransactable(trx, [{ party: { kind: 'person', id: p.personId }, self: true }, { party: terms.expert.party, self: false }], 'consultation.accept', this.now());
      const consent = this.consent(input.electronicRecords);
      const verified = this.verified(request, booking);
      await this.commission.confirmed?.(trx, booking.id, 'buyer');
      const seller = columnsOf(terms.expert.party);
      const agreement = await consultationAgreements.insert(trx, {
        buyer_person_id: p.personId, seller_person_id: seller.person, seller_company_id: seller.company, offer_ref_id: booking.id, request_ref_id: request.id,
        offer_digest: verified.bookingRef.digest.value, request_digest: verified.requestRef.digest.value, accepted_terms_digest: verified.digest.value, created_by_person_id: p.personId,
      });
      const event = await this.recordEvent(trx, p, agreement, 'buyer_accepts_terms', { kind: 'person', id: p.personId }, actor, key, { consent });
      if (!(await consultationBookings.linkAgreement(trx, booking.id, { agreement_id: agreement.id, recording_consent: input.recordingConsent }))) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.accepted', 'agreement', agreement.id, { requestId, bookingId: booking.id, digest: verified.digest.value, eventId: event.id, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', agreement.id, agreement.revision, 'consultation.accepted', { agreementId: agreement.id, requestId, bookingId: booking.id, eventKind: 'buyer_accepts_terms', termsKind: 'consultation', via: actor.via });
      return this.requesterView(trx, (await consultationRequests.get(trx, requestId)) as ConsultationRequestRow);
    });
  }

  async declineProposal(bookingId: string, input: In<typeof DeclineProposalCommandSchema>, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.partyBooking(trx, p, bookingId, true);
      if (side !== 'client') throw new ApiError('access.forbidden', 'the client declines a proposal', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'consultation', id: row.request_id });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'proposed' || row.agreement_id !== null) throw new ApiError('validation.schema', 'only an open proposal is declined', { reason: 'invalid_transition' });
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: 'proposed' }, { status: 'declined', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.proposal_declined', 'consultation_booking', row.id, { reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, 'consultation.proposal_declined', { requestId: row.request_id, bookingId: row.id, status: 'declined', via: actor.via });
      return this.requesterView(trx, (await consultationRequests.get(trx, row.request_id)) as ConsultationRequestRow);
    });
  }

  private async lockAgreement(trx: Transaction, agreementId: string): Promise<{ agreement: AgreementRow; booking: ConsultationBookingRow; request: ConsultationRequestRow }> {
    if (!UUID.test(agreementId)) throw new ApiError('access.not_found');
    const agreement = await consultationAgreements.lock(trx, agreementId);
    if (!agreement || !agreement.offer_ref_id || !agreement.request_ref_id) throw new ApiError('access.not_found');
    const booking = await consultationBookings.lock(trx, agreement.offer_ref_id);
    const request = await consultationRequests.get(trx, agreement.request_ref_id);
    if (!booking || !request) throw new ApiError('access.not_found');
    return { agreement, booking, request };
  }

  async withdrawAcceptance(agreementId: string, input: In<typeof WithdrawAcceptanceCommandSchema>, key: string, state: RequestState): Promise<RequesterRequestView> {
    return this.run(state, async (trx, p) => {
      const { agreement, booking, request } = await this.lockAgreement(trx, agreementId);
      if (agreement.buyer_person_id !== p.personId) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'place_order', { kind: 'agreement', id: agreementId });
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not withdrawn`, { reason: 'invalid_transition' });
      await this.recordEvent(trx, p, agreement, 'withdrawn', { kind: 'person', id: p.personId }, actor, key, { reason: input.reason });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'withdrawn', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      if (!(await consultationBookings.setStatus(trx, booking.id, { revision: booking.revision, status: 'proposed' }, { status: 'withdrawn', closed_reason: input.reason }))) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.acceptance_withdrawn', 'agreement', agreementId, { requestId: request.id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'consultation.acceptance_withdrawn', { agreementId, requestId: request.id, eventKind: 'withdrawn', termsKind: 'consultation', via: actor.via });
      return this.requesterView(trx, (await consultationRequests.get(trx, request.id)) as ConsultationRequestRow);
    });
  }

  /**
   * The expert side confirms the agreement, stating the digest it accepts (it must equal the digest recomputed from the
   * stored request and proposal). In the same transaction: the agreement is accepted by both, the obligations are
   * recorded (perform, pay when priced, accept), the booking takes the window's capacity (serialized in the database),
   * the session opens (a site visit's site becomes readable to the expert) and the reminders are scheduled.
   */
  async confirmBooking(agreementId: string, input: In<typeof ConfirmBookingCommandSchema>, key: string, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      const { agreement, booking, request } = await this.lockAgreement(trx, agreementId);
      const seller = partyOf(agreement.seller_person_id, agreement.seller_company_id);
      if (!this.actsFor(p, seller)) throw new ApiError('access.not_found');
      const terms = this.terms(booking);
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: agreementId }, terms.pricing.clientTotal);
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not confirmed`, { reason: 'invalid_transition' });
      const verified = this.verified(request, booking);
      if (verified.digest.value !== agreement.accepted_terms_digest || input.acceptedTermsDigest.value !== agreement.accepted_terms_digest) {
        throw new ApiError('commercial.digest_mismatch', CHECK_MESSAGES['commercial.digest_mismatch'], { reason: 'digest_mismatch' });
      }
      await this.screening.requireTransactable(trx, [{ party: seller, self: true }, { party: { kind: 'person', id: p.personId }, self: true }, { party: terms.client, self: false }], 'consultation.confirm', this.now());
      const consent = this.consent(input.electronicRecords);
      await this.commission.confirmed?.(trx, booking.id, 'seller');
      const event = await this.recordEvent(trx, p, agreement, 'seller_accepts_order', seller, actor, key, { consent });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'accepted_by_both' });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await obligations.insertMany(trx, agreementId, deriveConsultationObligations(terms).map((o, position) => ({
        position, obligor_person_id: columnsOf(o.party).person, obligor_company_id: columnsOf(o.party).company, kind: o.kind, due: o.due, amount_minor: o.amount?.minorUnits ?? null,
        currency: o.amount?.currency ?? null, scope_value: null, scope_unit: null,
      })));
      const booked = await consultationBookings.setStatus(trx, booking.id, { revision: booking.revision, status: 'proposed' }, { status: 'booked', booked_at: this.now() });
      if (!booked) throw new ApiError('validation.revision_conflict');
      // The authenticated confirmation creates only the context shell, not a participant-authored message.
      await threads.open(trx, { kind: 'agreement', id: agreementId, counterparty: { person: null, company: null },
        subject: ConsultationRequestTermsSchema.parse(request.terms).question.slice(0, 200), openedBy: p.personId });
      await consultationSessions.open(trx, booking.id);
      await consultationReminders.insertMany(trx, reminderTimes(terms.slot, this.now()).map((r) => ({ booking_id: booking.id, agreement_id: agreementId, source_hub_id: this.sourceHubId, remind_at: r.remindAt, offset_minutes: r.offsetMinutes })));
      await this.audit(trx, p, state, 'consultation.booked', 'consultation_booking', booking.id, { agreementId, requestId: request.id, digest: saved.accepted_terms_digest, eventId: event.id, via: actor.via, mandateId: actor.mandateId, electronicRecords: consent.disclosureKey });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'consultation.booked', { agreementId, requestId: request.id, bookingId: booking.id, eventKind: 'seller_accepts_order', termsKind: 'consultation', via: actor.via });
      return this.bookingView(trx, p, (await consultationBookings.get(trx, booking.id)) as ConsultationBookingRow);
    });
  }

  async declineAgreement(agreementId: string, input: In<typeof DeclineAgreementCommandSchema>, key: string, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      const { agreement, booking, request } = await this.lockAgreement(trx, agreementId);
      const seller = partyOf(agreement.seller_person_id, agreement.seller_company_id);
      if (!this.actsFor(p, seller)) throw new ApiError('access.not_found');
      const actor = await this.actor(p, input.actor, 'accept_order', { kind: 'agreement', id: agreementId });
      if (agreement.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (agreement.status !== 'accepted_by_buyer') throw new ApiError('validation.schema', `a ${agreement.status} agreement is not declined`, { reason: 'invalid_transition' });
      await this.recordEvent(trx, p, agreement, 'seller_declines', seller, actor, key, { reason: input.reason });
      const saved = await agreements.setStatus(trx, agreementId, input.expectedRevision, { status: 'declined', closed_reason: input.reason });
      if (!saved) throw new ApiError('validation.revision_conflict');
      if (!(await consultationBookings.setStatus(trx, booking.id, { revision: booking.revision, status: 'proposed' }, { status: 'declined', closed_reason: input.reason }))) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.agreement_declined', 'agreement', agreementId, { requestId: request.id, bookingId: booking.id, reason: input.reason, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', agreementId, saved.revision, 'consultation.agreement_declined', { agreementId, requestId: request.id, bookingId: booking.id, eventKind: 'seller_declines', termsKind: 'consultation', via: actor.via });
      return this.bookingView(trx, p, (await consultationBookings.get(trx, booking.id)) as ConsultationBookingRow);
    });
  }

  /* ---------- Booking life ---------- */

  /** A party cancels for its own side, or records the other side's absence after the start; the charge follows the booked terms (CONS-002 settles it). */
  async cancel(bookingId: string, input: In<typeof CancelBookingCommandSchema>, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.partyBooking(trx, p, bookingId, true);
      const actor = await this.actor(p, input.actor, 'schedule', { kind: 'consultation', id: row.request_id });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'booked') throw new ApiError('validation.schema', `a ${row.status} booking is not cancelled`, { reason: 'invalid_transition' });
      const allowed = input.kind === 'no_show' ? input.absentSide !== side : input.kind === side;
      if (!allowed) throw new ApiError('validation.schema', 'a party cancels for its own side or records the other side\'s absence', { reason: 'cancellation_not_allowed' });
      const terms = this.terms(row);
      const at = this.now();
      const charge = cancellationCharge(terms, { kind: input.kind, absentSide: input.absentSide, at });
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: 'booked' }, {
        status: 'cancelled', closed_reason: input.reason, cancellation_kind: input.kind, cancellation_absent_side: input.absentSide, cancellation_charge_minor: charge?.minorUnits ?? null,
        cancellation_charge_currency: charge?.currency ?? null, cancelled_at: at, cancelled_by_person_id: p.personId,
      });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await consultationReminders.cancelFor(trx, row.id);
      await this.audit(trx, p, state, 'consultation.cancelled', 'consultation_booking', row.id, { kind: input.kind, absentSide: input.absentSide, charged: charge !== null, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, 'consultation.cancelled', { bookingId: row.id, agreementId: row.agreement_id, status: 'cancelled', kind: input.kind, via: actor.via });
      return this.bookingView(trx, p, saved);
    });
  }

  async recordSession(bookingId: string, input: In<typeof RecordSessionCommandSchema>, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      const { row } = await this.partyBooking(trx, p, bookingId, true);
      const actor = await this.actor(p, input.actor, 'record_evidence', { kind: 'consultation', id: row.request_id });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'booked' || row.slot_start === null) throw new ApiError('validation.schema', 'a session is recorded for a booked synchronous consultation', { reason: 'invalid_transition' });
      if (Date.parse(input.endedAt) > this.now().getTime() + 600_000) throw new ApiError('validation.schema', 'a session is recorded once it took place', { reason: 'session_not_recorded' });
      const recorded = await consultationSessions.record(trx, row.id, { started_at: input.startedAt, ended_at: input.endedAt, recorded_by_person_id: p.personId, attendance: { client: 'attended', expert: 'attended' } });
      if (!recorded) throw new ApiError('validation.revision_conflict', 'the session is already recorded', { reason: 'session_recorded' });
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: 'booked' }, { status: 'held' });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.held', 'consultation_booking', row.id, { via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, 'consultation.held', { bookingId: row.id, status: 'held', via: actor.via });
      return this.bookingView(trx, p, saved);
    });
  }

  /**
   * The expert delivers in person: an EXE-001 `service_delivered` claim on the expert's perform obligation and the
   * deliverable that cites it, in one transaction. The client decides; the claim is never a fact because it was said.
   */
  async deliver(bookingId: string, input: In<typeof RecordDeliverableCommandSchema>, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      const { row, side } = await this.partyBooking(trx, p, bookingId, true);
      if (side !== 'expert') throw new ApiError('access.forbidden', 'the expert side delivers', { reason: 'not_authorised' });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const due = row.slot_start === null ? 'booked' : 'held';
      if (row.status !== due || !row.agreement_id) throw new ApiError('validation.revision_conflict', 'the booking is not due for delivery', { reason: 'not_deliverable' });
      const perform = (await executionAgreements.obligations(trx, row.agreement_id)).find((o) => o.kind === 'perform' && o.status !== 'waived');
      if (!perform) throw new ApiError('validation.schema', 'the agreement has no perform obligation', { reason: 'unknown_obligation' });
      const seller = columnsOf(this.sellerParty(row));
      const claim = await executionClaims.insert(trx, {
        agreement_id: row.agreement_id, obligation_id: perform.id, defect_id: null, kind: 'service_delivered', claimant_person_id: seller.person, claimant_company_id: seller.company, lines: [],
        period_from: null, period_to: null, performed_at: this.now(), statement: null, supersedes_claim_id: null, recorded_by_person_id: p.personId, via: 'person', mandate_id: null,
      });
      const deliverable = await consultationDeliverables.insert(trx, {
        booking_id: row.id, agreement_id: row.agreement_id, kind: input.kind, title: input.title, body: input.body, attachments: input.attachments, claim_id: claim.id, author_person_id: p.personId,
        seller_person_id: seller.person, seller_company_id: seller.company, client_person_id: row.client_person_id,
      });
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: row.status }, { status: 'delivered' });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.delivered', 'consultation_deliverable', deliverable.id, { bookingId: row.id, claimId: claim.id, kind: input.kind });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, 'consultation.delivered', { bookingId: row.id, deliverableId: deliverable.id, claimId: claim.id, status: 'delivered' });
      return this.bookingView(trx, p, saved);
    });
  }

  /**
   * The client accepts or rejects the latest deliverable in person (`confirm_execution` is human-only): an EXE-001
   * confirmation of the expert's claim. Acceptance completes the booking, derives the performance observations (from
   * which REP-001 counts `consultation_given`) and finishes the plan item; a rejection reopens the delivery.
   */
  async decideDeliverable(deliverableId: string, input: In<typeof DecideDeliverableCommandSchema>, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(deliverableId)) throw new ApiError('access.not_found');
      const deliverable = await consultationDeliverables.lock(trx, deliverableId);
      if (!deliverable) throw new ApiError('access.not_found');
      const { row, side } = await this.partyBooking(trx, p, deliverable.booking_id, true);
      if (side !== 'client') throw new ApiError('access.forbidden', 'the client decides on the deliverable', { reason: 'not_authorised' });
      if (row.status !== 'delivered' || deliverable.decision !== null) throw new ApiError('validation.revision_conflict', 'the deliverable is decided', { reason: 'decision_recorded' });
      const confirmation = await executionConfirmations.insert(trx, {
        claim_id: deliverable.claim_id, agreement_id: deliverable.agreement_id, decision: input.decision, lines: [], note: input.note, stage_code: null, decided_by_person_id: p.personId,
        on_behalf_person_id: p.personId, on_behalf_company_id: null,
      });
      if (!(await consultationDeliverables.decide(trx, deliverable.id, { confirmation_id: confirmation.id, decision: input.decision, decided_at: this.now() }))) throw new ApiError('validation.revision_conflict');
      const next = statusAfterDecision(input.decision, row.mode);
      const saved = await consultationBookings.setStatus(trx, row.id, { revision: row.revision, status: 'delivered' }, { status: next });
      if (!saved) throw new ApiError('validation.revision_conflict');
      if (input.decision === 'accepted') {
        await executionAgreements.observe(trx, deliverable.agreement_id);
        const request = await consultationRequests.get(trx, row.request_id);
        if (request) await this.completePlanItem(trx, p, request);
      }
      await this.audit(trx, p, state, `consultation.deliverable_${input.decision}`, 'consultation_deliverable', deliverable.id, { bookingId: row.id, confirmationId: confirmation.id, status: next });
      await this.event(trx, 'consultation_booking', row.id, saved.revision, `consultation.deliverable_${input.decision}`, { bookingId: row.id, deliverableId: deliverable.id, confirmationId: confirmation.id, status: next });
      return this.bookingView(trx, p, saved);
    });
  }

  /** The author publishes its own deliverable (title and body only; never the client, the project or attachments). */
  async publishDeliverable(deliverableId: string, _input: In<typeof PublishDeliverableCommandSchema>, state: RequestState): Promise<BookingView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(deliverableId)) throw new ApiError('access.not_found');
      const deliverable = await consultationDeliverables.lock(trx, deliverableId);
      if (!deliverable) throw new ApiError('access.not_found');
      const { row } = await this.partyBooking(trx, p, deliverable.booking_id, false);
      if (deliverable.author_person_id !== p.personId) throw new ApiError('access.forbidden', 'only the author publishes', { reason: 'not_author' });
      if (deliverable.published_at !== null) throw new ApiError('validation.revision_conflict', 'already published', { reason: 'published' });
      const published = await consultationDeliverables.publish(trx, deliverable.id, this.now());
      if (!published) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'consultation.deliverable_published', 'consultation_deliverable', deliverable.id, { bookingId: row.id });
      await this.event(trx, 'consultation_deliverable', deliverable.id, 1, 'consultation.deliverable_published', { deliverableId: deliverable.id, bookingId: row.id });
      return this.bookingView(trx, p, row);
    });
  }

  /** A published deliverable for anyone (anonymous too); otherwise not found. */
  async publicDeliverable(deliverableId: string, state: RequestState): Promise<z.infer<typeof PublicDeliverableSchema>> {
    if (!UUID.test(deliverableId)) throw new ApiError('access.not_found');
    return this.read(state, async (trx) => {
      const row = await consultationDeliverables.publicOne(trx, deliverableId);
      if (!row) throw new ApiError('access.not_found');
      return PublicDeliverableSchema.parse({
        id: row.deliverable_id, kind: row.kind, consultationKind: row.consultation_kind, title: row.title, body: row.body, author: partyOf(row.author_person_id, row.author_company_id),
        publishedAt: iso(row.published_at),
      });
    });
  }

  /* ---------- Reads ---------- */

  async getBooking(id: string, state: RequestState): Promise<BookingView> {
    if (!state.principal || !UUID.test(id)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => this.bookingView(trx, p, (await this.partyBooking(trx, p, id, false)).row));
  }

  async listBookings(state: RequestState): Promise<z.infer<typeof BookingListSchema>> {
    return this.run(state, async (trx, p) => {
      const rows = await consultationBookings.listForParties(trx, this.scope(p));
      const bookings = rows.map((row) => {
        const terms = this.terms(row);
        const side = row.client_person_id === p.personId ? 'client' as const : 'expert' as const;
        return { id: row.id, side, kind: row.kind, mode: row.mode, status: row.status, slot: terms.slot, title: terms.offering.title, counterparty: side === 'client' ? terms.expert.party : terms.client };
      });
      return BookingListSchema.parse({ bookings });
    });
  }

  /** A calendar file for a booked synchronous consultation (title and times only; never the site, a link or a price). */
  async calendar(id: string, state: RequestState): Promise<z.infer<typeof CalendarFileSchema>> {
    if (!state.principal || !UUID.test(id)) throw new ApiError('access.not_found');
    return this.run(state, async (trx, p) => {
      const { row } = await this.partyBooking(trx, p, id, false);
      const terms = this.terms(row);
      if (!terms.slot || !['booked', 'held', 'delivered', 'accepted', 'cancelled'].includes(row.status) || row.booked_at === null) {
        throw new ApiError('validation.schema', 'a calendar file exists for a booked session', { reason: 'not_booked' });
      }
      const host = new URL(this.ctx.config.publicOrigin || 'https://trustwork.invalid').host;
      const content = bookingCalendar({ bookingId: row.id, title: terms.offering.title, slot: terms.slot, sequence: row.status === 'cancelled' ? 1 : 0, cancelled: row.status === 'cancelled', hubHost: host, stamp: this.now() });
      return CalendarFileSchema.parse({ fileName: `consultation-${row.id.slice(0, 8)}.ics`, mediaType: 'text/calendar', content });
    });
  }

  /* ---------- Mentoring ---------- */

  async proposeMentoring(input: In<typeof ProposeMentoringCommandSchema>, state: RequestState): Promise<z.infer<typeof MentoringRelationshipSchema>> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(input.counterpart) || input.counterpart === p.personId) throw new ApiError('validation.schema', 'a relationship names another person', { reason: 'self_invitation' });
      if (input.offeringId !== null && !UUID.test(input.offeringId)) throw new ApiError('validation.schema', 'unknown offering', { reason: 'mentoring_offering' });
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'profile', id: p.personId });
      const [mentor, mentee] = input.myRole === 'mentor' ? [p.personId, input.counterpart] : [input.counterpart, p.personId];
      const row = await mentoringRelationships.insert(trx, { mentor_person_id: mentor, mentee_person_id: mentee, proposed_by_person_id: p.personId, topics: input.topics, terms: input.terms, offering_id: input.offeringId });
      await this.audit(trx, p, state, 'consultation.mentoring_proposed', 'mentoring_relationship', row.id, { terms: row.terms, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'mentoring_relationship', row.id, row.revision, 'consultation.mentoring_proposed', { relationshipId: row.id, status: row.status, via: actor.via });
      return mentoringContract(row);
    });
  }

  private async ownRelationship(trx: Transaction, p: Principal, id: string): Promise<MentoringRelationshipRow> {
    if (!UUID.test(id)) throw new ApiError('access.not_found');
    const row = await mentoringRelationships.lock(trx, id);
    if (!row || (row.mentor_person_id !== p.personId && row.mentee_person_id !== p.personId)) throw new ApiError('access.not_found');
    return row;
  }

  async respondMentoring(id: string, input: In<typeof RespondMentoringCommandSchema>, state: RequestState): Promise<z.infer<typeof MentoringRelationshipSchema>> {
    return this.run(state, async (trx, p) => {
      const row = await this.ownRelationship(trx, p, id);
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'profile', id: p.personId });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      if (row.status !== 'proposed' || row.proposed_by_person_id === p.personId) throw new ApiError('validation.schema', 'the other person answers a proposal', { reason: 'invalid_transition' });
      const saved = await mentoringRelationships.setStatus(trx, id, row.revision, { status: input.decision === 'accept' ? 'active' : 'declined', ended_reason: null });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, `consultation.mentoring_${input.decision === 'accept' ? 'accepted' : 'declined'}`, 'mentoring_relationship', id, { via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'mentoring_relationship', id, saved.revision, 'consultation.mentoring_answered', { relationshipId: id, status: saved.status, via: actor.via });
      return mentoringContract(saved);
    });
  }

  async changeMentoring(id: string, input: In<typeof ChangeMentoringCommandSchema>, state: RequestState): Promise<z.infer<typeof MentoringRelationshipSchema>> {
    return this.run(state, async (trx, p) => {
      const row = await this.ownRelationship(trx, p, id);
      const actor = await this.actor(p, input.actor, 'communicate', { kind: 'profile', id: p.personId });
      if (row.revision !== input.expectedRevision) throw new ApiError('validation.revision_conflict');
      const saved = await mentoringRelationships.setStatus(trx, id, row.revision, { status: input.to, ended_reason: input.to === 'ended' ? input.reason : null });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, `consultation.mentoring_${input.to}`, 'mentoring_relationship', id, { via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'mentoring_relationship', id, saved.revision, 'consultation.mentoring_changed', { relationshipId: id, status: saved.status, via: actor.via });
      return mentoringContract(saved);
    });
  }

  async listMentoring(state: RequestState): Promise<z.infer<typeof MentoringListSchema>> {
    return this.run(state, async (trx, p) => MentoringListSchema.parse({ relationships: (await mentoringRelationships.listFor(trx, p.personId)).map(mentoringContract) }));
  }
}
