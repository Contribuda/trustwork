import { z } from 'zod';
import { TimestampSchema } from './ids.js';
import { DecimalSchema, decimalToScaled } from './quantity.js';

/** Integer minor units serialized as a string; never a JSON number. Scale comes from the currency table. */
export const MinorUnitsSchema = z.string().regex(/^(0|-?[1-9]\d*)$/, 'integer minor units as string (no negative zero)');
export const NonNegativeMinorUnitsSchema = z.string().regex(/^(0|[1-9]\d*)$/, 'non-negative integer minor units as string');
/** ISO 4217 alphabetic code. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 currency code');

export const MoneySchema = z.strictObject({ minorUnits: MinorUnitsSchema, currency: CurrencySchema });
export const NonNegativeMoneySchema = z.strictObject({ minorUnits: NonNegativeMinorUnitsSchema, currency: CurrencySchema });
export type Money = z.infer<typeof MoneySchema>;

export class CurrencyMismatchError extends Error {
  readonly code = 'commercial.currency_mismatch' as const;
  constructor(readonly left: string, readonly right: string) {
    super(`currency mismatch: ${left} vs ${right}`);
  }
}

/** Fails closed: arithmetic across currencies is impossible without an explicit rate snapshot. */
export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}
const parse = (m: Money): bigint => {
  MoneySchema.parse(m);
  return BigInt(m.minorUnits);
};
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minorUnits: (parse(a) + parse(b)).toString(), currency: a.currency };
}
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minorUnits: (parse(a) - parse(b)).toString(), currency: a.currency };
}
/** Sums a non-empty list of same-currency amounts; an explicit currency is required for the empty case. */
export function sumMoney(items: readonly Money[], currency?: string): Money {
  if (items.length === 0) {
    if (!currency) throw new Error('sumMoney requires a currency for an empty list');
    return { minorUnits: '0', currency: CurrencySchema.parse(currency) };
  }
  return items.reduce((acc, item) => addMoney(acc, item), { minorUnits: '0', currency: currency ?? items[0]!.currency });
}
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  const [x, y] = [parse(a), parse(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}
export function isNonNegativeMoney(m: Money): boolean {
  return parse(m) >= 0n;
}

/** Explicit exchange-rate snapshot; mixed-currency comparison is never an implicit sum. */
export const ExchangeRateSnapshotSchema = z.strictObject({
  base: CurrencySchema,
  quote: CurrencySchema,
  /** Quote units per one base unit, as an exact decimal string. */
  rate: DecimalSchema,
  source: z.string().min(1).max(200),
  observedAt: TimestampSchema,
});
export type ExchangeRateSnapshot = z.infer<typeof ExchangeRateSnapshotSchema>;

/** Converts base-currency money to the quote currency with round-half-even; same minor-unit scale is assumed for both. */
export function convertMoney(money: Money, snapshot: ExchangeRateSnapshot): Money {
  ExchangeRateSnapshotSchema.parse(snapshot);
  if (money.currency !== snapshot.base) throw new CurrencyMismatchError(money.currency, snapshot.base);
  const { scaled, scale } = decimalToScaled(snapshot.rate);
  const numerator = parse(money) * scaled;
  const denominator = 10n ** BigInt(scale);
  return { minorUnits: divideHalfEven(numerator, denominator).toString(), currency: snapshot.quote };
}
function divideHalfEven(n: bigint, d: bigint): bigint {
  const negative = n < 0n !== d < 0n;
  const [an, ad] = [n < 0n ? -n : n, d < 0n ? -d : d];
  let q = an / ad;
  const r = an % ad;
  const twice = r * 2n;
  if (twice > ad || (twice === ad && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}
