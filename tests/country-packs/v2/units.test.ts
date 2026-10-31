import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASE_UNITS,
  CatalogueUnitCodeSchema,
  UNIT_CATALOGUE,
  UNIT_DIMENSIONS,
  UnitConversionError,
  UnitMismatchError,
  addQuantity,
  conversionRule,
  convertQuantity,
  getUnit,
} from '@trustwork/contracts/client';
import { packProblems } from '@trustwork/country-packs';
import { federalFixture } from './federal-fixture.js';

const exact = { scale: 6, rounding: 'half-even' } as const;

test('the unit catalogue is unique, complete per dimension and anchored on SI base units', () => {
  const codes = UNIT_CATALOGUE.map((u) => u.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const dimension of UNIT_DIMENSIONS) {
    const base = BASE_UNITS[dimension];
    assert.ok(UNIT_CATALOGUE.some((u) => u.dimension === dimension), dimension);
    if (base) assert.equal(getUnit(base)?.toBase, '1', `${dimension} base ${base}`);
  }
  for (const code of ['m', 'm2', 'm3', 'lm', 't', 'ft', 'ft2', 'yd3', 'bdft', 'lb', 'us_gal', 'imp_gal', 'sq', 'pc', 'ls']) assert.ok(getUnit(code), code);
  assert.ok(UNIT_CATALOGUE.filter((u) => u.dimension === 'count').every((u) => u.toBase === null), 'count units never convert');
});

test('conversion rules are exact ratios from the 1959 yard and pound and the gallon definitions', () => {
  assert.deepEqual(conversionRule('ft', 'in'), { from: 'ft', to: 'in', numerator: 12n, denominator: 1n });
  assert.deepEqual(conversionRule('yd3', 'ft3'), { from: 'yd3', to: 'ft3', numerator: 27n, denominator: 1n });
  assert.deepEqual(conversionRule('bdft', 'in3'), { from: 'bdft', to: 'in3', numerator: 144n, denominator: 1n });
  assert.deepEqual(conversionRule('short_ton', 'lb'), { from: 'short_ton', to: 'lb', numerator: 2000n, denominator: 1n });
  assert.deepEqual(conversionRule('ac', 'ft2'), { from: 'ac', to: 'ft2', numerator: 43560n, denominator: 1n });
  assert.deepEqual(conversionRule('us_gal', 'in3'), { from: 'us_gal', to: 'in3', numerator: 231n, denominator: 1n });
  assert.deepEqual(conversionRule('sq', 'ft2'), { from: 'sq', to: 'ft2', numerator: 100n, denominator: 1n });
  assert.deepEqual(conversionRule('h', 's'), { from: 'h', to: 's', numerator: 3600n, denominator: 1n });
  assert.notDeepEqual(conversionRule('us_gal', 'l'), conversionRule('imp_gal', 'l'), 'US and imperial gallons differ');
});

test('quantities convert with exact arithmetic and an explicit scale and rounding mode', () => {
  assert.deepEqual(convertQuantity({ value: '100', unit: 'ft2' }, 'm2', exact), { value: '9.290304', unit: 'm2' });
  assert.deepEqual(convertQuantity({ value: '1', unit: 'yd3' }, 'm3', exact), { value: '0.764555', unit: 'm3' });
  assert.deepEqual(convertQuantity({ value: '1', unit: 'yd3' }, 'm3', { scale: 6, rounding: 'down' }), { value: '0.764554', unit: 'm3' });
  assert.deepEqual(convertQuantity({ value: '2000', unit: 'lb' }, 'short_ton', { scale: 0, rounding: 'half-even' }), { value: '1', unit: 'short_ton' });
  assert.deepEqual(convertQuantity({ value: '1', unit: 'bdft' }, 'ft3', exact), { value: '0.083333', unit: 'ft3' });
  assert.deepEqual(convertQuantity({ value: '1', unit: 'bdft' }, 'ft3', { scale: 6, rounding: 'up' }), { value: '0.083334', unit: 'ft3' });
  assert.deepEqual(convertQuantity({ value: '25.4', unit: 'mm' }, 'in', exact), { value: '1.000000', unit: 'in' });
  assert.deepEqual(convertQuantity({ value: '-2.5', unit: 'm' }, 'cm', { scale: 0, rounding: 'half-up' }), { value: '-250', unit: 'cm' });
  assert.deepEqual(convertQuantity({ value: '0.5', unit: 'm' }, 'm', { scale: 0, rounding: 'half-even' }), { value: '0', unit: 'm' }, 'half-even rounds to the even neighbour');
  assert.deepEqual(convertQuantity({ value: '1.5', unit: 'm' }, 'm', { scale: 0, rounding: 'half-even' }), { value: '2', unit: 'm' });
  assert.deepEqual(convertQuantity({ value: '-0.5', unit: 'm' }, 'm', { scale: 0, rounding: 'half-up' }), { value: '-1', unit: 'm' }, 'half-up rounds away from zero');
  assert.deepEqual(convertQuantity({ value: '-0.000001', unit: 'm' }, 'km', { scale: 0, rounding: 'down' }), { value: '0', unit: 'km' }, 'no negative zero');
  const back = convertQuantity(convertQuantity({ value: '12.5', unit: 'ft' }, 'm', exact), 'ft', { scale: 2, rounding: 'half-even' });
  assert.deepEqual(back, { value: '12.50', unit: 'ft' });
});

test('conversion refuses unknown units, other dimensions, count units and missing options', () => {
  assert.throws(() => convertQuantity({ value: '1', unit: 'furlong' }, 'm', exact), (e: unknown) => e instanceof UnitConversionError && e.reason === 'unknown_unit');
  assert.throws(() => convertQuantity({ value: '1', unit: 'm3' }, 't', exact), (e: unknown) => e instanceof UnitConversionError && e.reason === 'dimension_mismatch' && e.code === 'validation.unit_conversion');
  assert.throws(() => convertQuantity({ value: '1', unit: 'set' }, 'pc', exact), (e: unknown) => e instanceof UnitConversionError && e.reason === 'not_convertible');
  assert.deepEqual(convertQuantity({ value: '3', unit: 'pc' }, 'pc', { scale: 0, rounding: 'down' }), { value: '3', unit: 'pc' });
  assert.throws(() => convertQuantity({ value: '1', unit: 'm' }, 'ft', {} as never));
  assert.throws(() => convertQuantity({ value: '1', unit: 'm' }, 'ft', { scale: 7, rounding: 'half-even' }), 'quantities carry at most six fractional digits');
  assert.throws(() => convertQuantity({ value: 1 as unknown as string, unit: 'm' }, 'ft', exact));
  assert.throws(() => addQuantity({ value: '1', unit: 'm' }, { value: '1', unit: 'ft' }), UnitMismatchError, 'adding still needs the same unit');
});

test('packs reference units only from the catalogue', () => {
  assert.equal(CatalogueUnitCodeSchema.safeParse('ft2').success, true);
  assert.equal(CatalogueUnitCodeSchema.safeParse('furlong').success, false);
  const raw = federalFixture();
  (raw.facets.units![0] as { common: string[] }).common = ['ft', 'furlong'];
  assert.equal(packProblems(raw).pack, null);
  const local = federalFixture();
  (local.facets.units![1] as { unit: string }).unit = 'cord';
  assert.match(packProblems(local).problems.join('\n'), /not in the measurement-unit catalogue/);
});
