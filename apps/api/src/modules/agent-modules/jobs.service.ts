import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  DEFAULT_APPROVAL_BY_ACTION, mandateChangeAllowed, MandateV2Schema, type ApprovalPolicy, type JobTrigger, type MandateActionV2, type MandateContext, type Principal,
} from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import { completionRecordId } from '../../common/idempotency/completion.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { mapDatabaseError } from '../procurement/common.js';
import { refusalError, requireCapability, type AgentActor, type CapabilityAuthority } from './authority.js';
import {
  jobTriggerViolations, moduleCapabilities, moduleRefusal, nextScheduleOccurrence, REFUSAL_MESSAGE_KEYS,
  type ApprovalMode, type JobRequestView, type JobTemplate, type TurnOnJobCommand,
} from './contracts.js';
import { agentJobs, mandateDigest, mandateProposals, type AgentJobRequestRow, type AgentJobScheduleRow } from './deps.js';
import { agentModulesRefusal } from './policy.service.js';
import { jobImplementation } from './templates.js';
import { servingHub } from './serving-hub.js';

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
const APPROVAL_RANK: Record<ApprovalMode, number> = { ask_each: 0, ask_first: 1, ask_above: 2, pre_authorized: 3 };
const MAX_JOB_VALIDITY_MS = 366 * 86_400_000;
export type ActingFor = 'self' | 'employer';

export function jobRequestView(row: AgentJobRequestRow, schedule: AgentJobScheduleRow | null): JobRequestView {
  return {
    id: row.id, moduleKey: row.module_key, templateKey: row.template_key, trigger: row.trigger as JobTrigger, status: row.status, reason: row.reason,
    mandateProposalId: row.proposal_id, jobSubscriptionId: row.job_subscription_id, nextDueAt: iso(schedule?.next_due_at ?? null), createdAt: iso(row.created_at) as string,
  };
}

/**
 * The strictest approval among the hub's default and the engine default of every verb the job asks for (AGT-002
 * `DEFAULT_APPROVAL_BY_ACTION`): a template never pre-authorizes more than either allows. `ask_above` needs a threshold the
 * template does not have, so it becomes `ask_each`.
 */
export function jobApprovalPolicy(hubDefault: ApprovalMode, actions: readonly MandateActionV2[]): ApprovalPolicy {
  const candidates: ApprovalPolicy[] = [hubDefault === 'ask_first' ? { mode: 'ask_first', count: 3 } : hubDefault === 'ask_above' ? { mode: 'ask_each' } : { mode: hubDefault }, ...actions.map((a) => DEFAULT_APPROVAL_BY_ACTION[a])];
  let strictest = candidates[0] as ApprovalPolicy;
  for (const c of candidates) {
    const mode = c.mode === 'ask_above' ? 'ask_each' : c.mode;
    if (APPROVAL_RANK[mode] < APPROVAL_RANK[strictest.mode]) strictest = mode === 'ask_each' ? { mode: 'ask_each' } : c;
    else if (mode === 'ask_first' && strictest.mode === 'ask_first' && c.mode === 'ask_first') strictest = { mode: 'ask_first', count: Math.max(c.count, strictest.count) };
  }
  return strictest;
}

/**
 * The participant's side of the agent product (AGT-003): which capabilities their one agent has in this hub, the hub's
 * defaults and maximums for their agent settings, the jobs modules offer, and turning a job on. Turning a job on creates
 * only an inert mandate proposal (origin `module_template`) and a pending job request; the job subscription exists after
 * the person confirms the proposal on the first-party form (`/v1/assistant/mandate-proposals/:id/confirm`, step-up).
 */
export class AgentJobsService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly authority: CapabilityAuthority) {}

  private run<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      const refusal = agentModulesRefusal(error);
      if (refusal) throw refusal;
      return mapDatabaseError(error);
    });
  }
  private actor(p: Principal, actingFor: ActingFor): AgentActor {
    if (actingFor === 'employer' && !p.membership) throw new ApiError('access.not_found', 'no active employer', { reason: 'no_employer' });
    return { personId: p.personId, onBehalfCompanyId: actingFor === 'employer' ? (p.membership as NonNullable<Principal['membership']>).companyId : null, representativeOf: null, connectionId: null };
  }

  /** Interface surface: every governed capability with its availability; an unavailable one carries its explanation key. */
  capabilities(state: RequestState, actingFor: ActingFor) {
    return this.run(state, async (trx, p) => ({ capabilities: await this.authority.availability(trx, this.actor(p, actingFor)) }));
  }

  /** Interface surface for one capability: available, or the same refusal the agent runtime and MCP give. */
  capability(state: RequestState, capabilityId: string, actingFor: ActingFor) {
    return this.run(state, async (trx, p) => {
      await requireCapability(this.authority, trx, this.actor(p, actingFor), capabilityId);
      return { capabilityId, available: true };
    });
  }

  /** Hub defaults and maximums for the participant's agent settings (AGT-022 lets the person tighten, never widen). */
  bounds(state: RequestState) {
    return this.run(state, async (trx) => {
      const { document, versionId } = await this.authority.policy(trx);
      return { versionId, participantSettings: document.participantSettings, protectionLimits: document.policy.protectionLimits, calendar: { timeZone: document.calendar.timeZone } };
    });
  }

  /** The job templates enabled modules offer here, with whether this person may turn each on. */
  templates(state: RequestState, actingFor: ActingFor) {
    return this.run(state, async (trx, p) => {
      const actor = this.actor(p, actingFor);
      const registry = await this.authority.registry();
      const { document } = await this.authority.policy(trx, registry);
      const out = [];
      for (const t of document.jobTemplates) {
        const refusal = await this.templateRefusal(trx, actor, t);
        const implemented = jobImplementation(t.moduleKey, t.templateKey) !== null;
        out.push({ ...t, available: refusal === null && implemented, reason: refusal ? REFUSAL_MESSAGE_KEYS[refusal.reason] : implemented ? null : REFUSAL_MESSAGE_KEYS['module.not_serving'] });
      }
      return { templates: out, minIntervalMinutes: document.participantSettings.scheduleMinIntervalMinutes, calendar: document.calendar };
    });
  }

  /** Why this person cannot turn the template on: the module, or a verb with no available capability. */
  private async templateRefusal(trx: Transaction, actor: AgentActor, t: JobTemplate, authority = this.authority) {
    const registry = await authority.registry();
    const { document } = await authority.policy(trx, registry);
    const principal = await authority.principalOf(trx, actor);
    const module = moduleRefusal(document, registry, t.moduleKey, principal);
    if (module === 'module.unregistered') return { reason: 'module.not_enabled' as const, messageKey: REFUSAL_MESSAGE_KEYS['module.not_enabled'], capabilityId: `${t.moduleKey}.job`, moduleKey: t.moduleKey, allowed: false as const, blockedBy: null };
    if (module !== null) return { reason: module, messageKey: REFUSAL_MESSAGE_KEYS[module], capabilityId: `${t.moduleKey}.job`, moduleKey: t.moduleKey, allowed: false as const, blockedBy: null };
    const enabled = document.policy.enabledModules.find((m) => m.moduleKey === t.moduleKey);
    const capabilities = enabled ? moduleCapabilities(registry, t.moduleKey, enabled.moduleVersion, document.policy.activeExtensionVersionIds) : [];
    for (const action of t.actions) {
      const backing = capabilities.filter((c) => c.mandateAction === action);
      let first = null;
      let ok = false;
      for (const c of backing) {
        const d = await authority.check(trx, actor, c.id, action);
        if (d.allowed) {
          ok = true;
          break;
        }
        first ??= d;
      }
      if (!ok) return first ?? { reason: 'capability.off_for_hub' as const, messageKey: REFUSAL_MESSAGE_KEYS['capability.off_for_hub'], capabilityId: `${t.moduleKey}.${action}`, moduleKey: t.moduleKey, allowed: false as const, blockedBy: null };
    }
    return null;
  }

  /**
   * Turns a job on: validates the template, the trigger and the person's eligibility, then inserts only an inert mandate
   * proposal and a pending job request. Nothing can fire until the person confirms the proposal on the first-party form.
   */
  turnOn(state: RequestState, body: TurnOnJobCommand) {
    return this.run(state, async (trx, p) => {
      const binding = await servingHub(trx, this.ctx.config.publicOrigin);
      const authority = this.authority.forHub(binding.hubId);
      const operationId = completionRecordId(state);
      if (!operationId || !state.session) throw new ApiError('access.forbidden', 'a committed first-party operation is required', { reason: 'operation_identity_missing' });
      const actor = this.actor(p, body.actingFor);
      const now = this.ctx.clock.now();
      const registry = await authority.registry();
      const { document } = await authority.policy(trx, registry);
      const template = document.jobTemplates.find((t) => t.moduleKey === body.moduleKey && t.templateKey === body.templateKey);
      if (!template) throw new ApiError('access.not_found', 'the hub offers no such job', { reason: 'template_not_offered' });
      const refusal = await this.templateRefusal(trx, actor, template, authority);
      if (refusal) throw refusalError(refusal);
      const trigger: JobTrigger = body.trigger ?? template.defaultTrigger;
      const problems = jobTriggerViolations(template, trigger, document.participantSettings.scheduleMinIntervalMinutes);
      if (problems.length) throw new ApiError('validation.schema', 'the trigger does not fit the job', { reason: 'trigger_invalid', items: problems });
      const validUntil = new Date(body.validUntil);
      if (validUntil.getTime() <= now.getTime() || validUntil.getTime() - now.getTime() > MAX_JOB_VALIDITY_MS) throw new ApiError('validation.schema', 'a job mandate lasts at most a year', { reason: 'validity_invalid' });
      const goalId = trigger.kind === 'goal' ? trigger.goalId : null;
      const goalContextIds = [...new Set([...(body.goalContextIds ?? []), ...(goalId ? [goalId] : [])])];
      for (const contextGoalId of goalContextIds) {
        const goal = await trx.selectFrom('goal').select(['id', 'status', 'on_behalf_company_id']).where('id', '=', contextGoalId).where('principal_person_id', '=', p.personId).executeTakeFirst();
        if (!goal || !['active', 'paused'].includes(goal.status) || goal.on_behalf_company_id !== actor.onBehalfCompanyId) throw new ApiError('access.not_found', 'goal not found', { reason: 'goal_not_active' });
      }
      const contexts: MandateContext[] = [actor.onBehalfCompanyId ? { kind: 'company', id: actor.onBehalfCompanyId } : { kind: 'profile', id: p.personId }, ...goalContextIds.map((id) => ({ kind: 'goal' as const, id }))];
      const proposed = MandateV2Schema.parse({
        id: randomUUID(), schemaVersion: 2, principal: { personId: p.personId, onBehalfOf: actor.onBehalfCompanyId ? { kind: 'company', id: actor.onBehalfCompanyId } : null }, grantee: { kind: 'own_agent' },
        moduleKeys: [template.moduleKey], actions: template.actions, contexts,
        limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null }, conditions: [],
        approvalPolicy: jobApprovalPolicy(document.participantSettings.approval.defaultMode, template.actions), approvers: [], escalation: { kind: 'ask_principal' },
        confirmation: null, validUntil: validUntil.toISOString(), status: 'draft', revision: 1, revokedAt: null,
      });
      // The pure gate agrees: a module template only ever proposes.
      if (mandateChangeAllowed({ kind: 'module' }, null, proposed) !== 'mandate.proposal_only') throw new Error('unreachable: module templates only propose');
      const proposal = await mandateProposals.insert(trx, {
        principal_person_id: p.personId, mandate_id: null, basis_revision: null, origin_kind: 'module_template',
        origin: { kind: 'module_template', moduleKey: template.moduleKey, templateKey: template.templateKey }, proposed, digest: mandateDigest(proposed),
      });
      const firstDue = trigger.kind === 'schedule' ? nextScheduleOccurrence(trigger, now, now, document.calendar, template.onClosedDay) : null;
      const request = await agentJobs.insertRequest(trx, {
        principal_person_id: p.personId, on_behalf_company_id: actor.onBehalfCompanyId, hub_id: binding.hubId, module_key: template.moduleKey, template_key: template.templateKey,
        trigger, goal_id: goalId, on_closed_day: template.onClosedDay, proposal_id: proposal.id, first_due_at: firstDue,
      });
      await sql`SELECT trustwork.agent_modules_bind_request(${request.id}::uuid, ${binding.id}::uuid, ${state.session.id}::uuid, ${operationId}::uuid)`.execute(trx);
      await auditEvents.append(trx, {
        actor_person_id: p.personId, on_behalf_of_company_id: actor.onBehalfCompanyId, action: 'agents.job_proposed', object_kind: 'agent_job_request', object_id: request.id,
        request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { moduleKey: template.moduleKey, templateKey: template.templateKey, proposalId: proposal.id, trigger: trigger.kind },
      });
      return {
        request: jobRequestView(request, null),
        /** The one structured confirmation the person sees on the first-party form. */
        confirmation: { proposalId: proposal.id, digest: { algorithm: 'trustwork-digest-1' as const, value: proposal.digest }, mandate: proposed },
      };
    });
  }

  list(state: RequestState) {
    return this.run(state, async (trx, p) => {
      const schedules = new Map((await agentJobs.schedules(trx, p.personId)).map((s) => [s.job_request_id, s]));
      return { jobs: (await agentJobs.requests(trx, p.personId)).map((r) => jobRequestView(r, schedules.get(r.id) ?? null)) };
    });
  }

  /** "Run it now": the same rechecks as a scheduled firing (active subscription and mandate, offered template, no switch). */
  runNow(state: RequestState, requestId: string) {
    return this.run(state, async (trx) => {
      const request = await agentJobs.request(trx, requestId);
      if (!request || request.job_subscription_id === null) throw new ApiError('access.not_found', 'access.not_found', { reason: request ? 'job_not_active' : 'not_found' });
      if (!jobImplementation(request.module_key, request.template_key)) throw new ApiError('access.forbidden', 'template implementation unavailable', { reason: 'template_unavailable', messageKey: REFUSAL_MESSAGE_KEYS['module.not_serving'] });
      const binding = await servingHub(trx, this.ctx.config.publicOrigin);
      const operationId = completionRecordId(state);
      if (!operationId) throw new ApiError('access.forbidden', 'operation identity is required', { reason: 'operation_identity_missing' });
      const result = await sql<{ id: string }>`SELECT trustwork.agent_modules_request_occurrence(
        ${request.job_subscription_id}::uuid, ${binding.id}::uuid, ${operationId}::uuid) AS id`.execute(trx);
      return { outcome: 'queued', occurrenceId: result.rows[0]?.id };
    });
  }
}
