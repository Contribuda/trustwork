import { z } from 'zod';
import { DecimalSchema, QuantitySchema, UnitCodeSchema, decimalToScaled, scaledToDecimal, type Quantity } from './quantity.js';

/**
 * Measurement-unit catalogue (O11, CTRY-002). Every unit code a quantity, catalogue item, quote line or country pack
 * may use is listed here with its dimension, measurement system and an exact conversion factor to the dimension's
 * base unit (SI: metre, square metre, cubic metre, kilogram, second). Factors are exact decimal strings taken from
 * the definitions of the international yard and pound (1959) and of the US and imperial gallons; nothing is a float.
 *
 * Conversion is explicit: `convertQuantity` needs a target scale and a rounding mode, converts only within one
 * dimension and refuses units without a factor (pieces, sets, lump sums). Quantities still add only in the same unit
 * (`addQuantity`); converting first is a visible, deliberate step.
 *
 * Unit names shown to people come from locale files and country packs (local names), never from this catalogue.
 */

export const UNIT_DIMENSIONS = ['length', 'area', 'volume', 'mass', 'time', 'count'] as const;
export const UnitDimensionSchema = z.enum(UNIT_DIMENSIONS);
export type UnitDimension = z.infer<typeof UnitDimensionSchema>;

/** `si` covers SI and the metric units accepted for use with it; `inch-pound` units are shared by US customary and imperial use; `us-customary` and `imperial` differ for volume and tons. */
export const UNIT_SYSTEMS = ['si', 'imperial', 'us-customary', 'inch-pound', 'neutral'] as const;
export const UnitSystemSchema = z.enum(UNIT_SYSTEMS);
export type UnitSystem = z.infer<typeof UnitSystemSchema>;

/** An exact positive decimal of any precision (conversion factors need more than the six digits a quantity carries). */
export const ExactFactorSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'exact decimal factor').refine((v) => /[1-9]/.test(v), 'factor must be positive');

export const UnitDefinitionSchema = z.strictObject({
  code: UnitCodeSchema,
  dimension: UnitDimensionSchema,
  system: UnitSystemSchema,
  /** International symbol for technical display; people-facing names come from locales and packs. */
  symbol: z.string().min(1).max(12),
  /** Exact factor to the base unit of the dimension; null means the unit never converts (pieces, sets, lump sums). */
  toBase: ExactFactorSchema.nullable(),
  /** Definition the factor rests on, for reviewers. */
  definition: z.string().min(1),
});
export type UnitDefinition = z.infer<typeof UnitDefinitionSchema>;

export const BASE_UNITS: Readonly<Record<UnitDimension, string | null>> = { length: 'm', area: 'm2', volume: 'm3', mass: 'kg', time: 's', count: null };

const u = (code: string, dimension: UnitDimension, system: UnitSystem, symbol: string, toBase: string | null, definition: string): UnitDefinition => ({ code, dimension, system, symbol, toBase, definition });

/** The catalogue. Adding a unit is a reviewed contract change; removing or re-defining one is a breaking change. */
export const UNIT_CATALOGUE: readonly UnitDefinition[] = z.array(UnitDefinitionSchema).parse([
  // Length (base metre)
  u('mm', 'length', 'si', 'mm', '0.001', 'SI prefix milli'),
  u('cm', 'length', 'si', 'cm', '0.01', 'SI prefix centi'),
  u('m', 'length', 'si', 'm', '1', 'SI base unit'),
  u('lm', 'length', 'si', 'lm', '1', 'running (linear) metre of a product sold by length; equal to one metre'),
  u('km', 'length', 'si', 'km', '1000', 'SI prefix kilo'),
  u('in', 'length', 'inch-pound', 'in', '0.0254', 'international inch, 1959: exactly 25.4 mm'),
  u('ft', 'length', 'inch-pound', 'ft', '0.3048', 'international foot, 1959: 12 in'),
  u('yd', 'length', 'inch-pound', 'yd', '0.9144', 'international yard, 1959: 3 ft'),
  u('mi', 'length', 'inch-pound', 'mi', '1609.344', 'international mile: 5280 ft'),
  // Area (base square metre)
  u('mm2', 'area', 'si', 'mm²', '0.000001', '(0.001 m)²'),
  u('cm2', 'area', 'si', 'cm²', '0.0001', '(0.01 m)²'),
  u('m2', 'area', 'si', 'm²', '1', 'SI derived unit'),
  u('ha', 'area', 'si', 'ha', '10000', 'hectare: 100 m × 100 m'),
  u('km2', 'area', 'si', 'km²', '1000000', '(1000 m)²'),
  u('in2', 'area', 'inch-pound', 'in²', '0.00064516', '(0.0254 m)²'),
  u('ft2', 'area', 'inch-pound', 'ft²', '0.09290304', '(0.3048 m)²'),
  u('yd2', 'area', 'inch-pound', 'yd²', '0.83612736', '(0.9144 m)²'),
  u('ac', 'area', 'inch-pound', 'ac', '4046.8564224', 'international acre: 43560 ft²'),
  u('sq', 'area', 'us-customary', 'sq', '9.290304', 'roofing square: 100 ft²'),
  // Volume (base cubic metre)
  u('ml', 'volume', 'si', 'ml', '0.000001', 'millilitre: 1 cm³'),
  u('l', 'volume', 'si', 'l', '0.001', 'litre: 1 dm³ (1964 definition)'),
  u('m3', 'volume', 'si', 'm³', '1', 'SI derived unit'),
  u('in3', 'volume', 'inch-pound', 'in³', '0.000016387064', '(0.0254 m)³'),
  u('ft3', 'volume', 'inch-pound', 'ft³', '0.028316846592', '(0.3048 m)³'),
  u('yd3', 'volume', 'inch-pound', 'yd³', '0.764554857984', '(0.9144 m)³'),
  u('bdft', 'volume', 'us-customary', 'FBM', '0.002359737216', 'board foot: 144 in³ (nominal lumber measure)'),
  u('us_gal', 'volume', 'us-customary', 'gal', '0.003785411784', 'US liquid gallon: 231 in³'),
  u('us_qt', 'volume', 'us-customary', 'qt', '0.000946352946', 'US liquid quart: 1/4 US gallon'),
  u('imp_gal', 'volume', 'imperial', 'gal (imp)', '0.00454609', 'imperial gallon: exactly 4.54609 l'),
  // Mass (base kilogram)
  u('g', 'mass', 'si', 'g', '0.001', 'SI prefix milli of the kilogram'),
  u('kg', 'mass', 'si', 'kg', '1', 'SI base unit'),
  u('t', 'mass', 'si', 't', '1000', 'tonne: 1000 kg'),
  u('oz', 'mass', 'inch-pound', 'oz', '0.028349523125', 'avoirdupois ounce: 1/16 lb'),
  u('lb', 'mass', 'inch-pound', 'lb', '0.45359237', 'international avoirdupois pound, 1959'),
  u('short_ton', 'mass', 'us-customary', 'ton', '907.18474', 'short ton: 2000 lb'),
  u('long_ton', 'mass', 'imperial', 'LT', '1016.0469088', 'long ton: 2240 lb'),
  // Time (base second); a working day or shift is not a fixed length and is not in the catalogue
  u('s', 'time', 'si', 's', '1', 'SI base unit'),
  u('min', 'time', 'si', 'min', '60', '60 s'),
  u('h', 'time', 'si', 'h', '3600', '60 min'),
  // Count: never converted into each other
  u('pc', 'count', 'neutral', 'pc', null, 'one piece or item'),
  u('set', 'count', 'neutral', 'set', null, 'one set as defined by the line or item'),
  u('pack', 'count', 'neutral', 'pack', null, 'one package as defined by the item'),
  u('ls', 'count', 'neutral', 'LS', null, 'lump sum: the whole scope of the line'),
]);

const BY_CODE = new Map(UNIT_CATALOGUE.map((unit) => [unit.code, unit]));

export function getUnit(code: string): UnitDefinition | null {
  return BY_CODE.get(code) ?? null;
}

export function isKnownUnit(code: string): boolean {
  return BY_CODE.has(code);
}

/** A code that must exist in the catalogue (packs and new contracts reference units through this). */
export const CatalogueUnitCodeSchema = UnitCodeSchema.refine(isKnownUnit, 'unit code is not in the measurement-unit catalogue');

export const ROUNDING_MODES = ['half-even', 'half-up', 'down', 'up'] as const;
export const RoundingModeSchema = z.enum(ROUNDING_MODES);
export type RoundingMode = z.infer<typeof RoundingModeSchema>;

export class UnitConversionError extends Error {
  readonly code = 'validation.unit_conversion' as const;
  constructor(readonly from: string, readonly to: string, readonly reason: 'unknown_unit' | 'dimension_mismatch' | 'not_convertible') {
    super(`cannot convert ${from} to ${to}: ${reason}`);
  }
}

/** Parses an exact decimal of any precision into numerator / 10^scale. */
function exactToScaled(value: string): { scaled: bigint; scale: number } {
  const [whole, fraction = ''] = value.split('.') as [string, string?];
  return { scaled: BigInt(whole + fraction), scale: fraction.length };
}

/** The explicit rule for converting `from` into `to`: multiply by numerator / denominator (exact, reduced). */
export function conversionRule(from: string, to: string): { from: string; to: string; numerator: bigint; denominator: bigint } {
  const a = getUnit(from);
  const b = getUnit(to);
  if (!a || !b) throw new UnitConversionError(from, to, 'unknown_unit');
  if (a.dimension !== b.dimension) throw new UnitConversionError(from, to, 'dimension_mismatch');
  if (a.toBase === null || b.toBase === null) {
    if (a.code === b.code) return { from, to, numerator: 1n, denominator: 1n };
    throw new UnitConversionError(from, to, 'not_convertible');
  }
  const x = exactToScaled(a.toBase);
  const y = exactToScaled(b.toBase);
  // value_to = value_from * (x / 10^xs) / (y / 10^ys)
  let numerator = x.scaled * 10n ** BigInt(y.scale);
  let denominator = y.scaled * 10n ** BigInt(x.scale);
  const g = gcd(numerator, denominator);
  numerator /= g;
  denominator /= g;
  return { from, to, numerator, denominator };
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

/** Integer division of n by d (d > 0) with an explicit rounding mode. */
function divideRounded(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  let q = abs / d;
  const r = abs % d;
  if (r !== 0n) {
    const twice = r * 2n;
    const roundAway =
      mode === 'up' ||
      (mode === 'half-up' && twice >= d) ||
      (mode === 'half-even' && (twice > d || (twice === d && q % 2n === 1n)));
    if (roundAway) q += 1n;
  }
  return negative ? -q : q;
}

export const ConversionOptionsSchema = z.strictObject({ scale: z.int().min(0).max(6), rounding: RoundingModeSchema });
export type ConversionOptions = z.infer<typeof ConversionOptionsSchema>;

/**
 * Converts a quantity into another unit of the same dimension with exact arithmetic, then rounds to `scale` fractional
 * digits with the given mode. The caller chooses scale and rounding; there is no default that could hide a loss.
 */
export function convertQuantity(quantity: Quantity, to: string, options: ConversionOptions): Quantity {
  QuantitySchema.parse(quantity);
  const { scale, rounding } = ConversionOptionsSchema.parse(options);
  const rule = conversionRule(quantity.unit, to);
  const value = decimalToScaled(quantity.value);
  // result * 10^scale = value.scaled / 10^value.scale * num / den * 10^scale
  const numerator = value.scaled * rule.numerator * 10n ** BigInt(scale);
  const denominator = rule.denominator * 10n ** BigInt(value.scale);
  const scaled = divideRounded(numerator, denominator, rounding);
  const result = scaledToDecimal(scaled, scale);
  return { value: DecimalSchema.parse(result), unit: to };
}
