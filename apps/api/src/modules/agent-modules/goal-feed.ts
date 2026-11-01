import { JobTriggerSchema } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { goals, goalProgress, jobSubscriptions } from '../../../../../packages/data/src/repositories/agents.js';
import { mandates } from '../assistant/deps.js';
import { mandateOf } from '../assistant/policy.js';
import { triggerMatchesEvent } from './contracts.js';
import type { DeadlineProjection } from './occurrences.js';
import { agentPolicies } from './deps.js';
import { AgentPolicyDocumentSchema } from './contracts.js';

/**
 * Principal-side source discovery, under the caller's real RLS transaction. Worker execution must use its separately
 * leased occurrence port, never call this with an invented session or an arbitrary runAs identity.
 * Nothing returned here is authority: admission and dispatch reload the source and every current gate.
 */
export class GoalOccurrenceFeed {
  async deadlines(trx: Transaction, subscriptionId: string): Promise<DeadlineProjection[]> {
    const loaded = await this.load(trx, subscriptionId);
    if (!loaded || loaded.trigger.kind !== 'deadline' || loaded.trigger.contextKind !== 'goal') return [];
    const request = await trx.selectFrom('agent_job_request').select('hub_id').where('job_subscription_id', '=', subscriptionId).where('status', '=', 'active').executeTakeFirst();
    const policy = request?.hub_id ? await agentPolicies.current(trx, request.hub_id) : undefined;
    if (!policy) return [];
    const { calendar } = AgentPolicyDocumentSchema.parse(policy.document);
    const result: DeadlineProjection[] = [];
    for (const context of loaded.mandate.contexts) {
      if (context.kind !== 'goal' || !('id' in context)) continue;
      const goal = await goals.get(trx, context.id);
      if (!goal || goal.principal_person_id !== loaded.subscription.principal_person_id || goal.on_behalf_company_id !== loaded.subscription.on_behalf_company_id
        || goal.status !== 'active' || !goal.confirmed_at) continue;
      result.push({ contextKind: 'goal', contextId: goal.id, deadlineKey: 'horizon', revision: goal.revision, deadline: goal.horizon, timeZone: calendar.timeZone, calendarVersionId: policy.config_version_id });
    }
    return result;
  }

  async progress(trx: Transaction, subscriptionId: string, progressId: string): Promise<{ progressId: string; goalId: string; revision: number } | null> {
    const loaded = await this.load(trx, subscriptionId);
    if (!loaded) return null;
    // Read the stored source under the same owner RLS used by GoalsService.getGoal, never event payload text.
    const progress = await goalProgress.get(trx, progressId);
    if (!progress || progress.event_kind !== 'evidence') return null;
    const goal = await goals.get(trx, progress.goal_id);
    if (!goal || goal.principal_person_id !== loaded.subscription.principal_person_id || goal.on_behalf_company_id !== loaded.subscription.on_behalf_company_id
      || goal.status !== 'active' || !goal.confirmed_at || goal.horizon <= new Date()
      || !loaded.mandate.contexts.some((c) => c.kind === 'goal' && 'id' in c && c.id === goal.id)
      || !triggerMatchesEvent(loaded.trigger, { type: 'agents.goal_progress', goalId: goal.id })) return null;
    // Only newly recorded evidence can prompt work. Report output must not recursively trigger itself.
    if (progress.at < loaded.subscription.created_at) return null;
    return { progressId: progress.id, goalId: goal.id, revision: goal.revision };
  }

  private async load(trx: Transaction, subscriptionId: string) {
    const subscription = await jobSubscriptions.get(trx, subscriptionId);
    if (!subscription || subscription.status !== 'active' || !subscription.mandate_id) return null;
    const row = await mandates.get(trx, subscription.mandate_id);
    const mandate = row ? mandateOf(row) : null;
    if (!mandate || mandate.status !== 'active' || new Date(mandate.validUntil) <= new Date() || !mandate.confirmation
      || mandate.principal.personId !== subscription.principal_person_id || mandate.grantee.kind !== 'own_agent'
      || (mandate.principal.onBehalfOf?.kind === 'company' ? mandate.principal.onBehalfOf.id : null) !== subscription.on_behalf_company_id
      || !mandate.moduleKeys.includes(subscription.module_key)) return null;
    const trigger = JobTriggerSchema.safeParse(subscription.trigger);
    return trigger.success ? { subscription, mandate, trigger: trigger.data } : null;
  }
}
