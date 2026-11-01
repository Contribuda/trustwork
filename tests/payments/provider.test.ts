import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PaymentBinding, PaymentInstruction } from '../../packages/contracts/src/payments.js';
import { DeterministicPaymentFake, PaymentProviders } from '../../apps/worker/src/payments/provider.js';
const hub = randomUUID();
const binding: PaymentBinding = {
  agreementId: randomUUID(), agreementDigest: 'a'.repeat(64), offerVersion: 1, requestVersion: 1,
  payer: { kind: 'person', id: randomUUID() }, payee: { kind: 'person', id: randomUUID() },
  collectingHubId: hub, payerHubId: hub, payeeHubId: hub, payerCountry: 'US', payeeCountry: 'US',
  amountMinor: '9007199254740993', currency: 'USD', connectionId: randomUUID(), connectedAccountRef: 'synthetic-payee', rail: 'qr', evidenceMode: 'synthetic',
};
const signal = new AbortController().signal;
const instruction = (): PaymentInstruction => ({ operationId: randomUUID(), kind: 'create', binding, originalProviderRef: null });
test('default registry has no provider and bootstrap has no effects', () => {
  assert.throws(() => new PaymentProviders().get(binding.connectionId), /unavailable/);
});
test('QR acknowledgement is customer action, not paid funds, even after its deadline', async () => {
  const fake = new DeterministicPaymentFake(); const i = instruction();
  const e = await fake.create(i, signal);
  assert.equal(e.state, 'pending_customer_action'); assert.equal(e.evidenceMode, 'synthetic');
  assert.equal((await fake.lookup(i, signal))?.state, 'pending_customer_action');
  assert.equal(fake.calls.length, 1);
});
test('lost acknowledgement reconciles the original operation without a second effect', async () => {
  const fake = new DeterministicPaymentFake(); const i = instruction(); fake.plan(i.operationId, 'succeeded', true);
  await assert.rejects(fake.create(i, signal), /acknowledgement lost/);
  assert.equal((await fake.lookup(i, signal))?.state, 'succeeded');
  assert.equal(fake.effects.size, 1); assert.equal(fake.calls.length, 1);
  await assert.rejects(fake.create({ ...i, binding: { ...binding, amountMinor: '1' } }, signal), /binding conflict/);
});
test('authentication precedes parsing, signed synthetic evidence never claims real money', async () => {
  const fake = new DeterministicPaymentFake(); const evidence = await fake.create(instruction(), signal);
  const { raw, signature } = fake.sign(evidence);
  assert.deepEqual(fake.verifyWebhook(raw, signature), evidence);
  assert.throws(() => fake.verifyWebhook(Buffer.from('{invalid'), signature), /invalid payment evidence/);
  assert.throws(() => fake.verifyWebhook(raw, '0'.repeat(64)), /invalid payment evidence/);
  const fabricated = fake.sign({ ...evidence, evidenceMode: 'licensed_provider' });
  assert.throws(() => fake.verifyWebhook(fabricated.raw, fabricated.signature), /real funds/);
});
test('refund, payout and confirmation require the original reference and preserve exact minor units', async () => {
  const fake = new DeterministicPaymentFake();
  for (const kind of ['refund', 'payout', 'confirm'] as const) {
    const i = { ...instruction(), kind };
    await assert.rejects(fake[kind](i, signal), /original provider reference/);
    const result = await fake[kind]({ ...i, originalProviderRef: 'synthetic-original' }, signal);
    assert.equal(result.originalProviderRef, 'synthetic-original'); assert.equal(result.amountMinor, binding.amountMinor);
  }
});
