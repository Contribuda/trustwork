import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Scoped tasks from plan items (TASK-001, packages/data/migrations/tasks): task requests cut from approved plan items,
 * immutable published request versions, versioned task offers pinned to the current request version, the two private
 * halves, invitations, assignments that name the plan item and the agreement version, execution records and reviews.
 * Agreements, acceptance events and obligations are the COM-002 tables (`schema/transactions.ts`, terms_kind `task`).
 * Every table is under FORCE RLS.
 */
export type TaskRequestStatusValue = 'draft' | 'published' | 'closed' | 'cancelled' | 'expired';
export type TaskAudienceValue = 'invited' | 'open';
export type TaskRequestVersionStatusValue = 'draft' | 'published' | 'superseded';
export type TaskInvitationStatusValue = 'sent' | 'withdrawn' | 'declined';
export type TaskOfferStatusValue = 'draft' | 'sent' | 'superseded' | 'withdrawn' | 'expired' | 'accepted' | 'declined';
export type TaskStaleReasonValue = 'request_amended' | 'request_closed';
export type TaskAssignmentStatusValue = 'assigned' | 'in_progress' | 'delivered' | 'accepted' | 'disputed' | 'cancelled';
export type TaskRecordKindValue = 'delivery_claim' | 'acceptance' | 'rejection';
export type TaskVia = 'person' | 'agent';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface TaskRequestTable {
  id: GeneratedUuid;
  owner_person_id: string;
  project_id: string;
  plan_id: string;
  plan_version_id: string;
  plan_item_key: string;
  audience: TaskAudienceValue;
  status: Generated<TaskRequestStatusValue>;
  current_version: number | null;
  current_version_id: string | null;
  closed_reason: string | null;
  creator_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskRequestPrivateTable {
  task_request_id: string;
  owner_person_id: string;
  budget_ceiling_minor: Int8 | null;
  budget_ceiling_currency: string | null;
  owner_notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskRequestVersionTable {
  id: GeneratedUuid;
  task_request_id: string;
  version: number;
  status: Generated<TaskRequestVersionStatusValue>;
  /** The owner's terms (what the brief was built from). */
  terms: Jsonb;
  payload: Jsonb;
  digest: string | null;
  drafted_by_person_id: string;
  published_at: Timestamp | null;
  published_by_person_id: string | null;
  published_via: TaskVia | null;
  published_mandate_id: string | null;
  amendment_reason: string | null;
  superseded_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskInvitationTable {
  id: GeneratedUuid;
  task_request_id: string;
  party_person_id: string | null;
  party_company_id: string | null;
  status: Generated<TaskInvitationStatusValue>;
  sent_by_person_id: string;
  sent_via: TaskVia;
  sent_mandate_id: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskOfferTable {
  id: GeneratedUuid;
  task_request_id: string;
  offeror_person_id: string | null;
  offeror_company_id: string | null;
  /** Set by the guard from the request owner. */
  owner_person_id: ColumnType<string, string | undefined, never>;
  version: number;
  request_version_id: string;
  request_version: number;
  request_version_digest: string;
  status: Generated<TaskOfferStatusValue>;
  payload: Jsonb;
  valid_until: Timestamp;
  digest: string | null;
  stale_reason: ColumnType<TaskStaleReasonValue | null, never, never>;
  stale_at: ColumnType<Date | null, never, never>;
  drafted_by_person_id: string;
  sent_at: Timestamp | null;
  sent_by_person_id: string | null;
  sent_via: TaskVia | null;
  sent_mandate_id: string | null;
  withdrawn_reason: string | null;
  superseded_at: Timestamp | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskOfferPrivateTable {
  task_offer_id: string;
  offeror_person_id: string | null;
  offeror_company_id: string | null;
  floor_price_minor: Int8 | null;
  floor_price_currency: string | null;
  offeror_notes: string | null;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskAssignmentTable {
  id: GeneratedUuid;
  task_request_id: string;
  task_offer_id: string;
  agreement_id: string;
  agreement_digest: string;
  offer_version: number;
  offer_digest: string;
  request_version_id: string;
  request_version: number;
  request_digest: string;
  project_id: string;
  plan_id: string;
  plan_version_id: string;
  plan_item_key: string;
  owner_person_id: string;
  assignee_person_id: string | null;
  assignee_company_id: string | null;
  milestones: Jsonb;
  status: Generated<TaskAssignmentStatusValue>;
  completed_at: Timestamp | null;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TaskExecutionRecordTable {
  id: GeneratedUuid;
  assignment_id: string;
  milestone_key: string;
  kind: TaskRecordKindValue;
  claim_id: string | null;
  evidence: Jsonb;
  note: string | null;
  by_person_id: string | null;
  by_company_id: string | null;
  recorded_by_person_id: string;
  via: TaskVia;
  mandate_id: string | null;
  created_at: GeneratedTimestamp;
}

export interface TaskReviewTable {
  id: GeneratedUuid;
  assignment_id: string;
  author_side: 'owner' | 'assignee';
  author_person_id: string | null;
  author_company_id: string | null;
  subject_person_id: string | null;
  subject_company_id: string | null;
  written_by_person_id: string;
  rating: number;
  text: string | null;
  created_at: GeneratedTimestamp;
}

export type TaskRequestRow = Selectable<TaskRequestTable>;
export type TaskRequestPrivateRow = Selectable<TaskRequestPrivateTable>;
export type TaskRequestVersionRow = Selectable<TaskRequestVersionTable>;
export type TaskInvitationRow = Selectable<TaskInvitationTable>;
export type TaskOfferRow = Selectable<TaskOfferTable>;
export type TaskOfferPrivateRow = Selectable<TaskOfferPrivateTable>;
export type TaskAssignmentRow = Selectable<TaskAssignmentTable>;
export type TaskExecutionRecordRow = Selectable<TaskExecutionRecordTable>;
export type TaskReviewRow = Selectable<TaskReviewTable>;

export interface TasksDatabase {
  task_request: TaskRequestTable;
  task_request_private: TaskRequestPrivateTable;
  task_request_version: TaskRequestVersionTable;
  task_invitation: TaskInvitationTable;
  task_offer: TaskOfferTable;
  task_offer_private: TaskOfferPrivateTable;
  task_assignment: TaskAssignmentTable;
  task_execution_record: TaskExecutionRecordTable;
  task_review: TaskReviewTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends TasksDatabase {}
}

const columns = columnsOf<TasksDatabase>();
export const TABLE_COLUMNS: TableColumns<TasksDatabase> = {
  task_request: columns('task_request', [
    'id', 'owner_person_id', 'project_id', 'plan_id', 'plan_version_id', 'plan_item_key', 'audience', 'status', 'current_version', 'current_version_id', 'closed_reason', 'creator_person_id',
    'revision', 'created_at', 'updated_at',
  ]),
  task_request_private: columns('task_request_private', [
    'task_request_id', 'owner_person_id', 'budget_ceiling_minor', 'budget_ceiling_currency', 'owner_notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  task_request_version: columns('task_request_version', [
    'id', 'task_request_id', 'version', 'status', 'terms', 'payload', 'digest', 'drafted_by_person_id', 'published_at', 'published_by_person_id', 'published_via', 'published_mandate_id',
    'amendment_reason', 'superseded_at', 'revision', 'created_at', 'updated_at',
  ]),
  task_invitation: columns('task_invitation', [
    'id', 'task_request_id', 'party_person_id', 'party_company_id', 'status', 'sent_by_person_id', 'sent_via', 'sent_mandate_id', 'revision', 'created_at', 'updated_at',
  ]),
  task_offer: columns('task_offer', [
    'id', 'task_request_id', 'offeror_person_id', 'offeror_company_id', 'owner_person_id', 'version', 'request_version_id', 'request_version', 'request_version_digest', 'status', 'payload',
    'valid_until', 'digest', 'stale_reason', 'stale_at', 'drafted_by_person_id', 'sent_at', 'sent_by_person_id', 'sent_via', 'sent_mandate_id', 'withdrawn_reason', 'superseded_at', 'revision',
    'created_at', 'updated_at',
  ]),
  task_offer_private: columns('task_offer_private', [
    'task_offer_id', 'offeror_person_id', 'offeror_company_id', 'floor_price_minor', 'floor_price_currency', 'offeror_notes', 'updated_by_person_id', 'revision', 'created_at', 'updated_at',
  ]),
  task_assignment: columns('task_assignment', [
    'id', 'task_request_id', 'task_offer_id', 'agreement_id', 'agreement_digest', 'offer_version', 'offer_digest', 'request_version_id', 'request_version', 'request_digest', 'project_id',
    'plan_id', 'plan_version_id', 'plan_item_key', 'owner_person_id', 'assignee_person_id', 'assignee_company_id', 'milestones', 'status', 'completed_at', 'created_by_person_id', 'revision',
    'created_at', 'updated_at',
  ]),
  task_execution_record: columns('task_execution_record', [
    'id', 'assignment_id', 'milestone_key', 'kind', 'claim_id', 'evidence', 'note', 'by_person_id', 'by_company_id', 'recorded_by_person_id', 'via', 'mandate_id', 'created_at',
  ]),
  task_review: columns('task_review', [
    'id', 'assignment_id', 'author_side', 'author_person_id', 'author_company_id', 'subject_person_id', 'subject_company_id', 'written_by_person_id', 'rating', 'text', 'created_at',
  ]),
};
