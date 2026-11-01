import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Support workspace (SUP-001, packages/data/migrations/support): reads recorded without a case grant, account servicing
 * actions (sign-in factor changes with evidence, a second person and a 72-hour cooling-off) and diagnostic snapshots a
 * requester shares into their own case. Every write goes through the `support_*` SECURITY DEFINER commands; the runtime
 * role never selects `account_service_action.new_email_normalized` (column grant), only its masked form.
 */
export type SupportAccessKindColumn = 'lookup' | 'account_card' | 'access_explainer';
export type AccountServiceActionColumn =
  | 'resend_verification' | 'unlock_after_lockout' | 'revoke_all_sessions' | 'require_password_reset' | 'rebind_recovery_email' | 'reset_second_factor'
  | 'start_data_export' | 'open_deletion_request' | 'send_guided_task';
export type AccountServiceStateColumn = 'pending' | 'cooling_off' | 'done' | 'cancelled';
type ReadOnly<T> = ColumnType<T, never, never>;

export interface SupportAccessRecordTable {
  id: Generated<string>;
  at: Generated<Date>;
  hub_id: string;
  actor_person_id: string;
  support_case_id: string | null;
  kind: SupportAccessKindColumn;
  subject_person_id: string | null;
  query_digest: string | null;
  result_count: Generated<number>;
}
export type SupportAccessRecordRow = Selectable<SupportAccessRecordTable>;

export interface AccountServiceActionTable {
  id: Generated<string>;
  hub_id: string;
  support_case_id: string;
  subject_person_id: string;
  action: AccountServiceActionColumn;
  requested_by: string;
  requested_at: Generated<Date>;
  reason: string;
  evidence_refs: Generated<string[]>;
  request_digest: string | null;
  approval_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  effective_at: Date;
  subject_notified: Generated<boolean>;
  state: AccountServiceStateColumn;
  /** Not selectable by the runtime role. */
  new_email_normalized: ReadOnly<string | null>;
  guided_task: string | null;
  second_factor_reset_id: string | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  executed_by: string | null;
  executed_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type AccountServiceActionRow = Omit<Selectable<AccountServiceActionTable>, 'new_email_normalized'>;

export interface SupportDiagnosticSnapshotTable {
  id: Generated<string>;
  support_case_id: string;
  hub_id: string;
  shared_by: string;
  page_id: string;
  app_version: string;
  locale: string | null;
  feature_flags: Generated<string[]>;
  error_codes: Generated<string[]>;
  request_ids: Generated<string[]>;
  objects: Generated<unknown>;
  created_at: Generated<Date>;
}
export type SupportDiagnosticSnapshotRow = Selectable<SupportDiagnosticSnapshotTable>;

export interface SupportDatabase {
  support_access_record: SupportAccessRecordTable;
  account_service_action: AccountServiceActionTable;
  support_diagnostic_snapshot: SupportDiagnosticSnapshotTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends SupportDatabase {}
}

const columns = columnsOf<SupportDatabase>();
export const TABLE_COLUMNS: TableColumns<SupportDatabase> = {
  support_access_record: columns('support_access_record', ['id', 'at', 'hub_id', 'actor_person_id', 'support_case_id', 'kind', 'subject_person_id', 'query_digest', 'result_count']),
  account_service_action: columns('account_service_action', ['id', 'hub_id', 'support_case_id', 'subject_person_id', 'action', 'requested_by', 'requested_at', 'reason', 'evidence_refs',
    'request_digest', 'approval_id', 'approved_by', 'approved_at', 'effective_at', 'subject_notified', 'state', 'new_email_normalized', 'guided_task', 'second_factor_reset_id',
    'cancelled_by', 'cancelled_at', 'executed_by', 'executed_at', 'revision', 'updated_at']),
  support_diagnostic_snapshot: columns('support_diagnostic_snapshot', ['id', 'support_case_id', 'hub_id', 'shared_by', 'page_id', 'app_version', 'locale', 'feature_flags', 'error_codes',
    'request_ids', 'objects', 'created_at']),
};
