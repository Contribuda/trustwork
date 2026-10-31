import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Hubs module (HUB-001, packages/data/migrations/hubs; docs/engine/hubs.md, docs/engine/hub-console/data-model.md):
 * the profile that extends the DATA-003 hub anchor, immutable configuration versions with a current pointer, launch
 * gates, legal document versions with counsel approvals and acceptances, provider credential references (never secret
 * values) and the retention policy derived from the privacy domain. The runtime role reads under row-level security
 * and writes only through the `hubs_*` SECURITY DEFINER commands (repositories/hubs.ts).
 */
export type ConfigVersionStatus = 'draft' | 'active' | 'superseded' | 'cancelled';
export type LaunchGateState = 'open' | 'passed' | 'invalidated';
export type CredentialStatus = 'registered' | 'active' | 'retired';

export interface HubProfileTable {
  hub_id: string;
  node_id: string;
  name: Record<string, string>;
  default_locale: string;
  locales: string[];
  time_zone: string;
  currency: string;
  brand_overlay: string | null;
  created_by: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type HubProfileRow = Selectable<HubProfileTable>;

export interface HubConfigVersionTable {
  id: Generated<string>;
  hub_id: string;
  domain: string;
  version: number;
  payload: Record<string, unknown>;
  payload_digest: string;
  status: Generated<ConfigVersionStatus>;
  source: Generated<'console' | 'deployment_import'>;
  reason: string;
  drafted_by: string;
  drafted_at: Generated<Date>;
  activated_by: string | null;
  activated_at: Date | null;
  effective_from: Date | null;
  approval_id: string | null;
  superseded_at: Date | null;
  cancelled_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type HubConfigVersionRow = Selectable<HubConfigVersionTable>;

export interface HubConfigCurrentTable {
  hub_id: string;
  domain: string;
  version_id: string;
  version: number;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type HubConfigCurrentRow = Selectable<HubConfigCurrentTable>;

export interface LaunchGateTable {
  id: Generated<string>;
  hub_id: string;
  gate: string;
  state: Generated<LaunchGateState>;
  evidence_ref: string | null;
  checked_by: string | null;
  checked_at: Date | null;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type LaunchGateRow = Selectable<LaunchGateTable>;

export interface CounselApprovalTable {
  id: Generated<string>;
  hub_id: string;
  document_version_ids: string[];
  counsel_name: string;
  firm: string;
  approved_on: Date;
  scope_note: string;
  recorded_by: string;
  recorded_at: Generated<Date>;
}
export type CounselApprovalRow = Selectable<CounselApprovalTable>;

export interface LegalDocumentVersionTable {
  id: Generated<string>;
  hub_id: string;
  kind: string;
  locale: string;
  version: number;
  body: string;
  body_digest: string;
  status: Generated<ConfigVersionStatus>;
  counsel_approval_id: string | null;
  drafted_by: string;
  drafted_at: Generated<Date>;
  activated_by: string | null;
  activated_at: Date | null;
  approval_id: string | null;
  superseded_at: Date | null;
  cancelled_at: Date | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type LegalDocumentVersionRow = Selectable<LegalDocumentVersionTable>;

export interface LegalAcceptanceTable {
  id: Generated<string>;
  person_id: string;
  legal_document_version_id: string;
  context: 'signup' | 'checkout' | 'hosting' | 'authoring' | 'peering';
  accepted_at: Generated<Date>;
}
export type LegalAcceptanceRow = Selectable<LegalAcceptanceTable>;

export interface ProviderCredentialRefTable {
  id: Generated<string>;
  hub_id: string;
  provider: string;
  adapter: string;
  mode: 'fake' | 'manual' | 'live';
  secret_store: 'envelope_db' | 'env' | 'file' | 'external_kms' | 'external_vault';
  secret_ref: string;
  status: Generated<CredentialStatus>;
  registered_by: string;
  registered_at: Generated<Date>;
  activated_by: string | null;
  activated_at: Date | null;
  approval_id: string | null;
  retired_by: string | null;
  retired_at: Date | null;
  rotated_from_id: string | null;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
export type ProviderCredentialRefRow = Selectable<ProviderCredentialRefTable>;

export interface RetentionPolicyTable {
  id: Generated<string>;
  hub_id: string;
  config_version_id: string;
  class: string;
  min_period: string | null;
  max_period: string | null;
  pack_fact_ref: Record<string, unknown> | null;
  disclosure_text_key: string | null;
  created_at: Generated<Date>;
}
export type RetentionPolicyRow = Selectable<RetentionPolicyTable>;

export interface HubsDatabase {
  hub_profile: HubProfileTable;
  hub_config_version: HubConfigVersionTable;
  hub_config_current: HubConfigCurrentTable;
  launch_gate: LaunchGateTable;
  counsel_approval: CounselApprovalTable;
  legal_document_version: LegalDocumentVersionTable;
  legal_acceptance: LegalAcceptanceTable;
  provider_credential_ref: ProviderCredentialRefTable;
  retention_policy: RetentionPolicyTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends HubsDatabase {}
}

const columns = columnsOf<HubsDatabase>();
export const TABLE_COLUMNS: TableColumns<HubsDatabase> = {
  hub_profile: columns('hub_profile', ['hub_id', 'node_id', 'name', 'default_locale', 'locales', 'time_zone', 'currency', 'brand_overlay', 'created_by', 'revision', 'created_at', 'updated_at']),
  hub_config_version: columns('hub_config_version', [
    'id', 'hub_id', 'domain', 'version', 'payload', 'payload_digest', 'status', 'source', 'reason', 'drafted_by', 'drafted_at', 'activated_by', 'activated_at', 'effective_from',
    'approval_id', 'superseded_at', 'cancelled_at', 'revision', 'updated_at',
  ]),
  hub_config_current: columns('hub_config_current', ['hub_id', 'domain', 'version_id', 'version', 'revision', 'updated_at']),
  launch_gate: columns('launch_gate', ['id', 'hub_id', 'gate', 'state', 'evidence_ref', 'checked_by', 'checked_at', 'invalidated_at', 'invalidation_reason', 'revision', 'updated_at']),
  counsel_approval: columns('counsel_approval', ['id', 'hub_id', 'document_version_ids', 'counsel_name', 'firm', 'approved_on', 'scope_note', 'recorded_by', 'recorded_at']),
  legal_document_version: columns('legal_document_version', [
    'id', 'hub_id', 'kind', 'locale', 'version', 'body', 'body_digest', 'status', 'counsel_approval_id', 'drafted_by', 'drafted_at', 'activated_by', 'activated_at', 'approval_id',
    'superseded_at', 'cancelled_at', 'revision', 'updated_at',
  ]),
  legal_acceptance: columns('legal_acceptance', ['id', 'person_id', 'legal_document_version_id', 'context', 'accepted_at']),
  provider_credential_ref: columns('provider_credential_ref', [
    'id', 'hub_id', 'provider', 'adapter', 'mode', 'secret_store', 'secret_ref', 'status', 'registered_by', 'registered_at', 'activated_by', 'activated_at', 'approval_id',
    'retired_by', 'retired_at', 'rotated_from_id', 'revision', 'updated_at',
  ]),
  retention_policy: columns('retention_policy', ['id', 'hub_id', 'config_version_id', 'class', 'min_period', 'max_period', 'pack_fact_ref', 'disclosure_text_key', 'created_at']),
};
