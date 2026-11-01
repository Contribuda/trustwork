import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Providers module (KEYS-001, packages/data/migrations/providers; docs/engine/hub-console/providers-and-models.md and
 * data-model.md): provider connections, secret references and their ciphertext, connection tests, operator spending caps,
 * model routes scoped by job, module or extension, the egress matrix, cost records, route kill switches, the spend
 * ledger, cap alerts and the change log with before and after values. The runtime role reads under row-level security
 * (staff of the hub) and writes only through the `providers_*` SECURITY DEFINER commands (repositories/providers.ts);
 * `secret_version` is never readable by a runtime role.
 */
export type ConnectionStatus = 'draft' | 'enabled' | 'disabled';
export type SecretVersionStatus = 'active' | 'grace' | 'destroyed';
export type RouteStatus = 'draft' | 'active' | 'superseded' | 'disabled';

export interface ProviderConnectionTable {
  id: Generated<string>;
  hub_id: string;
  adapter_id: string;
  label: string;
  capabilities: string[];
  mode: 'fake' | 'manual' | 'live';
  endpoint: string | null;
  hosting_kind: 'self_hosted' | 'vendor';
  processing_country: string;
  storage_country: string | null;
  region: string | null;
  zero_retention: boolean | null;
  trains_on_inputs: boolean | null;
  broker: boolean | null;
  credential_ref_id: string | null;
  secret_generation: Generated<number>;
  status: Generated<ConnectionStatus>;
  last_test_id: string | null;
  enabled_by: string | null;
  enabled_at: Date | null;
  approval_id: string | null;
  created_by: string;
  created_at: Generated<Date>;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ProviderConnectionRow = Selectable<ProviderConnectionTable>;

export interface SecretRefTable {
  id: Generated<string>;
  connection_id: string;
  hub_id: string;
  store: Generated<'envelope_db'>;
  ref: string;
  keyed_fingerprint: string;
  version: number;
  status: Generated<SecretVersionStatus>;
  created_by: string;
  created_at: Generated<Date>;
  rotated_at: Date | null;
  grace_until: Date | null;
  destroyed_at: Date | null;
  last_used_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type SecretRefRow = Selectable<SecretRefTable>;

/** Ciphertext of one secret version; no runtime role can SELECT it (mirrored for the catalogue test only). */
export interface SecretVersionTable {
  secret_ref_id: string;
  algorithm: Generated<'aes-256-gcm'>;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  wrapped_key: Buffer;
  kek_id: string;
}

export interface ConnectionTestTable {
  id: Generated<string>;
  connection_id: string;
  hub_id: string;
  tested_by: string;
  tested_at: Generated<Date>;
  outcome: string;
  latency_ms: number | null;
  models_listed: number | null;
  cost_minor: string | null;
  cost_currency: string | null;
  synthetic_input_only: Generated<boolean>;
  probe_digest: string;
  config_digest: string;
  secret_ref_id: string | null;
}
export type ConnectionTestRow = Selectable<ConnectionTestTable>;

export interface ProviderBudgetTable {
  id: Generated<string>;
  hub_id: string;
  scope_kind: 'hub' | 'job' | 'pipeline' | 'agent_module' | 'connection';
  job: string | null;
  pipeline_id: string | null;
  module_key: string | null;
  connection_id: string | null;
  period: 'day' | 'month';
  limit_minor: string;
  currency: string;
  alert_at_percent: Generated<number[]>;
  on_exhausted: 'pause' | 'deny_new';
  status: Generated<'active' | 'retired'>;
  created_by: string;
  created_at: Generated<Date>;
  retired_by: string | null;
  retired_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ProviderBudgetRow = Selectable<ProviderBudgetTable>;

export interface ModelRefJson { connectionId: string; modelId: string; modelRevision: string | null }
export interface ModelRouteTable {
  id: Generated<string>;
  hub_id: string;
  job: string;
  scope_kind: 'job' | 'module' | 'extension';
  module_key: string | null;
  extension_id: string | null;
  version: number;
  primary_ref: ModelRefJson;
  fallbacks: Generated<ModelRefJson[]>;
  allowed_data_classes: string[];
  max_input_tokens: number;
  max_output_tokens: number;
  max_file_bytes: string | null;
  timeout_ms: number;
  budget_id: string | null;
  status: Generated<RouteStatus>;
  reason: string;
  drafted_by: string;
  drafted_at: Generated<Date>;
  activated_by: string | null;
  activated_at: Date | null;
  approval_id: string | null;
  superseded_at: Date | null;
  disabled_by: string | null;
  disabled_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ModelRouteRow = Selectable<ModelRouteTable>;

export interface EgressRuleTable {
  id: Generated<string>;
  hub_id: string;
  connection_id: string;
  data_class: string;
  decision: 'allow' | 'deny';
  require_in_residency: boolean;
  require_zero_retention: boolean;
  version: number;
  approval_id: string | null;
  reason: string;
  created_by: string;
  created_at: Generated<Date>;
}
export type EgressRuleRow = Selectable<EgressRuleTable>;

export interface ModelPricingTable {
  id: Generated<string>;
  hub_id: string;
  connection_id: string;
  model_id: string;
  version: number;
  currency: string;
  input_per_million_tokens: string | null;
  output_per_million_tokens: string | null;
  per_image: string | null;
  per_audio_minute: string | null;
  basis: 'provider_list' | 'contract' | 'measured';
  observed_at: Date;
  source_note: string | null;
  recorded_by: string;
  recorded_at: Generated<Date>;
}
export type ModelPricingRow = Selectable<ModelPricingTable>;

export interface ProviderRouteKillSwitchTable {
  id: Generated<string>;
  hub_id: string;
  job: string;
  scope_kind: 'job' | 'module' | 'extension';
  module_key: string | null;
  extension_id: string | null;
  state: Generated<'engaged' | 'released'>;
  engaged_by: string;
  engaged_at: Generated<Date>;
  reason: string;
  released_by: string | null;
  released_at: Date | null;
  release_approval_id: string | null;
  incident_note: string | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ProviderRouteKillSwitchRow = Selectable<ProviderRouteKillSwitchTable>;

export interface ProviderUsageTable {
  id: Generated<string>;
  hub_id: string;
  request_ref: string;
  route_id: string;
  candidates: string[];
  connection_id: string | null;
  model_id: string | null;
  job: string;
  module_key: string | null;
  extension_id: string | null;
  pipeline_id: string | null;
  data_classes: string[];
  budget_ids: Generated<string[]>;
  paid: boolean;
  state: Generated<'reserved' | 'settled' | 'released'>;
  currency: string;
  reserved_minor: string;
  cost_minor: string | null;
  outcome: 'succeeded' | 'failed' | 'unknown' | null;
  input_tokens: number | null;
  output_tokens: number | null;
  images: number | null;
  audio_seconds: number | null;
  created_at: Generated<Date>;
  settled_at: Date | null;
}
export type ProviderUsageRow = Selectable<ProviderUsageTable>;

export interface ProviderBudgetAlertTable {
  budget_id: string;
  period_start: Date;
  kind: 'alert' | 'exhausted';
  percent: number;
  created_at: Generated<Date>;
}

export interface ProviderConfigChangeTable {
  id: Generated<string>;
  hub_id: string;
  object_type: string;
  object_id: string;
  action: string;
  actor_person_id: string | null;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  approval_id: string | null;
  request_id: string | null;
  occurred_at: Generated<Date>;
}
export type ProviderConfigChangeRow = Selectable<ProviderConfigChangeTable>;

export interface ProvidersDatabase {
  provider_connection: ProviderConnectionTable;
  secret_ref: SecretRefTable;
  secret_version: SecretVersionTable;
  connection_test: ConnectionTestTable;
  provider_budget: ProviderBudgetTable;
  model_route: ModelRouteTable;
  egress_rule: EgressRuleTable;
  model_pricing: ModelPricingTable;
  provider_route_kill_switch: ProviderRouteKillSwitchTable;
  provider_usage: ProviderUsageTable;
  provider_budget_alert: ProviderBudgetAlertTable;
  provider_config_change: ProviderConfigChangeTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends ProvidersDatabase {}
}

const columns = columnsOf<ProvidersDatabase>();
export const TABLE_COLUMNS: TableColumns<ProvidersDatabase> = {
  provider_connection: columns('provider_connection', [
    'id', 'hub_id', 'adapter_id', 'label', 'capabilities', 'mode', 'endpoint', 'hosting_kind', 'processing_country', 'storage_country', 'region', 'zero_retention',
    'trains_on_inputs', 'broker', 'credential_ref_id', 'secret_generation', 'status', 'last_test_id', 'enabled_by', 'enabled_at', 'approval_id', 'created_by', 'created_at', 'revision', 'updated_at',
  ]),
  secret_ref: columns('secret_ref', [
    'id', 'connection_id', 'hub_id', 'store', 'ref', 'keyed_fingerprint', 'version', 'status', 'created_by', 'created_at', 'rotated_at', 'grace_until', 'destroyed_at', 'last_used_at',
    'revision', 'updated_at',
  ]),
  secret_version: columns('secret_version', ['secret_ref_id', 'algorithm', 'ciphertext', 'iv', 'auth_tag', 'wrapped_key', 'kek_id']),
  connection_test: columns('connection_test', [
    'id', 'connection_id', 'hub_id', 'tested_by', 'tested_at', 'outcome', 'latency_ms', 'models_listed', 'cost_minor', 'cost_currency', 'synthetic_input_only', 'probe_digest',
    'config_digest', 'secret_ref_id',
  ]),
  provider_budget: columns('provider_budget', [
    'id', 'hub_id', 'scope_kind', 'job', 'pipeline_id', 'module_key', 'connection_id', 'period', 'limit_minor', 'currency', 'alert_at_percent', 'on_exhausted', 'status', 'created_by',
    'created_at', 'retired_by', 'retired_at', 'revision', 'updated_at',
  ]),
  model_route: columns('model_route', [
    'id', 'hub_id', 'job', 'scope_kind', 'module_key', 'extension_id', 'version', 'primary_ref', 'fallbacks', 'allowed_data_classes', 'max_input_tokens', 'max_output_tokens',
    'max_file_bytes', 'timeout_ms', 'budget_id', 'status', 'reason', 'drafted_by', 'drafted_at', 'activated_by', 'activated_at', 'approval_id', 'superseded_at', 'disabled_by',
    'disabled_at', 'revision', 'updated_at',
  ]),
  egress_rule: columns('egress_rule', [
    'id', 'hub_id', 'connection_id', 'data_class', 'decision', 'require_in_residency', 'require_zero_retention', 'version', 'approval_id', 'reason', 'created_by', 'created_at',
  ]),
  model_pricing: columns('model_pricing', [
    'id', 'hub_id', 'connection_id', 'model_id', 'version', 'currency', 'input_per_million_tokens', 'output_per_million_tokens', 'per_image', 'per_audio_minute', 'basis',
    'observed_at', 'source_note', 'recorded_by', 'recorded_at',
  ]),
  provider_route_kill_switch: columns('provider_route_kill_switch', [
    'id', 'hub_id', 'job', 'scope_kind', 'module_key', 'extension_id', 'state', 'engaged_by', 'engaged_at', 'reason', 'released_by', 'released_at', 'release_approval_id',
    'incident_note', 'revision', 'updated_at',
  ]),
  provider_usage: columns('provider_usage', [
    'id', 'hub_id', 'request_ref', 'route_id', 'candidates', 'connection_id', 'model_id', 'job', 'module_key', 'extension_id', 'pipeline_id', 'data_classes', 'budget_ids', 'paid',
    'state', 'currency', 'reserved_minor', 'cost_minor', 'outcome', 'input_tokens', 'output_tokens', 'images', 'audio_seconds', 'created_at', 'settled_at',
  ]),
  provider_budget_alert: columns('provider_budget_alert', ['budget_id', 'period_start', 'kind', 'percent', 'created_at']),
  provider_config_change: columns('provider_config_change', [
    'id', 'hub_id', 'object_type', 'object_id', 'action', 'actor_person_id', 'reason', 'before', 'after', 'approval_id', 'request_id', 'occurred_at',
  ]),
};
