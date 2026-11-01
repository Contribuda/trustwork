import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Consultations and mentoring from plan items (CONS-001, packages/data/migrations/consultations): consultation
 * offerings on catalogue offerings, availability windows, requests with the requester's private half, proposals that
 * become bookings, sessions, deliverables, reminders and mentoring relationships. Agreements, acceptance events and
 * obligations are the COM-002 tables (terms_kind `consultation`); delivery and acceptance are EXE-001 claims and
 * confirmations. Every table is under FORCE RLS.
 */
export type ConsultationKindValue = 'session' | 'drawing_review' | 'quote_review' | 'site_visit' | 'mentoring';
export type ConsultationModeValue = 'video' | 'chat' | 'phone' | 'in_person' | 'async';
export type DeliverableKindValue = 'written_advice' | 'marked_up_document' | 'site_report' | 'checklist' | 'recording';
export type PricingModeValue = 'free' | 'fixed' | 'hourly';
export type OfferingStatusValue = 'active' | 'paused' | 'retired';
export type WindowStatusValue = 'open' | 'closed';
export type RequestStatusValue = 'requested' | 'offered' | 'booked' | 'withdrawn' | 'expired' | 'declined';
export type BookingStatusValue = 'proposed' | 'booked' | 'held' | 'delivered' | 'accepted' | 'cancelled' | 'declined' | 'withdrawn' | 'disputed';
export type MentoringStatusValue = 'proposed' | 'active' | 'paused' | 'declined' | 'ended';
export type ConsultationVia = 'person' | 'agent';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;
/** date: read as text or Date, written as an ISO date. */
type DateText = ColumnType<string | Date, string, string>;

export interface ConsultationOfferingTable {
  offering_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  expert_person_id: string;
  kind: ConsultationKindValue;
  modes: ConsultationModeValue[];
  topics: Generated<string[]>;
  regions: Generated<string[]>;
  languages: string[];
  duration_minutes: number;
  deliverable_kind: DeliverableKindValue;
  pricing: PricingModeValue;
  cancellation: Jsonb;
  licence_required: boolean;
  licence_credential_id: string | null;
  recording_offered: Generated<boolean>;
  status: Generated<OfferingStatusValue>;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AvailabilityWindowTable {
  id: GeneratedUuid;
  expert_person_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  time_zone: string;
  capacity: number;
  status: Generated<WindowStatusValue>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsultationRequestTable {
  id: GeneratedUuid;
  requester_person_id: string;
  offering_id: string;
  /** Copied from the offering by the guard (input values are overwritten). */
  offering_owner_person_id: Generated<string | null>;
  offering_owner_company_id: Generated<string | null>;
  expert_person_id: Generated<string>;
  project_id: string | null;
  plan_id: string | null;
  plan_version_id: string | null;
  plan_item_key: string | null;
  mentoring_relationship_id: string | null;
  kind: ConsultationKindValue;
  licence_required: boolean;
  terms: Jsonb;
  brief: Jsonb;
  digest: string;
  status: Generated<RequestStatusValue>;
  closed_reason: string | null;
  sent_via: ConsultationVia;
  sent_mandate_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsultationRequestPrivateTable {
  request_id: string;
  requester_person_id: string;
  budget_ceiling_minor: Int8 | null;
  budget_ceiling_currency: string | null;
  requester_notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface MentoringRelationshipTable {
  id: GeneratedUuid;
  mentor_person_id: string;
  mentee_person_id: string;
  proposed_by_person_id: string;
  topics: string[];
  terms: 'free' | 'paid';
  offering_id: string | null;
  status: Generated<MentoringStatusValue>;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  ended_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsultationBookingTable {
  id: GeneratedUuid;
  request_id: string;
  offering_id: string;
  offering_version_id: string;
  offering_version: number;
  offering_version_digest: string;
  expert_person_id: string;
  seller_person_id: string | null;
  seller_company_id: string | null;
  client_person_id: string;
  kind: ConsultationKindValue;
  mode: ConsultationModeValue;
  window_id: string | null;
  slot_start: Timestamp | null;
  slot_end: Timestamp | null;
  deliverable_due: DateText | null;
  terms: Jsonb;
  terms_digest: string;
  valid_until: Timestamp;
  status: Generated<BookingStatusValue>;
  agreement_id: string | null;
  recording_consent: Generated<boolean>;
  closed_reason: string | null;
  cancellation_kind: 'client' | 'expert' | 'no_show' | null;
  cancellation_absent_side: 'client' | 'expert' | null;
  cancellation_charge_minor: Int8 | null;
  cancellation_charge_currency: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by_person_id: string | null;
  booked_at: Timestamp | null;
  proposed_by_person_id: string;
  proposed_via: ConsultationVia;
  proposed_mandate_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsultationSessionTable {
  booking_id: string;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  attendance: ColumnType<unknown, string | undefined, string>;
  meeting_link_ref: string | null;
  /** Set by the guard for a site visit when the session opens with the booking. */
  site_address_revealed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  recorded_by_person_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ConsultationDeliverableTable {
  id: GeneratedUuid;
  booking_id: string;
  agreement_id: string;
  kind: DeliverableKindValue;
  title: string;
  body: string;
  attachments: Jsonb;
  claim_id: string;
  author_person_id: string;
  seller_person_id: string | null;
  seller_company_id: string | null;
  client_person_id: string;
  delivered_at: GeneratedTimestamp;
  confirmation_id: string | null;
  decision: 'accepted' | 'rejected' | null;
  decided_at: Timestamp | null;
  published_at: Timestamp | null;
}

export interface ConsultationReminderTable {
  id: GeneratedUuid;
  booking_id: string;
  agreement_id: string;
  remind_at: Timestamp;
  offset_minutes: number;
  status: Generated<'scheduled' | 'cancelled' | 'sent'>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  message_id: string | null;
  source_hub_id: string | null;
}

export type ConsultationOfferingRow = Selectable<ConsultationOfferingTable>;
export type AvailabilityWindowRow = Selectable<AvailabilityWindowTable>;
export type ConsultationRequestRow = Selectable<ConsultationRequestTable>;
export type ConsultationRequestPrivateRow = Selectable<ConsultationRequestPrivateTable>;
export type MentoringRelationshipRow = Selectable<MentoringRelationshipTable>;
export type ConsultationBookingRow = Selectable<ConsultationBookingTable>;
export type ConsultationSessionRow = Selectable<ConsultationSessionTable>;
export type ConsultationDeliverableRow = Selectable<ConsultationDeliverableTable>;
export type ConsultationReminderRow = Selectable<ConsultationReminderTable>;

export interface ConsultationsDatabase {
  consultation_offering: ConsultationOfferingTable;
  availability_window: AvailabilityWindowTable;
  consultation_request: ConsultationRequestTable;
  consultation_request_private: ConsultationRequestPrivateTable;
  mentoring_relationship: MentoringRelationshipTable;
  consultation_booking: ConsultationBookingTable;
  consultation_session: ConsultationSessionTable;
  consultation_deliverable: ConsultationDeliverableTable;
  consultation_reminder: ConsultationReminderTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ConsultationsDatabase {}
}

const columns = columnsOf<ConsultationsDatabase>();
export const TABLE_COLUMNS: TableColumns<ConsultationsDatabase> = {
  consultation_offering: columns('consultation_offering', [
    'offering_id', 'owner_person_id', 'owner_company_id', 'expert_person_id', 'kind', 'modes', 'topics', 'regions', 'languages', 'duration_minutes', 'deliverable_kind', 'pricing',
    'cancellation', 'licence_required', 'licence_credential_id', 'recording_offered', 'status', 'created_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  availability_window: columns('availability_window', ['id', 'expert_person_id', 'starts_at', 'ends_at', 'time_zone', 'capacity', 'status', 'revision', 'created_at', 'updated_at']),
  consultation_request: columns('consultation_request', [
    'id', 'requester_person_id', 'offering_id', 'offering_owner_person_id', 'offering_owner_company_id', 'expert_person_id', 'project_id', 'plan_id', 'plan_version_id', 'plan_item_key',
    'mentoring_relationship_id', 'kind', 'licence_required', 'terms', 'brief', 'digest', 'status', 'closed_reason', 'sent_via', 'sent_mandate_id', 'revision', 'created_at', 'updated_at',
  ]),
  consultation_request_private: columns('consultation_request_private', [
    'request_id', 'requester_person_id', 'budget_ceiling_minor', 'budget_ceiling_currency', 'requester_notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  mentoring_relationship: columns('mentoring_relationship', [
    'id', 'mentor_person_id', 'mentee_person_id', 'proposed_by_person_id', 'topics', 'terms', 'offering_id', 'status', 'started_at', 'ended_at', 'ended_reason', 'revision', 'created_at', 'updated_at',
  ]),
  consultation_booking: columns('consultation_booking', [
    'id', 'request_id', 'offering_id', 'offering_version_id', 'offering_version', 'offering_version_digest', 'expert_person_id', 'seller_person_id', 'seller_company_id', 'client_person_id',
    'kind', 'mode', 'window_id', 'slot_start', 'slot_end', 'deliverable_due', 'terms', 'terms_digest', 'valid_until', 'status', 'agreement_id', 'recording_consent', 'closed_reason',
    'cancellation_kind', 'cancellation_absent_side', 'cancellation_charge_minor', 'cancellation_charge_currency', 'cancelled_at', 'cancelled_by_person_id', 'booked_at', 'proposed_by_person_id',
    'proposed_via', 'proposed_mandate_id', 'revision', 'created_at', 'updated_at',
  ]),
  consultation_session: columns('consultation_session', [
    'booking_id', 'started_at', 'ended_at', 'attendance', 'meeting_link_ref', 'site_address_revealed_at', 'recorded_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  consultation_deliverable: columns('consultation_deliverable', [
    'id', 'booking_id', 'agreement_id', 'kind', 'title', 'body', 'attachments', 'claim_id', 'author_person_id', 'seller_person_id', 'seller_company_id', 'client_person_id', 'delivered_at',
    'confirmation_id', 'decision', 'decided_at', 'published_at',
  ]),
  consultation_reminder: columns('consultation_reminder', ['id', 'booking_id', 'agreement_id', 'remind_at', 'offset_minutes', 'status', 'message_id', 'source_hub_id', 'revision', 'created_at', 'updated_at']),
};
