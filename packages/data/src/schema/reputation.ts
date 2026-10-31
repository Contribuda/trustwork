import type { ColumnType, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * The reputation builder (REP-001, packages/data/migrations/reputation): credentials and their register checks,
 * portfolio entries, declared close relationships, confirmation requests and final responses, contribution and
 * timeliness records derived by `trustwork.reputation_derive` from canonical records only, and automated limitations
 * recorded when the person appeals them. Every table is under FORCE RLS and append-only, except the reminder and
 * withdrawal columns of a request.
 */
export type CredentialKindValue = 'licence' | 'insurance' | 'bond' | 'certificate' | 'training' | 'membership' | 'registration';
export type CredentialCheckOutcomeValue = 'match' | 'mismatch' | 'not_found' | 'suspended' | 'revoked' | 'unavailable';
export type ReputationVisibilityValue = 'public' | 'private';
export type ConfirmationContextKindValue = 'agreement' | 'task_assignment' | 'project';
export type StatementKindValue = 'delivered' | 'on_time' | 'quality_met' | 'role_performed' | 'paid_on_time' | 'advice_delivered';
export type ConfirmationDecisionValue = 'confirmed' | 'partially' | 'declined';
export type RelationKindValue = 'relative' | 'household' | 'close_personal';
export type ContributionKindValue = 'publication' | 'accepted_answer' | 'consultation_given' | 'mentoring' | 'course_taught' | 'event_talk' | 'document_review' | 'knowledge_item';
export type TimelinessKindValue = 'response' | 'delivery' | 'payment' | 'consultation_start' | 'milestone';
export type TimelinessAttributionValue = 'subject' | 'counterparty' | 'external' | 'unknown';
export type TimelinessExcludedReasonValue = 'client_caused_change' | 'external_change' | 'unattributed_change' | 'no_due_date';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** Set by the guard from the server clock. */
type ServerTimestamp = ColumnType<Date, Date | string | undefined, never>;
/** bigint: read as a string by node-postgres. */
type BigIntColumn = ColumnType<string, string | number | bigint, never>;
type NullableBigInt = ColumnType<string | null, string | number | bigint | null, never>;

export interface ProfessionalCredentialTable {
  id: GeneratedUuid;
  holder_person_id: string | null;
  holder_company_id: string | null;
  kind: CredentialKindValue;
  jurisdiction: string;
  credential_type: string;
  issuer: string;
  number: string | null;
  classification: string | null;
  coverage_minor: NullableBigInt;
  coverage_currency: string | null;
  valid_from: ColumnType<Date | null, string | null, never>;
  valid_until: ColumnType<Date | null, string | null, never>;
  visibility: ReputationVisibilityValue;
  supersedes_id: string | null;
  recorded_by_person_id: string;
  created_at: GeneratedTimestamp;
}

export interface CredentialCheckTable {
  id: GeneratedUuid;
  credential_id: string;
  hub_id: string;
  register_code: string;
  outcome: CredentialCheckOutcomeValue;
  register_valid_until: ColumnType<Date | null, string | null, never>;
  source_ref: string | null;
  requested_by_person_id: string;
  checked_at: GeneratedTimestamp;
}

export interface PortfolioEntryTable {
  id: GeneratedUuid;
  holder_person_id: string | null;
  holder_company_id: string | null;
  context_kind: ConfirmationContextKindValue | null;
  context_id: string | null;
  external_description: string | null;
  title: string;
  role: string;
  period_from: ColumnType<Date | null, string | null, never>;
  period_to: ColumnType<Date | null, string | null, never>;
  scope_summary: string | null;
  visibility: ReputationVisibilityValue;
  supersedes_id: string | null;
  recorded_by_person_id: string;
  created_at: GeneratedTimestamp;
}

export interface RelationDeclarationTable {
  id: GeneratedUuid;
  declarer_person_id: string;
  other_person_id: string;
  kind: RelationKindValue;
  declared_at: GeneratedTimestamp;
}

export interface ConfirmationRequestTable {
  id: GeneratedUuid;
  requester_person_id: string | null;
  requester_company_id: string | null;
  addressed_person_id: string | null;
  addressed_company_id: string | null;
  context_kind: ConfirmationContextKindValue;
  context_id: string;
  portfolio_entry_id: string | null;
  statement_kind: StatementKindValue;
  statement: string;
  no_incentive: boolean;
  no_conflict: boolean;
  requested_by_person_id: string;
  requested_at: ServerTimestamp;
  /** Set by the guard: 30 days after the request. */
  due_at: ColumnType<Date, Date | string, never>;
  reminder_sent_at: ColumnType<Date | null, Date | string | null | undefined, Date | string>;
  withdrawn_at: ColumnType<Date | null, Date | string | null | undefined, Date | string>;
}

export interface ConfirmationResponseTable {
  id: GeneratedUuid;
  confirmation_request_id: string;
  responder_person_id: string;
  on_behalf_person_id: string | null;
  on_behalf_company_id: string | null;
  decision: ConfirmationDecisionValue;
  comment: string | null;
  consent_to_show: ColumnType<boolean, boolean | undefined, never>;
  no_conflict: boolean;
  responded_at: GeneratedTimestamp;
}

export interface ContributionRecordTable {
  id: GeneratedUuid;
  holder_person_id: string | null;
  holder_company_id: string | null;
  kind: ContributionKindValue;
  source_kind: 'confirmation_response' | 'agreement';
  source_id: string;
  appeal_subject_kind: 'confirmation_response' | 'performance_observation';
  appeal_subject_id: string;
  outcome: Jsonb;
  occurred_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface TimelinessObservationTable {
  id: GeneratedUuid;
  subject_person_id: string | null;
  subject_company_id: string | null;
  kind: TimelinessKindValue;
  agreement_id: string;
  source_observation_id: string;
  expected_at: Timestamp | null;
  actual_at: Timestamp | null;
  delta_seconds: BigIntColumn | NullableBigInt;
  attribution: TimelinessAttributionValue;
  plan_change_ids: ColumnType<string[], string[] | undefined, never>;
  excluded_reason: TimelinessExcludedReasonValue | null;
  created_at: GeneratedTimestamp;
}

export interface AutomatedLimitationTable {
  id: GeneratedUuid;
  subject_person_id: string | null;
  subject_company_id: string | null;
  module: 'reputation' | 'introductions' | 'assistant';
  scope: 'confirmation_request' | 'confirmation_response' | 'introductions' | 'agent_module' | 'observation';
  reason_code: string;
  evidence: Jsonb;
  recorded_by_person_id: string | null;
  starts_at: GeneratedTimestamp;
  ends_at: Timestamp | null;
  created_at: GeneratedTimestamp;
}

export type ProfessionalCredentialRow = Selectable<ProfessionalCredentialTable>;
export type CredentialCheckRow = Selectable<CredentialCheckTable>;
export type PortfolioEntryRow = Selectable<PortfolioEntryTable>;
export type RelationDeclarationRow = Selectable<RelationDeclarationTable>;
export type ConfirmationRequestRow = Selectable<ConfirmationRequestTable>;
export type ConfirmationResponseRow = Selectable<ConfirmationResponseTable>;
export type ContributionRecordRow = Selectable<ContributionRecordTable>;
export type TimelinessObservationRow = Selectable<TimelinessObservationTable>;
export type AutomatedLimitationRow = Selectable<AutomatedLimitationTable>;

export interface ReputationDatabase {
  professional_credential: ProfessionalCredentialTable;
  credential_check: CredentialCheckTable;
  portfolio_entry: PortfolioEntryTable;
  relation_declaration: RelationDeclarationTable;
  confirmation_request: ConfirmationRequestTable;
  confirmation_response: ConfirmationResponseTable;
  contribution_record: ContributionRecordTable;
  timeliness_observation: TimelinessObservationTable;
  automated_limitation: AutomatedLimitationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ReputationDatabase {}
}

const columns = columnsOf<ReputationDatabase>();
export const TABLE_COLUMNS: TableColumns<ReputationDatabase> = {
  professional_credential: columns('professional_credential', [
    'id', 'holder_person_id', 'holder_company_id', 'kind', 'jurisdiction', 'credential_type', 'issuer', 'number', 'classification', 'coverage_minor', 'coverage_currency', 'valid_from',
    'valid_until', 'visibility', 'supersedes_id', 'recorded_by_person_id', 'created_at',
  ]),
  credential_check: columns('credential_check', ['id', 'credential_id', 'hub_id', 'register_code', 'outcome', 'register_valid_until', 'source_ref', 'requested_by_person_id', 'checked_at']),
  portfolio_entry: columns('portfolio_entry', [
    'id', 'holder_person_id', 'holder_company_id', 'context_kind', 'context_id', 'external_description', 'title', 'role', 'period_from', 'period_to', 'scope_summary', 'visibility',
    'supersedes_id', 'recorded_by_person_id', 'created_at',
  ]),
  relation_declaration: columns('relation_declaration', ['id', 'declarer_person_id', 'other_person_id', 'kind', 'declared_at']),
  confirmation_request: columns('confirmation_request', [
    'id', 'requester_person_id', 'requester_company_id', 'addressed_person_id', 'addressed_company_id', 'context_kind', 'context_id', 'portfolio_entry_id', 'statement_kind', 'statement',
    'no_incentive', 'no_conflict', 'requested_by_person_id', 'requested_at', 'due_at', 'reminder_sent_at', 'withdrawn_at',
  ]),
  confirmation_response: columns('confirmation_response', [
    'id', 'confirmation_request_id', 'responder_person_id', 'on_behalf_person_id', 'on_behalf_company_id', 'decision', 'comment', 'consent_to_show', 'no_conflict', 'responded_at',
  ]),
  contribution_record: columns('contribution_record', [
    'id', 'holder_person_id', 'holder_company_id', 'kind', 'source_kind', 'source_id', 'appeal_subject_kind', 'appeal_subject_id', 'outcome', 'occurred_at', 'created_at',
  ]),
  timeliness_observation: columns('timeliness_observation', [
    'id', 'subject_person_id', 'subject_company_id', 'kind', 'agreement_id', 'source_observation_id', 'expected_at', 'actual_at', 'delta_seconds', 'attribution', 'plan_change_ids',
    'excluded_reason', 'created_at',
  ]),
  automated_limitation: columns('automated_limitation', [
    'id', 'subject_person_id', 'subject_company_id', 'module', 'scope', 'reason_code', 'evidence', 'recorded_by_person_id', 'starts_at', 'ends_at', 'created_at',
  ]),
};
