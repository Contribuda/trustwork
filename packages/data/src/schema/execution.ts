import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Project execution, evidence and fair reputation (EXE-001, packages/data/migrations/execution): claims, evidence,
 * confirmations, defects and disputes recorded independently; performance observations derived by
 * `trustwork.execution_observe`; reviews and responses of completed agreements; explainable reputation snapshots.
 * Agreements and obligations are the COM-002 tables; evidence artifacts are FILE-001's. Every table is under FORCE RLS
 * and append-only except the dispute case.
 */
export type ExecutionClaimKindValue = 'goods_delivery' | 'work_performed' | 'service_delivered' | 'payment_made' | 'remediation';
export type ExecutionDecisionValue = 'accepted' | 'partially_accepted' | 'rejected';
export type ExecutionEvidenceKindValue = 'photo' | 'delivery_note' | 'acceptance_act' | 'inspection_report' | 'test_report' | 'e_document' | 'invoice' | 'other';
export type DefectSeverityValue = 'minor' | 'major' | 'critical';
export type DisputeTargetKindValue = 'confirmation' | 'defect';
export type DisputeStatusValue = 'open' | 'decided' | 'appealed' | 'appeal_decided';
export type DisputeDecisionValue = 'upheld' | 'overturned' | 'partially';
export type DisputeAppealDecisionValue = 'upheld' | 'overturned' | 'partially_overturned';
export type ObservationSourceKindValue = 'execution_confirmation' | 'task_acceptance' | 'task_rejection';
export type ObservationDimensionValue = 'timing' | 'quality' | 'payment';
export type ObservationOutcomeValue = 'on_time' | 'late' | 'excused_delay' | 'unknown' | 'accepted' | 'partially_accepted' | 'rejected';
export type ObservationAttributionValue = 'subject' | 'counterparty' | 'external' | 'unknown';
export type ObservationExcludedReasonValue = 'client_caused_change' | 'external_change' | 'unattributed_change' | 'no_due_date';
export type ReviewSideValue = 'buyer' | 'seller';
export type ExecutionVia = 'person' | 'agent';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
type JsonbDefault = ColumnType<unknown, string | undefined, string>;

export interface ExecutionDefectTable {
  id: GeneratedUuid;
  agreement_id: string;
  obligation_id: string | null;
  claim_id: string | null;
  reporter_person_id: string | null;
  reporter_company_id: string | null;
  /** Set by the guard: the other party of the agreement. */
  subject_person_id: ColumnType<string | null, string | null | undefined, never>;
  subject_company_id: ColumnType<string | null, string | null | undefined, never>;
  reported_by_person_id: string;
  via: ExecutionVia;
  mandate_id: string | null;
  severity: DefectSeverityValue;
  location: string | null;
  description: string;
  observed_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface ExecutionClaimTable {
  id: GeneratedUuid;
  agreement_id: string;
  obligation_id: string | null;
  defect_id: string | null;
  kind: ExecutionClaimKindValue;
  claimant_person_id: string | null;
  claimant_company_id: string | null;
  /** Set by the guard: the other party of the agreement. */
  counterparty_person_id: ColumnType<string | null, string | null | undefined, never>;
  counterparty_company_id: ColumnType<string | null, string | null | undefined, never>;
  lines: JsonbDefault;
  period_from: ColumnType<Date | null, string | null, string | null>;
  period_to: ColumnType<Date | null, string | null, string | null>;
  performed_at: Timestamp;
  statement: string | null;
  supersedes_claim_id: string | null;
  recorded_by_person_id: string;
  via: ExecutionVia;
  mandate_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ExecutionEvidenceTable {
  id: GeneratedUuid;
  agreement_id: string;
  claim_id: string | null;
  defect_id: string | null;
  artifact_id: string;
  artifact_sha256: string;
  kind: ExecutionEvidenceKindValue;
  observed_at: Timestamp | null;
  note: string | null;
  attached_by_person_id: string;
  via: ExecutionVia;
  mandate_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ExecutionConfirmationTable {
  id: GeneratedUuid;
  claim_id: string;
  agreement_id: string;
  decision: ExecutionDecisionValue;
  lines: JsonbDefault;
  note: string | null;
  stage_code: string | null;
  decided_by_person_id: string;
  on_behalf_person_id: string | null;
  on_behalf_company_id: string | null;
  decided_at: GeneratedTimestamp;
}

export interface ExecutionDisputeTable {
  id: GeneratedUuid;
  agreement_id: string;
  hub_id: string;
  target_kind: DisputeTargetKindValue;
  target_id: string;
  opened_by_person_id: string;
  opener_person_id: string | null;
  opener_company_id: string | null;
  reason: string;
  status: Generated<DisputeStatusValue>;
  decision: DisputeDecisionValue | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_reason: string | null;
  appealed_by_person_id: string | null;
  appeal_reason: string | null;
  appealed_at: Timestamp | null;
  appeal_decision: DisputeAppealDecisionValue | null;
  appeal_decided_by: string | null;
  appeal_decided_at: Timestamp | null;
  appeal_decision_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PerformanceObservationTable {
  id: GeneratedUuid;
  agreement_id: string;
  source_kind: ObservationSourceKindValue;
  source_id: string;
  obligation_id: string | null;
  claim_id: string | null;
  subject_person_id: string | null;
  subject_company_id: string | null;
  counterparty_person_id: string | null;
  counterparty_company_id: string | null;
  dimension: ObservationDimensionValue;
  outcome: ObservationOutcomeValue;
  due_at: Timestamp | null;
  performed_at: Timestamp | null;
  allowance_days: Generated<number>;
  late_days: number | null;
  attribution: ObservationAttributionValue;
  excluded_reason: ObservationExcludedReasonValue | null;
  plan_change_ids: Generated<string[]>;
  baseline_plan_version_id: string | null;
  decided_by_person_id: string;
  created_at: GeneratedTimestamp;
}

export interface ReviewTable {
  id: GeneratedUuid;
  agreement_id: string;
  author_side: ReviewSideValue;
  author_person_id: string | null;
  author_company_id: string | null;
  subject_person_id: string | null;
  subject_company_id: string | null;
  written_by_person_id: string;
  ratings: Jsonb;
  text: string | null;
  language: string | null;
  corrects_review_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface ReviewResponseTable {
  id: GeneratedUuid;
  review_id: string;
  agreement_id: string;
  responder_person_id: string | null;
  responder_company_id: string | null;
  written_by_person_id: string;
  text: string;
  created_at: GeneratedTimestamp;
}

export interface ReputationSnapshotTable {
  id: GeneratedUuid;
  subject_person_id: string | null;
  subject_company_id: string | null;
  method_version: string;
  method_digest: string;
  summary: Jsonb;
  public_summary: Jsonb;
  explanation: Jsonb;
  inputs_digest: string;
  computed_by_person_id: string;
  computed_at: GeneratedTimestamp;
}

export type ExecutionDefectRow = Selectable<ExecutionDefectTable>;
export type ExecutionClaimRow = Selectable<ExecutionClaimTable>;
export type ExecutionEvidenceRow = Selectable<ExecutionEvidenceTable>;
export type ExecutionConfirmationRow = Selectable<ExecutionConfirmationTable>;
export type ExecutionDisputeRow = Selectable<ExecutionDisputeTable>;
export type PerformanceObservationRow = Selectable<PerformanceObservationTable>;
export type ReviewRow = Selectable<ReviewTable>;
export type ReviewResponseRow = Selectable<ReviewResponseTable>;
export type ReputationSnapshotRow = Selectable<ReputationSnapshotTable>;

export interface ExecutionDatabase {
  execution_defect: ExecutionDefectTable;
  execution_claim: ExecutionClaimTable;
  execution_evidence: ExecutionEvidenceTable;
  execution_confirmation: ExecutionConfirmationTable;
  execution_dispute: ExecutionDisputeTable;
  performance_observation: PerformanceObservationTable;
  review: ReviewTable;
  review_response: ReviewResponseTable;
  reputation_snapshot: ReputationSnapshotTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ExecutionDatabase {}
}

const columns = columnsOf<ExecutionDatabase>();
export const TABLE_COLUMNS: TableColumns<ExecutionDatabase> = {
  execution_defect: columns('execution_defect', [
    'id', 'agreement_id', 'obligation_id', 'claim_id', 'reporter_person_id', 'reporter_company_id', 'subject_person_id', 'subject_company_id', 'reported_by_person_id', 'via', 'mandate_id',
    'severity', 'location', 'description', 'observed_at', 'created_at',
  ]),
  execution_claim: columns('execution_claim', [
    'id', 'agreement_id', 'obligation_id', 'defect_id', 'kind', 'claimant_person_id', 'claimant_company_id', 'counterparty_person_id', 'counterparty_company_id', 'lines', 'period_from',
    'period_to', 'performed_at', 'statement', 'supersedes_claim_id', 'recorded_by_person_id', 'via', 'mandate_id', 'created_at',
  ]),
  execution_evidence: columns('execution_evidence', [
    'id', 'agreement_id', 'claim_id', 'defect_id', 'artifact_id', 'artifact_sha256', 'kind', 'observed_at', 'note', 'attached_by_person_id', 'via', 'mandate_id', 'created_at',
  ]),
  execution_confirmation: columns('execution_confirmation', [
    'id', 'claim_id', 'agreement_id', 'decision', 'lines', 'note', 'stage_code', 'decided_by_person_id', 'on_behalf_person_id', 'on_behalf_company_id', 'decided_at',
  ]),
  execution_dispute: columns('execution_dispute', [
    'id', 'agreement_id', 'hub_id', 'target_kind', 'target_id', 'opened_by_person_id', 'opener_person_id', 'opener_company_id', 'reason', 'status', 'decision', 'decided_by', 'decided_at',
    'decision_reason', 'appealed_by_person_id', 'appeal_reason', 'appealed_at', 'appeal_decision', 'appeal_decided_by', 'appeal_decided_at', 'appeal_decision_reason', 'revision', 'created_at',
    'updated_at',
  ]),
  performance_observation: columns('performance_observation', [
    'id', 'agreement_id', 'source_kind', 'source_id', 'obligation_id', 'claim_id', 'subject_person_id', 'subject_company_id', 'counterparty_person_id', 'counterparty_company_id', 'dimension',
    'outcome', 'due_at', 'performed_at', 'allowance_days', 'late_days', 'attribution', 'excluded_reason', 'plan_change_ids', 'baseline_plan_version_id', 'decided_by_person_id', 'created_at',
  ]),
  review: columns('review', [
    'id', 'agreement_id', 'author_side', 'author_person_id', 'author_company_id', 'subject_person_id', 'subject_company_id', 'written_by_person_id', 'ratings', 'text', 'language',
    'corrects_review_id', 'created_at',
  ]),
  review_response: columns('review_response', ['id', 'review_id', 'agreement_id', 'responder_person_id', 'responder_company_id', 'written_by_person_id', 'text', 'created_at']),
  reputation_snapshot: columns('reputation_snapshot', [
    'id', 'subject_person_id', 'subject_company_id', 'method_version', 'method_digest', 'summary', 'public_summary', 'explanation', 'inputs_digest', 'computed_by_person_id', 'computed_at',
  ]),
};
