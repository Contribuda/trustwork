import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type {
  BillingAccountRow, BudgetKindColumn, BudgetRow, CreditGrantRow, EntitlementRow, EntitlementSource, LedgerEntryRow, MarketplaceFeeVersionRow, MeterCode, MeterRateVersionRow, OfferKind,
  OfferRow, PriceAcceptanceRow, PriceVersionRow, ProviderClass, ReservationRow, SubscriptionPlanVersionRow, SubscriptionRow, SubscriptionStatus, UsageRecordRow,
} from '../schema/billing.js';

/**
 * Billing persistence (BILL-001). Two kinds of calls:
 *
 * - Runtime calls run under `withPrincipal` (RLS applies): opening a billing account, accepting a price version,
 *   cancelling a subscription, reading one's own billing rows and the budget commands, which go only through the
 *   SECURITY DEFINER functions `billing_grant_budget`, `billing_set_budget_limit`, `billing_close_budget`,
 *   `billing_reserve`, `billing_settle` and `billing_release` (authority re-checked in the database).
 * - Owner-run calls (marked "owner-run") need a `withMaintenance` transaction: catalogue administration until the staff
 *   roles of DATA-002 exist, starting subscriptions and granting entitlements from payment evidence (BILL-002), usage
 *   recording for the agent runtime (AGT-004), refunds, ledger corrections, credits and the expiry sweep. Triggers
 *   enforce the version and money rules on this path too.
 *
 * Money is always a string of integer minor units; nothing here converts it to a JavaScript number.
 */
export type PartyRef = { kind: 'person' | 'company'; id: string };
const ownerColumns = (party: PartyRef) => ({ person: party.kind === 'person' ? party.id : null, company: party.kind === 'company' ? party.id : null });
const minor = (value: string | bigint): string => {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (!/^(0|-?[1-9]\d*)$/.test(text)) throw new Error('money must be integer minor units');
  return text;
};
async function one<T>(promise: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const { rows } = await promise;
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export const billingAccounts = {
  /** Runtime: the caller opens an account for themself or, with company.billing.manage, for the active employer. */
  async open(trx: Transaction, input: { hubId: string; owner: PartyRef; currency: string; createdBy: string; taxRegistrationId?: string | null }): Promise<BillingAccountRow> {
    const owner = ownerColumns(input.owner);
    return trx.insertInto('billing_account').values({
      hub_id: input.hubId, owner_person_id: owner.person, owner_company_id: owner.company, currency: input.currency, created_by: input.createdBy, tax_registration_id: input.taxRegistrationId ?? null,
    }).returningAll().executeTakeFirstOrThrow();
  },
  async get(trx: Transaction, id: string): Promise<BillingAccountRow | undefined> {
    return trx.selectFrom('billing_account').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** The active account of a party in a hub and currency, when the caller may see it. */
  async findActive(trx: Transaction, owner: PartyRef, hubId: string, currency: string): Promise<BillingAccountRow | undefined> {
    return trx.selectFrom('billing_account').selectAll()
      .where(owner.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', owner.id)
      .where('hub_id', '=', hubId).where('currency', '=', currency).where('status', '=', 'active').executeTakeFirst();
  },
  async listForParty(trx: Transaction, owner: PartyRef): Promise<BillingAccountRow[]> {
    return trx.selectFrom('billing_account').selectAll().where(owner.kind === 'person' ? 'owner_person_id' : 'owner_company_id', '=', owner.id).orderBy('created_at').execute();
  },
};

export const catalogue = {
  /** Owner-run. */
  async createOffer(trx: Transaction, input: { hubId: string; code: string; name: string; kind: OfferKind; createdBy: string; status?: 'draft' | 'active' }): Promise<OfferRow> {
    return trx.insertInto('offer').values({ hub_id: input.hubId, code: input.code, name: input.name, kind: input.kind, created_by: input.createdBy, status: input.status ?? 'draft' }).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async setOfferStatus(trx: Transaction, offerId: string, status: 'draft' | 'active' | 'retired'): Promise<OfferRow> {
    return trx.updateTable('offer').set({ status }).where('id', '=', offerId).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run: a new draft price version (the next version number of the offer). */
  async draftPriceVersion(trx: Transaction, input: { offerId: string; amountMinor: string; currency: string; effectiveFrom: Date | string; effectiveTo?: Date | string | null; acceptanceTextVersion: string; draftedBy: string; taxRuleRef?: string | null }): Promise<PriceVersionRow> {
    const next = await trx.selectFrom('price_version').select(sql<number>`coalesce(max(version), 0) + 1`.as('v')).where('offer_id', '=', input.offerId).executeTakeFirstOrThrow();
    return trx.insertInto('price_version').values({
      offer_id: input.offerId, version: next.v, amount_minor: minor(input.amountMinor), currency: input.currency, effective_from: input.effectiveFrom, effective_to: input.effectiveTo ?? null,
      acceptance_text_version: input.acceptanceTextVersion, drafted_by: input.draftedBy, tax_rule_ref: input.taxRuleRef ?? null,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /**
   * Owner-run: activates a draft. The database stamps `activated_at`, refuses the drafter as activator
   * (`billing.activator_is_drafter`), an effective date not after activation (`billing.backdated`) and any overlap with
   * another active version (`billing.version_overlap`). With `supersedePrevious`, an open-ended or later-ending active
   * version that starts earlier is first end-dated at the new version's start (never into the past).
   */
  async activatePriceVersion(trx: Transaction, id: string, activatedBy: string, options: { supersedePrevious?: boolean } = {}): Promise<PriceVersionRow> {
    const draft = await trx.selectFrom('price_version').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (options.supersedePrevious) {
      await trx.updateTable('price_version').set({ effective_to: draft.effective_from })
        .where('offer_id', '=', draft.offer_id).where('status', '=', 'active').where('id', '<>', id)
        .where('effective_from', '<', draft.effective_from)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', draft.effective_from)]))
        .execute();
    }
    return trx.updateTable('price_version').set({ status: 'active', activated_by: activatedBy }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async cancelDraft(trx: Transaction, table: 'price_version' | 'subscription_plan_version' | 'meter_rate_version' | 'marketplace_fee_version', id: string): Promise<void> {
    await trx.updateTable(table).set({ status: 'cancelled' }).where('id', '=', id).executeTakeFirstOrThrow();
  },
  /** Owner-run: `payload` must already be validated against SubscriptionPlanVersionSchema by the caller. */
  async draftPlanVersion(trx: Transaction, input: { offerId: string; payerKind: 'person' | 'company'; payload: unknown; priceVersionId: string; draftedBy: string }): Promise<SubscriptionPlanVersionRow> {
    const next = await trx.selectFrom('subscription_plan_version').select(sql<number>`coalesce(max(version), 0) + 1`.as('v')).where('offer_id', '=', input.offerId).executeTakeFirstOrThrow();
    return trx.insertInto('subscription_plan_version').values({
      offer_id: input.offerId, version: next.v, payer_kind: input.payerKind, payload: JSON.stringify(input.payload), price_version_id: input.priceVersionId, drafted_by: input.draftedBy,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run: one active plan version per offer; the previous active one is superseded in the same transaction. */
  async activatePlanVersion(trx: Transaction, id: string, activatedBy: string): Promise<SubscriptionPlanVersionRow> {
    const draft = await trx.selectFrom('subscription_plan_version').select(['offer_id']).where('id', '=', id).executeTakeFirstOrThrow();
    await trx.updateTable('subscription_plan_version').set({ status: 'superseded' }).where('offer_id', '=', draft.offer_id).where('status', '=', 'active').where('id', '<>', id).execute();
    return trx.updateTable('subscription_plan_version').set({ status: 'active', activated_by: activatedBy }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async draftMeterRate(trx: Transaction, input: { hubId: string; meter: MeterCode; providerClass: ProviderClass | null; currency: string; pricePerThousandMinor: string; passThrough: boolean; effectiveFrom: Date | string; effectiveTo?: Date | string | null; draftedBy: string }): Promise<MeterRateVersionRow> {
    const next = await trx.selectFrom('meter_rate_version').select(sql<number>`coalesce(max(version), 0) + 1`.as('v'))
      .where('hub_id', '=', input.hubId).where('meter', '=', input.meter)
      .where(sql<boolean>`provider_class IS NOT DISTINCT FROM ${input.providerClass}`).executeTakeFirstOrThrow();
    return trx.insertInto('meter_rate_version').values({
      hub_id: input.hubId, version: next.v, meter: input.meter, provider_class: input.providerClass, currency: input.currency, price_per_thousand_minor: minor(input.pricePerThousandMinor),
      pass_through: input.passThrough, effective_from: input.effectiveFrom, effective_to: input.effectiveTo ?? null, drafted_by: input.draftedBy,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async activateMeterRate(trx: Transaction, id: string, activatedBy: string): Promise<MeterRateVersionRow> {
    return trx.updateTable('meter_rate_version').set({ status: 'active', activated_by: activatedBy }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async draftFeeVersion(trx: Transaction, input: {
    hubId: string; kind: 'consultation' | 'task' | 'ticket' | 'course'; categoryKey: string | null; currency: string; basisPoints: number | null; fixedMinor: string | null; payer: 'buyer' | 'seller';
    effectiveFrom: Date | string; effectiveTo?: Date | string | null; acceptanceTextVersion: string; draftedBy: string;
  }): Promise<MarketplaceFeeVersionRow> {
    const next = await trx.selectFrom('marketplace_fee_version').select(sql<number>`coalesce(max(version), 0) + 1`.as('v'))
      .where('hub_id', '=', input.hubId).where('kind', '=', input.kind).where('payer', '=', input.payer)
      .where(sql<boolean>`category_key IS NOT DISTINCT FROM ${input.categoryKey}`).executeTakeFirstOrThrow();
    return trx.insertInto('marketplace_fee_version').values({
      hub_id: input.hubId, kind: input.kind, category_key: input.categoryKey, version: next.v, currency: input.currency, basis_points: input.basisPoints,
      fixed_minor: input.fixedMinor === null ? null : minor(input.fixedMinor), payer: input.payer, effective_from: input.effectiveFrom, effective_to: input.effectiveTo ?? null,
      acceptance_text_version: input.acceptanceTextVersion, drafted_by: input.draftedBy,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run: needs the id of the second-person approval (DATA-002) under which it is activated. */
  async activateFeeVersion(trx: Transaction, id: string, activatedBy: string, approvalId: string): Promise<MarketplaceFeeVersionRow> {
    return trx.updateTable('marketplace_fee_version').set({ status: 'active', activated_by: activatedBy, approval_id: approvalId }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  },
  /** Runtime or owner-run: activated price versions of a hub's published offers, in effect at `at` or later. */
  async publishedPrices(trx: Transaction, hubId: string, at: Date): Promise<(PriceVersionRow & { offer_code: string; offer_kind: OfferKind })[]> {
    return trx.selectFrom('price_version as p').innerJoin('offer as o', 'o.id', 'p.offer_id').selectAll('p').select(['o.code as offer_code', 'o.kind as offer_kind'])
      .where('o.hub_id', '=', hubId).where('o.status', '=', 'active').where('p.status', '=', 'active')
      .where((eb) => eb.or([eb('p.effective_to', 'is', null), eb('p.effective_to', '>', at)]))
      .orderBy('o.code').orderBy('p.effective_from').execute();
  },
  async priceVersion(trx: Transaction, id: string): Promise<PriceVersionRow | undefined> {
    return trx.selectFrom('price_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async planVersion(trx: Transaction, id: string): Promise<SubscriptionPlanVersionRow | undefined> {
    return trx.selectFrom('subscription_plan_version').selectAll().where('id', '=', id).executeTakeFirst();
  },
  async offer(trx: Transaction, id: string): Promise<OfferRow | undefined> {
    return trx.selectFrom('offer').selectAll().where('id', '=', id).executeTakeFirst();
  },
};

export const priceAcceptances = {
  /**
   * Runtime: records the payer's acceptance of exactly this price version, its amount and its acceptance text. The
   * database refuses a mismatch (`billing.acceptance_mismatch`), a version not open for acceptance
   * (`billing.price_not_active`), another party's account (`billing.account_mismatch`) and stamps the time itself.
   */
  async accept(trx: Transaction, input: { priceVersionId: string; billingAccountId: string; payer: PartyRef; acceptedBy: string; amountMinor: string; currency: string; acceptanceTextVersion: string }): Promise<PriceAcceptanceRow> {
    const payer = ownerColumns(input.payer);
    return trx.insertInto('price_acceptance').values({
      price_version_id: input.priceVersionId, billing_account_id: input.billingAccountId, payer_person_id: payer.person, payer_company_id: payer.company, accepted_by_person_id: input.acceptedBy,
      amount_minor: minor(input.amountMinor), currency: input.currency, acceptance_text_version: input.acceptanceTextVersion,
    }).returningAll().executeTakeFirstOrThrow();
  },
  async listForAccount(trx: Transaction, billingAccountId: string): Promise<PriceAcceptanceRow[]> {
    return trx.selectFrom('price_acceptance').selectAll().where('billing_account_id', '=', billingAccountId).orderBy('accepted_at', 'desc').execute();
  },
};

export const subscriptions = {
  /** Owner-run (payment evidence arrives with BILL-002): starts a subscription from the account's own acceptance. */
  async start(trx: Transaction, input: { billingAccountId: string; offerId: string; planVersionId: string | null; priceVersionId: string; priceAcceptanceId: string; status: Extract<SubscriptionStatus, 'trial' | 'active'>; periodStart: Date | string; periodEnd: Date | string; renewsAt: Date | string | null }): Promise<SubscriptionRow> {
    return trx.insertInto('subscription').values({
      billing_account_id: input.billingAccountId, offer_id: input.offerId, subscription_plan_version_id: input.planVersionId, price_version_id: input.priceVersionId,
      price_acceptance_id: input.priceAcceptanceId, status: input.status, current_period_start: input.periodStart, current_period_end: input.periodEnd, renews_at: input.renewsAt,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /** Runtime: cancel at any time in one step, no fee; the database stamps the time and clears the renewal. */
  async cancel(trx: Transaction, id: string, personId: string): Promise<SubscriptionRow | undefined> {
    return trx.updateTable('subscription').set({ status: 'cancelled', cancelled_by: personId }).where('id', '=', id).returningAll().executeTakeFirst();
  },
  async listForAccount(trx: Transaction, billingAccountId: string): Promise<SubscriptionRow[]> {
    return trx.selectFrom('subscription').selectAll().where('billing_account_id', '=', billingAccountId).orderBy('created_at').execute();
  },
};

export const entitlements = {
  /** Owner-run. */
  async grant(trx: Transaction, input: { billingAccountId: string; offerId: string; subscriptionId: string | null; moduleCode: string | null; limits?: Record<string, unknown>; validFrom: Date | string; validUntil: Date | string | null; source: EntitlementSource }): Promise<EntitlementRow> {
    return trx.insertInto('entitlement').values({
      billing_account_id: input.billingAccountId, offer_id: input.offerId, subscription_id: input.subscriptionId, module_code: input.moduleCode, limits: JSON.stringify(input.limits ?? {}),
      valid_from: input.validFrom, valid_until: input.validUntil, source: input.source,
    }).returningAll().executeTakeFirstOrThrow();
  },
  /** Owner-run. */
  async revoke(trx: Transaction, id: string, reason: string): Promise<void> {
    await trx.updateTable('entitlement').set({ revoked_at: sql<Date>`clock_timestamp()`, revoked_reason: reason }).where('id', '=', id).where('revoked_at', 'is', null).executeTakeFirstOrThrow();
  },
  /** Entitlements of the party's accounts valid at `at` and not revoked (RLS limits runtime callers to their own). */
  async activeForParty(trx: Transaction, owner: PartyRef, at: Date): Promise<(EntitlementRow & { offer_code: string })[]> {
    return trx.selectFrom('entitlement as e').innerJoin('billing_account as a', 'a.id', 'e.billing_account_id').innerJoin('offer as o', 'o.id', 'e.offer_id')
      .selectAll('e').select('o.code as offer_code')
      .where(owner.kind === 'person' ? 'a.owner_person_id' : 'a.owner_company_id', '=', owner.id)
      .where('e.revoked_at', 'is', null).where('e.valid_from', '<=', at)
      .where((eb) => eb.or([eb('e.valid_until', 'is', null), eb('e.valid_until', '>', at)]))
      .execute();
  },
};

export interface BudgetGrant { kind: BudgetKindColumn; owner: 'person' | 'company'; projectId: string | null; employeePersonId: string | null; periodFrom: Date | string; periodTo: Date | string; limitMinor: string; currency: string }
export interface ReserveInput { budgetId: string; kind: BudgetKindColumn; amountMinor: string; currency: string; actionIntentId: string; correlationKey: string; projectId: string | null; ttlSeconds: number }

export const budgets = {
  /** Runtime (definer): the owner person, or a billing manager of the employer (never to themself). */
  async grant(trx: Transaction, input: BudgetGrant): Promise<string> {
    const row = await one(sql<{ id: string }>`SELECT trustwork.billing_grant_budget(${input.kind}, ${input.owner}, ${input.projectId}::uuid, ${input.employeePersonId}::uuid,
      ${input.periodFrom}::timestamptz, ${input.periodTo}::timestamptz, ${minor(input.limitMinor)}::bigint, ${input.currency}) AS id`.execute(trx), 'billing_grant_budget');
    return row.id;
  },
  /** Runtime (definer): a new limit is a new approval; never below what is consumed or held. */
  async setLimit(trx: Transaction, budgetId: string, limitMinor: string, expectedRevision: number): Promise<BudgetRow> {
    return one(sql<BudgetRow>`SELECT * FROM trustwork.billing_set_budget_limit(${budgetId}::uuid, ${minor(limitMinor)}::bigint, ${expectedRevision}::integer)`.execute(trx), 'billing_set_budget_limit');
  },
  /** Runtime (definer). */
  async close(trx: Transaction, budgetId: string): Promise<BudgetRow> {
    return one(sql<BudgetRow>`SELECT * FROM trustwork.billing_close_budget(${budgetId}::uuid)`.execute(trx), 'billing_close_budget');
  },
  async get(trx: Transaction, budgetId: string): Promise<BudgetRow | undefined> {
    return trx.selectFrom('budget').selectAll().where('id', '=', budgetId).executeTakeFirst();
  },
  /** Budgets the caller can see, optionally of one kind (RLS: owner, billing viewers, the scoped employee). */
  async listVisible(trx: Transaction, kind?: BudgetKindColumn): Promise<BudgetRow[]> {
    let q = trx.selectFrom('budget').selectAll().where('status', '=', 'active');
    if (kind) q = q.where('kind', '=', kind);
    return q.orderBy('created_at').execute();
  },
  /**
   * limit - consumed - held as seen by the caller, with the same arithmetic as `billing_reserve` (which re-evaluates it
   * under the row lock): consumed from the budget's ledger legs, held from open, unexpired reservations.
   */
  async balance(trx: Transaction, budgetId: string): Promise<{ limitMinor: string; consumedMinor: string; heldMinor: string; remainingMinor: string; currency: string } | undefined> {
    const row = await sql<{ limit_minor: string; consumed: string; held: string; currency: string }>`
      SELECT b.limit_minor, b.currency,
        coalesce((SELECT -sum(e.amount_minor) FROM trustwork.ledger_entry e WHERE e.account_kind = 'budget' AND e.account_id = b.id), 0)::bigint AS consumed,
        coalesce((SELECT sum(r.amount_minor) FROM trustwork.reservation r WHERE r.budget_id = b.id AND r.state = 'reserved' AND r.expires_at > clock_timestamp()), 0)::bigint AS held
      FROM trustwork.budget b WHERE b.id = ${budgetId}::uuid`.execute(trx);
    const r = row.rows[0];
    if (!r) return undefined;
    const remaining = BigInt(r.limit_minor) - BigInt(r.consumed) - BigInt(r.held);
    return { limitMinor: r.limit_minor, consumedMinor: r.consumed, heldMinor: r.held, remainingMinor: remaining.toString(), currency: r.currency };
  },
};

export const reservations = {
  /** Runtime (definer): atomic and idempotent per correlation key; see the migration for the refusal hints. */
  async reserve(trx: Transaction, input: ReserveInput): Promise<ReservationRow> {
    return one(sql<ReservationRow>`SELECT * FROM trustwork.billing_reserve(${input.budgetId}::uuid, ${input.kind}, ${minor(input.amountMinor)}::bigint, ${input.currency},
      ${input.actionIntentId}::uuid, ${input.correlationKey}, ${input.projectId}::uuid, make_interval(secs => ${input.ttlSeconds}))`.execute(trx), 'billing_reserve');
  },
  /** Runtime (definer): settles on the actual amount from outcome evidence; never above the reservation. */
  async settle(trx: Transaction, reservationId: string, actualMinor: string, evidenceRef: string): Promise<ReservationRow> {
    return one(sql<ReservationRow>`SELECT * FROM trustwork.billing_settle(${reservationId}::uuid, ${minor(actualMinor)}::bigint, ${evidenceRef})`.execute(trx), 'billing_settle');
  },
  /** Runtime (definer). */
  async release(trx: Transaction, reservationId: string, evidenceRef: string): Promise<ReservationRow> {
    return one(sql<ReservationRow>`SELECT * FROM trustwork.billing_release(${reservationId}::uuid, ${evidenceRef})`.execute(trx), 'billing_release');
  },
  /** Owner-run: returns the ledger batch id. */
  async refund(trx: Transaction, reservationId: string, amountMinor: string, evidenceRef: string): Promise<string> {
    const row = await one(sql<{ batch: string }>`SELECT trustwork.billing_refund(${reservationId}::uuid, ${minor(amountMinor)}::bigint, ${evidenceRef}) AS batch`.execute(trx), 'billing_refund');
    return row.batch;
  },
  /** Owner-run: number of reservations moved to `expired`. */
  async expireDue(trx: Transaction): Promise<number> {
    const row = await one(sql<{ n: number }>`SELECT trustwork.billing_expire_reservations() AS n`.execute(trx), 'billing_expire_reservations');
    return row.n;
  },
  async get(trx: Transaction, reservationId: string): Promise<ReservationRow | undefined> {
    return trx.selectFrom('reservation').selectAll().where('id', '=', reservationId).executeTakeFirst();
  },
};

export const ledger = {
  /** Owner-run: reverses a batch once; returns the correction batch id. */
  async correctBatch(trx: Transaction, batchId: string, reason: string): Promise<string> {
    const row = await one(sql<{ batch: string }>`SELECT trustwork.billing_correct_batch(${batchId}::uuid, ${reason}) AS batch`.execute(trx), 'billing_correct_batch');
    return row.batch;
  },
  async entriesForReservation(trx: Transaction, reservationId: string): Promise<LedgerEntryRow[]> {
    return trx.selectFrom('ledger_entry').selectAll().where('reservation_id', '=', reservationId).orderBy('occurred_at').orderBy('account_kind').execute();
  },
  async entriesForBatch(trx: Transaction, batchId: string): Promise<LedgerEntryRow[]> {
    return trx.selectFrom('ledger_entry').selectAll().where('batch_id', '=', batchId).orderBy('account_kind').execute();
  },
};

export const usageRecords = {
  /** Owner-run: idempotent per (run step, attempt, meter); a replay returns the first record unchanged. */
  async record(trx: Transaction, input: {
    principal: PartyRef; billingAccountId: string; moduleKey: string; capabilityId: string | null; runId: string; runStepId: string; attemptId: string; connectionId: string | null;
    meter: MeterCode; providerClass: ProviderClass | null; units: string; withinIncludedQuota: boolean; meterRateVersionId: string | null; reservationId: string | null;
  }): Promise<{ record: UsageRecordRow; replayed: boolean }> {
    const principal = ownerColumns(input.principal);
    const inserted = await trx.insertInto('usage_record').values({
      principal_person_id: principal.person, principal_company_id: principal.company, billing_account_id: input.billingAccountId, module_key: input.moduleKey, capability_id: input.capabilityId,
      run_id: input.runId, run_step_id: input.runStepId, attempt_id: input.attemptId, connection_id: input.connectionId, meter: input.meter, provider_class: input.providerClass,
      units: minor(input.units), within_included_quota: input.withinIncludedQuota, meter_rate_version_id: input.meterRateVersionId, reservation_id: input.reservationId,
    }).onConflict((oc) => oc.columns(['run_step_id', 'attempt_id', 'meter']).doNothing()).returningAll().executeTakeFirst();
    if (inserted) return { record: inserted, replayed: false };
    const existing = await trx.selectFrom('usage_record').selectAll().where('run_step_id', '=', input.runStepId).where('attempt_id', '=', input.attemptId).where('meter', '=', input.meter).executeTakeFirstOrThrow();
    return { record: existing, replayed: true };
  },
};

export const creditGrants = {
  /** Owner-run: capped per staff role, never to oneself or one's employer, posts its ledger batch. */
  async grant(trx: Transaction, input: { billingAccountId: string; amountMinor: string; reasonCode: string; issuedBy: string; capCheck: { roleKey: string; capMinor: string }; caseId: string | null; validUntil: Date | string | null; expiryDisclosureKey: string | null }): Promise<CreditGrantRow> {
    const row = await one(sql<{ id: string }>`SELECT trustwork.billing_grant_credit(${input.billingAccountId}::uuid, ${minor(input.amountMinor)}::bigint, ${input.reasonCode}, ${input.issuedBy}::uuid,
      ${JSON.stringify(input.capCheck)}::jsonb, ${input.caseId}::uuid, ${input.validUntil}::timestamptz, ${input.expiryDisclosureKey}) AS id`.execute(trx), 'billing_grant_credit');
    return trx.selectFrom('credit_grant').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
  },
};
