import '../schema/agent-metering.js';
import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import {
  MeteredCostRecordSchema, meteredPriceView, PublicMeteredPriceRowSchema,
  type MeteredCostInput, type MeteredCostRecord, type MeteredPriceDraftTerms, type MeteredPriceVersion, type PublicMeteredPriceRow,
} from '../../../contracts/src/agent-metering.js';

async function value(trx: Transaction, query: ReturnType<typeof sql<{ value: unknown }>>): Promise<unknown> {
  return (await query.execute(trx)).rows[0]?.value;
}

/** Agent usage prices. Every command runs through a SECURITY DEFINER function that checks staff authority and audits. */
export const meteredPrices = {
  async recordCost(trx: Transaction, ctx: CommandContext, hubId: string, input: MeteredCostInput): Promise<MeteredCostRecord> {
    return MeteredCostRecordSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_metered_record_cost(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${JSON.stringify(input)}::jsonb) AS value`));
  },
  async draft(trx: Transaction, ctx: CommandContext, hubId: string, terms: MeteredPriceDraftTerms): Promise<MeteredPriceVersion> {
    return meteredPriceView(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_metered_draft(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${JSON.stringify(terms)}::jsonb) AS value`));
  },
  async activate(trx: Transaction, ctx: CommandContext, hubId: string, id: string, digest: string, approvalId: string): Promise<MeteredPriceVersion> {
    return meteredPriceView(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_metered_activate(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${id}::uuid, ${digest}, ${approvalId}::uuid) AS value`));
  },
  async cancel(trx: Transaction, ctx: CommandContext, hubId: string, id: string): Promise<MeteredPriceVersion> {
    return meteredPriceView(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_metered_cancel(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${id}::uuid) AS value`));
  },
  async staffList(trx: Transaction, ctx: CommandContext, hubId: string): Promise<MeteredPriceVersion[]> {
    const rows = await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_metered_staff_list(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid) AS value`);
    return (rows as unknown[]).map(meteredPriceView);
  },
  /** Anonymous reader: the explicit public allowlist, current and upcoming versions only. */
  async publicList(pool: DataPool, hubId: string, at: Date): Promise<PublicMeteredPriceRow[]> {
    const r = await pool.query<{ value: unknown }>('SELECT trustwork.billing_metered_public($1::uuid, $2::timestamptz) AS value', [hubId, at.toISOString()]);
    return PublicMeteredPriceRowSchema.array().parse(r.rows[0]?.value);
  },
};
