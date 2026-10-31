import { z } from 'zod';
import { PartySchema } from '../access.js';
import { IdSchema, NameSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { compareMoney, MoneySchema, NonNegativeMoneySchema, sumMoney, type Money } from '../common/money.js';
import { KeySchema, NonNegativeDecimalSchema, StepTermsSchema } from './common.js';

/**
 * Project budgets and cost control (PRC-007). Budget lines sit under the project's `transaction` budget; the cost
 * ledger is append-only and idempotent per source; planned, committed, actual, forecast and paid are views over it.
 * Everything here is private to the buying party.
 */

export const CostCodeSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  projectId: IdSchema.nullable(),
  code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
  title: NameSchema,
  parentId: IdSchema.nullable(),
  stepTerms: StepTermsSchema,
  source: z.enum(['manual', 'template', 'import']),
});
export type CostCode = z.infer<typeof CostCodeSchema>;

export const BudgetLineSchema = z.strictObject({
  id: IdSchema,
  /** A budget of kind `transaction` (billing.ts). */
  budgetId: IdSchema,
  costCodeId: IdSchema,
  planItemKey: KeySchema.nullable(),
  planned: NonNegativeMoneySchema,
  /** Warnings as percentages of planned, ascending, for example 80 and 95. The hard stop stays the atomic reservation. */
  warningThresholds: z.array(NonNegativeDecimalSchema).max(5),
});
export type BudgetLine = z.infer<typeof BudgetLineSchema>;

export const BudgetChangeSchema = z.strictObject({
  id: IdSchema,
  budgetLineId: IdSchema,
  delta: MoneySchema,
  reason: ShortTextSchema,
  planChangeId: IdSchema.nullable(),
  approvalRequestId: IdSchema,
  appliedAt: TimestampSchema.nullable(),
});

export const CostEntryKindSchema = z.enum(['commitment', 'commitment_change', 'commitment_release', 'actual', 'actual_reversal', 'forecast_adjustment']);
export type CostEntryKind = z.infer<typeof CostEntryKindSchema>;
const NON_NEGATIVE_KINDS: readonly CostEntryKind[] = ['commitment', 'actual'];
const NON_POSITIVE_KINDS: readonly CostEntryKind[] = ['commitment_release', 'actual_reversal'];

export const CostEntrySchema = z.strictObject({
  id: IdSchema,
  budgetLineId: IdSchema,
  kind: CostEntryKindSchema,
  /** Signed: releases and reversals are negative, commitments and actuals positive. */
  amount: MoneySchema,
  source: z.strictObject({ kind: z.enum(['order_line', 'call_off', 'external_order_line', 'order_change', 'trade_invoice_line', 'stock_movement', 'manual']), id: IdSchema }),
  idempotencyKey: z.string().min(8).max(200),
  occurredAt: TimestampSchema,
}).refine((e) => !NON_NEGATIVE_KINDS.includes(e.kind) || !e.amount.minorUnits.startsWith('-'), { message: 'commitments and actuals are positive', path: ['amount'] })
  .refine((e) => !NON_POSITIVE_KINDS.includes(e.kind) || e.amount.minorUnits === '0' || e.amount.minorUnits.startsWith('-'), { message: 'releases and reversals are negative', path: ['amount'] });
export type CostEntry = z.infer<typeof CostEntrySchema>;

export type CostFigures = { planned: Money; committed: Money; actual: Money; forecast: Money; paid: Money; forecastIsEstimate: true; warningsCrossed: string[]; overPlanned: boolean };

/**
 * Exact budget summary for one line. Entries with a repeated idempotency key count once (the ledger is idempotent per
 * source). `forecast` = committed plus forecast adjustments, always labelled an estimate. `paid` comes from payment
 * instructions with final provider evidence or recorded external payments.
 */
export function costSummary(line: BudgetLine, entries: readonly CostEntry[], paid: readonly Money[] = []): CostFigures {
  const l = BudgetLineSchema.parse(line);
  const currency = l.planned.currency;
  const seen = new Set<string>();
  const mine = entries.filter((e) => {
    if (e.budgetLineId !== l.id || seen.has(e.idempotencyKey)) return false;
    seen.add(e.idempotencyKey);
    return true;
  });
  const sum = (kinds: readonly CostEntryKind[]) => sumMoney(mine.filter((e) => kinds.includes(e.kind)).map((e) => e.amount), currency);
  const committed = sum(['commitment', 'commitment_change', 'commitment_release']);
  const actual = sum(['actual', 'actual_reversal']);
  const forecast = sumMoney([committed, sum(['forecast_adjustment'])], currency);
  const paidTotal = sumMoney([...paid], currency);
  const reference = compareMoney(forecast, committed) > 0 ? forecast : committed;
  const warningsCrossed = l.warningThresholds.filter((pct) => {
    const [whole, frac = ''] = pct.split('.') as [string, string?];
    const scale = 10n ** BigInt(frac.length);
    const scaledPct = BigInt(whole) * scale + BigInt(frac || '0');
    return BigInt(reference.minorUnits) * 100n * scale >= BigInt(l.planned.minorUnits) * scaledPct;
  });
  return { planned: l.planned, committed, actual, forecast, paid: paidTotal, forecastIsEstimate: true, warningsCrossed, overPlanned: compareMoney(reference, l.planned) > 0 };
}

/** Sum of several line summaries in one currency. */
export function costTotals(figures: readonly CostFigures[], currency: string): Omit<CostFigures, 'warningsCrossed' | 'overPlanned'> {
  const pick = (k: 'planned' | 'committed' | 'actual' | 'forecast' | 'paid') => sumMoney(figures.map((f) => f[k]), currency);
  return { planned: pick('planned'), committed: pick('committed'), actual: pick('actual'), forecast: pick('forecast'), paid: pick('paid'), forecastIsEstimate: true };
}
