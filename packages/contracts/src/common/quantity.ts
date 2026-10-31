import { z } from 'zod';

/** Exact decimal string with at most six fractional digits; never a JS number. `10.0` and `10` are distinct strings and distinct digests. */
export const DecimalSchema = z.string().regex(/^(?!-0+(\.0+)?$)-?(0|[1-9]\d*)(\.\d{1,6})?$/, 'exact decimal string (no negative zero)');
export type Decimal = z.infer<typeof DecimalSchema>;
export const PercentSchema = DecimalSchema;

/** Unit code from the measurement-unit catalogue (O11); the catalogue entry, not the value, defines allowed precision. */
export const UnitCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'unit code');
export const QuantitySchema = z.strictObject({ value: DecimalSchema, unit: UnitCodeSchema });
export type Quantity = z.infer<typeof QuantitySchema>;

export function decimalToScaled(value: string): { scaled: bigint; scale: number } {
  DecimalSchema.parse(value);
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  const negative = whole.startsWith('-');
  const digits = (negative ? whole.slice(1) : whole) + fraction;
  const scaled = BigInt(digits) * (negative ? -1n : 1n);
  return { scaled, scale: fraction.length };
}
export function scaledToDecimal(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`;
}
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = [decimalToScaled(a), decimalToScaled(b)];
  const scale = Math.max(x.scale, y.scale);
  const xs = x.scaled * 10n ** BigInt(scale - x.scale);
  const ys = y.scaled * 10n ** BigInt(scale - y.scale);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}
export class UnitMismatchError extends Error {
  readonly code = 'validation.unit_mismatch' as const;
  constructor(readonly left: string, readonly right: string) {
    super(`unit mismatch: ${left} vs ${right}`);
  }
}
/** Same-unit addition only; unit conversion requires an explicit catalogue rule, never an implicit factor. */
export function addQuantity(a: Quantity, b: Quantity): Quantity {
  QuantitySchema.parse(a);
  QuantitySchema.parse(b);
  if (a.unit !== b.unit) throw new UnitMismatchError(a.unit, b.unit);
  const [x, y] = [decimalToScaled(a.value), decimalToScaled(b.value)];
  const scale = Math.max(x.scale, y.scale);
  const sum = x.scaled * 10n ** BigInt(scale - x.scale) + y.scaled * 10n ** BigInt(scale - y.scale);
  return { value: scaledToDecimal(sum, scale), unit: a.unit };
}
