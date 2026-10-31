import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Kernel module (DATA-003, packages/data/migrations/kernel): the shared tables every later slice references instead of
 * inventing its own file, unit, jurisdiction, taxonomy or hub columns. Reference rows are written only by the
 * maintenance command (`kernelSync`); the runtime role reads them and inserts evidence artifacts under their policy.
 */
type GeneratedInt = Generated<number>;
/** `numeric` columns arrive from pg as exact strings. */
type NumericText = ColumnType<string, string | bigint, string | bigint>;
type Json<T> = ColumnType<T, string, string>;

export type UnitDimension = 'length' | 'area' | 'volume' | 'mass' | 'time' | 'count';
export type UnitSystem = 'si' | 'imperial' | 'us-customary' | 'inch-pound' | 'neutral';
export type JurisdictionLevel = 'country' | 'subdivision' | 'county' | 'city' | 'district' | 'special';
export type JurisdictionSource = 'pack' | 'dataset';
export type HubLifecycle = 'draft' | 'preparing' | 'soft_launch' | 'public' | 'suspended' | 'closing' | 'closed';
export type HubTerritoryLevel = 'country' | 'region' | 'place';
export type TaxonomyScheme =
  | 'topic' | 'category' | 'article_format' | 'event_type' | 'licence_class' | 'need_category' | 'project_type'
  | 'work_type' | 'trade' | 'material' | 'stage' | 'skill' | 'permit_type' | 'inspection_type' | 'decision';
export type TaxonomyStatus = 'draft' | 'released' | 'retired';
export type StepRelation = 'requires_trade' | 'uses_material' | 'precedes_stage' | 'needs_permit_type' | 'teaches' | 'precedes' | 'in_stage';
export type EvidenceParentKind = 'person' | 'company' | 'project' | 'rfq' | 'quote' | 'agreement' | 'order' | 'thread' | 'publication';
export type EvidenceClassification = 'public' | 'shared' | 'party_private' | 'owner_private' | 'restricted';
export type ScanState = 'pending' | 'clean' | 'quarantined';

export interface RestrictedPlaceTable {
  code: string;
  basis: string;
  synced_at: GeneratedTimestamp;
}
export interface UnitTable {
  code: string;
  dimension: UnitDimension;
  system: UnitSystem;
  symbol: string;
  to_base: string | null;
  definition: string;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface UnitConversionRuleTable {
  from_unit: string;
  to_unit: string;
  numerator: NumericText;
  denominator: NumericText;
  exact: Generated<boolean>;
  source: string;
  created_at: GeneratedTimestamp;
}
export interface ExchangeRateSnapshotTable {
  id: GeneratedUuid;
  base_currency: string;
  quote_currency: string;
  rate: string;
  source: string;
  observed_at: Timestamp;
  recorded_at: GeneratedTimestamp;
}
export interface JurisdictionTable {
  code: string;
  parent_code: string | null;
  level: JurisdictionLevel;
  region_kind: string | null;
  source: JurisdictionSource;
  pack_code: string | null;
  pack_version: string;
  /** Computed by trigger from the restricted list and the parent; any written value is overwritten. */
  restricted: Generated<boolean>;
  selectable: Generated<boolean>;
  retired_at: Timestamp | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface HubTable {
  id: GeneratedUuid;
  /** Node-local key (HubSchema.slug). */
  slug: string;
  lifecycle: Generated<HubLifecycle>;
  pack_code: string | null;
  pack_version: string | null;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface HubTerritoryTable {
  id: GeneratedUuid;
  hub_id: string;
  level: HubTerritoryLevel;
  code: string;
  place_key: string | null;
  created_at: GeneratedTimestamp;
}
export interface TaxonomyReleaseTable {
  id: GeneratedUuid;
  hub_id: string | null;
  version: string;
  payload: Json<Record<string, unknown>>;
  digest: string;
  released_by: string | null;
  released_at: GeneratedTimestamp;
}
export interface TaxonomyTermTable {
  id: GeneratedUuid;
  hub_id: string | null;
  scheme: TaxonomyScheme;
  code: string;
  parent_id: string | null;
  status: Generated<TaxonomyStatus>;
  release_id: string | null;
  attributes: ColumnType<Record<string, unknown>, string | undefined, string>;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}
export interface StepTermRelationTable {
  id: GeneratedUuid;
  hub_id: string | null;
  from_term_id: string;
  relation: StepRelation;
  to_term_id: string;
  created_at: GeneratedTimestamp;
}
export interface EvidenceArtifactTable {
  id: GeneratedUuid;
  owner_person_id: string | null;
  owner_company_id: string | null;
  parent_kind: EvidenceParentKind;
  parent_id: string;
  classification: EvidenceClassification;
  storage_key: string;
  sha256: string;
  /** bigint arrives as a string from pg. */
  bytes: ColumnType<string, string | number | bigint, string | number | bigint>;
  media_type: string;
  scan_state: Generated<ScanState>;
  uploaded_by: string;
  legal_hold: Generated<boolean>;
  revision: GeneratedInt;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type Unit = Selectable<UnitTable>;
export type UnitConversionRule = Selectable<UnitConversionRuleTable>;
export type ExchangeRateSnapshotRow = Selectable<ExchangeRateSnapshotTable>;
export type Jurisdiction = Selectable<JurisdictionTable>;
export type Hub = Selectable<HubTable>;
export type HubTerritory = Selectable<HubTerritoryTable>;
export type TaxonomyRelease = Selectable<TaxonomyReleaseTable>;
export type TaxonomyTerm = Selectable<TaxonomyTermTable>;
export type StepTermRelation = Selectable<StepTermRelationTable>;
export type EvidenceArtifact = Selectable<EvidenceArtifactTable>;
export type NewEvidenceArtifact = Insertable<EvidenceArtifactTable>;

export interface KernelDatabase {
  restricted_place: RestrictedPlaceTable;
  unit: UnitTable;
  unit_conversion_rule: UnitConversionRuleTable;
  exchange_rate_snapshot: ExchangeRateSnapshotTable;
  jurisdiction: JurisdictionTable;
  hub: HubTable;
  hub_territory: HubTerritoryTable;
  taxonomy_release: TaxonomyReleaseTable;
  taxonomy_term: TaxonomyTermTable;
  step_term_relation: StepTermRelationTable;
  evidence_artifact: EvidenceArtifactTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends KernelDatabase {}
}

const columns = columnsOf<KernelDatabase>();
export const TABLE_COLUMNS: TableColumns<KernelDatabase> = {
  restricted_place: columns('restricted_place', ['code', 'basis', 'synced_at']),
  unit: columns('unit', ['code', 'dimension', 'system', 'symbol', 'to_base', 'definition', 'revision', 'created_at', 'updated_at']),
  unit_conversion_rule: columns('unit_conversion_rule', ['from_unit', 'to_unit', 'numerator', 'denominator', 'exact', 'source', 'created_at']),
  exchange_rate_snapshot: columns('exchange_rate_snapshot', ['id', 'base_currency', 'quote_currency', 'rate', 'source', 'observed_at', 'recorded_at']),
  jurisdiction: columns('jurisdiction', ['code', 'parent_code', 'level', 'region_kind', 'source', 'pack_code', 'pack_version', 'restricted', 'selectable', 'retired_at', 'revision', 'created_at', 'updated_at']),
  hub: columns('hub', ['id', 'slug', 'lifecycle', 'pack_code', 'pack_version', 'revision', 'created_at', 'updated_at']),
  hub_territory: columns('hub_territory', ['id', 'hub_id', 'level', 'code', 'place_key', 'created_at']),
  taxonomy_release: columns('taxonomy_release', ['id', 'hub_id', 'version', 'payload', 'digest', 'released_by', 'released_at']),
  taxonomy_term: columns('taxonomy_term', ['id', 'hub_id', 'scheme', 'code', 'parent_id', 'status', 'release_id', 'attributes', 'revision', 'created_at', 'updated_at']),
  step_term_relation: columns('step_term_relation', ['id', 'hub_id', 'from_term_id', 'relation', 'to_term_id', 'created_at']),
  evidence_artifact: columns('evidence_artifact', [
    'id', 'owner_person_id', 'owner_company_id', 'parent_kind', 'parent_id', 'classification', 'storage_key', 'sha256', 'bytes', 'media_type',
    'scan_state', 'uploaded_by', 'legal_hold', 'revision', 'created_at', 'updated_at',
  ]),
};
