import { sql, type RawBuilder } from 'kysely';
import type { Transaction } from '../pool.js';
import type { ClaimDisputeRow, ClaimLevel, ClaimState, ClaimsSettingsRow, CompanyClaimRow, CompanyHandoverRow, CompanyIdentifierRow, CompanyProfileRow, CompanyVerificationRow } from '../schema/claims.js';
import type { CompanyCountryCorrection } from '../schema/directory.js';
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
 *   cooling periods (`admin.claims.policy.edit`), correct a company's country (`admin.claims.authority.decide`). Each
 *   command writes the admin audit row in the same transaction. Claim review stays inside the hub's territories: the
 *   database refuses a hub that does not cover the company's country, and a company with no country.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type ClaimTie = { kind: 'invitation_link' | 'own_domain_mailbox'; email: string } | null;
export type RecordKind = 'identifier' | 'registration' | 'tax_registration' | 'branch';
/** What a hub shows about a company: categories and dates, never a document. */
export interface PublicBadge { level: ClaimLevel; categories: string[]; decided_at: Date; valid_until: Date }
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

  /** A reviewer binds checks to a claim; a decision counts only these. */
  async bindEvidence(trx: Transaction, ctx: CommandContext, claimId: string, checkIds: readonly string[]): Promise<number> {
    return (await one(sql<{ bound: number }>`SELECT trustwork.claims_bind_evidence(${ctxJson(ctx)}::jsonb, ${claimId}::uuid, ${[...checkIds]}::uuid[]) AS bound`, trx, 'claims_bind_evidence')).bound;
  },
  async evidence(trx: Transaction, claimId: string): Promise<string[]> {
    return (await trx.selectFrom('company_claim_evidence').select('check_id').where('claim_id', '=', claimId).orderBy('bound_at').orderBy('check_id').execute()).map((r) => r.check_id);
  },
  /** A company administrator states a record; the payload's own fields never set a status or a source. */
  async addRecord(trx: Transaction, companyId: string, kind: RecordKind, payload: unknown): Promise<string> {
    return (await one(sql<{ id: string }>`SELECT trustwork.claims_record_add(${companyId}::uuid, ${kind}::text, ${JSON.stringify(payload)}::jsonb) AS id`, trx, 'claims_record_add')).id;
  },
  async retireRecord(trx: Transaction, companyId: string, kind: RecordKind, recordId: string): Promise<void> {
    await sql`SELECT trustwork.claims_record_retire(${companyId}::uuid, ${kind}::text, ${recordId}::uuid)`.execute(trx);
  },
  setProfile(trx: Transaction, companyId: string, payload: unknown): Promise<CompanyProfileRow> {
    return one(sql<CompanyProfileRow>`SELECT * FROM trustwork.claims_set_profile(${companyId}::uuid, ${JSON.stringify(payload)}::jsonb)`, trx, 'claims_set_profile');
  },
  async sourceRecord(trx: Transaction, ctx: CommandContext, hubId: string, companyId: string, kind: RecordKind, payload: unknown, sourceRef: string): Promise<string> {
    return (await one(sql<{ id: string }>`SELECT trustwork.claims_staff_record_add(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${companyId}::uuid, ${kind}::text, ${JSON.stringify(payload)}::jsonb, ${sourceRef}::text) AS id`,
      trx, 'claims_staff_record_add')).id;
  },
  verifyIdentifier(trx: Transaction, ctx: CommandContext, hubId: string, identifierId: string, expectedRevision: number, checkId: string): Promise<CompanyIdentifierRow> {
    return one(sql<CompanyIdentifierRow>`SELECT * FROM trustwork.claims_verify_identifier(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${identifierId}::uuid, ${expectedRevision}::int, ${checkId}::uuid)`, trx, 'claims_verify_identifier');
  },
  /** Needs no principal. */
  async publicRecords(trx: Transaction, companyId: string): Promise<unknown> {
    return (await one(sql<{ records: unknown }>`SELECT trustwork.claims_public_records(${companyId}::uuid) AS records`, trx, 'claims_public_records')).records;
  },
  /** The company's own people; tax registrations only for its administrators. */
  async companyRecords(trx: Transaction, companyId: string): Promise<unknown> {
    return (await one(sql<{ records: unknown }>`SELECT trustwork.claims_company_records(${companyId}::uuid) AS records`, trx, 'claims_company_records')).records;
  },
  /** Staff of the hub with an open claim or case of the company there; audited; never tax registrations. */
  async staffRecords(trx: Transaction, ctx: CommandContext, hubId: string, companyId: string): Promise<unknown> {
    return (await one(sql<{ records: unknown }>`SELECT trustwork.claims_staff_records(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${companyId}::uuid) AS records`, trx, 'claims_staff_records')).records;
  },

  /** A re-check under an active recipe of the level: a new row with a new date, or a refusal that changes nothing. */
  recheck(trx: Transaction, ctx: CommandContext, verificationId: string, recipeId: string): Promise<CompanyVerificationRow> {
    return one(sql<CompanyVerificationRow>`SELECT * FROM trustwork.claims_recheck(${ctxJson(ctx)}::jsonb, ${verificationId}::uuid, ${recipeId}::uuid)`, trx, 'claims_recheck');
  },
  /** Needs no principal: what the hub may show about a company. */
  async publicBadges(trx: Transaction, hubId: string, companyId: string): Promise<PublicBadge[]> {
    return (await sql<PublicBadge>`SELECT * FROM trustwork.claims_public_badges(${hubId}::uuid, ${companyId}::uuid)`.execute(trx)).rows;
  },
  /** Staff of the hub: verifications, optionally of one company, or those that lapse within `dueDays`. */
  verifications(trx: Transaction, hubId: string, filter: { companyId?: string; dueDays?: number } = {}): Promise<CompanyVerificationRow[]> {
    let query = trx.selectFrom('company_verification').selectAll().where('hub_id', '=', hubId);
    if (filter.companyId) query = query.where('company_id', '=', filter.companyId);
    if (filter.dueDays !== undefined) query = query.where('state', '=', 'active').where('valid_until', '<=', new Date(Date.now() + filter.dueDays * 86_400_000));
    return query.orderBy('decided_at').orderBy('id').execute();
  },
  verification(trx: Transaction, verificationId: string): Promise<CompanyVerificationRow | undefined> {
    return trx.selectFrom('company_verification').selectAll().where('id', '=', verificationId).executeTakeFirst();
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
  /** The trusted country a reviewer sees on a claim; null on a company older than the rule. */
  async companyCountry(trx: Transaction, companyId: string): Promise<string | null> {
    return (await trx.selectFrom('company').select('country_code').where('id', '=', companyId).executeTakeFirst())?.country_code ?? null;
  },
  /** `from` restates the country the reviewer saw. Hints: `directory.country_changed`, `directory.outside_territory`, `directory.country_refused`. */
  correctCompanyCountry(trx: Transaction, ctx: CommandContext, hubId: string, companyId: string, from: string | null, to: string): Promise<CompanyCountryCorrection> {
    return one(sql<CompanyCountryCorrection>`SELECT * FROM trustwork.directory_correct_company_country(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${companyId}::uuid, ${from}, ${to})`, trx, 'directory_correct_company_country');
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

/** The worker's side (no principal): verifications past their date lapse and the status follows. */
export const claimsWorker = {
  async runExpiry(trx: Transaction, now: Date, limit: number): Promise<number> {
    const { rows } = await sql<{ expired: number }>`SELECT trustwork.claims_run_expiry(${now}::timestamptz, ${limit}::int) AS expired`.execute(trx);
    return rows[0]?.expired ?? 0;
  },
};
