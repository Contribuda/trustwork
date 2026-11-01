import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Screening lists module (SANC-002, packages/data/migrations/screening-lists; ADR 014 decisions 10 and 11): the lists
 * every hub screens against (the OFAC baseline plus a hub's additional lists), their immutable versions and entries.
 * The runtime role reads the tables only as a compliance officer or auditor of the node; the worker writes them only
 * through the owner-run `screening_list_*` entry points and has no table grant.
 */
export type ScreeningListModeColumn = 'fake' | 'file' | 'live';
export type ScreeningListStatusColumn = 'active' | 'paused';
export type ScreeningListVersionStateColumn = 'staged' | 'active' | 'superseded' | 'rejected';
export type ScreeningEntryTypeColumn = 'individual' | 'entity' | 'vessel' | 'aircraft';
export type ScreeningListOutcomeColumn = 'activated' | 'unchanged' | 'needs_confirmation' | 'rejected' | 'malformed' | 'source_missing' | 'refused' | 'failed';
/** `interval` arrives from pg as a postgres-interval object; write it as text ('7 days'). */
type IntervalColumn = ColumnType<unknown, string, string>;
/** `numeric` arrives from pg as a string. */
type NumericText = ColumnType<string, string | number, string | number>;
type Json<T> = ColumnType<T, string, string>;

export interface ScreeningListTable {
  id: Generated<string>;
  hub_id: string | null;
  code: string;
  name: string;
  authority: string;
  source_url: string;
  source_id: Generated<string | null>;
  adapter: string;
  mode: ScreeningListModeColumn;
  cadence: IntervalColumn;
  warn_after: IntervalColumn;
  stale_after: IntervalColumn;
  max_drop_share: NumericText;
  min_entries: Generated<number>;
  baseline: Generated<boolean>;
  status: Generated<ScreeningListStatusColumn>;
  last_checked_at: Date | null;
  last_attempt_at: Date | null;
  last_outcome: ScreeningListOutcomeColumn | null;
  last_error: string | null;
  created_at: Generated<Date>;
}
export type ScreeningListRow = Selectable<ScreeningListTable>;

export interface ScreeningListVersionTable {
  id: Generated<string>;
  list_id: string;
  version: number;
  published_on: Date | null;
  fetched_at: Date;
  mode: ScreeningListModeColumn;
  source_digest: string;
  entry_count: number;
  digest: string;
  state: Generated<ScreeningListVersionStateColumn>;
  sanity: Json<Record<string, unknown>>;
  staged_at: Generated<Date>;
  activated_at: Date | null;
  activated_by: string | null;
  activation_reason: string | null;
  decided_at: Date | null;
  rejected_reason: string | null;
}
export type ScreeningListVersionRow = Selectable<ScreeningListVersionTable>;

export interface ScreeningListEntryTable {
  list_version_id: string;
  entry_uid: string;
  entry_type: ScreeningEntryTypeColumn;
  primary_name: string;
  programs: ColumnType<string[], string[] | undefined, never>;
  name_keys: ColumnType<string[], string[], never>;
  attributes: Json<Record<string, unknown>>;
  entry_digest: string;
}
export type ScreeningListEntryRow = Selectable<ScreeningListEntryTable>;

export interface ScreeningListSourceTable {
  id: Generated<string>; pack_code: string; pack_version: string; fact_id: string; code: string;
  name: string; authority: string; source_url: string; adapter: string; source_digest: string;
  snapshot: Json<unknown>; current: Generated<boolean>; created_at: Generated<Date>;
}
export interface ScreeningListProposalTable {
  id: Generated<string>; hub_id: string; source_id: string; requested_by: string;
  cadence_seconds: number; warn_after_seconds: number; stale_after_seconds: number;
  reason: string; evidence: string; before_digest: string; action_digest: string;
  state: Generated<'pending' | 'approved' | 'rejected'>; created_at: Generated<Date>; expires_at: Generated<Date>;
  decided_by: string | null; decided_at: Date | null; decision_reason: string | null;
}

export interface ScreeningListsDatabase {
  screening_list_source: ScreeningListSourceTable;
  screening_list_proposal: ScreeningListProposalTable;
  screening_list: ScreeningListTable;
  screening_list_version: ScreeningListVersionTable;
  screening_list_entry: ScreeningListEntryTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ScreeningListsDatabase {}
}

const columns = columnsOf<ScreeningListsDatabase>();
export const TABLE_COLUMNS: TableColumns<ScreeningListsDatabase> = {
  screening_list_source: columns('screening_list_source', ['id','pack_code','pack_version','fact_id','code','name','authority','source_url','adapter','source_digest','snapshot','current','created_at']),
  screening_list_proposal: columns('screening_list_proposal', ['id','hub_id','source_id','requested_by','cadence_seconds','warn_after_seconds','stale_after_seconds','reason','evidence','before_digest','action_digest','state','created_at','expires_at','decided_by','decided_at','decision_reason']),
  screening_list: columns('screening_list', ['id', 'hub_id', 'code', 'name', 'authority', 'source_url', 'source_id', 'adapter', 'mode', 'cadence', 'warn_after', 'stale_after', 'max_drop_share',
    'min_entries', 'baseline', 'status', 'last_checked_at', 'last_attempt_at', 'last_outcome', 'last_error', 'created_at']),
  screening_list_version: columns('screening_list_version', ['id', 'list_id', 'version', 'published_on', 'fetched_at', 'mode', 'source_digest', 'entry_count', 'digest', 'state',
    'sanity', 'staged_at', 'activated_at', 'activated_by', 'activation_reason', 'decided_at', 'rejected_reason']),
  screening_list_entry: columns('screening_list_entry', ['list_version_id', 'entry_uid', 'entry_type', 'primary_name', 'programs', 'name_keys', 'attributes', 'entry_digest']),
};
