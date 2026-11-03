import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { ClaimDisputeRow, ClaimLevel, ClaimState, ClaimsSettingsRow, CompanyClaimRow, CompanyHandoverRow } from '../schema/claims.js';
import type { CommandContext } from './admin.js';
import type { PlannedDelivery } from './communications.js';
import '../schema/claims.js';

/**
 * Company claims and hand-over (CLM-001, migration packages/data/migrations/claims).
 *
 * - **Claimant** under `withPrincipal`: read the recipes a hub offers, submit a claim (with an optional domain tie: an
 *   address of the claimant's own verified logins) and withdraw it; read their own claims and hand-overs.
 * - **Staff** with a `CommandContext`: decide a claim against its recipe (`admin.claims.decide`), propose and confirm
 *   a dispute outcome (two different reviewers), revoke a hand-over (`admin.claims.revoke`), set the waiting and
 *   cooling periods (`admin.claims.policy.edit`). Each command writes the admin audit row in the same transaction.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type ClaimTie = { kind: 'invitation_link' | 'own_domain_mailbox'; email: string } | null;
export interface ClaimRecipe { id: string; level: ClaimLevel; key: string; version: number; steps: unknown; badge_categories: string[]; recheck_months: number }

export const claims = {
  submit(trx: Transaction, hubId: string, companyId: string, level: ClaimLevel, recipeId: string, tie: ClaimTie): Promise<CompanyClaimRow> {
    return one(sql<CompanyClaimRow>`SELECT * FROM trustwork.claims_submit(${hubId}::uuid, ${companyId}::uuid, ${level}::text, ${recipeId}::uuid, ${tie === null ? null : JSON.stringify(tie)}::jsonb)`,
      trx, 'claims_submit');
  },
  withdraw(trx: Transaction, claimId: string): Promise<CompanyClaimRow> {
    return one(sql<CompanyClaimRow>`SELECT * FROM trustwork.claims_withdraw(${claimId}::uuid)`, trx, 'claims_withdraw');
  },
  decide(trx: Transaction, ctx: CommandContext, claimId: string, expectedRevision: number, decision: 'approved' | 'rejected', officerMatch: boolean, note: string | null): Promise<CompanyClaimRow> {
    return one(sql<CompanyClaimRow>`SELECT * FROM trustwork.claims_decide(${ctxJson(ctx)}::jsonb, ${claimId}::uuid, ${expectedRevision}::int, ${decision}::text, ${officerMatch}::boolean,
      ${note}::text)`, trx, 'claims_decide');
  },
  proposeDispute(trx: Transaction, ctx: CommandContext, disputeId: string, expectedRevision: number, winnerClaimId: string | null, note: string): Promise<ClaimDisputeRow> {
    return one(sql<ClaimDisputeRow>`SELECT * FROM trustwork.claims_propose_dispute(${ctxJson(ctx)}::jsonb, ${disputeId}::uuid, ${expectedRevision}::int, ${winnerClaimId}::uuid, ${note}::text)`,
      trx, 'claims_propose_dispute');
  },
  confirmDispute(trx: Transaction, ctx: CommandContext, disputeId: string, expectedRevision: number): Promise<ClaimDisputeRow> {
    return one(sql<ClaimDisputeRow>`SELECT * FROM trustwork.claims_confirm_dispute(${ctxJson(ctx)}::jsonb, ${disputeId}::uuid, ${expectedRevision}::int)`, trx, 'claims_confirm_dispute');
  },
  revoke(trx: Transaction, ctx: CommandContext, handoverId: string, reason: string): Promise<CompanyHandoverRow> {
    return one(sql<CompanyHandoverRow>`SELECT * FROM trustwork.claims_revoke(${ctxJson(ctx)}::jsonb, ${handoverId}::uuid, ${reason}::text)`, trx, 'claims_revoke');
  },
  setSettings(trx: Transaction, ctx: CommandContext, hubId: string, waitingDays: number, coolingDays: number): Promise<ClaimsSettingsRow> {
    return one(sql<ClaimsSettingsRow>`SELECT * FROM trustwork.claims_set_settings(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${waitingDays}::int, ${coolingDays}::int)`, trx,
      'claims_set_settings');
  },

  /** The recipes a hub offers a claimant, per level. */
  async activeRecipes(trx: Transaction, hubId: string): Promise<ClaimRecipe[]> {
    return (await sql<ClaimRecipe>`SELECT * FROM trustwork.claims_active_recipes(${hubId}::uuid)`.execute(trx)).rows;
  },
  /** E-mail deliveries of claim notices the caller planned in this transaction; the API renders them before COMMIT. */
  async plannedDeliveries(trx: Transaction): Promise<PlannedDelivery[]> {
    return (await sql<PlannedDelivery>`SELECT * FROM trustwork.claims_planned_deliveries()`.execute(trx)).rows;
  },

  list(trx: Transaction, hubId: string, state: ClaimState | null = null): Promise<CompanyClaimRow[]> {
    let query = trx.selectFrom('company_claim').selectAll().where('hub_id', '=', hubId);
    if (state) query = query.where('state', '=', state);
    return query.orderBy('created_at').orderBy('id').execute();
  },
  get(trx: Transaction, claimId: string): Promise<CompanyClaimRow | undefined> {
    return trx.selectFrom('company_claim').selectAll().where('id', '=', claimId).executeTakeFirst();
  },
  own(trx: Transaction, personId: string): Promise<CompanyClaimRow[]> {
    return trx.selectFrom('company_claim').selectAll().where('claimant_id', '=', personId).orderBy('created_at').execute();
  },
  disputes(trx: Transaction, hubId: string): Promise<ClaimDisputeRow[]> {
    return trx.selectFrom('claim_dispute').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  dispute(trx: Transaction, disputeId: string): Promise<ClaimDisputeRow | undefined> {
    return trx.selectFrom('claim_dispute').selectAll().where('id', '=', disputeId).executeTakeFirst();
  },
  handovers(trx: Transaction, companyId: string): Promise<CompanyHandoverRow[]> {
    return trx.selectFrom('company_handover').selectAll().where('company_id', '=', companyId).orderBy('created_at').orderBy('id').execute();
  },
  hubHandovers(trx: Transaction, hubId: string): Promise<CompanyHandoverRow[]> {
    return trx.selectFrom('company_handover').selectAll().where('hub_id', '=', hubId).orderBy('created_at').orderBy('id').execute();
  },
  handover(trx: Transaction, handoverId: string): Promise<CompanyHandoverRow | undefined> {
    return trx.selectFrom('company_handover').selectAll().where('id', '=', handoverId).executeTakeFirst();
  },
  ownHandovers(trx: Transaction, personId: string): Promise<CompanyHandoverRow[]> {
    return trx.selectFrom('company_handover').selectAll().where('person_id', '=', personId).orderBy('created_at').orderBy('id').execute();
  },
  settings(trx: Transaction, hubId: string): Promise<ClaimsSettingsRow | undefined> {
    return trx.selectFrom('claims_settings').selectAll().where('hub_id', '=', hubId).executeTakeFirst();
  },
};
