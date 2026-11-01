import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentBindingSchema, PaymentEvidenceSchema, type PaymentEvidence, type PaymentInstruction } from '../../../../packages/contracts/src/payments.js';

/** Provider SDKs belong behind this port. The shipped registry is empty; no operational provider is assumed. */
export interface PaymentProvider {
  readonly evidenceMode: 'synthetic' | 'licensed_provider';
  create(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence>;
  confirm(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence>;
  refund(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence>;
  payout(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence>;
  connectedAccount(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence>;
  /** A missing result is uncertainty, not proof that no charge occurred. */
  lookup(instruction: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence | null>;
  /** Signature/authentication first, bounded parsing second. Never accepts a caller's "verified" flag. */
  verifyWebhook(raw: Uint8Array, signature: string): PaymentEvidence;
}
export class PaymentProviders {
  constructor(private readonly adapters: ReadonlyMap<string, PaymentProvider> = new Map()) {}
  get(connectionId: string): PaymentProvider {
    const provider = this.adapters.get(connectionId);
    if (!provider) throw new Error('payment provider unavailable');
    return provider;
  }
}

/** Deterministic synthetic provider: no network, credentials, real account or real funds. */
export class DeterministicPaymentFake implements PaymentProvider {
  readonly evidenceMode = 'synthetic' as const;
  readonly effects = new Map<string, PaymentEvidence>();
  readonly calls: string[] = [];
  readonly lookups: string[] = [];
  private readonly instructions = new Map<string, string>();
  private readonly outcomes = new Map<string, PaymentEvidence['state']>();
  private readonly lostAcknowledgements = new Set<string>();
  constructor(private readonly signingKey = 'synthetic-payment-fixture-not-a-production-secret') {}
  plan(operationId: string, state: PaymentEvidence['state'], loseAcknowledgement = false): void {
    this.outcomes.set(operationId, state);
    if (loseAcknowledgement) this.lostAcknowledgements.add(operationId);
  }
  create(i: PaymentInstruction, s: AbortSignal) { return this.execute('create', i, s); }
  confirm(i: PaymentInstruction, s: AbortSignal) { return this.execute('confirm', i, s); }
  refund(i: PaymentInstruction, s: AbortSignal) { return this.execute('refund', i, s); }
  payout(i: PaymentInstruction, s: AbortSignal) { return this.execute('payout', i, s); }
  connectedAccount(i: PaymentInstruction, s: AbortSignal) { return this.execute('connected_account', i, s); }
  async lookup(i: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence | null> {
    signal.throwIfAborted();
    this.lookups.push(i.operationId);
    const prior = this.instructions.get(i.operationId);
    if (prior && prior !== JSON.stringify(i)) throw new Error('operation binding conflict');
    return structuredClone(this.effects.get(i.operationId) ?? null);
  }
  private async execute(kind: PaymentInstruction['kind'], i: PaymentInstruction, signal: AbortSignal): Promise<PaymentEvidence> {
    signal.throwIfAborted();
    PaymentBindingSchema.parse(i.binding);
    if (i.kind !== kind || i.binding.evidenceMode !== 'synthetic') throw new Error('invalid synthetic instruction');
    if (kind !== 'create' && kind !== 'connected_account' && !i.originalProviderRef) throw new Error('original provider reference required');
    const serialized = JSON.stringify(i);
    if (this.instructions.has(i.operationId) && this.instructions.get(i.operationId) !== serialized) throw new Error('operation binding conflict');
    this.calls.push(i.operationId);
    let evidence = this.effects.get(i.operationId);
    if (!evidence) {
      const state = this.outcomes.get(i.operationId) ?? (kind === 'create' ? 'pending_customer_action' : 'succeeded');
      evidence = PaymentEvidenceSchema.parse({
        eventId: `synthetic:${i.operationId}:1`, operationId: i.operationId, connectionId: i.binding.connectionId,
        kind, providerRef: `synthetic:${i.operationId}`, originalProviderRef: i.originalProviderRef,
        connectedAccountRef: i.binding.connectedAccountRef, amountMinor: i.binding.amountMinor, currency: i.binding.currency,
        state, customerActionDeadline: state === 'pending_customer_action' ? '2026-11-01T00:00:00.000Z' : null, evidenceMode: 'synthetic',
      });
      this.instructions.set(i.operationId, serialized);
      this.effects.set(i.operationId, evidence);
    }
    if (this.lostAcknowledgements.delete(i.operationId)) throw new Error('synthetic acknowledgement lost');
    return structuredClone(evidence);
  }
  complete(operationId: string, state: 'succeeded' | 'failed', eventId: string): PaymentEvidence {
    const previous = this.effects.get(operationId);
    if (!previous) throw new Error('unknown operation');
    const evidence = PaymentEvidenceSchema.parse({ ...previous, eventId, state, customerActionDeadline: null });
    this.effects.set(operationId, evidence);
    return structuredClone(evidence);
  }
  sign(evidence: PaymentEvidence): { raw: Uint8Array; signature: string } {
    const raw = Buffer.from(JSON.stringify(evidence));
    return { raw, signature: createHmac('sha256', this.signingKey).update(raw).digest('hex') };
  }
  verifyWebhook(raw: Uint8Array, signature: string): PaymentEvidence {
    if (raw.byteLength > 8192 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('invalid payment evidence');
    const expected = createHmac('sha256', this.signingKey).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('invalid payment evidence');
    const evidence = PaymentEvidenceSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
    if (evidence.evidenceMode !== 'synthetic') throw new Error('synthetic evidence cannot prove real funds');
    return evidence;
  }
}
