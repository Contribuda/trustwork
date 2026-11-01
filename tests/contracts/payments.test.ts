import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreatePaymentCommandSchema, PaymentMinorSchema, paymentTransition } from '../../packages/contracts/src/payments.js';

test('payment commands cannot choose identities, hubs, countries, amounts or destinations', () => {
  const valid = { agreementId: randomUUID(), budgetId: randomUUID() };
  assert.ok(CreatePaymentCommandSchema.safeParse(valid).success);
  for (const key of ['payer', 'payee', 'hubId', 'payerCountry', 'amountMinor', 'currency', 'connectedAccountRef', 'connectionId']) {
    assert.equal(CreatePaymentCommandSchema.safeParse({ ...valid, [key]: 'untrusted' }).success, false, key);
  }
});
test('minor units refuse numeric coercion, decimal rounding, zero, negatives and overflow', () => {
  for (const value of [1, '0', '-1', '01', '1.01', '1e6', '1000000000000000000', ' 1', 'NaN']) assert.equal(PaymentMinorSchema.safeParse(value).success, false);
  for (const value of ['1', '9007199254740993', '999999999999999999']) assert.equal(PaymentMinorSchema.parse(value), value);
});
test('terminal outcomes are monotonic and conflicting final evidence is quarantined', () => {
  for (const current of ['succeeded', 'failed'] as const) {
    assert.equal(paymentTransition(current, current), 'ignore');
    assert.equal(paymentTransition(current, current === 'succeeded' ? 'failed' : 'succeeded'), 'conflict');
    for (const pending of ['outcome_unknown', 'requires_confirmation', 'pending_customer_action'] as const) assert.equal(paymentTransition(current, pending), 'ignore');
  }
  assert.equal(paymentTransition('outcome_unknown', 'succeeded'), 'apply');
  assert.equal(paymentTransition('pending_customer_action', 'requires_confirmation'), 'ignore');
});
