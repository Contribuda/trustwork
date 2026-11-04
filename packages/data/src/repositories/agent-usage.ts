import '../schema/agent-metering.js';
import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import type { PartyRef } from './billing.js';
import {
  AbuseSignalListSchema, AgentPlanVersionViewSchema, AgentUsageStatsSchema, MeteredEstimateSchema, MeteredStepDecisionSchema,
  type AbuseSignalList, type AgentPlanTerms, type AgentUsageStats, type AgentPlanVersionView, type MeteredEstimate, type MeteredStepDecision, type MeteredStepInput,
} from '../../../contracts/src/agent-metering.js';

async function value(trx: Transaction, query: ReturnType<typeof sql<{ value: unknown }>>): Promise<unknown> {
  return (await query.execute(trx)).rows[0]?.value;
}
const json = (input: unknown) => JSON.stringify(input);

/**
 * The metered step. Model calls and action intents meter themselves inside their owning transactions; these calls are
 * for owning modules that meter a step of their own run (`checks`, `document_pages`, `deliverables` and the like).
 */
export const meteredSteps = {
  async admit(trx: Transaction, input: MeteredStepInput): Promise<MeteredStepDecision> {
    return MeteredStepDecisionSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_meter_admit(${json(input)}::jsonb) AS value`));
  },
  async finish(trx: Transaction, stepId: string, result: 'succeeded' | 'failed' | 'unknown', units: number | null, evidence: string): Promise<MeteredStepDecision> {
    return MeteredStepDecisionSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_meter_finish(${stepId}::uuid, ${result}, ${units}::bigint, ${evidence}) AS value`));
  },
  async estimate(trx: Transaction, input: { hubId: string; principal: PartyRef; moduleKey: string; capabilityId: string | null; meter: string; estimatedUnits: number; budgetId: string | null; projectId?: string | null }): Promise<MeteredEstimate> {
    return MeteredEstimateSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_meter_estimate(${json(input)}::jsonb) AS value`));
  },
  async reconcile(trx: Transaction, ctx: CommandContext, hubId: string, stepId: string, result: 'succeeded' | 'failed', units: number | null, evidence: string): Promise<MeteredStepDecision> {
    return MeteredStepDecisionSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_meter_reconcile(${json(ctx)}::jsonb, ${hubId}::uuid, ${stepId}::uuid, ${result}, ${units}::bigint, ${evidence}) AS value`));
  },
  /** Worker: a step that lost its lease becomes unknown and keeps its holds. */
  async sweep(trx: Transaction, olderThanSeconds: number, limit: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.billing_meter_sweep(make_interval(secs => ${olderThanSeconds}), ${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};

/** Why an action would stop at its quota now, or null. The queue rechecks this under the window lock. */
export async function actionQuotaStop(trx: Transaction, hubId: string, moduleKey: string, capabilityId: string, mandateId: string, projectId: string | null): Promise<string | null> {
  const { rows } = await sql<{ stop: string | null }>`SELECT trustwork.billing_meter_action_stop(${hubId}::uuid, ${moduleKey}, ${capabilityId}, ${mandateId}::uuid, ${projectId}::uuid) AS stop`.execute(trx);
  return rows[0]?.stop ?? null;
}

export const agentEntitlements = {
  /** The plan key of the caller, or of their active employer when acting for it; null means the free floor. */
  async planKey(trx: Transaction, hubId: string, companyId: string | null): Promise<string | null> {
    const { rows } = await sql<{ key: string | null }>`SELECT trustwork.billing_agent_plan_key(${hubId}::uuid, ${companyId}::uuid) AS key`.execute(trx);
    return rows[0]?.key ?? null;
  },
  /** False only when the hub sells this module, it has no free quota and the caller's plan does not include it. */
  async moduleAllowed(trx: Transaction, hubId: string, companyId: string | null, moduleKey: string): Promise<boolean> {
    const { rows } = await sql<{ allowed: boolean }>`SELECT trustwork.billing_agent_module_allowed(${hubId}::uuid, ${companyId}::uuid, ${moduleKey}) AS allowed`.execute(trx);
    return rows[0]?.allowed === true;
  },
};

export const agentPlans = {
  async draft(trx: Transaction, ctx: CommandContext, hubId: string, terms: AgentPlanTerms): Promise<AgentPlanVersionView> {
    return AgentPlanVersionViewSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_plan_draft(${json(ctx)}::jsonb, ${hubId}::uuid, ${json(terms)}::jsonb) AS value`));
  },
  async activate(trx: Transaction, ctx: CommandContext, hubId: string, id: string, digest: string, approvalId: string): Promise<AgentPlanVersionView> {
    return AgentPlanVersionViewSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_plan_activate(${json(ctx)}::jsonb, ${hubId}::uuid, ${id}::uuid, ${digest}, ${approvalId}::uuid) AS value`));
  },
};

/** Prepaid lots funded from BILL-003's credit-pack versions. */
export const creditPacks = {
  /** Owner-run, from payment evidence of an accepted pack (BILL-002): no runtime role can create credit. */
  async fund(trx: Transaction, acceptanceId: string, evidenceRef: string): Promise<{ id: string; remaining_minor: string; valid_until: Date | null }> {
    const { rows } = await sql<{ id: string; remaining_minor: string; valid_until: Date | null }>`SELECT id, remaining_minor, valid_until FROM trustwork.billing_credit_fund(${acceptanceId}::uuid, ${evidenceRef})`.execute(trx);
    return rows[0]!;
  },
  /** Worker: announces lots entering their reminder period. */
  async noticeSweep(trx: Transaction, limit: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.billing_credit_notice_sweep(${limit}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};

/** Aggregates and counts for staff. Each command checks authority; nothing here takes a person, company or date range. */
export const agentStatistics = {
  async usage(trx: Transaction, ctx: CommandContext, hubId: string, period: string): Promise<AgentUsageStats> {
    return AgentUsageStatsSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_agent_usage_stats(${json(ctx)}::jsonb, ${hubId}::uuid, ${period}) AS value`));
  },
  async abuseList(trx: Transaction, ctx: CommandContext, hubId: string): Promise<AbuseSignalList> {
    return AbuseSignalListSchema.parse({ signals: await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_abuse_list(${json(ctx)}::jsonb, ${hubId}::uuid) AS value`) });
  },
  async openCase(trx: Transaction, ctx: CommandContext, hubId: string, signalId: string): Promise<{ id: string; moderationCaseId: string }> {
    return await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_abuse_open_case(${json(ctx)}::jsonb, ${hubId}::uuid, ${signalId}::uuid) AS value`) as { id: string; moderationCaseId: string };
  },
  /** Worker: raises a signal for principals at the threshold of unknown outcomes past the deadline this week. */
  async abuseSweep(trx: Transaction, threshold: number, deadlineSeconds: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.billing_abuse_sweep(${threshold}::integer, make_interval(secs => ${deadlineSeconds})) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};
