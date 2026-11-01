import { createHash } from 'node:crypto';
import type { ModelCall, ModelCallMetadata, PinnedCandidate, ResolvedModelRoute } from '../../packages/contracts/src/models.js';
import { MODEL_KILL_SCOPES } from '../../packages/contracts/src/models.js';
import type { ModelAuthorityPort, ModelCallStore, ReservedModelCall, RouteResolutionPort } from '../../apps/api/src/modules/models/ports.js';
import { ModelRefusal } from '../../apps/api/src/modules/models/ports.js';

export const candidate: PinnedCandidate = { connectionId: 'connection-synthetic', modelId: 'synthetic-model', modelRevision: 'rev-2026-10-31', mode: 'fake' };
export const route: ResolvedModelRoute = {
  routeId: 'route-synthetic', routeVersion: 1, stage: 'current', candidates: [candidate],
  limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxFileBytes: null, timeoutMs: 100 },
};
export const request: ModelCall = {
  operationId: 'operation-synthetic', principalId: 'person-synthetic', runId: 'run-synthetic', mandateId: 'mandate-synthetic', mandateRevision: 1,
  hubId: 'hub-synthetic', job: 'agent_drafting', moduleKey: 'research', capabilityId: 'research.draft', extensionId: null, pipelineId: null,
  dataClasses: ['person_private'], allowedConnections: [candidate.connectionId], residencyCountries: ['US'], requireZeroRetention: true,
  estimatedCost: { minorUnits: '10', currency: 'USD' }, maxInputTokens: 20, maxOutputTokens: 10, prompt: 'PRIVATE_PROMPT_CANARY',
};
export class SyntheticAuthority implements ModelAuthorityPort {
  checks = 0;
  answer = {
    principalId: request.principalId, mandateId: request.mandateId, mandateRevision: request.mandateRevision, runId: request.runId,
    sourceAllowsModelUse: true, processingCountry: 'US', storageCountry: null as string | null, zeroRetention: true, restricted: false,
    killed: Object.fromEntries(MODEL_KILL_SCOPES.map((s) => [s, false])) as Awaited<ReturnType<ModelAuthorityPort['check']>>['killed'],
  };
  async check(): Promise<typeof this.answer> { this.checks++; return structuredClone(this.answer); }
}
export class SyntheticRoutes implements RouteResolutionPort {
  current = structuredClone(route);
  checks: PinnedCandidate[] = [];
  deny: string | null = null;
  async resolve(): Promise<ResolvedModelRoute> { return structuredClone(this.current); }
  async recheck(_call: ModelCall, _route: ResolvedModelRoute, model: PinnedCandidate): Promise<void> {
    this.checks.push({ ...model });
    if (model.connectionId === this.deny) throw new ModelRefusal('egress_denied');
  }
}

/** TEST DOUBLE ONLY. No durability, PostgreSQL, billing or cross-process guarantee is claimed. */
export class MemoryStore implements ModelCallStore {
  begins = 0;
  beforeReturn: (() => void) | null = null;
  failFinish = false;
  rows = new Map<string, { digest: string; call: ReservedModelCall; metadata: ModelCallMetadata | null }>();
  async begin(call: ModelCall, resolved: ResolvedModelRoute, model: PinnedCandidate) {
    this.begins++;
    const digest = createHash('sha256').update(JSON.stringify(call)).digest('hex');
    const previous = this.rows.get(call.operationId);
    if (previous) {
      if (previous.digest !== digest) throw new ModelRefusal('idempotency_conflict');
      return { kind: 'replay' as const, outcome: previous.metadata?.outcome ?? 'outcome_unknown', metadata: previous.metadata };
    }
    const { prompt: _prompt, ...metadataRequest } = call;
    void _prompt;
    const operation: ReservedModelCall = { operationId: call.operationId, reservationId: `reservation-${call.operationId}`, dispatchToken: call.operationId, request: metadataRequest, route: resolved, candidate: model };
    this.rows.set(call.operationId, { digest, call: operation, metadata: null });
    this.beforeReturn?.();
    return { kind: 'dispatch' as const, call: operation };
  }
  async fallback(operation: ReservedModelCall, model: PinnedCandidate) {
    const next = { ...operation, candidate: model };
    this.rows.get(operation.operationId)!.call = next;
    return next;
  }
  async admit(): Promise<boolean> { return true; }
  async finish(operation: ReservedModelCall, metadata: ModelCallMetadata) {
    if (this.failFinish) throw new Error('PRIVATE_STORAGE_ERROR_CANARY');
    this.rows.get(operation.operationId)!.metadata = metadata;
  }
  async settled(operationId: string, principalId: string) {
    const row = this.rows.get(operationId);
    return row?.call.request.principalId === principalId && row.metadata?.outcome !== 'outcome_unknown' ? row?.metadata ?? null : null;
  }
  async unknown(operationId: string, principalId: string) {
    const row = this.rows.get(operationId);
    return row?.call.request.principalId === principalId && (!row.metadata || row.metadata.outcome === 'outcome_unknown') ? row.call : null;
  }
}
