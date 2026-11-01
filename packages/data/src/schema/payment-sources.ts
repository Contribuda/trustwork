import type { ColumnType, Generated } from 'kysely';
import { columnsOf, type TableColumns, type Timestamp, type GeneratedTimestamp } from './index.js';
type Json = ColumnType<unknown, string, string>;
interface Version { id: Generated<string>; created_at: GeneratedTimestamp; expires_at: Timestamp; revoked_at: Timestamp | null }
export interface PaymentSourceRegistrationTable extends Version {
  hub_id: string; connection_id: string; fact: 'identity_link' | 'account' | 'publisher'; payload: Json; digest: string;
  proposed_by: string; proposed_epoch: number; proposed_elevation_id: string;
}
export interface PaymentAdapterActivationTable {
  registration_id: string; approval_id: string; activated_by: string; reviewer_id: string; reviewer_elevation_id: string; created_at: GeneratedTimestamp;
}
export interface PaymentSourceChallengeTable {
  id: Generated<string>; person_id: string; session_id: string; person_epoch: number; hub_id: string; connection_id: string;
  identity_registration_id: string; account_registration_id: string | null; purpose: 'payment_participant' | 'payment_account';
  nonce: string; nonce_digest: string; created_at: GeneratedTimestamp; expires_at: Timestamp;
}
export interface PaymentIdentityLinkTable extends Version { challenge_id: string; person_id: string; registration_id: string; assertion: Json; digest: string }
export interface PaymentParticipantBindingTable extends Version { identity_link_id: string; person_id: string; hub_id: string }
export interface PaymentAccountEvidenceTable extends Version { challenge_id: string; identity_link_id: string; registration_id: string; assertion: Json; digest: string }
export interface PaymentAccountBindingTable extends Version { participant_binding_id: string; account_evidence_id: string; person_id: string }
export interface PaymentBindingReviewTable extends Version {
  participant_binding_id: string; account_binding_id: string | null; approval_id: string; digest: string;
  proposer_id: string; reviewer_id: string; reviewer_elevation_id: string;
}
export interface PaymentAuthorizationVersionTable extends Version {
  agreement_id: string; payer_id: string; payee_id: string; payer_binding_id: string; payee_binding_id: string;
  account_binding_id: string; publisher_registration_id: string; snapshot: Json; binding: Json; digest: string;
}
export interface PaymentAuthorizationAcceptanceTable { authorization_id: string; person_id: string; session_id: string; person_epoch: number; digest: string; created_at: GeneratedTimestamp }
export interface PaymentSourceVersionTable extends Version { authorization_id: string; agreement_id: string; binding: Json; digest: string }
export interface PaymentSourceCurrentTable { agreement_id: string; source_version_id: string }
export interface PaymentSourcesDatabase {
  payment_source_registration: PaymentSourceRegistrationTable;
  payment_adapter_activation: PaymentAdapterActivationTable;
  payment_source_challenge: PaymentSourceChallengeTable;
  payment_identity_link_version: PaymentIdentityLinkTable;
  payment_participant_binding_version: PaymentParticipantBindingTable;
  payment_account_evidence: PaymentAccountEvidenceTable;
  payment_account_binding_version: PaymentAccountBindingTable;
  payment_binding_review: PaymentBindingReviewTable;
  payment_authorization_version: PaymentAuthorizationVersionTable;
  payment_authorization_acceptance: PaymentAuthorizationAcceptanceTable;
  payment_source_version: PaymentSourceVersionTable;
  payment_source_current: PaymentSourceCurrentTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module table augmentation
  interface Database extends PaymentSourcesDatabase {}
}
const columns = columnsOf<PaymentSourcesDatabase>();
const version = ['id', 'created_at', 'expires_at', 'revoked_at'] as const;
export const TABLE_COLUMNS: TableColumns<PaymentSourcesDatabase> = {
  payment_source_registration: columns('payment_source_registration', [...version, 'hub_id', 'connection_id', 'fact', 'payload', 'digest', 'proposed_by', 'proposed_epoch', 'proposed_elevation_id']),
  payment_adapter_activation: columns('payment_adapter_activation', ['registration_id', 'approval_id', 'activated_by', 'reviewer_id', 'reviewer_elevation_id', 'created_at']),
  payment_source_challenge: columns('payment_source_challenge', ['id', 'person_id', 'session_id', 'person_epoch', 'hub_id', 'connection_id', 'identity_registration_id', 'account_registration_id', 'purpose', 'nonce', 'nonce_digest', 'created_at', 'expires_at']),
  payment_identity_link_version: columns('payment_identity_link_version', [...version, 'challenge_id', 'person_id', 'registration_id', 'assertion', 'digest']),
  payment_participant_binding_version: columns('payment_participant_binding_version', [...version, 'identity_link_id', 'person_id', 'hub_id']),
  payment_account_evidence: columns('payment_account_evidence', [...version, 'challenge_id', 'identity_link_id', 'registration_id', 'assertion', 'digest']),
  payment_account_binding_version: columns('payment_account_binding_version', [...version, 'participant_binding_id', 'account_evidence_id', 'person_id']),
  payment_binding_review: columns('payment_binding_review', [...version, 'participant_binding_id', 'account_binding_id', 'approval_id', 'digest', 'proposer_id', 'reviewer_id', 'reviewer_elevation_id']),
  payment_authorization_version: columns('payment_authorization_version', [...version, 'agreement_id', 'payer_id', 'payee_id', 'payer_binding_id', 'payee_binding_id', 'account_binding_id', 'publisher_registration_id', 'snapshot', 'binding', 'digest']),
  payment_authorization_acceptance: columns('payment_authorization_acceptance', ['authorization_id', 'person_id', 'session_id', 'person_epoch', 'digest', 'created_at']),
  payment_source_version: columns('payment_source_version', [...version, 'authorization_id', 'agreement_id', 'binding', 'digest']),
  payment_source_current: columns('payment_source_current', ['agreement_id', 'source_version_id']),
};
