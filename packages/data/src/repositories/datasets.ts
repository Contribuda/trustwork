import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { DatasetLicenceRow, DatasetRecordRow, DatasetRow, DatasetTombstoneRow } from '../schema/datasets.js';
import type { CommandContext } from './admin.js';
import '../schema/datasets.js';

/**
 * Local data mining (MINE-001, migration packages/data/migrations/datasets).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext`: each calls one `datasets_*` SECURITY DEFINER
 *   command that checks the permission at the hub (`admin.datasets.edit` to propose, license, mark contact use and
 *   ingest; `admin.datasets.activate` to activate, with a second person for personal-data, court and debt datasets)
 *   and writes the admin audit row in the same transaction.
 * - **Reads** under row-level security: staff of the hub with a datasets permission; contact points for OUTR-002.
 * - **Worker** (`datasetsWorker`): ingestion of refresh results and the retention and licence sweep.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const json = (v: unknown): string => JSON.stringify(v);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export interface ProposeDatasetInput {
  subject: string;
  name: string;
  sourceIds: string[];
  purpose: string;
  legalBasis: string;
  personalData: { present: boolean; naturalPersons: boolean; categories: string[] };
  impactAssessmentRef: string | null;
  retention: { className: string; days: number };
  outputs: string[];
  publicDisplay: boolean;
  subjectNotice: boolean;
  refreshScheduleId: string | null;
}
export interface DatasetLicenceInput {
  supplier: string;
  agreementDigest: string;
  agreementRef: string;
  purposes: string[];
  uses: { display: boolean; enrich: boolean; contactUse: boolean; syndicate: boolean };
  validFrom: string;
  validUntil: string;
}
/** One incoming record: its source, key, optional identifier, whether it concerns a natural person, fields and URL. */
export interface DatasetRecordInput {
  sourceId: string;
  externalKey: string;
  identifierKind?: string | null;
  identifierValue?: string | null;
  naturalPerson: boolean;
  fields: Record<string, string>;
  sourceUrl: string;
  method?: string;
}
export interface IngestCounts { stored: number; unchanged: number; droppedDoNotCollect: number }
export interface ContactPointRow {
  record_id: string;
  external_key: string;
  identifier_kind: string | null;
  identifier_value: string | null;
  fields: Record<string, string>;
  provenance: DatasetRecordRow['provenance'];
  observed_at: Date;
}

export const datasets = {
  propose(trx: Transaction, ctx: CommandContext, hubId: string, input: ProposeDatasetInput): Promise<DatasetRow> {
    return one(sql<DatasetRow>`SELECT * FROM trustwork.datasets_propose(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${json(input)}::jsonb)`, trx, 'datasets_propose');
  },
  activate(trx: Transaction, ctx: CommandContext, datasetId: string, expectedRevision: number, approvalId: string | null): Promise<DatasetRow> {
    return one(sql<DatasetRow>`SELECT * FROM trustwork.datasets_activate(${ctxJson(ctx)}::jsonb, ${datasetId}::uuid, ${expectedRevision}::int, ${approvalId}::uuid)`, trx, 'datasets_activate');
  },
  setStatus(trx: Transaction, ctx: CommandContext, datasetId: string, expectedRevision: number, to: 'paused' | 'retired'): Promise<DatasetRow> {
    return one(sql<DatasetRow>`SELECT * FROM trustwork.datasets_set_status(${ctxJson(ctx)}::jsonb, ${datasetId}::uuid, ${expectedRevision}::int, ${to}::text)`, trx, 'datasets_set_status');
  },
  recordLicence(trx: Transaction, ctx: CommandContext, datasetId: string, input: DatasetLicenceInput): Promise<DatasetLicenceRow> {
    return one(sql<DatasetLicenceRow>`SELECT * FROM trustwork.datasets_record_licence(${ctxJson(ctx)}::jsonb, ${datasetId}::uuid, ${json(input)}::jsonb)`, trx, 'datasets_record_licence');
  },
  setContactUse(trx: Transaction, ctx: CommandContext, datasetId: string, expectedRevision: number, allowed: boolean): Promise<DatasetRow> {
    return one(sql<DatasetRow>`SELECT * FROM trustwork.datasets_set_contact_use(${ctxJson(ctx)}::jsonb, ${datasetId}::uuid, ${expectedRevision}::int, ${allowed}::boolean)`, trx,
      'datasets_set_contact_use');
  },
  markContact(trx: Transaction, ctx: CommandContext, recordId: string, allowed: boolean): Promise<DatasetRecordRow> {
    return one(sql<DatasetRecordRow>`SELECT * FROM trustwork.datasets_mark_contact(${ctxJson(ctx)}::jsonb, ${recordId}::uuid, ${allowed}::boolean)`, trx, 'datasets_mark_contact');
  },
  /** Adds a do-not-collect entry (hashed, never stored as given); returns how many stored records were buried. */
  async addDoNotCollect(trx: Transaction, ctx: CommandContext, hubId: string, kind: 'identifier' | 'domain' | 'email', value: string, reason: string): Promise<number> {
    const row = await one(sql<{ v: number }>`SELECT trustwork.datasets_add_do_not_collect(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${kind}::text, ${value}::text, ${reason}::text) AS v`, trx,
      'datasets_add_do_not_collect');
    return row.v;
  },
  async ingest(trx: Transaction, ctx: CommandContext, datasetId: string, records: readonly DatasetRecordInput[]): Promise<IngestCounts> {
    const row = await one(sql<{ v: IngestCounts }>`SELECT trustwork.datasets_ingest(${ctxJson(ctx)}::jsonb, ${datasetId}::uuid, ${json(records)}::jsonb) AS v`, trx, 'datasets_ingest');
    return row.v;
  },
  /** The digest a second person approves before a personal-data, court or debt dataset is activated. */
  async activationDigest(trx: Transaction, datasetId: string, revision: number): Promise<string> {
    const row = await one(sql<{ v: string }>`SELECT trustwork.datasets_activation_digest(${datasetId}::uuid, ${revision}::int) AS v`, trx, 'datasets_activation_digest');
    return row.v;
  },

  list(trx: Transaction, hubId: string): Promise<DatasetRow[]> {
    return trx.selectFrom('dataset').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  get(trx: Transaction, datasetId: string): Promise<DatasetRow | undefined> {
    return trx.selectFrom('dataset').selectAll().where('id', '=', datasetId).executeTakeFirst();
  },
  licences(trx: Transaction, datasetId: string): Promise<DatasetLicenceRow[]> {
    return trx.selectFrom('dataset_licence').selectAll().where('dataset_id', '=', datasetId).orderBy('created_at').orderBy('id').execute();
  },
  records(trx: Transaction, datasetId: string): Promise<DatasetRecordRow[]> {
    return trx.selectFrom('dataset_record').selectAll().where('dataset_id', '=', datasetId).orderBy('external_key').execute();
  },
  tombstones(trx: Transaction, datasetId: string): Promise<DatasetTombstoneRow[]> {
    return trx.selectFrom('dataset_tombstone').selectAll().where('dataset_id', '=', datasetId).orderBy('created_at').orderBy('id').execute();
  },
  async contactPoints(trx: Transaction, hubId: string, datasetId: string): Promise<ContactPointRow[]> {
    const { rows } = await sql<ContactPointRow>`SELECT * FROM trustwork.datasets_contact_points(${hubId}::uuid, ${datasetId}::uuid)`.execute(trx);
    return rows;
  },
};

export const datasetsWorker = {
  async ingest(trx: Transaction, datasetId: string, records: readonly DatasetRecordInput[], now: Date): Promise<IngestCounts> {
    const row = await one(sql<{ v: IngestCounts }>`SELECT trustwork.datasets_worker_ingest(${datasetId}::uuid, ${json(records)}::jsonb, ${now}::timestamptz) AS v`, trx,
      'datasets_worker_ingest');
    return row.v;
  },
  async sweep(trx: Transaction, now: Date): Promise<{ retention: number; licenceEnded: number }> {
    const row = await one(sql<{ v: { retention: number; licenceEnded: number } }>`SELECT trustwork.datasets_sweep(${now}::timestamptz) AS v`, trx, 'datasets_sweep');
    return row.v;
  },
};
