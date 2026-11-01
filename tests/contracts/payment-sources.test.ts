import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { PaymentAuthorizationDraftCommandSchema, PaymentSourceChallengeCommandSchema, PaymentAdapterRegistrationSchema } from '../../packages/contracts/src/payment-sources.js';
import { PaymentSourceAdapters, SignedSyntheticSourceAdapter } from '../../apps/worker/src/payments/source-adapter.js';

test('source commands select exact opaque records, never replacement parties or self-verified facts', () => {
  const challenge = { hubId: randomUUID(), connectionId: randomUUID(), identityRegistrationId: randomUUID(), accountRegistrationId: null, purpose: 'payment_participant' };
  assert.ok(PaymentSourceChallengeCommandSchema.safeParse(challenge).success);
  for (const key of ['personId', 'sessionId', 'personEpoch', 'nonce', 'verified', 'residenceCountry', 'accountRef']) assert.equal(PaymentSourceChallengeCommandSchema.safeParse({ ...challenge, [key]: 'untrusted' }).success, false);
  assert.equal(PaymentSourceChallengeCommandSchema.safeParse({ ...challenge, purpose: 'payment_account' }).success, false);
  const authorization = { agreementId: randomUUID(), payerBindingId: randomUUID(), payeeBindingId: randomUUID(), accountBindingId: randomUUID(), publisherRegistrationId: randomUUID(), rail: 'qr' };
  assert.ok(PaymentAuthorizationDraftCommandSchema.safeParse(authorization).success);
  for (const key of ['payer', 'payee', 'payerCountry', 'amountMinor', 'connectedAccountRef', 'binding']) assert.equal(PaymentAuthorizationDraftCommandSchema.safeParse({ ...authorization, [key]: 'untrusted' }).success, false);
});

test('empty registry and bounded signed synthetic adapter cannot establish operational or caller-selected authority', () => {
  assert.throws(() => new PaymentSourceAdapters().get('a'.repeat(64)), /unavailable/);
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const id = randomUUID();
  const record = { schemaVersion: 1, fact: 'withdrawal', issuerFact: 'identity_link', registrationId: id, audience: id, recordId: randomUUID(), digest: 'b'.repeat(64), issuedAt: new Date().toISOString(), evidenceMode: 'synthetic' };
  const adapter = new SignedSyntheticSourceAdapter('a'.repeat(64), 'identity_link');
  const authenticate = (input: unknown) => { const raw = Buffer.from(JSON.stringify(input)); return adapter.authenticate(raw, sign(null, raw, keys.privateKey).toString('hex'), publicKey); };
  assert.deepEqual(authenticate(record), record);
  for (const patch of [{ verified: true }, { evidenceMode: 'licensed_provider' }, { issuerFact: 'account' }, { extra: 'x'.repeat(8192) }]) assert.throws(() => authenticate({ ...record, ...patch }));
  const raw = Buffer.from(JSON.stringify(record));
  assert.throws(() => adapter.authenticate(raw, sign(null, raw, other.privateKey).toString('hex'), publicKey), /signature/);
  assert.equal(PaymentAdapterRegistrationSchema.safeParse({ schemaVersion: 1, hubId: randomUUID(), connectionId: randomUUID(), fact: 'identity_link', implementationDigest: 'a'.repeat(64), algorithm: 'ed25519', keyId: 'synthetic', publicKey, evidenceMode: 'licensed_provider', expiresAt: new Date(Date.now() + 60000).toISOString() }).success, false);
});
