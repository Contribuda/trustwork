import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Screening module (SANC-003, packages/data/migrations/screening; ADR 014 decisions 11 to 17): subject states, results,
 * matches, decisions and report drafts. The runtime role reads the tables only as a compliance officer or auditor of
 * the node; every write goes through the owner-run `screening_*` commands (worker: results; runtime: decisions and
 * appeals). No table is ever read by a public, counterparty, search, federation or agent projection.
 */
export type ScreeningOutcomeColumn = 'clear' | 'possible_match' | 'insufficient_name' | 'not_screened';
export type ScreeningTriggerColumn = 'registration' | 'sign_in' | 'name_change' | 'company_change' | 'claim' | 'seller' | 'counterparty' | 'payee' | 'organizer' | 'peer' | 'operator' | 'list_update' | 'scheduled';
export type ScreeningMatchStateColumn = 'open' | 'pending_second' | 'not_same_person' | 'confirmed' | 'appeal' | 'pending_reversal';
export type ScreeningDecisionKindColumn = 'confirm' | 'propose_not_same_person' | 'approve' | 'reject' | 'appeal' | 'uphold' | 'propose_reversal';
export type ScreeningEvidenceColumn = 'identity_document' | 'date_of_birth' | 'nationality' | 'address' | 'registration_identifier' | 'other';
/** `numeric` arrives from pg as a string. */
type NumericText = ColumnType<string, never, never>;
type ReadOnly<T> = ColumnType<T, never, never>;

export interface ScreeningSubjectStateTable {
  id: Generated<string>;
  subject_person_id: string | null;
  subject_company_id: string | null;
  names_digest: string;
  last_result_id: string | null;
  last_outcome: ScreeningOutcomeColumn | null;
  last_screened_at: Date | null;
  screened_versions: ReadOnly<string[]>;
  money_held: Generated<boolean>;
  suspended: Generated<boolean>;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ScreeningSubjectStateRow = Selectable<ScreeningSubjectStateTable>;

export interface ScreeningResultTable {
  id: Generated<string>;
  subject_person_id: string | null;
  subject_company_id: string | null;
  trigger: ScreeningTriggerColumn;
  list_version_ids: ReadOnly<string[]>;
  outcome: ScreeningOutcomeColumn;
  matcher_version: string;
  fuzzy_threshold: NumericText | null;
  screened_names_digest: string;
  names_digest: string;
  match_count: Generated<number>;
  screened_at: Generated<Date>;
}
export type ScreeningResultRow = Selectable<ScreeningResultTable>;

export interface ScreeningMatchTable {
  id: Generated<string>;
  result_id: string;
  last_result_id: string;
  subject_person_id: string | null;
  subject_company_id: string | null;
  list_code: string;
  list_version_id: string;
  entry_uid: string;
  entry_type: 'individual' | 'entity' | 'vessel' | 'aircraft';
  entry_digest: string;
  entry_keys_digest: string;
  entry_name: string;
  programs: ReadOnly<string[]>;
  matched_key: string;
  screened_name: string;
  rule: 'engine' | 'fuzzy';
  score: NumericText | null;
  state: Generated<ScreeningMatchStateColumn>;
  opened_at: Generated<Date>;
  decided_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ScreeningMatchRow = Selectable<ScreeningMatchTable>;

export interface ScreeningDecisionTable {
  id: Generated<string>;
  seq: ReadOnly<string>;
  match_id: string;
  kind: ScreeningDecisionKindColumn;
  decided_by: string;
  reason: string;
  evidence_category: ScreeningEvidenceColumn | null;
  second_person_approval_id: string | null;
  approval_digest: string | null;
  case_id: string | null;
  decided_at: Generated<Date>;
}
export type ScreeningDecisionRow = Selectable<ScreeningDecisionTable>;

export interface ScreeningReportDraftTable {
  id: Generated<string>;
  match_id: string;
  subject_person_id: string | null;
  subject_company_id: string | null;
  list_code: string;
  entry_uid: string;
  programs: ReadOnly<string[]>;
  prepared_at: Generated<Date>;
  due_on: Date;
  status: Generated<'draft'>;
}
export type ScreeningReportDraftRow = Selectable<ScreeningReportDraftTable>;

export interface ScreeningDatabase {
  screening_subject_state: ScreeningSubjectStateTable;
  screening_result: ScreeningResultTable;
  screening_match: ScreeningMatchTable;
  screening_decision: ScreeningDecisionTable;
  screening_report_draft: ScreeningReportDraftTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ScreeningDatabase {}
}

const columns = columnsOf<ScreeningDatabase>();
export const TABLE_COLUMNS: TableColumns<ScreeningDatabase> = {
  screening_subject_state: columns('screening_subject_state', ['id', 'subject_person_id', 'subject_company_id', 'names_digest', 'last_result_id', 'last_outcome', 'last_screened_at',
    'screened_versions', 'money_held', 'suspended', 'revision', 'created_at', 'updated_at']),
  screening_result: columns('screening_result', ['id', 'subject_person_id', 'subject_company_id', 'trigger', 'list_version_ids', 'outcome', 'matcher_version', 'fuzzy_threshold',
    'screened_names_digest', 'names_digest', 'match_count', 'screened_at']),
  screening_match: columns('screening_match', ['id', 'result_id', 'last_result_id', 'subject_person_id', 'subject_company_id', 'list_code', 'list_version_id', 'entry_uid', 'entry_type',
    'entry_digest', 'entry_keys_digest', 'entry_name', 'programs', 'matched_key', 'screened_name', 'rule', 'score', 'state', 'opened_at', 'decided_at', 'revision', 'created_at', 'updated_at']),
  screening_decision: columns('screening_decision', ['id', 'seq', 'match_id', 'kind', 'decided_by', 'reason', 'evidence_category', 'second_person_approval_id', 'approval_digest',
    'case_id', 'decided_at']),
  screening_report_draft: columns('screening_report_draft', ['id', 'match_id', 'subject_person_id', 'subject_company_id', 'list_code', 'entry_uid', 'programs', 'prepared_at', 'due_on',
    'status']),
};
