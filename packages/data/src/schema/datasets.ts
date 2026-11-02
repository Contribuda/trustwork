import type { Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Datasets module (MINE-001, packages/data/migrations/datasets; contract DatasetSchema in packages/contracts/src/hub.ts):
 * datasets with legal basis, purpose, personal-data flags, impact assessment, retention and outputs; operator dataset
 * licences; records with per-record provenance; the do-not-collect list (digests only, never read by the runtime
 * role); tombstones of deleted records. The runtime role reads under row-level security (staff of the hub with a
 * datasets permission) and writes only through the `datasets_*` SECURITY DEFINER commands (repositories/datasets.ts).
 */
export type DatasetStatus = 'proposed' | 'active' | 'paused' | 'retired';
export type AllowedUsesJson = Record<string, boolean>;

export interface DatasetTable {
  id: Generated<string>;
  hub_id: string;
  subject: string;
  name: string;
  source_ids: string[];
  purpose: string;
  legal_basis: string;
  personal_present: boolean;
  natural_persons: boolean;
  personal_categories: string[];
  impact_assessment_ref: string | null;
  retention_class: string;
  retention_days: number;
  outputs: string[];
  public_display: boolean;
  subject_notice: boolean;
  contact_use_allowed: Generated<boolean>;
  refresh_schedule_id: string | null;
  status: Generated<DatasetStatus>;
  proposed_by: string;
  activated_by: string | null;
  activated_at: Date | null;
  approval_id: string | null;
  version: Generated<number>;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type DatasetRow = Selectable<DatasetTable>;

export interface DatasetLicenceTable {
  id: Generated<string>;
  hub_id: string;
  dataset_id: string;
  supplier: string;
  agreement_digest: string;
  agreement_ref: string;
  purposes: string[];
  uses: { display: boolean; enrich: boolean; contactUse: boolean; syndicate: boolean };
  valid_from: Date;
  valid_until: Date;
  recorded_by: string;
  created_at: Generated<Date>;
}
export type DatasetLicenceRow = Selectable<DatasetLicenceTable>;

export interface DatasetDoNotCollectTable {
  hub_id: string;
  key_kind: 'identifier' | 'domain' | 'email';
  digest: string;
  reason: 'objection' | 'erasure' | 'legal_demand' | 'operator_decision';
  added_by: string;
  created_at: Generated<Date>;
}

export interface DatasetRecordProvenance {
  sourceUrl: string;
  observedAt: string;
  method: string;
  licenceSnapshot: AllowedUsesJson;
}
export interface DatasetRecordTable {
  id: Generated<string>;
  hub_id: string;
  dataset_id: string;
  source_id: string;
  external_key: string;
  identifier_kind: string | null;
  identifier_value: string | null;
  identifier_norm: Generated<string | null>;
  natural_person: boolean;
  fields: Record<string, string>;
  provenance: DatasetRecordProvenance;
  content_digest: string;
  contact_use: Generated<boolean>;
  contact_use_by: string | null;
  observed_at: Date;
  expires_at: Date;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type DatasetRecordRow = Selectable<DatasetRecordTable>;

export interface DatasetTombstoneTable {
  id: Generated<string>;
  hub_id: string;
  dataset_id: string;
  record_id: string;
  key_digest: string;
  reason: 'retention' | 'licence_ended' | 'do_not_collect' | 'dataset_retired';
  created_at: Generated<Date>;
}
export type DatasetTombstoneRow = Selectable<DatasetTombstoneTable>;

export interface DatasetsDatabase {
  dataset: DatasetTable;
  dataset_licence: DatasetLicenceTable;
  dataset_do_not_collect: DatasetDoNotCollectTable;
  dataset_record: DatasetRecordTable;
  dataset_tombstone: DatasetTombstoneTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends DatasetsDatabase {}
}

const columns = columnsOf<DatasetsDatabase>();
export const TABLE_COLUMNS: TableColumns<DatasetsDatabase> = {
  dataset: columns('dataset', [
    'id', 'hub_id', 'subject', 'name', 'source_ids', 'purpose', 'legal_basis', 'personal_present', 'natural_persons', 'personal_categories', 'impact_assessment_ref',
    'retention_class', 'retention_days', 'outputs', 'public_display', 'subject_notice', 'contact_use_allowed', 'refresh_schedule_id', 'status', 'proposed_by', 'activated_by',
    'activated_at', 'approval_id', 'version', 'revision', 'created_at', 'updated_at',
  ]),
  dataset_licence: columns('dataset_licence', [
    'id', 'hub_id', 'dataset_id', 'supplier', 'agreement_digest', 'agreement_ref', 'purposes', 'uses', 'valid_from', 'valid_until', 'recorded_by', 'created_at',
  ]),
  dataset_do_not_collect: columns('dataset_do_not_collect', ['hub_id', 'key_kind', 'digest', 'reason', 'added_by', 'created_at']),
  dataset_record: columns('dataset_record', [
    'id', 'hub_id', 'dataset_id', 'source_id', 'external_key', 'identifier_kind', 'identifier_value', 'identifier_norm', 'natural_person', 'fields', 'provenance',
    'content_digest', 'contact_use', 'contact_use_by', 'observed_at', 'expires_at', 'created_at', 'updated_at',
  ]),
  dataset_tombstone: columns('dataset_tombstone', ['id', 'hub_id', 'dataset_id', 'record_id', 'key_digest', 'reason', 'created_at']),
};
