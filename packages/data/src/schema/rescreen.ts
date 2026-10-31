import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Re-screening module (SANC-005, packages/data/migrations/rescreen; ADR 014 decision 12): runs that screen every person
 * and company again on each activated list version (delta), weekly and on a compliance officer's request (full), and
 * the append-only items that tie a run to the results it recorded. The runtime role reads both tables only as a
 * compliance officer or auditor of the node; every write goes through the owner-run `screening_rescreen_*` entry
 * points. Runs carry counts only; items never carry a name.
 */
export type RescreenTriggerColumn = 'list_version' | 'scheduled' | 'manual';
export type RescreenModeColumn = 'delta' | 'full';
export type RescreenRunStateColumn = 'queued' | 'running' | 'done' | 'failed';
export type RescreenPhaseColumn = 'candidates' | 'all';
type ReadOnly<T> = ColumnType<T, never, never>;

export interface ScreeningRescreenRunTable {
  id: Generated<string>;
  trigger: RescreenTriggerColumn;
  mode: RescreenModeColumn;
  list_version_id: string | null;
  previous_version_id: string | null;
  requested_by: string | null;
  request_reason: string | null;
  state: Generated<RescreenRunStateColumn>;
  phase: RescreenPhaseColumn;
  cursor_kind: 'company' | 'person' | null;
  cursor_id: string | null;
  blocked_reason: 'lists_unavailable' | null;
  window_seconds: number;
  subjects_total: Generated<number>;
  subjects_done: Generated<number>;
  candidates_screened: Generated<number>;
  screened_full: Generated<number>;
  screened_delta: Generated<number>;
  already_current: Generated<number>;
  verified: Generated<number>;
  outcome_clear: Generated<number>;
  outcome_possible_match: Generated<number>;
  outcome_insufficient_name: Generated<number>;
  outcome_not_screened: Generated<number>;
  matches_opened: Generated<number>;
  batches: Generated<number>;
  failures: Generated<number>;
  resumed: Generated<number>;
  last_error: string | null;
  overdue_alerted_at: Date | null;
  queued_at: Generated<Date>;
  started_at: Date | null;
  last_progress_at: Date | null;
  finished_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ScreeningRescreenRunRow = Selectable<ScreeningRescreenRunTable>;

export interface ScreeningRescreenItemTable {
  id: Generated<string>;
  run_id: string;
  subject_person_id: string | null;
  subject_company_id: string | null;
  phase: RescreenPhaseColumn;
  method: 'full' | 'delta';
  result_id: string;
  outcome: 'clear' | 'possible_match' | 'insufficient_name' | 'not_screened';
  base_versions: ReadOnly<string[] | null>;
  recorded_at: Generated<Date>;
}
export type ScreeningRescreenItemRow = Selectable<ScreeningRescreenItemTable>;

export interface RescreenDatabase {
  screening_rescreen_run: ScreeningRescreenRunTable;
  screening_rescreen_item: ScreeningRescreenItemTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends RescreenDatabase {}
}

const columns = columnsOf<RescreenDatabase>();
export const TABLE_COLUMNS: TableColumns<RescreenDatabase> = {
  screening_rescreen_run: columns('screening_rescreen_run', ['id', 'trigger', 'mode', 'list_version_id', 'previous_version_id', 'requested_by', 'request_reason', 'state', 'phase',
    'cursor_kind', 'cursor_id', 'blocked_reason', 'window_seconds', 'subjects_total', 'subjects_done', 'candidates_screened', 'screened_full', 'screened_delta', 'already_current',
    'verified', 'outcome_clear', 'outcome_possible_match', 'outcome_insufficient_name', 'outcome_not_screened', 'matches_opened', 'batches', 'failures', 'resumed', 'last_error',
    'overdue_alerted_at', 'queued_at', 'started_at', 'last_progress_at', 'finished_at', 'revision', 'updated_at']),
  screening_rescreen_item: columns('screening_rescreen_item', ['id', 'run_id', 'subject_person_id', 'subject_company_id', 'phase', 'method', 'result_id', 'outcome', 'base_versions',
    'recorded_at']),
};
