import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Approval routes module (PRC-001, packages/data/migrations/approval-routes; handbook "Approval routes" in
 * docs/engine/procurement-and-supply.md, data model section 18a). The runtime role reads these tables under row-level
 * security and writes nothing directly: every change goes through the owner-run `approval_*` commands, and decisions
 * only through `approval_decide` in the decider's own first-party session.
 */
export type ApprovalSubjectKindColumn = 'requisition' | 'award' | 'order' | 'order_change' | 'trade_invoice' | 'payment_proposal' | 'document' | 'substitution' | 'budget_change' | 'payee_change' | 'supplier_status';
export type ApprovalRouteStatusColumn = 'draft' | 'active' | 'superseded';
export type ApprovalRequestStatusColumn = 'pending' | 'approved' | 'rejected' | 'returned' | 'withdrawn' | 'expired' | 'superseded';
export type ApprovalStepStatusColumn = 'waiting' | 'pending' | 'approved' | 'rejected' | 'returned' | 'expired' | 'closed';
export type ApprovalDelegationStatusColumn = 'active' | 'ended' | 'revoked';
/** `numeric` arrives from pg as a string. */
type NumericText = ColumnType<string, string, never>;
type ReadOnly<T> = ColumnType<T, never, never>;

export interface ApprovalRouteVersionTable {
  id: Generated<string>;
  owner_company_id: string;
  subject_kind: ApprovalSubjectKindColumn;
  version: number;
  payload: ReadOnly<unknown>;
  digest: string;
  template_key: string | null;
  template_version: number | null;
  drafted_by: string;
  drafted_at: Generated<Date>;
  activated_by: string | null;
  activated_at: Date | null;
  superseded_at: Date | null;
  second_person_required: Generated<boolean>;
  status: Generated<ApprovalRouteStatusColumn>;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ApprovalRouteVersionRow = Selectable<ApprovalRouteVersionTable>;

export interface ApprovalRequestTable {
  id: Generated<string>;
  owner_company_id: string;
  subject_kind: ApprovalSubjectKindColumn;
  subject_id: string;
  subject_version_id: string;
  subject_digest: string;
  route_version_id: string;
  project_id: string | null;
  current_step: string;
  requested_by_person_id: string;
  amount_minor: NumericText | null;
  currency: string | null;
  facts: ReadOnly<unknown>;
  status: Generated<ApprovalRequestStatusColumn>;
  submitted_at: Date;
  closed_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ApprovalRequestRow = Selectable<ApprovalRequestTable>;

export interface ApprovalRequestStepTable {
  request_id: string;
  step_key: string;
  step_order: number;
  quorum: number;
  selector: ReadOnly<unknown>;
  escalation: ReadOnly<unknown>;
  timeout_hours: number;
  escalation_level: Generated<number>;
  due_at: Date | null;
  approvals: Generated<number>;
  status: ApprovalStepStatusColumn;
  escalated_at: Date | null;
  completed_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ApprovalRequestStepRow = Selectable<ApprovalRequestStepTable>;

export interface ApprovalDecisionTable {
  id: Generated<string>;
  approval_request_id: string;
  step_key: string;
  approver_person_id: string;
  voter_person_id: ReadOnly<string>;
  on_behalf_company_id: string;
  delegated_from_person_id: string | null;
  delegation_id: string | null;
  decision: 'approve' | 'reject' | 'return';
  subject_digest: string;
  reason: string | null;
  confirmation_via: Generated<'first_party_form'>;
  session_id: string;
  step_up: boolean;
  escalation_level: number;
  sod_flag: string | null;
  decided_at: Date;
}
export type ApprovalDecisionRow = Selectable<ApprovalDecisionTable>;

export interface ApprovalDelegationTable {
  id: Generated<string>;
  company_id: string;
  delegator_person_id: string;
  delegate_person_id: string;
  subject_kinds: ReadOnly<ApprovalSubjectKindColumn[]>;
  limit_minor: NumericText | null;
  limit_currency: string | null;
  valid_from: Date;
  valid_until: Date;
  status: Generated<ApprovalDelegationStatusColumn>;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ApprovalDelegationRow = Selectable<ApprovalDelegationTable>;

export interface ApprovalRoutesDatabase {
  approval_route_version: ApprovalRouteVersionTable;
  approval_request: ApprovalRequestTable;
  approval_request_step: ApprovalRequestStepTable;
  approval_decision: ApprovalDecisionTable;
  approval_delegation: ApprovalDelegationTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ApprovalRoutesDatabase {}
}

const columns = columnsOf<ApprovalRoutesDatabase>();
export const TABLE_COLUMNS: TableColumns<ApprovalRoutesDatabase> = {
  approval_route_version: columns('approval_route_version', ['id', 'owner_company_id', 'subject_kind', 'version', 'payload', 'digest', 'template_key', 'template_version', 'drafted_by',
    'drafted_at', 'activated_by', 'activated_at', 'superseded_at', 'second_person_required', 'status', 'revision', 'created_at', 'updated_at']),
  approval_request: columns('approval_request', ['id', 'owner_company_id', 'subject_kind', 'subject_id', 'subject_version_id', 'subject_digest', 'route_version_id', 'project_id',
    'current_step', 'requested_by_person_id', 'amount_minor', 'currency', 'facts', 'status', 'submitted_at', 'closed_at', 'revision', 'created_at', 'updated_at']),
  approval_request_step: columns('approval_request_step', ['request_id', 'step_key', 'step_order', 'quorum', 'selector', 'escalation', 'timeout_hours', 'escalation_level', 'due_at',
    'approvals', 'status', 'escalated_at', 'completed_at', 'revision', 'updated_at']),
  approval_decision: columns('approval_decision', ['id', 'approval_request_id', 'step_key', 'approver_person_id', 'voter_person_id', 'on_behalf_company_id', 'delegated_from_person_id',
    'delegation_id', 'decision', 'subject_digest', 'reason', 'confirmation_via', 'session_id', 'step_up', 'escalation_level', 'sod_flag', 'decided_at']),
  approval_delegation: columns('approval_delegation', ['id', 'company_id', 'delegator_person_id', 'delegate_person_id', 'subject_kinds', 'limit_minor', 'limit_currency', 'valid_from',
    'valid_until', 'status', 'revoked_at', 'revoked_by', 'revoked_reason', 'revision', 'created_at', 'updated_at']),
};
