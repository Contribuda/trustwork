import { sql } from 'kysely';
import { withPrincipal, type DataPool, type Principal } from '../../deps/data.js';
import type { ModelCall, ModelRuntimeBinding, PinnedCandidate } from '../../../../../packages/contracts/src/models.js';
import { ModelRefusal } from '../models/ports.js';
import type { ModelAuthorityPort } from '../models/ports.js';
import { UnavailableModelGovernance, type ModelGovernancePort } from '../models/runtime-authority.js';

/** AGT supplies only exact run/capability authority. Model/role/source/retention/residency remain a mandatory owning port. */
export class AgentModelGovernance implements ModelGovernancePort {
  constructor(private readonly pool: DataPool, private readonly principal: Principal, private readonly owning: ModelGovernancePort = new UnavailableModelGovernance()) {}
  withAuthority<T>(call: ModelCall, candidate: PinnedCandidate, binding: ModelRuntimeBinding, invoke: (facts: Awaited<ReturnType<ModelAuthorityPort['check']>>) => Promise<T>): Promise<T> {
    if (!this.owning.withAuthority || !call.sourceBindings?.length) throw new ModelRefusal('governance_unavailable');
    // The original-operation store holds AGT/identity authority inside this source-policy callback.
    return this.owning.withAuthority(call,candidate,binding,invoke);
  }
  async check(call: ModelCall, candidate: PinnedCandidate, binding: ModelRuntimeBinding, purpose: 'invoke' | 'reconcile' = 'invoke') {
    // Original-operation recovery uses PostgresModelReceiptStore and never asks for fresh execution permission.
    if (purpose !== 'invoke') throw new ModelRefusal('receipt_path_required');
    const { prompt: _prompt, ...metadata } = call;
    void _prompt;
    await withPrincipal(this.pool, this.principal, trx => sql`SELECT trustwork.agent_modules_check_model_scope(
      ${JSON.stringify(metadata)}::jsonb,${JSON.stringify(binding)}::jsonb)`.execute(trx));
    return this.owning.check(call, candidate, binding, purpose);
  }
}
