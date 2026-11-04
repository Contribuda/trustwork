import type { ColumnType, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';
import type { MeterCode } from './billing.js';

/**
 * Agent usage prices (AGT-004, packages/data/migrations/billing). `*_micro` columns are `bigint` millionths of a minor
 * unit and stay strings: no JavaScript number and no decimal column ever carries a price.
 */
type Micro = ColumnType<string, string | bigint, string | bigint>;
export type MeteredSubjectKind = 'module' | 'capability' | 'model' | 'meter';
export type MeteredUnit = 'thousand_tokens' | 'action' | 'deliverable' | 'api_call';
export type CostBasis = 'model_list_price' | 'measured_average' | 'contract';

export interface MeteredSubjectTable {
  id: GeneratedUuid; hub_id: string; offer_id: string; kind: MeteredSubjectKind; subject_key: string; direction: 'input' | 'output' | null; meter: MeterCode; unit: MeteredUnit;
  created_at: GeneratedTimestamp;
}
export interface MeteredCostRecordTable {
  id: GeneratedUuid; subject_id: string; version: number; currency: string; cost_micro: Micro; basis: CostBasis; observed_at: Timestamp; recorded_by: string;
  recorded_at: GeneratedTimestamp;
}
export interface MeteredPriceTermTable {
  price_version_id: string; subject_id: string; sale_micro: Micro; per_units: ColumnType<string, string | bigint, never>; basis: 'flat' | 'markup'; markup_percent: number | null;
  cost_micro: Micro; cost_basis: CostBasis; model_pricing_id: string | null; cost_record_id: string | null;
}
export interface AgentMeteringDatabase {
  metered_subject: MeteredSubjectTable;
  metered_cost_record: MeteredCostRecordTable;
  metered_price_term: MeteredPriceTermTable;
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned table augmentation
  interface Database extends AgentMeteringDatabase {}
}
export type MeteredSubjectRow = Selectable<MeteredSubjectTable>;
export type MeteredPriceTermRow = Selectable<MeteredPriceTermTable>;

const columns = columnsOf<AgentMeteringDatabase>();
export const TABLE_COLUMNS: TableColumns<AgentMeteringDatabase> = {
  metered_subject: columns('metered_subject', ['id', 'hub_id', 'offer_id', 'kind', 'subject_key', 'direction', 'meter', 'unit', 'created_at']),
  metered_cost_record: columns('metered_cost_record', ['id', 'subject_id', 'version', 'currency', 'cost_micro', 'basis', 'observed_at', 'recorded_by', 'recorded_at']),
  metered_price_term: columns('metered_price_term', ['price_version_id', 'subject_id', 'sale_micro', 'per_units', 'basis', 'markup_percent', 'cost_micro', 'cost_basis', 'model_pricing_id', 'cost_record_id']),
};
