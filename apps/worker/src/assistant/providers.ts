/**
 * Effect provider ports of the agent runtime (AST-001): orders, payments and outbound channel messages. Only fakes
 * exist; live adapters arrive with their own packages (PAY-001, CHAN-001, the order integrations) behind the same port.
 *
 * Contract every adapter states (docs/data/lifecycles.md): the provider deduplicates by the stable effect correlation
 * key (`submit` with a key it has seen returns the earlier result and never repeats the effect), and `lookup` by that
 * key is authoritative: `not_found` proves that no effect happened. An adapter that cannot guarantee both must answer
 * `unknown` from lookup, which leaves the action for a person to reconcile.
 */
export interface EffectRequest {
  /** Stable across attempts and reconciliation: the provider idempotency key. */
  correlationKey: string;
  /** Unique per attempt. */
  operationId: string;
  attemptNo: number;
  operation: string;
  /** Structured, first-party payload without private constraints (checked by the API before the intent existed). */
  payload: unknown;
  amount: { minorUnits: string; currency: string } | null;
}
export type EffectResponse =
  | { kind: 'final'; result: 'succeeded' | 'failed'; providerReference: string | null; evidence: string }
  | { kind: 'acknowledged'; providerReference: string };
export type LookupResult =
  | { status: 'not_found' }
  | { status: 'pending'; providerReference: string }
  | { status: 'final'; result: 'succeeded' | 'failed'; providerReference: string | null; evidence: string }
  | { status: 'unknown' };

/** A definitive refusal before any effect (validation, authorization at the provider): the action fails, no retry. */
export class ProviderRejectedError extends Error {
  constructor(readonly evidence: string) {
    super(`provider rejected the request before any effect: ${evidence}`);
    this.name = 'ProviderRejectedError';
  }
}

export interface EffectProvider {
  readonly name: string;
  /** Throws `ProviderRejectedError` for a definitive pre-effect refusal; any other throw or a timeout is an unknown outcome. */
  submit(request: EffectRequest, signal: AbortSignal): Promise<EffectResponse>;
  lookup(correlationKey: string): Promise<LookupResult>;
}

/**
 * What the fake does on the next `submit`:
 * - `succeed` / `fail`: final outcome; `reject`: ProviderRejectedError (no effect);
 * - `acknowledge`: accepted, final outcome later (`complete`, which also yields a receipt);
 * - `timeout_after_effect`: the effect happens, then the call throws as if the connection dropped;
 * - `timeout_before_effect`: the call throws and nothing happens;
 * - `hang_after_effect`: the effect happens and the call never returns (a crashed or frozen worker).
 */
export type FakeBehaviour = 'succeed' | 'fail' | 'reject' | 'acknowledge' | 'timeout_after_effect' | 'timeout_before_effect' | 'hang_after_effect';

interface FakeRecord { status: 'pending' | 'succeeded' | 'failed'; providerReference: string; operation: string; payload: unknown; amount: EffectRequest['amount'] }
export interface FakeReceipt { provider: string; account: string; eventId: string; correlationKey: string; kind: 'acknowledged' | 'final'; result: 'succeeded' | 'failed' | null; providerReference: string; evidence: string }

/** Stateful fake: deduplicates by correlation key, answers lookups from its ledger, and counts every effect it performed. */
export class FakeEffectProvider implements EffectProvider {
  readonly records = new Map<string, FakeRecord>();
  readonly submissions: EffectRequest[] = [];
  /** Effects actually performed (a deduplicated repeat does not add one). */
  effects = 0;
  private readonly script: FakeBehaviour[] = [];
  private counter = 0;
  private receiptCounter = 0;
  constructor(readonly name: string, private readonly fallback: FakeBehaviour = 'succeed') {}

  /** Queues behaviours for the next submits (first in, first out). */
  next(...behaviours: FakeBehaviour[]): this {
    this.script.push(...behaviours);
    return this;
  }

  async submit(request: EffectRequest, signal: AbortSignal): Promise<EffectResponse> {
    this.submissions.push(request);
    const existing = this.records.get(request.correlationKey);
    if (existing) return this.responseOf(existing);
    const behaviour = this.script.shift() ?? this.fallback;
    if (behaviour === 'reject') throw new ProviderRejectedError('fake provider refused the request');
    if (behaviour === 'timeout_before_effect') throw new Error('fake provider timed out before the request arrived');
    const record: FakeRecord = { status: behaviour === 'fail' ? 'failed' : behaviour === 'succeed' ? 'succeeded' : 'pending', providerReference: `${this.name}-${++this.counter}`, operation: request.operation, payload: request.payload, amount: request.amount };
    if (behaviour === 'timeout_after_effect' || behaviour === 'hang_after_effect') record.status = 'succeeded';
    this.records.set(request.correlationKey, record);
    this.effects += 1;
    if (behaviour === 'timeout_after_effect') throw new Error('fake provider connection dropped after the effect');
    if (behaviour === 'hang_after_effect') {
      await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')), { once: true }));
    }
    return this.responseOf(record);
  }

  async lookup(correlationKey: string): Promise<LookupResult> {
    const record = this.records.get(correlationKey);
    if (!record) return { status: 'not_found' };
    if (record.status === 'pending') return { status: 'pending', providerReference: record.providerReference };
    return { status: 'final', result: record.status, providerReference: record.providerReference, evidence: `${this.name} lookup: ${record.status}` };
  }

  /** Completes an acknowledged operation later (accepted then confirmed or rejected) and returns the provider's receipt. */
  complete(correlationKey: string, result: 'succeeded' | 'failed'): FakeReceipt {
    const record = this.records.get(correlationKey);
    if (!record) throw new Error(`no operation for ${correlationKey}`);
    record.status = result;
    return { provider: this.name, account: 'fake', eventId: `${this.name}-receipt-${++this.receiptCounter}`, correlationKey, kind: 'final', result, providerReference: record.providerReference, evidence: `${this.name} receipt: ${result}` };
  }

  private responseOf(record: FakeRecord): EffectResponse {
    if (record.status === 'pending') return { kind: 'acknowledged', providerReference: record.providerReference };
    return { kind: 'final', result: record.status, providerReference: record.providerReference, evidence: `${this.name}: ${record.status}` };
  }
}

/** The three fake providers the runtime knows by default: orders, payments and outbound channel messages. */
export function fakeEffectProviders(): { orders: FakeEffectProvider; payments: FakeEffectProvider; channel: FakeEffectProvider; all: EffectProvider[] } {
  const orders = new FakeEffectProvider('fake_orders');
  const payments = new FakeEffectProvider('fake_payments');
  const channel = new FakeEffectProvider('fake_channel');
  return { orders, payments, channel, all: [orders, payments, channel] };
}
