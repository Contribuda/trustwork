import { AgentModelGovernance } from '../agent-modules/model-governance.js';
import type { ModelCall, ModelRuntimeBinding } from '../../../../../packages/contracts/src/models.js';
import type { DataPool } from '../../../../../packages/data/src/pool.js';
import type { ModelInput } from '../assistant/ports.js';
import { GatewayAssistantModel } from './assistant-model.js';
import { ModelGateway, reconcileModelOperation } from './gateway.js';
import { KeysRouteResolver } from './keys-route-resolver.js';
import { FakeModelRegistry, ModelRefusal } from './ports.js';
import { PostgresModelCallStore, PostgresModelReceiptStore } from './postgres-store.js';
import { RuntimeModelAuthority, UnavailableModelGovernance, type ModelGovernancePort } from './runtime-authority.js';

type Execution = NonNullable<ModelInput['execution']>;
/** Structured runtime selection by the owning policy, not by a prompt or model tool call. */
export interface ModelExecutionPolicyPort extends ModelGovernancePort {
  select(execution: Execution): Promise<{
    call: Omit<ModelCall, 'prompt' | 'operationId' | 'principalId' | 'runId' | 'hubId'>;
    action: ModelRuntimeBinding['action'];
    context: ModelRuntimeBinding['context'];
  }>;
}
export class UnavailableModelExecutionPolicy extends UnavailableModelGovernance implements ModelExecutionPolicyPort {
  async select(): ReturnType<ModelExecutionPolicyPort['select']> {
    throw new ModelRefusal('governance_unavailable');
  }
}

/** Composes the existing AST model option with real BILL/AST/KEYS persistence. No network adapter or permissive policy. */
export function createRuntimeAssistantModel(
  pool: DataPool,
  adapters = new FakeModelRegistry(),
  policy: ModelExecutionPolicyPort = new UnavailableModelExecutionPolicy(),
): GatewayAssistantModel {
  return new GatewayAssistantModel({
    async recover(execution) {
      const store = new PostgresModelReceiptStore(pool, execution.principal, {
        sessionId: execution.sessionId, authzEpoch: execution.principal.authzEpoch,
      });
      return reconcileModelOperation(store, adapters, execution.operationId, execution.principal.personId);
    },
    async resolve(execution) {
      if (!execution.hubId) throw new ModelRefusal('hub_required');
      const selected = await policy.select(execution);
      const call = {
        ...selected.call,
        operationId: execution.operationId,
        principalId: execution.principal.personId,
        runId: execution.runId,
        hubId: execution.hubId,
      };
      const binding: ModelRuntimeBinding = {
        sessionId: execution.sessionId,
        authzEpoch: execution.principal.authzEpoch,
        action: selected.action,
        context: selected.context,
      };
      return {
        call,
        gateway: new ModelGateway(
          new KeysRouteResolver(pool),
          new RuntimeModelAuthority(pool, execution.principal, binding, new AgentModelGovernance(pool, execution.principal, policy)),
          new PostgresModelCallStore(pool, execution.principal, binding),
          adapters,
        ),
      };
    },
  });
}
