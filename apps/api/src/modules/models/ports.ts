import type { ModelCall, ModelCallMetadata, ModelKillScope, PinnedCandidate, ResolvedModelRoute } from '../../../../../packages/contracts/src/models.js';

export class ModelRefusal extends Error {
  constructor(readonly reason: string) {
    super('Model call refused');
    this.name = 'ModelRefusal';
  }
}

export interface RouteResolutionPort {
  resolve(call: ModelCall): Promise<ResolvedModelRoute>;
  /** Recheck the current route and current policy for THIS exact candidate, immediately before dispatch. */
  recheck(call: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate): Promise<void>;
}

/** Supplied by trusted application services, never by a request body or model output. */
export interface ModelAuthorityPort {
  check(call: ModelCall, candidate: PinnedCandidate, purpose?: 'invoke' | 'reconcile'): Promise<{
    principalId: string;
    mandateId: string;
    mandateRevision: number;
    runId: string;
    sourceAllowsModelUse: boolean;
    /** Exact connection facts after intersecting hub, model, mandate and source policies. */
    processingCountry: string;
    storageCountry: string | null;
    zeroRetention: boolean;
    restricted: boolean;
    killed: Record<ModelKillScope, boolean | 'unknown'>;
  }>;
}

export interface ReservedModelCall {
  operationId: string;
  reservationId: string | null;
  dispatchToken: string;
  request: Omit<ModelCall, 'prompt'>;
  route: ResolvedModelRoute;
  candidate: PinnedCandidate;
}
export type ModelReplay = { kind: 'replay'; outcome: ModelCallMetadata['outcome']; metadata: ModelCallMetadata | null };
export type ModelRecovery = { kind: 'undispatched' } | { kind: 'settled'; metadata: ModelCallMetadata } | { kind: 'unknown'; call: ReservedModelCall };
/** Receipt-only authority: authenticates ownership and fences undispatched work, never authorizes new effects. */
export interface ModelReceiptStore {
  recover(operationId: string, principalId: string): Promise<ModelRecovery>;
  finish(operation: ReservedModelCall, metadata: ModelCallMetadata): Promise<void>;
}
/**
 * MUST be durable and atomic across processes. Begin binds the exact command digest, principal, mandate revision,
 * run, route and provider revision. It reserves platform AND operator budgets before returning dispatch ownership.
 * A duplicate never dispatches. An abandoned dispatcher is reconciled, not reclaimed. Unknown holds never expire.
 * Finish settles/releases both reservations and records only allowlisted metadata in the same transaction.
 * The PostgreSQL implementation accepts fake connections only, as KEYS assigns them zero operator cost.
 */
export interface ModelCallStore extends ModelReceiptStore {
  begin(call: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate): Promise<{ kind: 'dispatch'; call: ReservedModelCall } | ModelReplay>;
  /** Only after authoritative evidence of no effect; atomically move operator holds to the fallback connection. */
  fallback(operation: ReservedModelCall, candidate: PinnedCandidate): Promise<ReservedModelCall>;
  /** Durable one-use fence. False means another execution or reconciliation owns this intent. */
  admit(operation: ReservedModelCall): Promise<boolean>;
  /** Hold current AGT/owning invocation authority through the callback after durable one-use admission. */
  withDispatchAuthority<T>(operation: ReservedModelCall, invoke: () => Promise<T>): Promise<T>;
  finish(operation: ReservedModelCall, metadata: ModelCallMetadata): Promise<void>;
  /** Reconciliation may only return an already dispatched operation belonging to this principal. */
  settled(operationId: string, principalId: string): Promise<ModelCallMetadata | null>;
  unknown(operationId: string, principalId: string): Promise<ReservedModelCall | null>;
}

export type ModelAdapterResult =
  | { kind: 'succeeded'; text: string; costMinorUnits: string; inputTokens: number; outputTokens: number }
  | { kind: 'not_sent'; reason: 'unreachable' | 'rate_limited' }
  | { kind: 'unknown' };
export interface ModelAdapter {
  readonly mode: 'fake';
  invoke(input: { operationId: string; model: PinnedCandidate; prompt: string; maxInputTokens: number; maxOutputTokens: number; signal: AbortSignal }): Promise<ModelAdapterResult>;
  /** Lookup only, never invoke. not_sent must be authoritative and fence any delayed invocation of this operation. Absence is unknown. */
  reconcile(operationId: string, model: PinnedCandidate): Promise<ModelAdapterResult>;
}

/** Live, manual and unregistered adapters fail closed. No network or secret implementation ships. */
export class FakeModelRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();
  register(connectionId: string, adapter: ModelAdapter): void {
    if (adapter.mode !== 'fake') throw new ModelRefusal('live_adapter_disabled');
    this.adapters.set(connectionId, adapter);
  }
  get(candidate: PinnedCandidate): ModelAdapter {
    if (candidate.mode !== 'fake') throw new ModelRefusal('live_adapter_disabled');
    const adapter = this.adapters.get(candidate.connectionId);
    if (!adapter) throw new ModelRefusal('adapter_unavailable');
    return adapter;
  }
}
