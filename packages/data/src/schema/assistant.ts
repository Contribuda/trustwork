import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Durable mandates and the agent action workflow (AST-001, packages/data/migrations/assistant): confirmed mandates with
 * their revision history and contexts, inert proposals, mandate uses, the person's stop control, runs and steps, action
 * intents with attempts, outcomes, approvals and reconciliations, the conversation, retained notes and the service
 * backlog. Every table is under FORCE RLS and readable only by its principal; state changes go through the owner-run
 * commands of the migration.
 */
export type MandateStatusValue = 'active' | 'suspended' | 'revoked' | 'expired';
export type GranteeKindValue = 'own_agent' | 'colleague_agent' | 'company_representative';
export type ProposalStatusValue = 'pending' | 'confirmed' | 'declined' | 'expired' | 'superseded';
export type ProposalOriginKindValue = 'chat_intent' | 'agent' | 'module_template' | 'goal' | 'connection' | 'settings';
export type RunStateValue = 'queued' | 'running' | 'waiting_approval' | 'waiting_event' | 'completed' | 'failed' | 'cancelled';
export type RunStepKindValue = 'tool_call' | 'model_call' | 'decision' | 'checkpoint';
export type RunStepStateValue = 'succeeded' | 'failed' | 'allowed' | 'asked' | 'denied' | 'recorded';
export type ActionStateValue = 'proposed' | 'authorized' | 'reserved' | 'queued' | 'executing' | 'pending' | 'succeeded' | 'failed' | 'outcome_unknown' | 'reconciling' | 'revoked';
export type OutcomeKindValue = 'unknown' | 'acknowledged' | 'final';
export type ConversationRoleValue = 'person' | 'agent' | 'system';
export type BacklogStatusValue = 'proposed' | 'accepted' | 'dismissed' | 'done';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;
/** bigint: node-postgres returns int8 as a string. */
type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface MandateTable {
  id: string;
  principal_person_id: string;
  on_behalf_company_id: string | null;
  grantee_kind: GranteeKindValue;
  grantee_person_id: string | null;
  grantee_company_id: string | null;
  module_keys: string[];
  actions: string[];
  revision: number;
  status: MandateStatusValue;
  status_reason: string | null;
  valid_until: Timestamp;
  snapshot: Jsonb;
  digest: string | null;
  confirmed_by_person_id: string;
  confirmed_at: Timestamp;
  confirmed_step_up: boolean;
  revoked_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface MandateContextTable {
  id: GeneratedUuid;
  mandate_id: string;
  context_kind: string;
  context_id: string | null;
  selector: ColumnType<unknown, string | null, string | null>;
}
export interface MandateRevisionTable {
  id: GeneratedUuid;
  mandate_id: string;
  revision: number;
  principal_person_id: string;
  snapshot: Jsonb;
  digest: string | null;
  change_kind: 'confirm' | 'narrow' | 'system';
  changed_by_person_id: string | null;
  reason: string | null;
  changed_at: GeneratedTimestamp;
}
export interface MandateProposalTable {
  id: GeneratedUuid;
  principal_person_id: string;
  mandate_id: string | null;
  basis_revision: number | null;
  origin_kind: ProposalOriginKindValue;
  origin: Jsonb;
  proposed: Jsonb;
  digest: string;
  status: Generated<ProposalStatusValue>;
  created_at: GeneratedTimestamp;
  decided_at: Timestamp | null;
  decided_by_person_id: string | null;
}
export interface MandateUseTable {
  id: GeneratedUuid;
  mandate_id: string;
  mandate_revision: number;
  action_intent_id: string | null;
  action: string;
  amount_minor: Int8 | null;
  currency: string | null;
  approved: Generated<boolean>;
  used_at: GeneratedTimestamp;
  voided_at: Timestamp | null;
}
export interface ParticipantStopTable {
  id: GeneratedUuid;
  scope_kind: 'person_stop';
  person_id: string;
  state: Generated<'engaged' | 'released'>;
  engaged_by: string;
  engaged_at: GeneratedTimestamp;
  released_at: Timestamp | null;
}
export interface RunTable {
  id: GeneratedUuid;
  principal_person_id: string;
  mandate_id: string | null;
  goal_id: string | null;
  kind: string;
  state: Generated<RunStateValue>;
  checkpoint: ColumnType<unknown, string | undefined, string>;
  cost_counters: ColumnType<unknown, string | undefined, string>;
  started_at: GeneratedTimestamp;
  ended_at: Timestamp | null;
  ended_reason: string | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface RunStepTable {
  id: GeneratedUuid;
  run_id: string;
  seq: ColumnType<string, never, never>;
  kind: RunStepKindValue;
  tool: string | null;
  input_digest: string | null;
  output_ref: ColumnType<unknown, string | null, string | null>;
  state: RunStepStateValue;
  started_at: GeneratedTimestamp;
  finished_at: Timestamp | null;
}
export interface ActionIntentTable {
  id: GeneratedUuid;
  run_id: string | null;
  origin: 'run' | 'module_check';
  principal_person_id: string;
  mandate_id: string;
  mandate_revision: number;
  capability_id: string;
  module_key: string;
  action: string;
  context_kind: string;
  context_id: string;
  resolved_from_selector: Generated<boolean>;
  amount_minor: Int8 | null;
  currency: string | null;
  action_digest: string;
  ask_reasons: Generated<string[]>;
  state: ActionStateValue;
  state_reason: string | null;
  reservation_id: string | null;
  attempt_count: Generated<number>;
  effect_correlation_key: string;
  effect: ColumnType<unknown, string | null, string | null>;
  outcome_kind: OutcomeKindValue | null;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface ActionAttemptTable {
  id: GeneratedUuid;
  action_intent_id: string;
  attempt_no: number;
  operation_id: string;
  provider: string;
  job_id: string;
  fencing_token: Int8;
  state: Generated<'executing' | 'ended' | 'abandoned'>;
  started_at: GeneratedTimestamp;
  ended_at: Timestamp | null;
}
export interface ActionOutcomeTable {
  id: GeneratedUuid;
  action_intent_id: string;
  attempt_id: string | null;
  kind: OutcomeKindValue;
  reason: 'timeout' | 'crash' | 'lease_expired' | 'ambiguous_response' | null;
  result: 'succeeded' | 'failed' | null;
  provider_reference: string | null;
  evidence: string | null;
  reconciliation_id: string | null;
  observed_at: GeneratedTimestamp;
}
export interface ApprovalTable {
  id: GeneratedUuid;
  action_intent_id: string;
  action_digest: string;
  mandate_revision: number;
  approver_person_id: string;
  step_up: boolean;
  approved_at: GeneratedTimestamp;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  consumed_at: Timestamp | null;
}
export interface ReconciliationTable {
  id: GeneratedUuid;
  action_intent_id: string;
  attempt_id: string;
  operation_id: string;
  lookup_reference: string;
  outcome: Jsonb;
  reconciled_by: 'worker' | 'staff';
  reconciled_at: GeneratedTimestamp;
}
export interface ConversationTurnTable {
  id: GeneratedUuid;
  person_id: string;
  role: ConversationRoleValue;
  content: string;
  run_id: string | null;
  created_at: GeneratedTimestamp;
  expires_at: GeneratedTimestamp;
}
export interface AssistantNoteTable {
  id: GeneratedUuid;
  person_id: string;
  text: string;
  source_dependencies: ColumnType<unknown, string | undefined, string>;
  retained_at: GeneratedTimestamp;
}
export interface ServiceBacklogItemTable {
  id: GeneratedUuid;
  person_id: string;
  company_id: string | null;
  title: string;
  proposal: Jsonb;
  source_run_id: string | null;
  status: Generated<BacklogStatusValue>;
  revision: Generated<number>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type MandateRow = Selectable<MandateTable>;
export type MandateContextRow = Selectable<MandateContextTable>;
export type MandateRevisionRow = Selectable<MandateRevisionTable>;
export type MandateProposalRow = Selectable<MandateProposalTable>;
export type MandateUseRow = Selectable<MandateUseTable>;
export type ParticipantStopRow = Selectable<ParticipantStopTable>;
export type RunRow = Selectable<RunTable>;
export type RunStepRow = Selectable<RunStepTable>;
export type ActionIntentRow = Selectable<ActionIntentTable>;
export type ActionAttemptRow = Selectable<ActionAttemptTable>;
export type ActionOutcomeRow = Selectable<ActionOutcomeTable>;
export type ApprovalRow = Selectable<ApprovalTable>;
export type ReconciliationRow = Selectable<ReconciliationTable>;
export type ConversationTurnRow = Selectable<ConversationTurnTable>;
export type AssistantNoteRow = Selectable<AssistantNoteTable>;
export type ServiceBacklogItemRow = Selectable<ServiceBacklogItemTable>;

export interface AssistantDatabase {
  mandate: MandateTable;
  mandate_context: MandateContextTable;
  mandate_revision: MandateRevisionTable;
  mandate_proposal: MandateProposalTable;
  mandate_use: MandateUseTable;
  participant_stop: ParticipantStopTable;
  run: RunTable;
  run_step: RunStepTable;
  action_intent: ActionIntentTable;
  action_attempt: ActionAttemptTable;
  action_outcome: ActionOutcomeTable;
  approval: ApprovalTable;
  reconciliation: ReconciliationTable;
  conversation_turn: ConversationTurnTable;
  assistant_note: AssistantNoteTable;
  service_backlog_item: ServiceBacklogItemTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends AssistantDatabase {}
}

const columns = columnsOf<AssistantDatabase>();
export const TABLE_COLUMNS: TableColumns<AssistantDatabase> = {
  mandate: columns('mandate', [
    'id', 'principal_person_id', 'on_behalf_company_id', 'grantee_kind', 'grantee_person_id', 'grantee_company_id', 'module_keys', 'actions', 'revision', 'status', 'status_reason',
    'valid_until', 'snapshot', 'digest', 'confirmed_by_person_id', 'confirmed_at', 'confirmed_step_up', 'revoked_at', 'created_at', 'updated_at',
  ]),
  mandate_context: columns('mandate_context', ['id', 'mandate_id', 'context_kind', 'context_id', 'selector']),
  mandate_revision: columns('mandate_revision', ['id', 'mandate_id', 'revision', 'principal_person_id', 'snapshot', 'digest', 'change_kind', 'changed_by_person_id', 'reason', 'changed_at']),
  mandate_proposal: columns('mandate_proposal', [
    'id', 'principal_person_id', 'mandate_id', 'basis_revision', 'origin_kind', 'origin', 'proposed', 'digest', 'status', 'created_at', 'decided_at', 'decided_by_person_id',
  ]),
  mandate_use: columns('mandate_use', ['id', 'mandate_id', 'mandate_revision', 'action_intent_id', 'action', 'amount_minor', 'currency', 'approved', 'used_at', 'voided_at']),
  participant_stop: columns('participant_stop', ['id', 'scope_kind', 'person_id', 'state', 'engaged_by', 'engaged_at', 'released_at']),
  run: columns('run', [
    'id', 'principal_person_id', 'mandate_id', 'goal_id', 'kind', 'state', 'checkpoint', 'cost_counters', 'started_at', 'ended_at', 'ended_reason', 'revision', 'created_at', 'updated_at',
  ]),
  run_step: columns('run_step', ['id', 'run_id', 'seq', 'kind', 'tool', 'input_digest', 'output_ref', 'state', 'started_at', 'finished_at']),
  action_intent: columns('action_intent', [
    'id', 'run_id', 'origin', 'principal_person_id', 'mandate_id', 'mandate_revision', 'capability_id', 'module_key', 'action', 'context_kind', 'context_id', 'resolved_from_selector',
    'amount_minor', 'currency', 'action_digest', 'ask_reasons', 'state', 'state_reason', 'reservation_id', 'attempt_count', 'effect_correlation_key', 'effect', 'outcome_kind', 'revision',
    'created_at', 'updated_at',
  ]),
  action_attempt: columns('action_attempt', ['id', 'action_intent_id', 'attempt_no', 'operation_id', 'provider', 'job_id', 'fencing_token', 'state', 'started_at', 'ended_at']),
  action_outcome: columns('action_outcome', ['id', 'action_intent_id', 'attempt_id', 'kind', 'reason', 'result', 'provider_reference', 'evidence', 'reconciliation_id', 'observed_at']),
  approval: columns('approval', ['id', 'action_intent_id', 'action_digest', 'mandate_revision', 'approver_person_id', 'step_up', 'approved_at', 'expires_at', 'revoked_at', 'consumed_at']),
  reconciliation: columns('reconciliation', ['id', 'action_intent_id', 'attempt_id', 'operation_id', 'lookup_reference', 'outcome', 'reconciled_by', 'reconciled_at']),
  conversation_turn: columns('conversation_turn', ['id', 'person_id', 'role', 'content', 'run_id', 'created_at', 'expires_at']),
  assistant_note: columns('assistant_note', ['id', 'person_id', 'text', 'source_dependencies', 'retained_at']),
  service_backlog_item: columns('service_backlog_item', ['id', 'person_id', 'company_id', 'title', 'proposal', 'source_run_id', 'status', 'revision', 'created_at', 'updated_at']),
};
