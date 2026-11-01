import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Agent module registry, hub agent policy, job requests, schedules, firings and authorization epochs (AGT-003,
 * packages/data/migrations/agent-modules). Every table is under FORCE RLS. Policy versions are readable by staff of the
 * hub; the current policy (the hub's agent product, naming no participant) by every signed-in session; job requests,
 * schedules and firings by their principal only. Epochs are reachable only through the owner-run functions.
 */
export type JobRequestStatusValue = 'pending' | 'active' | 'withdrawn' | 'lapsed';
export type JobRequestReasonValue = 'proposal_declined' | 'proposal_expired' | 'proposal_superseded' | 'template_withdrawn' | 'module_not_enabled';
export type JobFireCauseValue = 'schedule' | 'deadline' | 'event' | 'goal' | 'request';
export type JobFireOutcomeValue = 'due' | 'blocked' | 'mandate_inactive' | 'subscription_inactive' | 'template_withdrawn';
export type EpochScopeValue = 'node' | 'hub' | 'company' | 'person' | 'connection';
/** jsonb: read as parsed JSON, written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;

export interface AgentPolicyVersionTable {
  config_version_id: string;
  hub_id: string;
  document: Jsonb;
  payload_digest: string;
  base_version_id: string | null;
  narrowed_module_keys: string[];
  drafted_by: string;
  created_at: GeneratedTimestamp;
}
export interface AgentPolicyCurrentTable {
  hub_id: string;
  config_version_id: string;
  document: Jsonb;
  activated_at: GeneratedTimestamp;
  revision: Generated<number>;
  updated_at: GeneratedTimestamp;
}
export interface AgentAuthzEpochTable {
  scope_kind: EpochScopeValue;
  scope_id: string;
  epoch: ColumnType<string, string | number | undefined, string | number>;
  changed_at: GeneratedTimestamp;
}
export interface AgentJobRequestTable {
  id: GeneratedUuid;
  principal_person_id: string;
  on_behalf_company_id: string | null;
  hub_id: string | null;
  module_key: string;
  template_key: string;
  trigger: Jsonb;
  goal_id: string | null;
  on_closed_day: 'skip' | 'next_open_day' | 'run';
  proposal_id: string;
  first_due_at: Timestamp | null;
  status: Generated<JobRequestStatusValue>;
  reason: JobRequestReasonValue | null;
  job_subscription_id: string | null;
  created_at: GeneratedTimestamp;
  decided_at: Timestamp | null;
  revision: Generated<number>;
  updated_at: GeneratedTimestamp;
}
export interface AgentJobScheduleTable {
  execution_not_before: GeneratedTimestamp;
  job_subscription_id: string;
  principal_person_id: string;
  hub_id: string | null;
  job_request_id: string;
  next_due_at: Timestamp | null;
  last_fired_at: Timestamp | null;
  revision: Generated<number>;
  updated_at: GeneratedTimestamp;
}
export interface AgentJobFireTable {
  id: GeneratedUuid;
  job_subscription_id: string;
  principal_person_id: string;
  cause: JobFireCauseValue;
  due_at: Timestamp;
  outcome: JobFireOutcomeValue;
  fired_at: GeneratedTimestamp;
}

export interface AgentJobDeadlineTable {
  id: GeneratedUuid;
  job_subscription_id: string;
  subscription_revision: number;
  principal_person_id: string;
  hub_id: string;
  goal_id: string;
  source_revision: number;
  calendar_version_id: string;
  offset_days: number;
  due_at: Timestamp;
  state: 'pending' | 'elapsed' | 'invalidated' | 'fired';
  created_at: GeneratedTimestamp;
}

export interface AgentJobOccurrenceTable {
  id: GeneratedUuid;
  job_subscription_id: string;
  subscription_revision: number;
  job_request_id: string;
  principal_person_id: string;
  hub_id: string;
  source_kind: 'schedule' | 'request' | 'event' | 'goal' | 'deadline';
  source_key: string;
  source: Jsonb;
  goal_id: string;
  goal_revision: number;
  template_version: number;
  mandate_id: string;
  mandate_revision: number;
  mandate_digest: string;
  state: Generated<'queued' | 'running' | 'succeeded' | 'refused' | 'cancelled'>;
  reason: string | null;
  run_id: string | null;
  report_id: string | null;
  worker_job_id: string | null;
  fencing_token: string | null;
  created_at: GeneratedTimestamp;
  finished_at: Timestamp | null;
}

export interface AgentModulesDatabase {
  agent_job_occurrence: AgentJobOccurrenceTable;
  agent_occurrence_signal: { id: GeneratedUuid; kind: 'schedule' | 'progress'; source_id: string; subscription_revision: number | null; created_at: GeneratedTimestamp };
  agent_serving_hub: { id: GeneratedUuid; origin: string; hub_id: string; active: Generated<boolean>; created_at: GeneratedTimestamp };
  agent_job_provenance: { job_request_id: string; principal_person_id: string; serving_binding_id: string; hub_id: string; session_id: string; operation_id: string; created_at: GeneratedTimestamp };
  agent_mandate_usage: { job_request_id: string; principal_person_id: string; hub_id: string; mandate_id: string; mandate_revision: number; mandate_digest: string; created_at: GeneratedTimestamp };
  agent_policy_version: AgentPolicyVersionTable;
  agent_policy_current: AgentPolicyCurrentTable;
  agent_authz_epoch: AgentAuthzEpochTable;
  agent_job_request: AgentJobRequestTable;
  agent_job_schedule: AgentJobScheduleTable;
  agent_job_fire: AgentJobFireTable;
  agent_job_deadline: AgentJobDeadlineTable;
}

export type AgentPolicyVersionRow = Selectable<AgentPolicyVersionTable>;
export type AgentPolicyCurrentRow = Selectable<AgentPolicyCurrentTable>;
export type AgentJobRequestRow = Selectable<AgentJobRequestTable>;
export type AgentJobScheduleRow = Selectable<AgentJobScheduleTable>;
export type AgentJobFireRow = Selectable<AgentJobFireTable>;

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends AgentModulesDatabase {}
}

const columns = columnsOf<AgentModulesDatabase>();
export const TABLE_COLUMNS: TableColumns<AgentModulesDatabase> = {
  agent_job_occurrence: columns('agent_job_occurrence', ['id', 'job_subscription_id', 'subscription_revision', 'job_request_id', 'principal_person_id', 'hub_id', 'source_kind', 'source_key', 'source', 'goal_id', 'goal_revision', 'template_version', 'mandate_id', 'mandate_revision', 'mandate_digest', 'state', 'reason', 'run_id', 'report_id', 'worker_job_id', 'fencing_token', 'created_at', 'finished_at']),
  agent_occurrence_signal: columns('agent_occurrence_signal', ['id', 'kind', 'source_id', 'subscription_revision', 'created_at']),
  agent_serving_hub: columns('agent_serving_hub', ['id', 'origin', 'hub_id', 'active', 'created_at']),
  agent_job_provenance: columns('agent_job_provenance', ['job_request_id', 'principal_person_id', 'serving_binding_id', 'hub_id', 'session_id', 'operation_id', 'created_at']),
  agent_mandate_usage: columns('agent_mandate_usage', ['job_request_id', 'principal_person_id', 'hub_id', 'mandate_id', 'mandate_revision', 'mandate_digest', 'created_at']),
  agent_policy_version: columns('agent_policy_version', ['config_version_id', 'hub_id', 'document', 'payload_digest', 'base_version_id', 'narrowed_module_keys', 'drafted_by', 'created_at']),
  agent_policy_current: columns('agent_policy_current', ['hub_id', 'config_version_id', 'document', 'activated_at', 'revision', 'updated_at']),
  agent_authz_epoch: columns('agent_authz_epoch', ['scope_kind', 'scope_id', 'epoch', 'changed_at']),
  agent_job_request: columns('agent_job_request', [
    'id', 'principal_person_id', 'on_behalf_company_id', 'hub_id', 'module_key', 'template_key', 'trigger', 'goal_id', 'on_closed_day', 'proposal_id', 'first_due_at', 'status', 'reason',
    'job_subscription_id', 'created_at', 'decided_at', 'revision', 'updated_at',
  ]),
  agent_job_schedule: columns('agent_job_schedule', ['execution_not_before', 'job_subscription_id', 'principal_person_id', 'hub_id', 'job_request_id', 'next_due_at', 'last_fired_at', 'revision', 'updated_at']),
  agent_job_fire: columns('agent_job_fire', ['id', 'job_subscription_id', 'principal_person_id', 'cause', 'due_at', 'outcome', 'fired_at']),
  agent_job_deadline: columns('agent_job_deadline', ['id', 'job_subscription_id', 'subscription_revision', 'principal_person_id', 'hub_id', 'goal_id', 'source_revision', 'calendar_version_id', 'offset_days', 'due_at', 'state', 'created_at']),
};
