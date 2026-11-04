import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { BidLevelSheetRow, BidLevelSheetVersionRow, SourcingEligibilityRuleSetRow } from '../schema/sourcing.js';

/**
 * Sourcing repository (PRC-004, migration packages/data/migrations/sourcing). Every write is one owner-run `sourcing_*`
 * command that repeats the rules in SQL: only the buyer side runs an event, pins are checked against the stored quote
 * versions, a sealed RFQ is not levelled, a frozen sheet version never changes, and revisions are checked under a row
 * lock. No levelling command appends an outbox event. Reads run under row-level security: the buyer side only.
 */
const one = <T>(rows: T[]): T => {
  const row = rows[0];
  if (!row) throw new Error('sourcing command returned no row');
  return row;
};
const json = (value: unknown): string => JSON.stringify(value);

export const sourcingAccess = {
  async reader(trx: Transaction, rfqId: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.sourcing_rfq_reader(${rfqId}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },
  /** Whether the seal holds now, by the database clock that row-level security reads. */
  async sealed(trx: Transaction, rfqId: string): Promise<boolean> {
    const { rows } = await sql<{ sealed: boolean }>`SELECT trustwork.sourcing_sealed(${rfqId}::uuid) AS sealed`.execute(trx);
    return rows[0]?.sealed === true;
  },
  /** When the seal on this RFQ lifts, or null for an RFQ that was never sealed. */
  async sealedUntil(trx: Transaction, rfqId: string): Promise<Date | null> {
    const { rows } = await sql<{ until: Date | null }>`SELECT trustwork.sourcing_sealed_until(${rfqId}::uuid) AS until`.execute(trx);
    return rows[0]?.until ?? null;
  },
};

export const levelSheets = {
  forRfq(trx: Transaction, rfqId: string): Promise<BidLevelSheetRow | undefined> {
    return trx.selectFrom('bid_level_sheet').selectAll().where('rfq_id', '=', rfqId).executeTakeFirst();
  },
  version(trx: Transaction, id: string): Promise<BidLevelSheetVersionRow | undefined> {
    return trx.selectFrom('bid_level_sheet_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  versions(trx: Transaction, sheetId: string): Promise<BidLevelSheetVersionRow[]> {
    return trx.selectFrom('bid_level_sheet_version').selectAll().where('sheet_id', '=', sheetId).orderBy('version').execute();
  },
  async openDraft(trx: Transaction, input: { rfqId: string; rfqVersionId: string; payload: unknown; digest: string; mandateId: string | null }): Promise<BidLevelSheetVersionRow> {
    const { rows } = await sql<BidLevelSheetVersionRow>`SELECT * FROM trustwork.sourcing_open_draft(${input.rfqId}::uuid, ${input.rfqVersionId}::uuid, ${json(input.payload)}::jsonb, ${input.digest}::text, ${input.mandateId}::text)`.execute(trx);
    return one(rows);
  },
  async saveDraft(trx: Transaction, input: { versionId: string; payload: unknown; digest: string; expectedRevision: number; mandateId: string | null }): Promise<BidLevelSheetVersionRow> {
    const { rows } = await sql<BidLevelSheetVersionRow>`SELECT * FROM trustwork.sourcing_save_draft(${input.versionId}::uuid, ${json(input.payload)}::jsonb, ${input.digest}::text, ${input.expectedRevision}::integer, ${input.mandateId}::text)`.execute(trx);
    return one(rows);
  },
  async freeze(trx: Transaction, input: { versionId: string; digest: string; expectedRevision: number }): Promise<BidLevelSheetVersionRow> {
    const { rows } = await sql<BidLevelSheetVersionRow>`SELECT * FROM trustwork.sourcing_freeze_sheet(${input.versionId}::uuid, ${input.digest}::text, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
};

export const eligibilityRules = {
  get(trx: Transaction, rfqId: string): Promise<SourcingEligibilityRuleSetRow | undefined> {
    return trx.selectFrom('sourcing_eligibility_rule_set').selectAll().where('rfq_id', '=', rfqId).executeTakeFirst();
  },
  async save(trx: Transaction, input: { rfqId: string; rules: readonly unknown[]; expectedRevision: number | null }): Promise<SourcingEligibilityRuleSetRow> {
    const { rows } = await sql<SourcingEligibilityRuleSetRow>`SELECT * FROM trustwork.sourcing_save_eligibility(${input.rfqId}::uuid, ${json(input.rules)}::jsonb, ${input.expectedRevision}::integer)`.execute(trx);
    return one(rows);
  },
};
