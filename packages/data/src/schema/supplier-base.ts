import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Supplier base module (PRC-003, packages/data/migrations/supplier-base; handbook "The company's supplier base" in
 * docs/engine/procurement-and-supply.md, data model section 18a). Every row is party_private of the buying company:
 * the runtime role reads them under row-level security (members of the owning company only) and writes nothing
 * directly; every change goes through the owner-run `supplier_base_*` commands.
 */
export type SupplierStatusColumn = 'prospect' | 'approved' | 'preferred' | 'on_hold' | 'blocked' | 'archived';
export type CounterpartySourceColumn = 'manual' | 'import' | 'document';
export type AssessmentStatusColumn = 'draft' | 'recorded';
type ReadOnly<T> = ColumnType<T, never, never>;
/** `date` columns arrive from pg as Date at local midnight; the repository casts them to text in its queries. */
type DateColumn = ColumnType<Date | string, string, string>;

export interface ExternalCounterpartyTable {
  id: Generated<string>;
  owner_company_id: string;
  name: string;
  name_key: ReadOnly<string>;
  identifiers: ReadOnly<unknown>;
  contacts: ReadOnly<unknown>;
  source: CounterpartySourceColumn;
  claimed_company_id: string | null;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type ExternalCounterpartyRow = Selectable<ExternalCounterpartyTable>;

export interface SupplierRecordTable {
  id: Generated<string>;
  owner_company_id: string;
  linked_company_id: string | null;
  linked_sourced_company_id: string | null;
  external_counterparty_id: string | null;
  status: Generated<SupplierStatusColumn>;
  categories: Generated<string[]>;
  regions: Generated<string[]>;
  internal_notes: string | null;
  default_payment_terms: string | null;
  onboarding: ReadOnly<unknown>;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type SupplierRecordRow = Selectable<SupplierRecordTable>;

export interface SupplierAssessmentTable {
  id: Generated<string>;
  supplier_record_id: string;
  owner_company_id: string;
  period_from: DateColumn;
  period_to: DateColumn;
  criteria_version: number;
  scores: ReadOnly<unknown>;
  assessed_by_person_id: string;
  status: Generated<AssessmentStatusColumn>;
  shared_with_supplier: Generated<boolean>;
  shared_company_id: string | null;
  supplier_response: string | null;
  responded_by_person_id: string | null;
  responded_at: Date | null;
  reputation_input: Generated<boolean>;
  assessed_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type SupplierAssessmentRow = Selectable<SupplierAssessmentTable>;

export interface SupplierBaseDatabase {
  external_counterparty: ExternalCounterpartyTable;
  supplier_record: SupplierRecordTable;
  supplier_assessment: SupplierAssessmentTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends SupplierBaseDatabase {}
}

const columns = columnsOf<SupplierBaseDatabase>();
export const TABLE_COLUMNS: TableColumns<SupplierBaseDatabase> = {
  external_counterparty: columns('external_counterparty', ['id', 'owner_company_id', 'name', 'name_key', 'identifiers', 'contacts', 'source', 'claimed_company_id', 'created_by_person_id',
    'revision', 'created_at', 'updated_at']),
  supplier_record: columns('supplier_record', ['id', 'owner_company_id', 'linked_company_id', 'linked_sourced_company_id', 'external_counterparty_id', 'status', 'categories', 'regions',
    'internal_notes', 'default_payment_terms', 'onboarding', 'created_by_person_id', 'revision', 'created_at', 'updated_at']),
  supplier_assessment: columns('supplier_assessment', ['id', 'supplier_record_id', 'owner_company_id', 'period_from', 'period_to', 'criteria_version', 'scores', 'assessed_by_person_id',
    'status', 'shared_with_supplier', 'shared_company_id', 'supplier_response', 'responded_by_person_id', 'responded_at', 'reputation_input', 'assessed_at', 'revision', 'created_at',
    'updated_at']),
};
