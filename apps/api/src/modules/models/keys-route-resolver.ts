import type { DataPool } from '../../../../../packages/data/src/pool.js';
import { providerCalls } from '../../../../../packages/data/src/repositories/providers.js';
import { ProviderCallDecisionSchema, type ProviderCallRequest } from '../../../../../packages/contracts/src/providers.js';
import { ResolvedModelRouteSchema, type ModelCall, type PinnedCandidate, type ResolvedModelRoute } from '../../../../../packages/contracts/src/models.js';
import { ModelRefusal, type RouteResolutionPort } from './ports.js';

export const sameCandidate = (a: PinnedCandidate, b: PinnedCandidate): boolean =>
  a.connectionId === b.connectionId && a.modelId === b.modelId && a.modelRevision === b.modelRevision && a.mode === b.mode;

/** Current KEYS-001 route resolution and egress. Dry runs reserve nothing; ModelCallStore owns atomic reservation. */
export class KeysRouteResolver implements RouteResolutionPort {
  constructor(private readonly pool: DataPool) {}
  private async current(call: ModelCall) {
    const request: ProviderCallRequest = {
      hubId: call.hubId, job: call.job, moduleKey: call.moduleKey, extensionId: call.extensionId, pipelineId: call.pipelineId,
      dataClasses: call.dataClasses, estimatedCost: call.estimatedCost, requestRef: call.operationId,
    };
    const decision = ProviderCallDecisionSchema.parse(await providerCalls.authorize(this.pool, request, true));
    if (!decision.allowed) throw new ModelRefusal(decision.reason);
    return decision;
  }
  async resolve(call: ModelCall): Promise<ResolvedModelRoute> {
    const decision = await this.current(call);
    return ResolvedModelRouteSchema.parse({
      routeId: decision.routeId, routeVersion: decision.routeVersion, stage: 'current', candidates: decision.candidates, limits: decision.limits,
    });
  }
  async recheck(call: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate): Promise<void> {
    const current = await this.current(call);
    if (route.routeId !== current.routeId || route.routeVersion !== current.routeVersion) throw new ModelRefusal('route_changed');
    if (!current.candidates.some((c) => sameCandidate(c, candidate))) throw new ModelRefusal('candidate_denied');
    if (JSON.stringify(current.limits) !== JSON.stringify(route.limits)) throw new ModelRefusal('route_changed');
    // A MODEL-001 resolver may implement canaries; this resolver never invents an enabled catalogue or rollout.
    if (route.stage !== 'current') throw new ModelRefusal('rollout_unavailable');
  }
}
