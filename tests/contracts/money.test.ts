import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMoney,
  subtractMoney,
  sumMoney,
  compareMoney,
  convertMoney,
  CurrencyMismatchError,
  MoneySchema,
  NonNegativeMoneySchema,
  MinorUnitsSchema,
  ExchangeRateSnapshotSchema,
} from '../../packages/contracts/src/common/money.js';
import { addQuantity, compareDecimal, DecimalSchema, QuantitySchema, UnitMismatchError, decimalToScaled, scaledToDecimal } from '../../packages/contracts/src/common/quantity.js';

const uzs = (m: string) => ({ minorUnits: m, currency: 'UZS' });
test('money schema accepts integer strings only; numbers, floats, exponents and leading zeros are rejected', () => {
  assert.ok(MoneySchema.safeParse(uzs('0')).success);
  assert.ok(MoneySchema.safeParse(uzs('-1')).success);
  assert.equal(NonNegativeMoneySchema.safeParse(uzs('-1')).success, false);
  for (const bad of ['1e3', '10.0', '01', '', ' 1', '1 ', '+1']) assert.equal(MinorUnitsSchema.safeParse(bad).success, false, bad);
  assert.equal(MoneySchema.safeParse({ minorUnits: 100, currency: 'UZS' }).success, false);
  assert.equal(MoneySchema.safeParse({ minorUnits: '100', currency: 'rub' }).success, false);
  assert.equal(MoneySchema.safeParse({ minorUnits: '100', currency: 'UZS', extra: 1 }).success, false);
});
test('same-currency arithmetic works with bigint precision', () => {
  assert.deepEqual(addMoney(uzs('9007199254740993'), uzs('1')), uzs('9007199254740994'));
  assert.deepEqual(subtractMoney(uzs('5'), uzs('7')), uzs('-2'));
  assert.deepEqual(sumMoney([uzs('1'), uzs('2'), uzs('3')]), uzs('6'));
  assert.deepEqual(sumMoney([], 'UZS'), uzs('0'));
  assert.equal(compareMoney(uzs('2'), uzs('10')), -1);
});
test('mixed-currency arithmetic fails closed', () => {
  assert.throws(() => addMoney(uzs('1'), { minorUnits: '1', currency: 'USD' }), CurrencyMismatchError);
  assert.throws(() => sumMoney([uzs('1'), { minorUnits: '1', currency: 'EUR' }]), CurrencyMismatchError);
  assert.throws(() => compareMoney(uzs('1'), { minorUnits: '1', currency: 'USD' }), CurrencyMismatchError);
  assert.throws(() => sumMoney([]), /currency/);
});
test('conversion requires an explicit rate snapshot and rounds half-even', () => {
  const snapshot = ExchangeRateSnapshotSchema.parse({ base: 'USD', quote: 'UZS', rate: '92.5', source: 'fixture', observedAt: '2026-10-27T00:00:00Z' });
  assert.deepEqual(convertMoney({ minorUnits: '100', currency: 'USD' }, snapshot), uzs('9250'));
  assert.deepEqual(convertMoney({ minorUnits: '1', currency: 'USD' }, { ...snapshot, rate: '0.5' }), uzs('0'));
  assert.deepEqual(convertMoney({ minorUnits: '3', currency: 'USD' }, { ...snapshot, rate: '0.5' }), uzs('2'));
  assert.throws(() => convertMoney(uzs('1'), snapshot), CurrencyMismatchError);
  assert.equal(ExchangeRateSnapshotSchema.safeParse({ ...snapshot, rate: 92.5 }).success, false);
});
test('quantities are exact decimals with unit codes', () => {
  assert.ok(QuantitySchema.safeParse({ value: '10.5', unit: 'm2' }).success);
  for (const bad of ['10.', '.5', '1e3', '10.1234567', 'ten']) assert.equal(DecimalSchema.safeParse(bad).success, false, bad);
  assert.equal(QuantitySchema.safeParse({ value: 10, unit: 'm2' }).success, false);
  assert.equal(QuantitySchema.safeParse({ value: '10', unit: 'M2' }).success, false);
  assert.deepEqual(addQuantity({ value: '0.1', unit: 'm2' }, { value: '0.2', unit: 'm2' }), { value: '0.3', unit: 'm2' });
  assert.deepEqual(addQuantity({ value: '-1', unit: 'pcs' }, { value: '0.25', unit: 'pcs' }), { value: '-0.75', unit: 'pcs' });
  assert.throws(() => addQuantity({ value: '1', unit: 'm2' }, { value: '1', unit: 'm3' }), UnitMismatchError);
  assert.equal(compareDecimal('10', '10.0'), 0);
  assert.equal(compareDecimal('100', '10'), 1);
  assert.equal(scaledToDecimal(decimalToScaled('-0.050').scaled, 3), '-0.050');
});
