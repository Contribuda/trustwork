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
  check(call: ModelCall, candidate: PinnedCandidate): Promise<{
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
  reservationId: string;
  request: Omit<ModelCall, 'prompt'>;
  route: ResolvedModelRoute;
  candidate: PinnedCandidate;
}
export type ModelReplay = { kind: 'replay'; outcome: ModelCallMetadata['outcome']; metadata: ModelCallMetadata | null };
/**
 * MUST be durable and atomic across processes. Begin binds the exact command digest, principal, mandate revision,
 * run, route and provider revision. It reserves platform AND operator budgets before returning dispatch ownership.
 * A duplicate never dispatches. An abandoned dispatcher is reconciled, not reclaimed. Unknown holds never expire.
 * Finish settles/releases both reservations and records only allowlisted metadata in the same transaction.
 * No production implementation exists yet: BILL-001 cannot currently hold an unknown reservation without expiry.
 */
export interface ModelCallStore {
  begin(call: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate): Promise<{ kind: 'dispatch'; call: ReservedModelCall } | ModelReplay>;
  /** Only after authoritative evidence of no effect; atomically move operator holds to the fallback connection. */
  fallback(operation: ReservedModelCall, candidate: PinnedCandidate): Promise<ReservedModelCall>;
  finish(operation: ReservedModelCall, metadata: ModelCallMetadata): Promise<void>;
  /** Reconciliation may only return an already dispatched operation belonging to this principal. */
  unknown(operationId: string, principalId: string): Promise<ReservedModelCall | null>;
}

export type ModelAdapterResult =
  | { kind: 'succeeded'; text: string; costMinorUnits: string; inputTokens: number; outputTokens: number }
  | { kind: 'not_sent'; reason: 'unreachable' | 'rate_limited' }
  | { kind: 'unknown' };
export interface ModelAdapter {
  readonly mode: 'fake';
  invoke(input: { operationId: string; model: PinnedCandidate; prompt: string; maxInputTokens: number; maxOutputTokens: number; signal: AbortSignal }): Promise<ModelAdapterResult>;
  /** Lookup only. Never implements reconciliation by calling invoke again. */
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
