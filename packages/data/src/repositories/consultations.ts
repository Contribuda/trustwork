import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  AvailabilityWindowRow, BookingStatusValue, ConsultationBookingRow, ConsultationDeliverableRow, ConsultationKindValue, ConsultationModeValue, ConsultationOfferingRow,
  ConsultationReminderRow, ConsultationRequestPrivateRow, ConsultationRequestRow, ConsultationSessionRow, ConsultationVia, DeliverableKindValue, MentoringRelationshipRow,
  MentoringStatusValue, OfferingStatusValue, PricingModeValue, RequestStatusValue,
} from '../schema/consultations.js';
import type { AgreementRow } from '../schema/transactions.js';

/**
 * Consultations repository (CONS-001). Thin typed access under `withPrincipal`: RLS scopes every read and write (the
 * expert side of an offering and its requests and bookings, the requester of a request, the two parties of a booking),
 * and the guards in packages/data/migrations/consultations freeze sent requests and proposed terms, pin proposals to the
 * current catalogue version, serialize capacity, check every digest the agreement repeats and keep everything retained.
 * Owner-run reads (public offerings, offering facts, free windows, the site of a booked site visit, published
 * deliverables) return allowlisted fields only.
 */
const json = (value: unknown): string => JSON.stringify(value);
export type ConsultationPartyScope = { personId: string; companyId: string | null };

/* ---------- Offerings ---------- */

export interface ConsultationOfferingColumns {
  kind: ConsultationKindValue; modes: ConsultationModeValue[]; topics: string[]; regions: string[]; languages: string[]; duration_minutes: number; deliverable_kind: DeliverableKindValue;
  pricing: PricingModeValue; cancellation: unknown; licence_required: boolean; licence_credential_id: string | null; recording_offered: boolean;
}
export interface OfferingFactsRow {
  offering_id: string; owner_person_id: string | null; owner_company_id: string | null; expert_person_id: string; kind: ConsultationKindValue; status: OfferingStatusValue;
  licence_required: boolean; licence_credential_id: string | null; modes: ConsultationModeValue[]; regions: string[]; duration_minutes: number; pricing: PricingModeValue;
}
export interface CredentialFactsRow {
  credential_id: string; jurisdiction: string; credential_type: string; valid_until: string | Date | null; last_outcome: string | null; register_valid_until: string | Date | null;
  checked_at: Date | null; superseded: boolean;
}
export interface PublicConsultationOfferingRow {
  offering_id: string; owner_person_id: string | null; owner_company_id: string | null; kind: ConsultationKindValue; modes: ConsultationModeValue[]; topics: string[]; regions: string[];
  languages: string[]; duration_minutes: number; deliverable_kind: DeliverableKindValue; pricing: PricingModeValue; title: string | null; list_price: unknown; credential_id: string | null;
  created_at: Date;
}

export const consultationOfferings = {
  insert(trx: Transaction, row: ConsultationOfferingColumns & { offering_id: string; owner_person_id: string | null; owner_company_id: string | null; expert_person_id: string; created_by_person_id: string }): Promise<ConsultationOfferingRow> {
    return trx.insertInto('consultation_offering').values({ ...row, cancellation: json(row.cancellation) }).returningAll().executeTakeFirstOrThrow();
  },
  /** The owner side's own offering (RLS); others get undefined and read the public projection. */
  get(trx: Transaction, offeringId: string): Promise<ConsultationOfferingRow | undefined> {
    return trx.selectFrom('consultation_offering').selectAll().where('offering_id', '=', offeringId).executeTakeFirst();
  },
  lock(trx: Transaction, offeringId: string): Promise<ConsultationOfferingRow | undefined> {
    return trx.selectFrom('consultation_offering').selectAll().where('offering_id', '=', offeringId).forUpdate().executeTakeFirst();
  },
  listOwned(trx: Transaction, scope: ConsultationPartyScope): Promise<ConsultationOfferingRow[]> {
    return trx.selectFrom('consultation_offering').selectAll()
      .where((eb) => eb.or([eb('owner_person_id', '=', scope.personId), ...(scope.companyId ? [eb('owner_company_id', '=', scope.companyId)] : [])])).orderBy('created_at', 'desc').orderBy('offering_id').limit(200).execute();
  },
  update(trx: Transaction, offeringId: string, expectedRevision: number, input: Omit<ConsultationOfferingColumns, 'kind'> & { status: OfferingStatusValue }): Promise<ConsultationOfferingRow | undefined> {
    return trx.updateTable('consultation_offering').set({ ...input, cancellation: json(input.cancellation) }).where('offering_id', '=', offeringId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
  async facts(trx: Transaction, offeringId: string): Promise<OfferingFactsRow | undefined> {
    const result = await sql<OfferingFactsRow>`SELECT * FROM trustwork.consultation_offering_facts(${offeringId}::uuid)`.execute(trx);
    return result.rows[0];
  },
  async credential(trx: Transaction, offeringId: string): Promise<CredentialFactsRow | undefined> {
    const result = await sql<CredentialFactsRow>`SELECT * FROM trustwork.consultation_credential_facts(${offeringId}::uuid)`.execute(trx);
    return result.rows[0];
  },
  async licenceUsable(trx: Transaction, credentialId: string, expertPersonId: string): Promise<boolean> {
    const result = await sql<{ v: boolean }>`SELECT trustwork.consultation_licence_usable(${credentialId}::uuid, ${expertPersonId}::uuid) AS v`.execute(trx);
    return result.rows[0]?.v === true;
  },
  /** The catalogue version a proposal would pin now (expert side only). */
  async currentVersion(trx: Transaction, offeringId: string): Promise<{ version_id: string; version: number; digest: string; payload: unknown } | undefined> {
    const result = await sql<{ version_id: string; version: number; digest: string; payload: unknown }>`SELECT * FROM trustwork.consultation_current_version(${offeringId}::uuid)`.execute(trx);
    return result.rows[0];
  },
  /** Active offerings with allowlisted fields (`trustwork.consultation_public_offerings`); anonymous callers too. */
  async publicList(trx: Transaction, filter: { ownerPersonId?: string; ownerCompanyId?: string; offeringId?: string }): Promise<PublicConsultationOfferingRow[]> {
    const result = await sql<PublicConsultationOfferingRow>`SELECT * FROM trustwork.consultation_public_offerings(${filter.ownerPersonId ?? null}::uuid, ${filter.ownerCompanyId ?? null}::uuid, ${filter.offeringId ?? null}::uuid)`.execute(trx);
    return result.rows;
  },
};

/** The catalogue offering a consultation extends (owner side, through the catalogue's own RLS). */
export const consultationCatalogue = {
  offering(trx: Transaction, offeringId: string): Promise<{ id: string; owner_person_id: string | null; owner_company_id: string | null; kind: string; status: string } | undefined> {
    return trx.selectFrom('offering').select(['id', 'owner_person_id', 'owner_company_id', 'kind', 'status']).where('id', '=', offeringId).executeTakeFirst();
  },
};

/* ---------- Availability ---------- */

export const availabilityWindows = {
  insert(trx: Transaction, row: { expert_person_id: string; starts_at: string; ends_at: string; time_zone: string; capacity: number }): Promise<AvailabilityWindowRow> {
    return trx.insertInto('availability_window').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<AvailabilityWindowRow | undefined> {
    return trx.selectFrom('availability_window').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listOwn(trx: Transaction, personId: string, since: Date): Promise<AvailabilityWindowRow[]> {
    return trx.selectFrom('availability_window').selectAll().where('expert_person_id', '=', personId).where('ends_at', '>', since).orderBy('starts_at').orderBy('id').limit(500).execute();
  },
  close(trx: Transaction, id: string, expectedRevision: number): Promise<AvailabilityWindowRow | undefined> {
    return trx.updateTable('availability_window').set({ status: 'closed' }).where('id', '=', id).where('revision', '=', expectedRevision).where('status', '=', 'open').returningAll().executeTakeFirst();
  },
  /** A window's facts for the expert and the expert side of offerings naming that expert. */
  async facts(trx: Transaction, id: string): Promise<{ window_id: string; expert_person_id: string; starts_at: Date; ends_at: Date; time_zone: string; capacity: number; status: 'open' | 'closed' } | undefined> {
    const result = await sql<{ window_id: string; expert_person_id: string; starts_at: Date; ends_at: Date; time_zone: string; capacity: number; status: 'open' | 'closed' }>`SELECT * FROM trustwork.consultation_window_facts(${id}::uuid)`.execute(trx);
    return result.rows[0];
  },
  async booked(trx: Transaction, id: string): Promise<number> {
    const result = await sql<{ v: number }>`SELECT trustwork.consultation_window_booked(${id}::uuid) AS v`.execute(trx);
    return Number(result.rows[0]?.v ?? 0);
  },
  /** Free windows of the addressed expert, for the requester of a live request only. */
  async freeFor(trx: Transaction, requestId: string): Promise<{ window_id: string; starts_at: Date; ends_at: Date; time_zone: string; remaining: number }[]> {
    const result = await sql<{ window_id: string; starts_at: Date; ends_at: Date; time_zone: string; remaining: number }>`SELECT * FROM trustwork.consultation_free_windows(${requestId}::uuid)`.execute(trx);
    return result.rows;
  },
};

/* ---------- Requests ---------- */

export const consultationRequests = {
  insert(trx: Transaction, row: {
    id: string; requester_person_id: string; offering_id: string; project_id: string | null; plan_id: string | null; plan_version_id: string | null; plan_item_key: string | null;
    mentoring_relationship_id: string | null; kind: ConsultationKindValue; licence_required: boolean; terms: unknown; brief: unknown; digest: string; sent_via: ConsultationVia;
    sent_mandate_id: string | null;
  }): Promise<ConsultationRequestRow> {
    return trx.insertInto('consultation_request').values({ ...row, terms: json(row.terms), brief: json(row.brief) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ConsultationRequestRow | undefined> {
    return trx.selectFrom('consultation_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<ConsultationRequestRow | undefined> {
    return trx.selectFrom('consultation_request').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  listForRequester(trx: Transaction, personId: string): Promise<ConsultationRequestRow[]> {
    return trx.selectFrom('consultation_request').selectAll().where('requester_person_id', '=', personId).orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  listForExpert(trx: Transaction, scope: ConsultationPartyScope): Promise<ConsultationRequestRow[]> {
    return trx.selectFrom('consultation_request').selectAll()
      .where((eb) => eb.or([eb('offering_owner_person_id', '=', scope.personId), ...(scope.companyId ? [eb('offering_owner_company_id', '=', scope.companyId)] : [])])).orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  close(trx: Transaction, id: string, expectedRevision: number, input: { status: Extract<RequestStatusValue, 'withdrawn' | 'declined'>; closed_reason: string }): Promise<ConsultationRequestRow | undefined> {
    return trx.updateTable('consultation_request').set(input).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export interface RequestPrivateColumns { budget_ceiling_minor: string | null; budget_ceiling_currency: string | null; requester_notes: string | null }
export const consultationRequestPrivate = {
  get(trx: Transaction, requestId: string): Promise<ConsultationRequestPrivateRow | undefined> {
    return trx.selectFrom('consultation_request_private').selectAll().where('request_id', '=', requestId).executeTakeFirst();
  },
  insert(trx: Transaction, row: RequestPrivateColumns & { request_id: string; requester_person_id: string; updated_by_person_id: string }): Promise<ConsultationRequestPrivateRow> {
    return trx.insertInto('consultation_request_private').values(row).returningAll().executeTakeFirstOrThrow();
  },
  update(trx: Transaction, requestId: string, expectedRevision: number, input: RequestPrivateColumns & { updated_by_person_id: string }): Promise<ConsultationRequestPrivateRow | undefined> {
    return trx.updateTable('consultation_request_private').set(input).where('request_id', '=', requestId).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

/* ---------- Bookings ---------- */

export const consultationBookings = {
  insert(trx: Transaction, row: {
    id: string; request_id: string; offering_id: string; offering_version_id: string; offering_version: number; offering_version_digest: string; expert_person_id: string;
    seller_person_id: string | null; seller_company_id: string | null; client_person_id: string; kind: ConsultationKindValue; mode: ConsultationModeValue; window_id: string | null;
    slot_start: string | null; slot_end: string | null; deliverable_due: string | null; terms: unknown; terms_digest: string; valid_until: string; proposed_by_person_id: string;
    proposed_via: ConsultationVia; proposed_mandate_id: string | null;
  }): Promise<ConsultationBookingRow> {
    return trx.insertInto('consultation_booking').values({ ...row, terms: json(row.terms) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ConsultationBookingRow | undefined> {
    return trx.selectFrom('consultation_booking').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<ConsultationBookingRow | undefined> {
    return trx.selectFrom('consultation_booking').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  listForRequest(trx: Transaction, requestId: string): Promise<ConsultationBookingRow[]> {
    return trx.selectFrom('consultation_booking').selectAll().where('request_id', '=', requestId).orderBy('created_at', 'desc').orderBy('id').execute();
  },
  listForParties(trx: Transaction, scope: ConsultationPartyScope): Promise<ConsultationBookingRow[]> {
    return trx.selectFrom('consultation_booking').selectAll()
      .where((eb) => eb.or([eb('client_person_id', '=', scope.personId), eb('seller_person_id', '=', scope.personId), ...(scope.companyId ? [eb('seller_company_id', '=', scope.companyId)] : [])]))
      .where('status', '<>', 'proposed').orderBy('created_at', 'desc').orderBy('id').limit(500).execute();
  },
  linkAgreement(trx: Transaction, id: string, input: { agreement_id: string; recording_consent: boolean }): Promise<ConsultationBookingRow | undefined> {
    return trx.updateTable('consultation_booking').set(input).where('id', '=', id).where('agreement_id', 'is', null).returningAll().executeTakeFirst();
  },
  setStatus(trx: Transaction, id: string, expected: { revision: number; status: BookingStatusValue }, input: {
    status: BookingStatusValue; closed_reason?: string | null; booked_at?: Date | null; cancellation_kind?: 'client' | 'expert' | 'no_show' | null; cancellation_absent_side?: 'client' | 'expert' | null;
    cancellation_charge_minor?: string | null; cancellation_charge_currency?: string | null; cancelled_at?: Date | null; cancelled_by_person_id?: string | null;
  }): Promise<ConsultationBookingRow | undefined> {
    return trx.updateTable('consultation_booking').set(input).where('id', '=', id).where('revision', '=', expected.revision).where('status', '=', expected.status).returningAll().executeTakeFirst();
  },
  /** The site of a booked site visit for its two parties; undefined before the booking and for other kinds. */
  async site(trx: Transaction, id: string): Promise<{ region_code: string | null; address: unknown; site_contact: unknown; site_access_notes: string | null } | undefined> {
    const result = await sql<{ region_code: string | null; address: unknown; site_contact: unknown; site_access_notes: string | null }>`SELECT * FROM trustwork.consultation_booking_site(${id}::uuid)`.execute(trx);
    return result.rows[0];
  },
};

export const consultationSessions = {
  open(trx: Transaction, bookingId: string): Promise<ConsultationSessionRow> {
    return trx.insertInto('consultation_session').values({ booking_id: bookingId }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, bookingId: string): Promise<ConsultationSessionRow | undefined> {
    return trx.selectFrom('consultation_session').selectAll().where('booking_id', '=', bookingId).executeTakeFirst();
  },
  record(trx: Transaction, bookingId: string, input: { started_at: string; ended_at: string; recorded_by_person_id: string; attendance: unknown }): Promise<ConsultationSessionRow | undefined> {
    return trx.updateTable('consultation_session').set({ ...input, attendance: json(input.attendance) }).where('booking_id', '=', bookingId).where('started_at', 'is', null).returningAll().executeTakeFirst();
  },
};

export const consultationDeliverables = {
  insert(trx: Transaction, row: {
    booking_id: string; agreement_id: string; kind: DeliverableKindValue; title: string; body: string; attachments: unknown[]; claim_id: string; author_person_id: string;
    seller_person_id: string | null; seller_company_id: string | null; client_person_id: string;
  }): Promise<ConsultationDeliverableRow> {
    return trx.insertInto('consultation_deliverable').values({ ...row, attachments: json(row.attachments) }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<ConsultationDeliverableRow | undefined> {
    return trx.selectFrom('consultation_deliverable').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<ConsultationDeliverableRow | undefined> {
    return trx.selectFrom('consultation_deliverable').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  listFor(trx: Transaction, bookingId: string): Promise<ConsultationDeliverableRow[]> {
    return trx.selectFrom('consultation_deliverable').selectAll().where('booking_id', '=', bookingId).orderBy('delivered_at').orderBy('id').execute();
  },
  decide(trx: Transaction, id: string, input: { confirmation_id: string; decision: 'accepted' | 'rejected'; decided_at: Date }): Promise<ConsultationDeliverableRow | undefined> {
    return trx.updateTable('consultation_deliverable').set(input).where('id', '=', id).where('confirmation_id', 'is', null).returningAll().executeTakeFirst();
  },
  publish(trx: Transaction, id: string, at: Date): Promise<ConsultationDeliverableRow | undefined> {
    return trx.updateTable('consultation_deliverable').set({ published_at: at }).where('id', '=', id).where('published_at', 'is', null).returningAll().executeTakeFirst();
  },
  /** A published deliverable's public projection (owner-run, allowlisted); anonymous callers too. */
  async publicOne(trx: Transaction, id: string): Promise<{ deliverable_id: string; kind: DeliverableKindValue; consultation_kind: ConsultationKindValue; title: string; body: string; author_person_id: string | null; author_company_id: string | null; published_at: Date } | undefined> {
    const result = await sql<{ deliverable_id: string; kind: DeliverableKindValue; consultation_kind: ConsultationKindValue; title: string; body: string; author_person_id: string | null; author_company_id: string | null; published_at: Date }>`SELECT * FROM trustwork.consultation_public_deliverable(${id}::uuid)`.execute(trx);
    return result.rows[0];
  },
};

export const consultationReminders = {
  async insertMany(trx: Transaction, rows: { booking_id: string; agreement_id: string; source_hub_id: string | null; remind_at: string; offset_minutes: number }[]): Promise<ConsultationReminderRow[]> {
    if (rows.length === 0) return [];
    return trx.insertInto('consultation_reminder').values(rows).returningAll().execute();
  },
  listFor(trx: Transaction, bookingId: string): Promise<ConsultationReminderRow[]> {
    return trx.selectFrom('consultation_reminder').selectAll().where('booking_id', '=', bookingId).orderBy('remind_at').orderBy('id').execute();
  },
  cancelFor(trx: Transaction, bookingId: string): Promise<ConsultationReminderRow[]> {
    return trx.updateTable('consultation_reminder').set({ status: 'cancelled' }).where('booking_id', '=', bookingId).where('status', '=', 'scheduled').returningAll().execute();
  },
};

/* ---------- Agreements of kind consultation (COM-002 tables) ---------- */

export const consultationAgreements = {
  insert(trx: Transaction, row: {
    buyer_person_id: string; seller_person_id: string | null; seller_company_id: string | null; offer_ref_id: string; request_ref_id: string; offer_digest: string; request_digest: string;
    accepted_terms_digest: string; created_by_person_id: string;
  }): Promise<AgreementRow> {
    return trx.insertInto('agreement').values({
      ...row, terms_kind: 'consultation', buyer_company_id: null, rfq_id: null, quote_id: null, quote_version_id: null, rfq_version_id: null, offer_version: 1, request_version: 1,
      status: 'accepted_by_buyer', supersedes_id: null,
    }).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'consultation').executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<AgreementRow | undefined> {
    return trx.selectFrom('agreement').selectAll().where('id', '=', id).where('terms_kind', '=', 'consultation').forUpdate().executeTakeFirst();
  },
  /** Consultation agreements on the given proposals, newest first. */
  listForBookings(trx: Transaction, bookingIds: readonly string[]): Promise<AgreementRow[]> {
    if (bookingIds.length === 0) return Promise.resolve([]);
    return trx.selectFrom('agreement').selectAll().where('terms_kind', '=', 'consultation').where('offer_ref_id', 'in', [...bookingIds]).orderBy('created_at', 'desc').orderBy('id').execute();
  },
};

/* ---------- Mentoring ---------- */

export const mentoringRelationships = {
  insert(trx: Transaction, row: { mentor_person_id: string; mentee_person_id: string; proposed_by_person_id: string; topics: string[]; terms: 'free' | 'paid'; offering_id: string | null }): Promise<MentoringRelationshipRow> {
    return trx.insertInto('mentoring_relationship').values(row).returningAll().executeTakeFirstOrThrow();
  },
  get(trx: Transaction, id: string): Promise<MentoringRelationshipRow | undefined> {
    return trx.selectFrom('mentoring_relationship').selectAll().where('id', '=', id).executeTakeFirst();
  },
  lock(trx: Transaction, id: string): Promise<MentoringRelationshipRow | undefined> {
    return trx.selectFrom('mentoring_relationship').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  listFor(trx: Transaction, personId: string): Promise<MentoringRelationshipRow[]> {
    return trx.selectFrom('mentoring_relationship').selectAll().where((eb) => eb.or([eb('mentor_person_id', '=', personId), eb('mentee_person_id', '=', personId)]))
      .orderBy('updated_at', 'desc').orderBy('id').limit(200).execute();
  },
  setStatus(trx: Transaction, id: string, expectedRevision: number, input: { status: MentoringStatusValue; ended_reason: string | null }): Promise<MentoringRelationshipRow | undefined> {
    return trx.updateTable('mentoring_relationship').set(input).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

/** Who owns a project (the owner side reads it; participants without a grant see nothing). */
export const consultationProjects = {
  owner(trx: Transaction, projectId: string): Promise<{ owner_person_id: string | null; owner_company_id: string | null } | undefined> {
    return trx.selectFrom('project').select(['owner_person_id', 'owner_company_id']).where('id', '=', projectId).executeTakeFirst();
  },
};
