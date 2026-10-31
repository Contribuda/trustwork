import { z } from 'zod';
import { PartySchema } from './access.js';
import { IdSchema, NameSchema, RevisionSchema, TimestampSchema } from './common/ids.js';
import { compareMoney, CurrencySchema, MoneySchema, NonNegativeMinorUnitsSchema, NonNegativeMoneySchema, subtractMoney, sumMoney } from './common/money.js';

/** Two budget kinds: procurement commitments use `transaction`; paid platform deliverables use `platform`. One never implies the other. */
export const BudgetKindSchema = z.enum(['transaction', 'platform']);
export type BudgetKind = z.infer<typeof BudgetKindSchema>;
export const BudgetSchema = z.strictObject({
  id: IdSchema,
  kind: BudgetKindSchema,
  owner: PartySchema,
  scope: z.strictObject({ projectId: IdSchema.nullable(), employeePersonId: IdSchema.nullable() }),
  period: z.strictObject({ from: TimestampSchema, to: TimestampSchema }),
  limit: NonNegativeMoneySchema,
  revision: RevisionSchema,
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ReservationStateSchema = z.enum(['reserved', 'settled', 'released', 'expired']);
export type ReservationState = z.infer<typeof ReservationStateSchema>;
export const ReservationSchema = z.strictObject({
  id: IdSchema,
  budgetId: IdSchema,
  actionIntentId: IdSchema,
  amount: NonNegativeMoneySchema,
  state: ReservationStateSchema,
  reservedAt: TimestampSchema,
  settledAmount: NonNegativeMoneySchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  /** Stable effect correlation shared by every attempt of the same action. */
  effectCorrelationKey: z.string().min(1).max(200),
});
export type Reservation = z.infer<typeof ReservationSchema>;
const RESERVATION_TRANSITIONS: Record<ReservationState, readonly ReservationState[]> = { reserved: ['settled', 'released', 'expired'], settled: [], released: [], expired: [] };
export function reservationTransitionAllowed(from: ReservationState, to: ReservationState): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}
/** Pure balance check; the database performs it again under a row lock or serializable transaction. */
export function remainingBudget(budget: Budget, reservations: readonly Reservation[]): { minorUnits: string; currency: string } {
  const held = reservations.filter((r) => r.budgetId === budget.id && (r.state === 'reserved' || r.state === 'settled')).map((r) => (r.state === 'settled' && r.settledAmount ? r.settledAmount : r.amount));
  return subtractMoney(budget.limit, sumMoney(held, budget.limit.currency));
}
export function canReserve(budget: Budget, reservations: readonly Reservation[], amount: { minorUnits: string; currency: string }): 'ok' | 'commercial.budget_insufficient' | 'commercial.currency_mismatch' {
  if (amount.currency !== budget.limit.currency) return 'commercial.currency_mismatch';
  return compareMoney(remainingBudget(budget, reservations), amount) >= 0 ? 'ok' : 'commercial.budget_insufficient';
}
/** Which budget kind an action consumes; a transaction mandate never authorizes platform spend and vice versa. */
export function budgetKindFor(action: 'place_order' | 'accept_order' | 'send_quote' | 'generate_deliverable' | 'subscribe'): BudgetKind | null {
  switch (action) {
    case 'place_order':
    case 'accept_order':
      return 'transaction';
    case 'generate_deliverable':
    case 'subscribe':
      return 'platform';
    default:
      return null;
  }
}

export const OfferSchema = z.strictObject({ id: IdSchema, code: z.string().min(1).max(60), name: NameSchema, kind: z.enum(['plan', 'deliverable', 'credit_pack']), status: z.enum(['draft', 'active', 'retired']), revision: RevisionSchema });
export const PriceVersionStatusSchema = z.enum(['draft', 'active', 'superseded', 'cancelled']);
/** Versioned price with effective dates; activation needs a second person and can never back-date. */
export const PriceVersionSchema = z.strictObject({
  id: IdSchema,
  offerId: IdSchema,
  version: z.int().min(1),
  currency: CurrencySchema,
  amountMinorUnits: NonNegativeMinorUnitsSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
  status: PriceVersionStatusSchema,
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
})
  .refine((p) => p.status === 'draft' || (p.activatedBy !== null && p.activatedAt !== null), { message: 'non-draft versions record activation', path: ['activatedBy'] })
  .refine((p) => p.activatedBy === null || p.activatedBy !== p.draftedBy, { message: 'activator must differ from drafter', path: ['activatedBy'] })
  .refine((p) => p.activatedAt === null || Date.parse(p.effectiveFrom) > Date.parse(p.activatedAt), { message: 'effectiveFrom must be after activation (no back-dating)', path: ['effectiveFrom'] })
  .refine((p) => p.effectiveTo === null || Date.parse(p.effectiveTo) > Date.parse(p.effectiveFrom), { message: 'effectiveTo after effectiveFrom', path: ['effectiveTo'] });
export type PriceVersion = z.infer<typeof PriceVersionSchema>;
/** Active versions of one offer never overlap. */
export function priceVersionsOverlap(a: PriceVersion, b: PriceVersion): boolean {
  if (a.offerId !== b.offerId || a.status !== 'active' || b.status !== 'active') return false;
  const end = (p: PriceVersion) => (p.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(p.effectiveTo));
  return Date.parse(a.effectiveFrom) < end(b) && Date.parse(b.effectiveFrom) < end(a);
}
/** Immutable record of which exact price version and text the payer accepted. */
export const PriceAcceptanceSchema = z.strictObject({
  id: IdSchema,
  priceVersionId: IdSchema,
  acceptanceTextVersion: z.string().min(1).max(40),
  payer: PartySchema,
  acceptedByPersonId: IdSchema,
  acceptedAt: TimestampSchema,
  amount: MoneySchema,
});
export type PriceAcceptance = z.infer<typeof PriceAcceptanceSchema>;
export const EntitlementSchema = z.strictObject({ id: IdSchema, billingAccountId: IdSchema, offerId: IdSchema, validFrom: TimestampSchema, validUntil: TimestampSchema.nullable(), source: z.enum(['free_basic', 'trial', 'subscription', 'credit']) });
