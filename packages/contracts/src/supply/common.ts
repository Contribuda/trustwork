import { z } from 'zod';
import { RegionCodeSchema } from '../agent-catalog.js';
import { IdSchema, TimestampSchema } from '../common/ids.js';
import { compareDecimal, DecimalSchema, decimalToScaled, scaledToDecimal, UnitMismatchError, type Quantity } from '../common/quantity.js';

/**
 * Shared vocabulary of the procurement and supply contracts (PRC-000). Source: docs/engine/procurement-and-supply.md,
 * docs/data/model.md section 18a and docs/data/lifecycles.md ("Procurement and supply"). Status: Contract; nothing in
 * this directory stores, sends or pays anything.
 *
 * Every object schema is strict, every amount is integer minor units in a string, every quantity is an exact decimal
 * string with a unit code, and every frozen version pins an id and a digest.
 */

/** Version of the supply contract directory; JSON Schemas carry it in their `$id`. Breaking changes need a new version and an ADR. */
export const SUPPLY_CONTRACT_VERSION = 1 as const;

/** Builds a transition guard from an explicit table; anything not listed is forbidden, including self-transitions. */
export function transitionGuard<S extends string>(table: Readonly<Record<S, readonly S[]>>): (from: S, to: S) => boolean {
  return (from, to) => (table[from] ?? []).includes(to);
}

/** Plan-step taxonomy term code (PLAN-000), for example `material.concrete` or `work.framing`. */
export const StepTermSchema = z.string().regex(/^[a-z]+(?:\.[a-z0-9_]+)*$/, 'plan-step term code').max(120);
export const StepTermsSchema = z.array(StepTermSchema).max(20).refine((xs) => new Set(xs).size === xs.length, 'step terms are distinct');

/** A stable key inside a versioned payload (line keys, step keys, column keys). */
export const KeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'stable key');

/** What a line refers to in the catalogue, the manufacturer data or the company's own stock. */
export const MaterialRefSchema = z.strictObject({ kind: z.enum(['offering_version', 'product_entry', 'stock_item']), id: IdSchema });
export type MaterialRef = z.infer<typeof MaterialRefSchema>;

export const PrioritySchema = z.enum(['routine', 'urgent', 'critical']);

/** Where an extracted value came from in a document: a page region, a spreadsheet cell, an XML path or a text line. */
export const LocatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page_region'), page: z.int().min(1).max(10_000), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }),
  z.strictObject({ kind: z.literal('cell'), sheet: z.string().min(1).max(120), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/) }),
  z.strictObject({ kind: z.literal('xml_path'), path: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('text_line'), line: z.int().min(1).max(1_000_000) }),
]);
export type Locator = z.infer<typeof LocatorSchema>;

/** Confidence between 0 and 1 as an exact decimal string (never a float in a digest). */
export const ConfidenceSchema = DecimalSchema.refine((v) => compareDecimal(v, '0') >= 0 && compareDecimal(v, '1') <= 0, 'confidence between 0 and 1');
/** Non-negative exact decimal (quantities on lines are never negative; corrections append). */
export const NonNegativeDecimalSchema = DecimalSchema.refine((v) => compareDecimal(v, '0') >= 0, 'non-negative decimal');
export const PositiveDecimalSchema = DecimalSchema.refine((v) => compareDecimal(v, '0') > 0, 'positive decimal');
export const NonNegativeQuantitySchema = z.strictObject({ value: NonNegativeDecimalSchema, unit: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'unit code') });
export const PositiveQuantitySchema = z.strictObject({ value: PositiveDecimalSchema, unit: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'unit code') });

export const EvidenceRefsSchema = z.array(IdSchema).max(100);
export { RegionCodeSchema };

/** A person acting on the first-party surface. Approvals, acceptance and risk-signal clearance carry this and nothing else. */
export const PersonActorSchema = z.strictObject({ kind: z.literal('person'), personId: IdSchema, via: z.literal('first_party') });
/** Who recorded something: a person, or the person's own agent under a mandate (the intent id links the audit trail). */
export const RecorderSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personId: IdSchema }),
  z.strictObject({ kind: z.literal('agent'), personId: IdSchema, mandateId: IdSchema, actionIntentId: IdSchema }),
]);
export type Recorder = z.infer<typeof RecorderSchema>;

export const TimeRangeSchema = z.strictObject({ from: TimestampSchema, to: TimestampSchema }).refine((r) => Date.parse(r.to) > Date.parse(r.from), { message: 'range ends after it starts', path: ['to'] });

/* ---------- Exact decimal helpers ---------- */

/** Exact sum of decimal strings. */
export function sumDecimals(values: readonly string[]): string {
  if (values.length === 0) return '0';
  const parsed = values.map(decimalToScaled);
  const scale = Math.max(...parsed.map((p) => p.scale));
  const total = parsed.reduce((acc, p) => acc + p.scaled * 10n ** BigInt(scale - p.scale), 0n);
  return scaledToDecimal(total, scale);
}
/** Exact difference `a - b`. */
export function subtractDecimals(a: string, b: string): string {
  const [x, y] = [decimalToScaled(a), decimalToScaled(b)];
  const scale = Math.max(x.scale, y.scale);
  return scaledToDecimal(x.scaled * 10n ** BigInt(scale - x.scale) - y.scaled * 10n ** BigInt(scale - y.scale), scale);
}
/** Exact same-unit sum of quantities; a different unit fails closed (convert explicitly first). */
export function sumQuantities(items: readonly Quantity[], unit: string): Quantity {
  for (const item of items) if (item.unit !== unit) throw new UnitMismatchError(unit, item.unit);
  return { value: sumDecimals(items.map((i) => i.value)), unit };
}
/** `value * minorUnits`, rounded half-even to integer minor units (exact bigint arithmetic). */
export function multiplyDecimalByMinorUnits(value: string, minorUnits: string): bigint {
  const { scaled, scale } = decimalToScaled(value);
  const n = scaled * BigInt(minorUnits);
  const d = 10n ** BigInt(scale);
  return divideHalfEven(n, d);
}
export function divideHalfEven(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const negative = n < 0n !== d < 0n;
  const [an, ad] = [n < 0n ? -n : n, d < 0n ? -d : d];
  let q = an / ad;
  const twice = (an % ad) * 2n;
  if (twice > ad || (twice === ad && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}
