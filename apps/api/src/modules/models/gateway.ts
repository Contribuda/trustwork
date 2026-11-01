import { z } from 'zod';
import {
  ModelCallMetadataSchema, ModelCallSchema, MODEL_KILL_SCOPES, ResolvedModelRouteSchema,
  type ModelCall, type ModelCallMetadata, type PinnedCandidate, type ResolvedModelRoute,
} from '../../../../../packages/contracts/src/models.js';
import { sameCandidate } from './keys-route-resolver.js';
import { FakeModelRegistry, ModelRefusal, type ModelAdapterResult, type ModelAuthorityPort, type ModelCallStore, type ModelReceiptStore, type ReservedModelCall, type RouteResolutionPort } from './ports.js';

// Adapter output is untrusted at runtime even when an implementation is written in TypeScript.
const AdapterResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('succeeded'), text: z.string().max(1_000_000), costMinorUnits: z.string().regex(/^(0|[1-9][0-9]{0,17})$/), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal('not_sent'), reason: z.enum(['unreachable', 'rate_limited']) }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
const receipt = (value: unknown): ModelAdapterResult => {
  const parsed = AdapterResultSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: 'unknown' };
};

export interface GatewayResult {
  operationId: string;
  outcome: ModelCallMetadata['outcome'];
  /** Returned only to the calling principal, never passed to the metadata sink. Replays contain no stored body. */
  text: string | null;
  metadata: ModelCallMetadata | null;
}

/** Internal gateway. Production wiring remains disabled until every mandatory governance scope has an authority. */
export class ModelGateway {
  constructor(
    private readonly routes: RouteResolutionPort,
    private readonly authority: ModelAuthorityPort,
    private readonly store: ModelCallStore,
    private readonly adapters: FakeModelRegistry,
    private readonly log: (metadata: ModelCallMetadata) => void = () => {},
  ) {}

  private async check(call: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate, purpose: 'invoke' | 'reconcile' = 'invoke'): Promise<void> {
    if (!route.candidates.some((c) => sameCandidate(c, candidate))) throw new ModelRefusal('candidate_not_pinned');
    if (!call.allowedConnections.includes(candidate.connectionId)) throw new ModelRefusal('connection_not_allowed');
    if (call.maxInputTokens > route.limits.maxInputTokens || call.maxOutputTokens > route.limits.maxOutputTokens) throw new ModelRefusal('token_limit');
    if (['embeddings', 'rerank'].includes(call.job) && (route.stage === 'canary' || route.candidates.length !== 1)) throw new ModelRefusal('vectors_must_not_mix');
    const authority = await this.authority.check(call, candidate, purpose);
    if (authority.principalId !== call.principalId || authority.mandateId !== call.mandateId || authority.mandateRevision !== call.mandateRevision || authority.runId !== call.runId) {
      throw new ModelRefusal('authority_mismatch');
    }
    if (!authority.sourceAllowsModelUse) throw new ModelRefusal('source_forbids_model_use');
    if (authority.restricted) throw new ModelRefusal('restricted_place');
    if (!call.residencyCountries.includes(authority.processingCountry) || (authority.storageCountry !== null && !call.residencyCountries.includes(authority.storageCountry))) throw new ModelRefusal('residency');
    if (call.requireZeroRetention && !authority.zeroRetention) throw new ModelRefusal('retention');
    for (const scope of MODEL_KILL_SCOPES) {
      if (authority.killed[scope] !== false) throw new ModelRefusal(`${scope}_killed_or_unknown`);
    }
    this.adapters.get(candidate);
    // Last await before invocation: resolves CURRENT egress for this exact fallback/canary, never reuses a permit.
    await this.routes.recheck(call, route, candidate);
  }

  async call(input: ModelCall): Promise<GatewayResult> {
    // Parse a fresh copy: a caller cannot mutate a pin, scope or estimate while an async check is in progress.
    const call = ModelCallSchema.parse(input);
    const route = ResolvedModelRouteSchema.parse(await this.routes.resolve(call));
    const first = route.candidates[0]!;
    await this.check(call, route, first);
    const begun = await this.store.begin(call, route, first);
    if (begun.kind === 'replay') return { operationId: call.operationId, outcome: begun.outcome, metadata: begun.metadata, text: null };
    let operation = begun.call;
    for (let index = 0; index < route.candidates.length; index++) {
      const candidate = route.candidates[index]!;
      const started = performance.now();
      try {
        await this.check(call, route, candidate);
        if (index > 0) {
          try { operation = await this.store.fallback(operation, candidate); }
          catch {
            // A failed acknowledgement may hide a committed reservation transfer. Do not release either hold.
            return { operationId: operation.operationId, outcome: 'outcome_unknown', text: null, metadata: null };
          }
        }
        // The reservation call may wait behind another process. Recheck ALL current policy after it returns.
        await this.check(call, route, candidate);
      } catch {
        return finish(this.store, this.log, operation, metadata(operation, 'refused', performance.now() - started), null);
      }
      // Commit the one-use dispatch fence before the effect. An ambiguous admission never authorizes sending.
      try {
        if (!await this.store.admit(operation)) return { operationId: operation.operationId, outcome: 'outcome_unknown', text: null, metadata: null };
      } catch {
        return { operationId: operation.operationId, outcome: 'outcome_unknown', text: null, metadata: null };
      }
      try { await this.check(call, route, candidate); }
      catch { return finish(this.store, this.log, operation, metadata(operation, 'refused', performance.now() - started), null); }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ModelAdapterResult;
      try {
        result = await this.store.withDispatchAuthority(operation, async () => receipt(await Promise.race([
          this.adapters.get(candidate).invoke({ operationId: operation.operationId, model: { ...candidate }, prompt: call.prompt,
            maxInputTokens: call.maxInputTokens, maxOutputTokens: call.maxOutputTokens, signal: controller.signal }),
          new Promise<ModelAdapterResult>((resolve) => {
            timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown' }); }, route.limits.timeoutMs);
          }),
        ])));
      } catch {
        result = { kind: 'unknown' };
      } finally {
        if (timer) clearTimeout(timer);
      }
      const elapsed = performance.now() - started;
      if (result.kind === 'not_sent') {
        if (index + 1 < route.candidates.length) continue;
        return finish(this.store, this.log, operation, metadata(operation, 'failed', elapsed), null);
      }
      if (result.kind === 'succeeded' && validSuccess(result, call)) {
        return finish(this.store, this.log, operation, metadata(operation, 'succeeded', elapsed, result), result.text);
      }
      // Timeouts, malformed receipts, over-budget receipts and exceptions never activate a fallback.
      return finish(this.store, this.log, operation, metadata(operation, 'outcome_unknown', elapsed), null);
    }
    throw new Error('Unreachable model route');
  }

  reconcile(operationId: string, principalId: string): Promise<GatewayResult> {
    return reconcileModelOperation(this.store, this.adapters, operationId, principalId, this.log);
  }
}

function metadata(operation: ReservedModelCall, outcome: ModelCallMetadata['outcome'], latencyMs: number, result?: Extract<ModelAdapterResult, { kind: 'succeeded' }>): ModelCallMetadata {
  return ModelCallMetadataSchema.parse({
    operationId: operation.operationId, routeId: operation.route.routeId, routeVersion: operation.route.routeVersion,
    model: operation.candidate, stage: operation.route.stage, fallbackUsed: !sameCandidate(operation.candidate, operation.route.candidates[0]!),
    latencyMs: Math.max(0, Math.round(latencyMs)), inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0,
    cost: { minorUnits: result?.costMinorUnits ?? (outcome === 'outcome_unknown' ? operation.request.estimatedCost.minorUnits : '0'), currency: operation.request.estimatedCost.currency }, outcome,
  });
}

function validSuccess(result: Extract<ModelAdapterResult, { kind: 'succeeded' }>, call: Omit<ModelCall, 'prompt'>): boolean {
  return typeof result.text === 'string' && result.text.length <= 1_000_000 && /^(0|[1-9][0-9]{0,17})$/.test(result.costMinorUnits)
    && BigInt(result.costMinorUnits) <= BigInt(call.estimatedCost.minorUnits)
    && Number.isSafeInteger(result.inputTokens) && result.inputTokens >= 0 && result.inputTokens <= call.maxInputTokens
    && Number.isSafeInteger(result.outputTokens) && result.outputTokens >= 0 && result.outputTokens <= call.maxOutputTokens;
}

async function finish(store: ModelReceiptStore, log: (metadata: ModelCallMetadata) => void, operation: ReservedModelCall, metadata: ModelCallMetadata, text: string | null): Promise<GatewayResult> {
  try {
    await store.finish(operation, metadata);
  } catch {
    // The durable dispatch intent still holds its reservation if settlement failed or its commit is ambiguous.
    // Never return success, release, retry, or print a database/provider error that could carry a body.
    return { operationId: operation.operationId, outcome: 'outcome_unknown', text: null, metadata: null };
  }
  try { log(ModelCallMetadataSchema.parse(metadata)); } catch { /* Logging must not repeat a committed call. */ }
  return { operationId: operation.operationId, outcome: metadata.outcome, text, metadata };
}
export async function reconcileModelOperation(store: ModelReceiptStore, adapters: FakeModelRegistry, operationId: string, principalId: string,
  log: (metadata: ModelCallMetadata) => void = () => {}): Promise<GatewayResult> {
  const recovered = await store.recover(operationId, principalId);
  if (recovered.kind === 'undispatched') return { operationId, outcome: 'refused', text: null, metadata: null };
  if (recovered.kind === 'settled') return { operationId, outcome: recovered.metadata.outcome, text: null, metadata: recovered.metadata };
  const operation = recovered.call;
  if (operation.request.principalId !== principalId) throw new ModelRefusal('authority_mismatch');
  const call = ModelCallSchema.parse({ ...operation.request, prompt: '' });
  // Lookup carries only stable operation identity and the original pin. It cannot invoke, select a new route,
  // export prompt/context, or authorize tools. Current dispatch policy is deliberately not receipt authority.
  let result: ModelAdapterResult;
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = receipt(await Promise.race([
      adapters.get(operation.candidate).reconcile(operationId, operation.candidate),
      new Promise<ModelAdapterResult>((resolve) => { timer = setTimeout(() => resolve({ kind: 'unknown' }), operation.route.limits.timeoutMs); }),
    ]));
  } catch { result = { kind: 'unknown' }; }
  finally { if (timer) clearTimeout(timer); }
  const elapsed = performance.now() - started;
  if (result.kind === 'succeeded' && validSuccess(result, call)) {
    return finish(store, log, operation, metadata(operation, 'succeeded', elapsed, result), null);
  }
  if (result.kind === 'not_sent') return finish(store, log, operation, metadata(operation, 'failed', elapsed), null);
  return finish(store, log, operation, metadata(operation, 'outcome_unknown', elapsed), null);
}
