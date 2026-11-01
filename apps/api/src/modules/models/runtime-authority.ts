import { ModelRuntimeBindingSchema, type ModelCall, type ModelRuntimeBinding, type PinnedCandidate } from '../../../../../packages/contracts/src/models.js';
import { withPrincipal, type DataPool, type Principal } from '../../../../../packages/data/src/pool.js';
import { modelCalls } from '../../../../../packages/data/src/repositories/models.js';
import { ModelRefusal, type ModelAuthorityPort } from './ports.js';

/** The remaining AGT-003 / source-policy integration boundary. Must resolve all scopes and policy intersections. */
export interface ModelGovernancePort {
  check(call: ModelCall, candidate: PinnedCandidate, binding: ModelRuntimeBinding, purpose?: 'invoke' | 'reconcile'): ReturnType<ModelAuthorityPort['check']>;
  withAuthority?<T>(call: ModelCall, candidate: PinnedCandidate, binding: ModelRuntimeBinding, invoke: (facts: Awaited<ReturnType<ModelAuthorityPort['check']>>) => Promise<T>): Promise<T>;
}
export class UnavailableModelGovernance implements ModelGovernancePort {
  async check(): ReturnType<ModelAuthorityPort['check']> {
    throw new ModelRefusal('governance_unavailable');
  }
}

/** Real authenticated session, run, current mandate, context access and budget ownership; governance is mandatory. */
export class RuntimeModelAuthority implements ModelAuthorityPort {
  private readonly binding: ModelRuntimeBinding;
  constructor(
    private readonly pool: DataPool,
    private readonly principal: Principal,
    binding: ModelRuntimeBinding,
    private readonly governance: ModelGovernancePort = new UnavailableModelGovernance(),
  ) {
    this.binding = ModelRuntimeBindingSchema.parse(binding);
  }
  async check(call: ModelCall, candidate: PinnedCandidate, purpose: 'invoke' | 'reconcile' = 'invoke') {
    if (call.principalId !== this.principal.personId || this.binding.authzEpoch !== this.principal.authzEpoch) throw new ModelRefusal('authority_mismatch');
    await withPrincipal(this.pool, this.principal, (trx) =>
      purpose === 'reconcile' ? modelCalls.checkReceiptAuthority(trx, call.operationId, this.binding) : modelCalls.checkAuthority(trx, call, this.binding),
    );
    // No default false switches, guessed source permissions or host facts when the owning policy is absent.
    return this.governance.check(call, candidate, this.binding, purpose);
  }
  withAuthority<T>(call: ModelCall, candidate: PinnedCandidate, invoke: (facts: Awaited<ReturnType<ModelAuthorityPort['check']>>) => Promise<T>): Promise<T> {
    if (!this.governance.withAuthority || !call.sourceBindings?.length) throw new ModelRefusal('governance_unavailable');
    if (call.principalId !== this.principal.personId || this.binding.authzEpoch !== this.principal.authzEpoch) throw new ModelRefusal('authority_mismatch');
    return this.governance.withAuthority(call,candidate,this.binding,invoke);
  }
}
