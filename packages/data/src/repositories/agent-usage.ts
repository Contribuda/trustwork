import '../schema/agent-metering.js';
import { sql } from 'kysely';
import type { DataPool, Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import type { PartyRef } from './billing.js';
import {
  AgentPlanVersionViewSchema, CreditPackVersionViewSchema, MeteredEstimateSchema, MeteredStepDecisionSchema, PublicCreditPackRowSchema,
  type AgentPlanTerms, type AgentPlanVersionView, type CreditPackTerms, type CreditPackVersionView, type MeteredEstimate, type MeteredStepDecision, type MeteredStepInput, type PublicCreditPackRow,
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
  async estimate(trx: Transaction, input: { hubId: string; principal: PartyRef; moduleKey: string; capabilityId: string | null; meter: string; estimatedUnits: number; budgetId: string | null }): Promise<MeteredEstimate> {
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
export async function actionQuotaStop(trx: Transaction, hubId: string, companyId: string | null, moduleKey: string, capabilityId: string, mandateId: string): Promise<string | null> {
  const { rows } = await sql<{ stop: string | null }>`SELECT trustwork.billing_meter_action_stop(${hubId}::uuid, ${companyId}::uuid, ${moduleKey}, ${capabilityId}, ${mandateId}::uuid) AS stop`.execute(trx);
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

export const creditPacks = {
  async draft(trx: Transaction, ctx: CommandContext, hubId: string, terms: CreditPackTerms): Promise<CreditPackVersionView> {
    return CreditPackVersionViewSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_pack_draft(${json(ctx)}::jsonb, ${hubId}::uuid, ${json(terms)}::jsonb) AS value`));
  },
  async activate(trx: Transaction, ctx: CommandContext, hubId: string, id: string, digest: string, approvalId: string): Promise<CreditPackVersionView> {
    return CreditPackVersionViewSchema.parse(await value(trx, sql<{ value: unknown }>`SELECT trustwork.billing_pack_activate(${json(ctx)}::jsonb, ${hubId}::uuid, ${id}::uuid, ${digest}, ${approvalId}::uuid) AS value`));
  },
  async publicList(pool: DataPool, hubId: string, at: Date): Promise<PublicCreditPackRow[]> {
    const r = await pool.query<{ value: unknown }>('SELECT trustwork.billing_pack_public($1::uuid, $2::timestamptz) AS value', [hubId, at.toISOString()]);
    return PublicCreditPackRowSchema.array().parse(r.rows[0]?.value);
  },
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
