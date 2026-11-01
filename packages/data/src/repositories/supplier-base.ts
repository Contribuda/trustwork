import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  CounterpartySourceColumn, ExternalCounterpartyRow, SupplierAssessmentRow, SupplierRecordRow, SupplierStatusColumn,
} from '../schema/supplier-base.js';

/**
 * Supplier base repository (PRC-003, migration packages/data/migrations/supplier-base). Every write is one owner-run
 * `supplier_base_*` command that repeats the rules in SQL: only members holding procurement.suppliers.manage of the
 * buying company write, a link reads nothing but the linked company's public claim status, a record links exactly one
 * supplier and moves only forward to a claimed company, revisions are checked under a row lock, and no command appends
 * an outbox event. Reads run under row-level security: members of the buying company only.
 *
 * Card history is read under the caller's own row-level security on the agreement and order tables, so a figure never
 * counts what the person may not see.
 */

export type LinkKind = 'company' | 'sourced_company' | 'external_counterparty';

export interface RecordFields {
  status: SupplierStatusColumn;
  categories: readonly string[];
  regions: readonly string[];
  internalNotes: string | null;
  defaultPaymentTerms: string | null;
  onboarding: readonly unknown[];
}

export interface SharedAssessmentRow {
  id: string;
  buyer_company_id: string;
  period_from: Date | string;
  period_to: Date | string;
  criteria_version: number;
  scores: unknown;
  supplier_response: string | null;
  responded_at: Date | null;
  assessed_at: Date;
  revision: number;
}

export interface OwnHistoryCounts { agreements: number; orders: number }

const one = <T>(rows: T[]): T => {
  const row = rows[0];
  if (!row) throw new Error('supplier base command returned no row');
  return row;
};
const json = (value: unknown): string => JSON.stringify(value);

export const externalCounterparties = {
  async create(trx: Transaction, input: { companyId: string; name: string; identifiers: readonly unknown[]; contacts: readonly unknown[]; source: CounterpartySourceColumn }): Promise<ExternalCounterpartyRow> {
    const { rows } = await sql<ExternalCounterpartyRow>`SELECT * FROM trustwork.supplier_base_create_counterparty(${input.companyId}::uuid, ${input.name}::text,
      ${json(input.identifiers)}::jsonb, ${json(input.contacts)}::jsonb, ${input.source}::text)`.execute(trx);
    return one(rows);
  },
  async update(trx: Transaction, input: { id: string; name: string; identifiers: readonly unknown[]; contacts: readonly unknown[]; expectedRevision: number }): Promise<ExternalCounterpartyRow> {
    const { rows } = await sql<ExternalCounterpartyRow>`SELECT * FROM trustwork.supplier_base_update_counterparty(${input.id}::uuid, ${input.name}::text,
      ${json(input.identifiers)}::jsonb, ${json(input.contacts)}::jsonb, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<ExternalCounterpartyRow | undefined> {
    return trx.selectFrom('external_counterparty').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, companyId: string, limit: number): Promise<ExternalCounterpartyRow[]> {
    return trx.selectFrom('external_counterparty').selectAll().where('owner_company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  },
  /** Normalized names already in the company's base (the import skips them). */
  async existingNameKeys(trx: Transaction, companyId: string, nameKeys: readonly string[]): Promise<Set<string>> {
    if (nameKeys.length === 0) return new Set();
    const rows = await trx.selectFrom('external_counterparty').select('name_key').where('owner_company_id', '=', companyId).where('name_key', 'in', [...nameKeys]).execute();
    return new Set(rows.map((r) => r.name_key));
  },
};

export const supplierRecords = {
  async create(trx: Transaction, input: { companyId: string; link: { kind: LinkKind; id: string } } & RecordFields): Promise<SupplierRecordRow> {
    const { rows } = await sql<SupplierRecordRow>`SELECT * FROM trustwork.supplier_base_create_record(${input.companyId}::uuid, ${input.link.kind}::text, ${input.link.id}::uuid,
      ${input.status}::text, ${[...input.categories]}::text[], ${[...input.regions]}::text[], ${input.internalNotes}::text, ${input.defaultPaymentTerms}::text,
      ${json(input.onboarding)}::jsonb)`.execute(trx);
    return one(rows);
  },
  async update(trx: Transaction, input: { id: string; expectedRevision: number } & RecordFields): Promise<SupplierRecordRow> {
    const { rows } = await sql<SupplierRecordRow>`SELECT * FROM trustwork.supplier_base_update_record(${input.id}::uuid, ${input.status}::text, ${[...input.categories]}::text[],
      ${[...input.regions]}::text[], ${input.internalNotes}::text, ${input.defaultPaymentTerms}::text, ${json(input.onboarding)}::jsonb, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
  async linkClaimed(trx: Transaction, input: { id: string; companyId: string; expectedRevision: number }): Promise<SupplierRecordRow> {
    const { rows } = await sql<SupplierRecordRow>`SELECT * FROM trustwork.supplier_base_link_claimed(${input.id}::uuid, ${input.companyId}::uuid, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<SupplierRecordRow | undefined> {
    return trx.selectFrom('supplier_record').selectAll().where('id', '=', id).executeTakeFirst();
  },
  list(trx: Transaction, input: { companyId: string; status: SupplierStatusColumn | null; limit: number }): Promise<SupplierRecordRow[]> {
    let q = trx.selectFrom('supplier_record').selectAll().where('owner_company_id', '=', input.companyId);
    if (input.status) q = q.where('status', '=', input.status);
    return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit).execute();
  },
  /** Whether the caller may maintain the company's supplier base (procurement.suppliers.manage). */
  async mayManage(trx: Transaction, companyId: string): Promise<boolean> {
    const { rows } = await sql<{ v: boolean }>`SELECT trustwork.supplier_base_may_manage(${companyId}::uuid) AS v`.execute(trx);
    return rows[0]?.v === true;
  },
  /**
   * The buyer's own concluded agreements and live orders with a platform company, under the caller's row-level
   * security on `agreement` and `commercial_order` (people without company.deals.manage see none of them).
   */
  async ownHistory(trx: Transaction, input: { buyerCompanyId: string; supplierCompanyId: string }): Promise<OwnHistoryCounts> {
    const { rows } = await sql<{ agreements: number; orders: number }>`
      SELECT (SELECT count(*)::int FROM trustwork.agreement a
               WHERE a.buyer_company_id = ${input.buyerCompanyId}::uuid AND a.seller_company_id = ${input.supplierCompanyId}::uuid AND a.status = 'accepted_by_both') AS agreements,
             (SELECT count(*)::int FROM trustwork.commercial_order o JOIN trustwork.agreement a ON a.id = o.agreement_id
               WHERE a.buyer_company_id = ${input.buyerCompanyId}::uuid AND a.seller_company_id = ${input.supplierCompanyId}::uuid AND o.status <> 'cancelled') AS orders`.execute(trx);
    const row = rows[0];
    return { agreements: row?.agreements ?? 0, orders: row?.orders ?? 0 };
  },
};

export const supplierAssessments = {
  async draft(trx: Transaction, input: { supplierRecordId: string; from: string; to: string; criteriaVersion: number; scores: readonly unknown[] }): Promise<SupplierAssessmentRow> {
    const { rows } = await sql<SupplierAssessmentRow>`SELECT * FROM trustwork.supplier_base_draft_assessment(${input.supplierRecordId}::uuid, ${input.from}::date, ${input.to}::date,
      ${input.criteriaVersion}::integer, ${json(input.scores)}::jsonb)`.execute(trx);
    return one(rows);
  },
  async record(trx: Transaction, input: { id: string; share: boolean; expectedRevision: number }): Promise<SupplierAssessmentRow> {
    const { rows } = await sql<SupplierAssessmentRow>`SELECT * FROM trustwork.supplier_base_record_assessment(${input.id}::uuid, ${input.share}::boolean, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
  get(trx: Transaction, id: string): Promise<SupplierAssessmentRow | undefined> {
    return trx.selectFrom('supplier_assessment').selectAll().where('id', '=', id).executeTakeFirst();
  },
  listFor(trx: Transaction, supplierRecordId: string, limit: number): Promise<SupplierAssessmentRow[]> {
    return trx.selectFrom('supplier_assessment').selectAll().where('supplier_record_id', '=', supplierRecordId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
  },
  /** The supplier's side: assessments buyers chose to share with the caller's company. */
  async sharedWithMe(trx: Transaction, limit: number): Promise<SharedAssessmentRow[]> {
    const { rows } = await sql<SharedAssessmentRow>`SELECT * FROM trustwork.supplier_base_shared_assessments(${limit}::integer)`.execute(trx);
    return rows;
  },
  async respond(trx: Transaction, input: { id: string; response: string; expectedRevision: number }): Promise<SharedAssessmentRow> {
    const { rows } = await sql<SharedAssessmentRow>`SELECT * FROM trustwork.supplier_base_respond(${input.id}::uuid, ${input.response}::text, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
};
