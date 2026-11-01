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
  source_field_resolution: {
    id: string; request_id: string; source_field_id: string; replacement_field_id: string | null; action: 'correction' | 'erasure';
    source_digest: string; decision_digest: string; retained_digest: string | null; executed_by: string; approved_by: string; created_at: Generated<Date>;
  };
  source_privacy_replay_receipt: { request_id: string; source_field_id: string; retained_digest: string; created_at: Generated<Date> };
  privacy_source_hold: { id: Generated<string>; source_field_id: string; placed_by: string; reason_code: string; evidence_ref: string; created_at: Generated<Date> };
  privacy_source_plan: {
    id: Generated<string>; request_id: string; proposed_by: string; proposer_grant_id: string; reviewer_grant_id: string | null;
    proposer_authority_digest: string; reviewer_authority_digest: string | null; approval_id: string; snapshot: unknown; digest: string;
    state: Generated<'proposed' | 'approved' | 'applied'>; created_at: Generated<Date>;
  };
  privacy_propagation: {
    id: Generated<string>; request_id: string; target: 'retrieval' | 'federation'; decision_digest: string; payload: unknown;
    state: Generated<'pending' | 'outcome_unknown' | 'acknowledged'>; receipt: string | null; created_at: Generated<Date>; acknowledged_at: Date | null;
  };
  privacy_subject_plan: {
    id: Generated<string>; request_id: string; proposed_by: string; proposer_grant_id: string; proposer_authority_digest: string;
    reviewer_grant_id: string | null; reviewer_authority_digest: string | null; approval_id: string; snapshot: unknown; digest: string;
    state: Generated<'proposed' | 'approved' | 'blocked' | 'invalidated'>; created_at: Generated<Date>;
  };
  privacy_source_proof: {
    id: Generated<string>; token_hash: string; source_field_id: string; source_digest: string; action: 'correction' | 'erasure' | 'objection';
    grant_id: string; verified_by: string; evidence_ref: string; method: 'signed_statement' | 'record_control' | 'verified_representative';
    expires_at: Date; used_at: Date | null; created_at: Generated<Date>;
  };
  privacy_source_request: {
    id: Generated<string>; proof_id: string; source_field_id: string; action: 'correction' | 'erasure' | 'objection'; proposed_value: string | null;
    state: Generated<'received' | 'objection_applied' | 'resolved'>; created_at: Generated<Date>;
  };
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
  source_field_resolution: c('source_field_resolution', ['id', 'request_id', 'source_field_id', 'replacement_field_id', 'action', 'source_digest', 'decision_digest', 'retained_digest', 'executed_by', 'approved_by', 'created_at']),
  source_privacy_replay_receipt: c('source_privacy_replay_receipt', ['request_id', 'source_field_id', 'retained_digest', 'created_at']),
  privacy_source_hold: c('privacy_source_hold', ['id', 'source_field_id', 'placed_by', 'reason_code', 'evidence_ref', 'created_at']),
  privacy_source_plan: c('privacy_source_plan', ['id', 'request_id', 'proposed_by', 'proposer_grant_id', 'reviewer_grant_id', 'proposer_authority_digest', 'reviewer_authority_digest', 'approval_id', 'snapshot', 'digest', 'state', 'created_at']),
  privacy_propagation: c('privacy_propagation', ['id', 'request_id', 'target', 'decision_digest', 'payload', 'state', 'receipt', 'created_at', 'acknowledged_at']),
  privacy_subject_plan: c('privacy_subject_plan', ['id', 'request_id', 'proposed_by', 'proposer_grant_id', 'proposer_authority_digest', 'reviewer_grant_id', 'reviewer_authority_digest', 'approval_id', 'snapshot', 'digest', 'state', 'created_at']),
  privacy_source_proof: c('privacy_source_proof', ['id', 'token_hash', 'source_field_id', 'source_digest', 'action', 'grant_id', 'verified_by', 'evidence_ref', 'method', 'expires_at', 'used_at', 'created_at']),
  privacy_source_request: c('privacy_source_request', ['id', 'proof_id', 'source_field_id', 'action', 'proposed_value', 'state', 'created_at']),
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
