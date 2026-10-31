import { withPrincipal, type DataPool, type Principal, type Transaction } from '../../deps/data.js';
import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import {
  BudgetSchema, PriceAcceptanceSchema, PriceVersionSchema, ReservationSchema, billingAccounts, budgetKindFor, budgets, catalogue, entitlements, priceAcceptances, reservations, subscriptions,
  type BillingAccountRow, type Budget, type BudgetGrant, type BudgetKind, type BudgetRow, type Party, type PriceAcceptance, type PriceAcceptanceRow, type PriceVersion, type PriceVersionRow,
  type Reservation, type ReservationRow, type SubscriptionRow,
} from './deps.js';
import { decideEntitlement, SPENDING_ACTIONS, type EntitlementDecision, type Feature, type SpendingAction } from './policy.js';

interface PgError { code?: string; hint?: string; message?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINOR = /^(0|[1-9]\d{0,17})$/;

/**
 * Database hints of the billing slice -> frozen contract codes; the billing reason travels in `details.reason`
 * until the error list gains billing codes (requested in the PR).
 */
const HINT_CODES: Record<string, ErrorCode> = {
  'commercial.budget_insufficient': 'commercial.budget_insufficient',
  'commercial.currency_mismatch': 'commercial.currency_mismatch',
  'commercial.authority_missing': 'commercial.authority_missing',
  'membership.permission_missing': 'membership.permission_missing',
  'validation.revision_conflict': 'validation.revision_conflict',
  'validation.idempotency_conflict': 'validation.idempotency_conflict',
  'access.not_found': 'access.not_found',
  'access.no_principal': 'access.forbidden',
  'billing.budget_kind_mismatch': 'commercial.authority_missing',
  'billing.scope_mismatch': 'commercial.authority_missing',
  'billing.self_grant': 'access.forbidden',
  'billing.self_credit': 'access.forbidden',
  'billing.activator_is_drafter': 'access.second_approver_required',
  'billing.approval_missing': 'access.second_approver_required',
  'billing.acceptance_mismatch': 'commercial.stale_version',
  'billing.price_not_active': 'commercial.stale_version',
  'billing.account_mismatch': 'access.forbidden',
  'billing.settlement_exceeds_reservation': 'access.approval_required',
  'billing.version_frozen': 'commercial.version_immutable',
  'billing.version_overlap': 'validation.schema',
  'billing.backdated': 'validation.schema',
  'billing.invalid_transition': 'validation.schema',
  'billing.reservation_closed': 'validation.schema',
  'billing.reservation_expired': 'validation.schema',
  'billing.limit_below_committed': 'validation.schema',
  'billing.budget_inactive': 'validation.schema',
  'billing.invalid_amount': 'validation.schema',
  'billing.invalid_budget': 'validation.schema',
};
export function mapBillingError(error: unknown): unknown {
  const pg = error as PgError;
  if (!pg || typeof pg.code !== 'string' || !pg.hint) return error;
  const code = HINT_CODES[pg.hint];
  return code ? new ApiError(code, pg.message ?? code, { reason: pg.hint }) : error;
}

const iso = (d: Date | string): string => new Date(d).toISOString();
const partyOf = (person: string | null, company: string | null): Party => (person ? { kind: 'person', id: person } : { kind: 'company', id: company as string });

/** Row -> contract record. Money stays integer minor units in strings throughout. */
export function toBudget(row: BudgetRow): Budget {
  return BudgetSchema.parse({
    id: row.id, kind: row.kind, owner: partyOf(row.owner_person_id, row.owner_company_id), scope: { projectId: row.project_id, employeePersonId: row.employee_person_id },
    period: { from: iso(row.period_from), to: iso(row.period_to) }, limit: { minorUnits: row.limit_minor, currency: row.currency }, revision: row.revision,
  });
}
export function toReservation(row: ReservationRow): Reservation {
  return ReservationSchema.parse({
    id: row.id, budgetId: row.budget_id, actionIntentId: row.action_intent_id, amount: { minorUnits: row.amount_minor, currency: row.currency }, state: row.state,
    reservedAt: iso(row.reserved_at), settledAmount: row.settled_minor === null ? null : { minorUnits: row.settled_minor, currency: row.currency },
    closedAt: row.closed_at ? iso(row.closed_at) : null, effectCorrelationKey: row.effect_correlation_key,
  });
}
export function toPriceVersion(row: PriceVersionRow): PriceVersion {
  return PriceVersionSchema.parse({
    id: row.id, offerId: row.offer_id, version: row.version, currency: row.currency, amountMinorUnits: row.amount_minor, effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to ? iso(row.effective_to) : null, acceptanceTextVersion: row.acceptance_text_version, status: row.status, draftedBy: row.drafted_by,
    activatedBy: row.activated_by, activatedAt: row.activated_at ? iso(row.activated_at) : null,
  });
}
export function toPriceAcceptance(row: PriceAcceptanceRow): PriceAcceptance {
  return PriceAcceptanceSchema.parse({
    id: row.id, priceVersionId: row.price_version_id, acceptanceTextVersion: row.acceptance_text_version, payer: partyOf(row.payer_person_id, row.payer_company_id),
    acceptedByPersonId: row.accepted_by_person_id, acceptedAt: iso(row.accepted_at), amount: { minorUnits: row.amount_minor, currency: row.currency },
  });
}

/** What the payer was shown before accepting; the database refuses an acceptance that differs from the version. */
export interface ShownPrice { priceVersionId: string; amountMinor: string; currency: string; acceptanceTextVersion: string }
export interface MyBilling { accounts: BillingAccountRow[]; subscriptions: SubscriptionRow[]; entitlements: { id: string; offerCode: string; moduleCode: string | null; source: string; validUntil: string | null }[] }

/**
 * Billing commands for participants (BILL-001). Every call runs under the caller's principal (RLS and the definer
 * commands re-check authority in the database). Two budget kinds never mix: the kind a reservation needs comes from
 * the contract's `budgetKindFor(action)`, never from the caller, and the database refuses a budget of the other kind.
 * Nothing here contacts a payment provider or moves money (ADR 010 decision 20); payments arrive with BILL-002 and
 * PAY-001 behind adapters with fakes.
 */
export class BillingService {
  constructor(private readonly pool: DataPool) {}

  private async run<T>(principal: Principal, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withPrincipal(this.pool, principal, fn);
    } catch (error) {
      throw mapBillingError(error);
    }
  }

  /** Free basic features are allowed for every person and company; paid features need a valid entitlement of the party. */
  async checkEntitlement(principal: Principal, party: Party, feature: Feature, at: Date): Promise<EntitlementDecision> {
    if (feature.kind === 'participation') return decideEntitlement(feature, []);
    return this.run(principal, async (trx) => decideEntitlement(feature, await entitlements.activeForParty(trx, party, at)));
  }

  async openAccount(principal: Principal, input: { hubId: string; owner: Party; currency: string }): Promise<BillingAccountRow> {
    return this.run(principal, (trx) => billingAccounts.open(trx, { ...input, createdBy: principal.personId }));
  }

  /** The hub's published (activated) prices; drafts are never visible to participants. */
  async publishedPrices(principal: Principal, hubId: string, at: Date): Promise<(PriceVersion & { offerCode: string })[]> {
    return this.run(principal, async (trx) => (await catalogue.publishedPrices(trx, hubId, at)).map((row) => ({ ...toPriceVersion(row), offerCode: row.offer_code })));
  }

  /** Records the payer's immutable acceptance of exactly the version, amount and text they were shown. */
  async acceptPrice(principal: Principal, input: { shown: ShownPrice; billingAccountId: string; payer: Party }): Promise<PriceAcceptance> {
    if (!MINOR.test(input.shown.amountMinor)) throw new ApiError('validation.schema', 'amount must be integer minor units', { field: 'amountMinor' });
    return this.run(principal, async (trx) => toPriceAcceptance(await priceAcceptances.accept(trx, {
      priceVersionId: input.shown.priceVersionId, billingAccountId: input.billingAccountId, payer: input.payer, acceptedBy: principal.personId,
      amountMinor: input.shown.amountMinor, currency: input.shown.currency, acceptanceTextVersion: input.shown.acceptanceTextVersion,
    })));
  }

  /**
   * Platform purchase: the acceptance and the platform-budget reservation for its amount in one transaction. A
   * transaction budget can never pay for it (the database refuses the kind), and neither can a budget the caller may
   * not spend from.
   */
  async acceptAndReserve(principal: Principal, input: { shown: ShownPrice; billingAccountId: string; payer: Party; action: 'subscribe' | 'generate_deliverable'; budgetId: string; actionIntentId: string; correlationKey: string; ttlSeconds: number }): Promise<{ acceptance: PriceAcceptance; reservation: Reservation }> {
    const kind = budgetKindFor(input.action);
    if (kind !== 'platform') throw new ApiError('commercial.authority_missing');
    return this.run(principal, async (trx) => {
      const acceptance = await priceAcceptances.accept(trx, {
        priceVersionId: input.shown.priceVersionId, billingAccountId: input.billingAccountId, payer: input.payer, acceptedBy: principal.personId,
        amountMinor: input.shown.amountMinor, currency: input.shown.currency, acceptanceTextVersion: input.shown.acceptanceTextVersion,
      });
      const reservation = await reservations.reserve(trx, {
        budgetId: input.budgetId, kind, amountMinor: acceptance.amount_minor, currency: acceptance.currency, actionIntentId: input.actionIntentId, correlationKey: input.correlationKey, projectId: null, ttlSeconds: input.ttlSeconds,
      });
      return { acceptance: toPriceAcceptance(acceptance), reservation: toReservation(reservation) };
    });
  }

  /** Cancel online at any time in one step, with no fee (BIL-F10 groundwork). */
  async cancelSubscription(principal: Principal, subscriptionId: string): Promise<SubscriptionRow> {
    if (!UUID.test(subscriptionId)) throw new ApiError('access.not_found');
    const row = await this.run(principal, (trx) => subscriptions.cancel(trx, subscriptionId, principal.personId));
    if (!row) throw new ApiError('access.not_found');
    return row;
  }

  /** The payer's own billing view (BIL-F17): accounts, subscriptions and valid entitlements; never shown to others. */
  async myBilling(principal: Principal, party: Party, at: Date): Promise<MyBilling> {
    return this.run(principal, async (trx) => {
      const accounts = await billingAccounts.listForParty(trx, party);
      const subs = (await Promise.all(accounts.map((a) => subscriptions.listForAccount(trx, a.id)))).flat();
      const rights = await entitlements.activeForParty(trx, party, at);
      return { accounts, subscriptions: subs, entitlements: rights.map((e) => ({ id: e.id, offerCode: e.offer_code, moduleCode: e.module_code, source: e.source, validUntil: e.valid_until ? iso(e.valid_until) : null })) };
    });
  }

  async grantBudget(principal: Principal, grant: BudgetGrant): Promise<Budget> {
    if (!MINOR.test(grant.limitMinor)) throw new ApiError('validation.schema', 'limit must be integer minor units', { field: 'limitMinor' });
    return this.run(principal, async (trx) => {
      const id = await budgets.grant(trx, grant);
      const row = await budgets.get(trx, id);
      if (!row) throw new ApiError('access.not_found');
      return toBudget(row);
    });
  }

  async setBudgetLimit(principal: Principal, budgetId: string, limitMinor: string, expectedRevision: number): Promise<Budget> {
    if (!MINOR.test(limitMinor)) throw new ApiError('validation.schema', 'limit must be integer minor units', { field: 'limitMinor' });
    if (!UUID.test(budgetId)) throw new ApiError('access.not_found');
    return this.run(principal, async (trx) => toBudget(await budgets.setLimit(trx, budgetId, limitMinor, expectedRevision)));
  }

  async closeBudget(principal: Principal, budgetId: string): Promise<Budget> {
    if (!UUID.test(budgetId)) throw new ApiError('access.not_found');
    return this.run(principal, async (trx) => toBudget(await budgets.close(trx, budgetId)));
  }

  async budgetBalance(principal: Principal, budgetId: string): Promise<{ limitMinor: string; consumedMinor: string; heldMinor: string; remainingMinor: string; currency: string }> {
    if (!UUID.test(budgetId)) throw new ApiError('access.not_found');
    const balance = await this.run(principal, (trx) => budgets.balance(trx, budgetId));
    if (!balance) throw new ApiError('access.not_found');
    return balance;
  }

  /** Visible budgets of the kind an action needs: an employee with only a transaction budget sees no platform budget. */
  async budgetsFor(principal: Principal, action: SpendingAction): Promise<Budget[]> {
    const kind = this.kindFor(action);
    return this.run(principal, async (trx) => (await budgets.listVisible(trx, kind)).map(toBudget));
  }

  /** Reservation before commitment; the kind comes from the action, the authority and balance from the database. */
  async reserve(principal: Principal, input: { action: SpendingAction; budgetId: string; amountMinor: string; currency: string; actionIntentId: string; correlationKey: string; projectId: string | null; ttlSeconds: number }): Promise<Reservation> {
    const kind = this.kindFor(input.action);
    if (!MINOR.test(input.amountMinor)) throw new ApiError('validation.schema', 'amount must be integer minor units', { field: 'amountMinor' });
    if (!UUID.test(input.budgetId)) throw new ApiError('access.not_found');
    return this.run(principal, async (trx) => toReservation(await reservations.reserve(trx, {
      budgetId: input.budgetId, kind, amountMinor: input.amountMinor, currency: input.currency, actionIntentId: input.actionIntentId, correlationKey: input.correlationKey, projectId: input.projectId, ttlSeconds: input.ttlSeconds,
    })));
  }

  /** Settlement on the actual amount from outcome evidence; an amount above the reservation needs a new approval. */
  async settle(principal: Principal, reservationId: string, actualMinor: string, evidenceRef: string): Promise<Reservation> {
    if (!MINOR.test(actualMinor)) throw new ApiError('validation.schema', 'amount must be integer minor units', { field: 'actualMinor' });
    if (!UUID.test(reservationId)) throw new ApiError('access.not_found');
    return this.run(principal, async (trx) => toReservation(await reservations.settle(trx, reservationId, actualMinor, evidenceRef)));
  }

  async release(principal: Principal, reservationId: string, evidenceRef: string): Promise<Reservation> {
    if (!UUID.test(reservationId)) throw new ApiError('access.not_found');
    return this.run(principal, async (trx) => toReservation(await reservations.release(trx, reservationId, evidenceRef)));
  }

  private kindFor(action: SpendingAction): BudgetKind {
    if (!SPENDING_ACTIONS.includes(action)) throw new ApiError('validation.schema', 'unknown spending action', { field: 'action' });
    const kind = budgetKindFor(action);
    if (!kind) throw new ApiError('commercial.authority_missing');
    return kind;
  }
}
