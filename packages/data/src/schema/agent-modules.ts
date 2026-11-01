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

export interface AgentModulesDatabase {
  agent_policy_version: AgentPolicyVersionTable;
  agent_policy_current: AgentPolicyCurrentTable;
  agent_authz_epoch: AgentAuthzEpochTable;
  agent_job_request: AgentJobRequestTable;
  agent_job_schedule: AgentJobScheduleTable;
  agent_job_fire: AgentJobFireTable;
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
  agent_policy_version: columns('agent_policy_version', ['config_version_id', 'hub_id', 'document', 'payload_digest', 'base_version_id', 'narrowed_module_keys', 'drafted_by', 'created_at']),
  agent_policy_current: columns('agent_policy_current', ['hub_id', 'config_version_id', 'document', 'activated_at', 'revision', 'updated_at']),
  agent_authz_epoch: columns('agent_authz_epoch', ['scope_kind', 'scope_id', 'epoch', 'changed_at']),
  agent_job_request: columns('agent_job_request', [
    'id', 'principal_person_id', 'on_behalf_company_id', 'hub_id', 'module_key', 'template_key', 'trigger', 'goal_id', 'on_closed_day', 'proposal_id', 'first_due_at', 'status', 'reason',
    'job_subscription_id', 'created_at', 'decided_at', 'revision', 'updated_at',
  ]),
  agent_job_schedule: columns('agent_job_schedule', ['job_subscription_id', 'principal_person_id', 'hub_id', 'job_request_id', 'next_due_at', 'last_fired_at', 'revision', 'updated_at']),
  agent_job_fire: columns('agent_job_fire', ['id', 'job_subscription_id', 'principal_person_id', 'cause', 'due_at', 'outcome', 'fired_at']),
};
