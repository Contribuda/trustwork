import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Row shapes of the governed extension registry (AGT-023, migration packages/data/migrations/agent-extensions). Staff read
 * the registry under row-level security and change it only through the `agent_extensions_*` commands; an `active` manifest
 * is readable by everyone in the hub. A safety run is completed only by the worker role.
 */
export type AgentExtensionStatusColumn = 'draft' | 'tested' | 'active' | 'suspended' | 'retired';

export interface AgentExtensionTable {
  id: Generated<string>;
  hub_id: string;
  key: string;
  created_by: string;
  created_at: Generated<Date>;
}
export interface AgentExtensionEngineTable {
  id: Generated<boolean>;
  engine_version: string;
  observed_at: Generated<Date>;
}
export interface AgentExtensionVersionTable {
  id: Generated<string>;
  extension_id: string;
  hub_id: string;
  version: number;
  manifest: unknown;
  manifest_digest: string;
  status: Generated<AgentExtensionStatusColumn>;
  status_reason: string | null;
  drafted_by: string;
  drafted_at: Generated<Date>;
  passing_run_id: string | null;
  config_version_id: string | null;
  approval_id: string | null;
  approved_by: string | null;
  activated_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export interface AgentExtensionSafetyRunTable {
  id: Generated<string>;
  hub_id: string;
  version_id: string;
  manifest_digest: string;
  trigger: 'staff' | 'engine_update';
  requested_by: string | null;
  state: Generated<'requested' | 'passed' | 'failed'>;
  engine_version: string | null;
  report: unknown;
  report_digest: string | null;
  scenario_count: Generated<number>;
  failed_count: Generated<number>;
  requested_at: Generated<Date>;
  completed_at: Date | null;
}
export interface AgentExtensionTransitionTable {
  id: Generated<string>;
  hub_id: string;
  version_id: string;
  from_status: string;
  to_status: string;
  reason: string | null;
  actor_person_id: string | null;
  at: Generated<Date>;
}

export type AgentExtensionRow = Selectable<AgentExtensionTable>;
export type AgentExtensionVersionRow = Selectable<AgentExtensionVersionTable>;
export type AgentExtensionSafetyRunRow = Selectable<AgentExtensionSafetyRunTable>;
export type AgentExtensionTransitionRow = Selectable<AgentExtensionTransitionTable>;

export interface AgentExtensionsDatabase {
  agent_extension: AgentExtensionTable;
  agent_extension_engine: AgentExtensionEngineTable;
  agent_extension_version: AgentExtensionVersionTable;
  agent_extension_safety_run: AgentExtensionSafetyRunTable;
  agent_extension_transition: AgentExtensionTransitionTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges this module's tables into Database
  interface Database extends AgentExtensionsDatabase {}
}

const columns = columnsOf<AgentExtensionsDatabase>();
export const TABLE_COLUMNS: TableColumns<AgentExtensionsDatabase> = {
  agent_extension: columns('agent_extension', ['id', 'hub_id', 'key', 'created_by', 'created_at']),
  agent_extension_engine: columns('agent_extension_engine', ['id', 'engine_version', 'observed_at']),
  agent_extension_version: columns('agent_extension_version', [
    'id', 'extension_id', 'hub_id', 'version', 'manifest', 'manifest_digest', 'status', 'status_reason', 'drafted_by', 'drafted_at', 'passing_run_id', 'config_version_id', 'approval_id', 'approved_by',
    'activated_at', 'revision', 'updated_at',
  ]),
  agent_extension_safety_run: columns('agent_extension_safety_run', [
    'id', 'hub_id', 'version_id', 'manifest_digest', 'trigger', 'requested_by', 'state', 'engine_version', 'report', 'report_digest', 'scenario_count', 'failed_count', 'requested_at', 'completed_at',
  ]),
  agent_extension_transition: columns('agent_extension_transition', ['id', 'hub_id', 'version_id', 'from_status', 'to_status', 'reason', 'actor_person_id', 'at']),
};
