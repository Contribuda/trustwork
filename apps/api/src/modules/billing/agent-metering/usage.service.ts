import type { z } from 'zod';
import type { Transaction } from '../../../deps/data.js';
import type { ErrorCode, Principal } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import { hubsRefusal } from '../../hubs/errors.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import {
  AgentUsageViewSchema, agentEntitlements, agentPlans, agentStatistics, billingAccounts, catalogue, mapBillingError, meteredSteps, priceAcceptances,
  type AcceptMeteredPriceSchema, type ActivateVersionSchema, type AgentUsageView, type CommandContext, type DraftAgentPlanSchema, type MeteredEstimateQuerySchema,
  type PartyRef, type ReconcileMeteredStepSchema,
} from './deps.js';

const REFUSALS: Readonly<Record<string, ErrorCode>> = {
  'billing.invalid_terms': 'validation.schema',
  'billing.backdated': 'validation.schema',
  'billing.version_overlap': 'validation.schema',
  'billing.invalid_transition': 'validation.revision_conflict',
  'billing.unavailable': 'validation.revision_conflict',
  'billing.activator_is_drafter': 'access.second_approver_required',
};
function refusal(error: unknown): never {
  const mapped = hubsRefusal(error);
  if (mapped) throw mapped;
  const hint = (error as { hint?: string }).hint;
  const code = hint ? REFUSALS[hint] : undefined;
  if (code) throw new ApiError(code, 'billing command refused', { reason: hint });
  throw mapBillingError(error);
}
const ACCEPTABLE_OFFERS: readonly string[] = ['agent_metered', 'credit_pack', 'plan', 'model', 'capability'];
const iso = (d: Date | string) => new Date(d).toISOString();

/** Staff commands for plans, statistics, signals and step reconciliation, for the server-configured hub. */
export class AgentPlansService {
  constructor(private readonly principals: PrincipalService, readonly hubId: string | null) {}
  private hub(): string {
    if (!this.hubId) throw new ApiError('access.not_found', 'access.not_found');
    return this.hubId;
  }
  private context(state: RequestState, elevationId: string, reason: string): CommandContext {
    return { elevationId, requestId: state.requestId, reasonCode: 'agent_plan_governance', reasonText: reason };
  }
  draftPlan(state: RequestState, elevationId: string, body: z.infer<typeof DraftAgentPlanSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => agentPlans.draft(trx, this.context(state, elevationId, body.reason), hub, body.terms)).catch(refusal);
  }
  activatePlan(state: RequestState, elevationId: string, id: string, body: z.infer<typeof ActivateVersionSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => agentPlans.activate(trx, this.context(state, elevationId, body.reason), hub, id, body.digest, body.approvalId)).catch(refusal);
  }
  statistics(state: RequestState, elevationId: string, period: string) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => agentStatistics.usage(trx, this.context(state, elevationId, 'Read agent usage statistics'), hub, period)).catch(refusal);
  }
  abuseSignals(state: RequestState, elevationId: string) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => agentStatistics.abuseList(trx, this.context(state, elevationId, 'Read agent abuse signals'), hub)).catch(refusal);
  }
  openAbuseCase(state: RequestState, elevationId: string, id: string, reason: string) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => agentStatistics.openCase(trx, this.context(state, elevationId, reason), hub, id)).catch(refusal);
  }
  reconcile(state: RequestState, elevationId: string, id: string, body: z.infer<typeof ReconcileMeteredStepSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => meteredSteps.reconcile(trx, this.context(state, elevationId, body.reason), hub, id, body.result, body.units, body.evidence)).catch(refusal);
  }
}

/** The participant's own usage, estimates and acceptances. Nothing here reads or returns another party's rows. */
export class AgentUsageService {
  constructor(private readonly principals: PrincipalService, readonly hubId: string | null) {}
  private hub(): string {
    if (!this.hubId) throw new ApiError('access.not_found', 'access.not_found');
    return this.hubId;
  }
  /** The person, or their active employer when they ask for it. A company they do not act for is not found. */
  private owner(p: Principal, forCompany: boolean): PartyRef {
    if (!forCompany) return { kind: 'person', id: p.personId };
    if (!p.membership) throw new ApiError('access.not_found', 'access.not_found');
    return { kind: 'company', id: p.membership.companyId };
  }
  view(state: RequestState, forCompany: boolean): Promise<AgentUsageView> {
    const hub = this.hub();
    return this.principals.runAs(state, async (trx: Transaction, p: Principal) => {
      const owner = this.owner(p, forCompany);
      const column = owner.kind === 'person' ? 'principal_person_id' : 'principal_company_id';
      const now = new Date();
      const windows = await trx.selectFrom('agent_quota_window').selectAll().where('hub_id', '=', hub).where(column, '=', owner.id).where('window_end', '>', now).orderBy('module_key').orderBy('meter').orderBy('window_kind').execute();
      const notices = await trx.selectFrom('agent_quota_notice as n').innerJoin('agent_quota_window as w', 'w.id', 'n.window_id')
        .select(['w.module_key', 'w.meter', 'w.window_kind', 'n.threshold', 'n.created_at']).where('w.hub_id', '=', hub).where(`w.${column}`, '=', owner.id).where('w.window_end', '>', now).orderBy('n.created_at').execute();
      const steps = await trx.selectFrom('metered_step').selectAll().where('hub_id', '=', hub).where(column, '=', owner.id).orderBy('created_at', 'desc').orderBy('id').limit(50).execute();
      return AgentUsageViewSchema.parse({
        planKey: (await agentEntitlements.planKey(trx, hub, owner.kind === 'company' ? owner.id : null)) ?? 'free',
        windows: windows.map((w) => ({ moduleKey: w.module_key, meter: w.meter, window: w.window_kind, windowStart: iso(w.window_start), windowEnd: iso(w.window_end), limitUnits: w.limit_units, usedUnits: w.used_units, heldUnits: w.held_units })),
        notices: notices.map((n) => ({ moduleKey: n.module_key, meter: n.meter, window: n.window_kind, threshold: n.threshold, at: iso(n.created_at) })),
        steps: steps.map((s) => ({ id: s.id, runId: s.run_id, moduleKey: s.module_key, capabilityId: s.capability_id, meter: s.meter, state: s.state, units: s.actual_units, chargedMinor: s.charged_minor, currency: s.currency, at: iso(s.created_at) })),
      });
    }).catch(refusal);
  }
  estimate(state: RequestState, query: z.infer<typeof MeteredEstimateQuerySchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx: Transaction, p: Principal) => meteredSteps.estimate(trx, {
      hubId: hub, principal: this.owner(p, query.forCompany === 'true'), moduleKey: query.moduleKey, capabilityId: query.capabilityId ?? null, meter: query.meter, estimatedUnits: query.units, budgetId: query.budgetId ?? null, projectId: query.projectId ?? null,
    })).catch(refusal);
  }
  /** A person accepts one exact version on the first-party session. The database refuses any other amount or text. */
  accept(state: RequestState, priceVersionId: string, body: z.infer<typeof AcceptMeteredPriceSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, async (trx: Transaction, p: Principal) => {
      const owner = this.owner(p, body.forCompany);
      const price = await catalogue.priceVersion(trx, priceVersionId);
      const offer = price ? await catalogue.offer(trx, price.offer_id) : undefined;
      if (!price || !offer || offer.hub_id !== hub || !ACCEPTABLE_OFFERS.includes(offer.kind)) throw new ApiError('access.not_found', 'access.not_found');
      const account = await billingAccounts.findActive(trx, owner, hub, body.currency) ?? await billingAccounts.open(trx, { hubId: hub, owner, currency: body.currency, createdBy: p.personId });
      const row = await priceAcceptances.accept(trx, { priceVersionId, billingAccountId: account.id, payer: owner, acceptedBy: p.personId, amountMinor: body.amountMinor, currency: body.currency, acceptanceTextVersion: body.acceptanceTextVersion });
      return { id: row.id, priceVersionId: row.price_version_id, acceptedAt: iso(row.accepted_at) };
    }).catch(refusal);
  }
}
