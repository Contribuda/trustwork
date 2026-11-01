import { createPublicKey, verify } from 'node:crypto';
import type { DataPool } from '@trustwork/data';
import { PaymentSourceAssertionSchema, type PaymentSourceAssertion } from '../../../../packages/contracts/src/payment-sources.js';
import { paymentSources } from '../../../../packages/data/src/repositories/payment-sources.js';
import { inTransaction } from '../db.js';

export interface RegisteredSourceAdapter {
  readonly implementationDigest: string;
  readonly fact: 'identity_link' | 'account';
  readonly evidenceMode: 'synthetic';
  /** An adapter's contract must explicitly attest exact verified identity/entity correlation, never account control alone. */
  authenticate(raw: Uint8Array, signature: string, publicKey: string): PaymentSourceAssertion;
}

/** No operational adapters are shipped or inferred from a callback. Installation registers reviewed implementations. */
export class PaymentSourceAdapters {
  constructor(private readonly adapters: ReadonlyMap<string, RegisteredSourceAdapter> = new Map()) {}
  get(implementationDigest: string): RegisteredSourceAdapter {
    const adapter = this.adapters.get(implementationDigest);
    if (!adapter || adapter.implementationDigest !== implementationDigest) throw new Error('payment source adapter unavailable');
    return adapter;
  }
}

/** Explicit synthetic issuer wire format. It proves no real identity, account or funds. */
export class SignedSyntheticSourceAdapter implements RegisteredSourceAdapter {
  readonly evidenceMode = 'synthetic' as const;
  constructor(readonly implementationDigest: string, readonly fact: 'identity_link' | 'account') {}
  authenticate(raw: Uint8Array, signature: string, publicKey: string): PaymentSourceAssertion {
    if (raw.byteLength > 8192 || !/^[a-f0-9]{128}$/.test(signature) || publicKey.length > 1024) throw new Error('invalid source envelope');
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, raw, key, Buffer.from(signature, 'hex'))) throw new Error('invalid source signature');
    const evidence = PaymentSourceAssertionSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
    if ((evidence.fact === 'withdrawal' ? evidence.issuerFact : evidence.fact) !== this.fact || evidence.evidenceMode !== this.evidenceMode) throw new Error('source fact mismatch');
    return evidence;
  }
}
export interface PaymentSourceRuntime { verifierPool: DataPool; adapters: PaymentSourceAdapters }

/** Trusted worker ingress: verification precedes narrow SQL intake; SQL rechecks current registration and challenge. */
export async function receivePaymentSource(runtime: PaymentSourceRuntime, registrationId: string, raw: Uint8Array, signature: string): Promise<void> {
  if (raw.byteLength > 8192) throw new Error('source envelope too large');
  const registration = await inTransaction(runtime.verifierPool, (trx) => paymentSources.verifierRegistration(trx, registrationId));
  const adapter = runtime.adapters.get(registration.implementationDigest);
  if (adapter.fact !== registration.fact || adapter.evidenceMode !== registration.evidenceMode) throw new Error('source registration mismatch');
  const evidence = adapter.authenticate(raw, signature, registration.publicKey);
  if (evidence.registrationId !== registrationId || evidence.audience !== registrationId) throw new Error('source audience mismatch');
  await inTransaction(runtime.verifierPool, (trx) => paymentSources.recordAssertion(trx, evidence));
}
