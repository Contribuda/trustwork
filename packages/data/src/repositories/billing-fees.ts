import '../schema/billing-fees.js';
import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import { FeeDisclosureSchema, type FeeDisclosure, PublicFeeSchema, type FeeTerms, type PublicFee } from '../../../contracts/src/billing-fees.js';

export const billingFees = {
  async draft(trx: Transaction, ctx: CommandContext, hubId: string, terms: FeeTerms): Promise<PublicFee> {
    const r = await sql<{ value: unknown }>`SELECT trustwork.billing_fee_draft(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${JSON.stringify(terms)}::jsonb) AS value`.execute(trx);
    return PublicFeeSchema.parse(r.rows[0]?.value);
  },
  async activate(trx: Transaction, ctx: CommandContext, hubId: string, id: string, digest: string, approvalId: string): Promise<PublicFee> {
    const r = await sql<{ value: unknown }>`SELECT trustwork.billing_fee_activate(${JSON.stringify(ctx)}::jsonb, ${hubId}::uuid, ${id}::uuid, ${digest}, ${approvalId}::uuid) AS value`.execute(trx);
    return PublicFeeSchema.parse(r.rows[0]?.value);
  },
  async publicList(pool: DataPool, hubId: string): Promise<PublicFee[]> {
    const r = await pool.query<{ value: unknown }>('SELECT trustwork.billing_fee_list($1::uuid) AS value', [hubId]);
    return PublicFeeSchema.array().parse(r.rows[0]?.value);
  },
};

/**
 * Internal booking adapter: the source module must register authorized immutable source provenance and
 * call bind inside the booking transaction. No public route accepts parties, home hubs or source digests.
 * Modules without that integration have no scope and fail closed.
 */
export const bookingFees = {
  async disclose(trx: Transaction, servedHubId: string, scopeId: string): Promise<FeeDisclosure> {
    const r = await sql<{ id: string; digest: string; snapshot: unknown }>`SELECT id,digest,snapshot FROM trustwork.billing_fee_disclose(${servedHubId}::uuid,${scopeId}::uuid)`.execute(trx);
    return FeeDisclosureSchema.parse(r.rows[0]);
  },
  async confirm(trx: Transaction, servedHubId: string, disclosureId: string, digest: string): Promise<{ id: string; disclosure_id: string }> {
    const r = await sql<{ id: string; disclosure_id: string }>`SELECT id,disclosure_id FROM trustwork.billing_fee_confirm(${servedHubId}::uuid,${disclosureId}::uuid,${digest})`.execute(trx);
    return r.rows[0]!;
  },
  async bind(trx: Transaction, servedHubId: string, confirmationId: string, bookingId: string, sourceDigest: string): Promise<{ id: string; local_fee_id: string; counterparty_fee_id: string }> {
    const r = await sql<{ id: string; local_fee_id: string; counterparty_fee_id: string }>`SELECT id,local_fee_id,counterparty_fee_id FROM trustwork.billing_fee_bind(${servedHubId}::uuid,${confirmationId}::uuid,${bookingId}::uuid,${sourceDigest})`.execute(trx);
    return r.rows[0]!;
  },
};


export const feePricingReaders = {
  async hubAvailable(trx: Transaction, hubId: string): Promise<boolean> {
    const r = await sql<{ available: boolean }>`SELECT trustwork.billing_fee_hub_available(${hubId}::uuid) AS available`.execute(trx);
    return r.rows[0]?.available === true;
  },
  async publishedPlans(trx: Transaction, hubId: string) {
    return trx.selectFrom('subscription_plan_version as p').innerJoin('offer as o', 'o.id', 'p.offer_id')
      .select(['p.id', 'p.version', 'p.price_version_id', 'p.offer_id', 'p.payer_kind', 'p.payload', 'p.status']).where('o.hub_id', '=', hubId)
      .where('o.status', '=', 'active').where('p.status', '=', 'active').orderBy('p.version').execute();
  },
  /** Public allowlist only: no staff, approval, provider-cost or payer records are loaded. */
  async publishedPrices(trx: Transaction, hubId: string, at: Date, plans: boolean) {
    return trx.selectFrom('price_version as p').innerJoin('offer as o', 'o.id', 'p.offer_id')
      .select(['p.id', 'p.version', 'p.offer_id', 'p.currency', 'p.amount_minor', 'p.effective_from', 'p.effective_to',
        'p.acceptance_text_version', 'o.code as offer_code', 'o.kind as offer_kind', 'o.name as offer_name'])
      .where('o.hub_id', '=', hubId).where('o.status', '=', 'active').where('p.status', '=', 'active')
      .where('o.kind', plans ? '=' : '!=', 'plan')
      .where('o.kind', 'in', ['plan', 'deliverable', 'verification_fee', 'agent_module'])
      .where(eb => eb.or([eb('p.effective_to', 'is', null), eb('p.effective_to', '>', at)]))
      .orderBy('o.code').orderBy('p.effective_from').execute();
  },
};
