import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

interface Subject { subject_kind: 'person' | 'company'; subject_id: string }
export interface PrivacyCountryPolicyTable {
  country: string; version: string; review: 'UNKNOWN' | 'verified'; sources: unknown;
  deadline_days: number | null; retention_days: number | null; registry_poll_hours: number | null; registry_deadline_days: number | null;
}
export interface PrivacyRequestTable extends Subject {
  id: Generated<string>; requested_by: string; kind: 'access' | 'erasure' | 'correction' | 'objection'; country: string;
  policy_version: string | null; policy_status: 'UNKNOWN' | 'verified'; deadline_at: Date | null; retention_days: number | null;
  correction: unknown; state: Generated<'open' | 'erasure_blocked' | 'completed'>; created_at: Generated<Date>;
}
export interface PrivacyPreferenceTable {
  person_id: string; opt_out_sale: Generated<boolean>; opt_out_sharing: Generated<boolean>; limit_sensitive: Generated<boolean>;
  direct_marketing_objection: Generated<boolean>; gpc: Generated<boolean>; revision: Generated<number>; updated_at: Generated<Date>;
}
export interface PrivacySuppressionTable {
  digest: string; person_id: string | null; marketing: Generated<boolean>; do_not_collect: Generated<boolean>; created_at: Generated<Date>;
}
export interface PrivacyExportTable extends Subject { id: Generated<string>; requested_by: string; coverage: unknown; created_at: Generated<Date> }
export interface LegalHoldTable extends Subject {
  id: Generated<string>; request_id: string; reason_code: string; evidence_ref: string; placed_by: string; placed_at: Generated<Date>;
  released_by: string | null; released_at: Date | null;
}
export interface PrivacyReplayReceiptTable extends Subject { request_id: string; ledger_digest: string; applied_at: Generated<Date> }
export interface DataBrokerRegistrationTable {
  id: Generated<string>; country: string; registry: 'fake_drop'; registration_ref: string; last_polled_at: Date | null; next_poll_at: Date | null;
}
export interface PrivacyDatabase {
  privacy_registry_intake: {
    id: Generated<string>; registration_id: string; external_ref: string; contact_digest: string;
    received_at: Generated<Date>; policy_version: string | null; deadline_at: Date | null; state: Generated<'received' | 'proof_required'>;
  };
  data_broker_registration: DataBrokerRegistrationTable;
  legal_hold: LegalHoldTable;
  privacy_country_policy: PrivacyCountryPolicyTable;
  privacy_export: PrivacyExportTable;
  privacy_preference: PrivacyPreferenceTable;
  privacy_replay_receipt: PrivacyReplayReceiptTable;
  privacy_request: PrivacyRequestTable;
  privacy_suppression: PrivacySuppressionTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned schema augmentation
  interface Database extends PrivacyDatabase {}
}
export type PrivacyRequestRow = Selectable<PrivacyRequestTable>;
export type PrivacyPreferenceRow = Selectable<PrivacyPreferenceTable>;
export type PrivacyExportRow = Selectable<PrivacyExportTable>;
export type LegalHoldRow = Selectable<LegalHoldTable>;
const c = columnsOf<PrivacyDatabase>();
export const TABLE_COLUMNS: TableColumns<PrivacyDatabase> = {
  privacy_registry_intake: c('privacy_registry_intake', ['id', 'registration_id', 'external_ref', 'contact_digest', 'received_at', 'policy_version', 'deadline_at', 'state']),
  data_broker_registration: c('data_broker_registration', ['id', 'country', 'registry', 'registration_ref', 'last_polled_at', 'next_poll_at']),
  legal_hold: c('legal_hold', ['id', 'request_id', 'subject_kind', 'subject_id', 'reason_code', 'evidence_ref', 'placed_by', 'placed_at', 'released_by', 'released_at']),
  privacy_country_policy: c('privacy_country_policy', ['country', 'version', 'review', 'sources', 'deadline_days', 'retention_days', 'registry_poll_hours', 'registry_deadline_days']),
  privacy_export: c('privacy_export', ['id', 'requested_by', 'subject_kind', 'subject_id', 'coverage', 'created_at']),
  privacy_preference: c('privacy_preference', ['person_id', 'opt_out_sale', 'opt_out_sharing', 'limit_sensitive', 'direct_marketing_objection', 'gpc', 'revision', 'updated_at']),
  privacy_replay_receipt: c('privacy_replay_receipt', ['request_id', 'subject_kind', 'subject_id', 'ledger_digest', 'applied_at']),
  privacy_request: c('privacy_request', ['id', 'requested_by', 'subject_kind', 'subject_id', 'kind', 'country', 'policy_version', 'policy_status', 'deadline_at', 'retention_days', 'correction', 'state', 'created_at']),
  privacy_suppression: c('privacy_suppression', ['digest', 'person_id', 'marketing', 'do_not_collect', 'created_at']),
};
