import type { Transaction } from '../../../deps/data.js';
import { DEFAULT_PLAN_KEY } from '../../agent-modules/contracts.js';
import type { EntitlementPort } from '../../agent-modules/ports.js';
import { agentEntitlements } from './deps.js';

/**
 * The entitlement port of AGT-003, answered from the principal's active subscription. A plan decides which modules and
 * capabilities are available; protection limits, ranking, matching, recommendations and reputation never ask this port.
 * A check without a proven hub is the free floor.
 */
export class AgentPlanEntitlements implements EntitlementPort {
  async planKey(trx: Transaction, actor: { personId: string; companyId: string | null }, hubId?: string | null): Promise<string> {
    if (!hubId) return DEFAULT_PLAN_KEY;
    return (await agentEntitlements.planKey(trx, hubId, actor.companyId)) ?? DEFAULT_PLAN_KEY;
  }
  async moduleAllowed(trx: Transaction, actor: { personId: string; companyId: string | null }, moduleKey: string, hubId: string): Promise<boolean> {
    return agentEntitlements.moduleAllowed(trx, hubId, actor.companyId, moduleKey);
  }
}
