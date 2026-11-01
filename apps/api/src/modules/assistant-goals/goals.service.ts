import { servingHub } from '../agent-modules/serving-hub.js';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { computeDigest, mandateChangeAllowed, MandateV2Schema, type MandateContext, type MandateV2 } from '../../deps/contracts.js';
import { type CreateGoalCommand, type GoalConfirmation, type GoalNeed, type ConfirmGoalCommandSchema, type CreateJobSubscriptionCommandSchema, type GoalEvidenceCommandSchema, type GoalStatusCommandSchema, type JobSubscriptionStatusCommandSchema, type ShareReportCommandSchema, type ResolveEscalationCommandSchema } from './contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  AgentsBase, digestOf, escalationView, goalView, isUuid, iso, jobSubscriptionView, progressView, reportView,
} from './common.js';
import {
  agentReports, escalations, goalProgress, goals, jobSubscriptions, mandateDigest, mandateOf, mandateProposals, mandates, runs, type GoalRow, type MandateProposalRow,
} from './deps.js';

type In<T extends z.ZodType> = z.infer<T>;
const sameContexts = (have: readonly MandateContext[], want: readonly MandateContext[]) => {
  const keys = new Set(have.map((c) => JSON.stringify(c)));
  return want.every((c) => keys.has(JSON.stringify(c)));
};

/** Whether an active own-agent mandate already authorizes a need for the whole horizon (it never has to be widened). */
export function mandateCoversNeed(m: MandateV2, need: GoalNeed, onBehalfCompany: string | null, horizon: Date): boolean {
  const company = m.principal.onBehalfOf?.kind === 'company' ? m.principal.onBehalfOf.id : null;
  return m.status === 'active' && m.grantee.kind === 'own_agent' && company === onBehalfCompany && Date.parse(m.validUntil) >= horizon.getTime()
    && m.moduleKeys.includes(need.moduleKey) && need.actions.every((a) => m.actions.includes(a)) && sameContexts(m.contexts, need.contexts);
}

/**
 * Goals of the person's one agent (AGT-001): a goal tells the agent what to achieve; creating one checks the current
 * mandates and proposes the missing changes; the person confirms the goal and all of its proposals together, with the
 * exact digest they were shown, on the first-party form. A goal never widens authority by itself. Also job
 * subscriptions, the evidence log, reports and the escalations agent-to-agent work produces for the person.
 */
export class GoalsService extends AgentsBase {
  constructor(ctx: AppContext, principals: PrincipalService) {
    super(ctx, principals);
  }

  listGoals(state: RequestState) {
    return this.run(state, async (trx, p) => ({ goals: (await goals.list(trx, p.personId)).map(goalView) }));
  }
  getGoal(id: string, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await goals.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'goal not found');
      return { ...goalView(row), progress: (await goalProgress.list(trx, id)).map(progressView) };
    });
  }

  /**
   * Creates a proposed goal. Needs already covered by an active own-agent mandate are bound by their revision; every
   * other need becomes an inert mandate proposal (origin `goal`). The response carries the one structured confirmation.
   */
  createGoal(body: CreateGoalCommand, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = body.onBehalfOf === null ? null : body.onBehalfOf.kind === 'company' ? this.employer(p, body.onBehalfOf.id) : null;
      if (body.onBehalfOf?.kind === 'person' && body.onBehalfOf.id !== p.personId) throw new ApiError('access.forbidden', 'a goal acts for its principal', { reason: 'authority_basis' });
      const horizon = new Date(body.horizon);
      if (horizon.getTime() <= this.now().getTime()) throw new ApiError('validation.schema', 'the horizon is in the future', { reason: 'horizon_passed' });
      const goalId = randomUUID();
      const own = (await mandates.list(trx, p.personId)).map(mandateOf).filter((m): m is MandateV2 => m !== null);
      const covered: GoalConfirmation['covered'] = [];
      const proposals: MandateProposalRow[] = [];
      for (const need of body.needs) {
        const existing = own.find((m) => mandateCoversNeed(m, need, company, horizon));
        if (existing) {
          covered.push({ mandateId: existing.id, revision: existing.revision, moduleKey: need.moduleKey });
          continue;
        }
        const proposed = MandateV2Schema.parse({
          id: randomUUID(), schemaVersion: 2, principal: { personId: p.personId, onBehalfOf: company ? { kind: 'company', id: company } : null }, grantee: { kind: 'own_agent' },
          moduleKeys: [need.moduleKey], actions: need.actions, contexts: need.contexts,
          limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: need.perWindow }, conditions: [],
          approvalPolicy: need.approvalPolicy, approvers: [], escalation: { kind: 'ask_principal' }, confirmation: null, validUntil: iso(horizon), status: 'draft', revision: 1, revokedAt: null,
        });
        // The pure gate agrees: a goal only ever proposes.
        if (mandateChangeAllowed({ kind: 'goal' }, null, proposed) !== 'mandate.proposal_only') throw new Error('unreachable: goals only propose');
        proposals.push(await mandateProposals.insert(trx, {
          principal_person_id: p.personId, mandate_id: null, basis_revision: null, origin_kind: 'goal', origin: { kind: 'goal', goalId }, proposed, digest: mandateDigest(proposed),
        }));
      }
      const allowedActions = [...new Set(body.needs.flatMap((n) => n.actions))].sort();
      const confirmationDigest = goalConfirmationDigest({ goalId, principal: p.personId, company, body, allowedActions, covered, proposals: proposals.map((r) => ({ id: r.id, digest: r.digest })) });
      const row = await goals.insert(trx, {
        principal_person_id: p.personId, on_behalf_company_id: company, text: body.text, success_criteria: body.successCriteria, allowed_actions: allowedActions, needs: body.needs,
        budget_range: body.budgetRange, horizon, report_cadence: body.reportCadence, proposed_by: 'principal', covered, proposal_ids: proposals.map((r) => r.id), confirmation_digest: confirmationDigest,
      }, goalId);
      await goalProgress.append(trx, { goal_id: row.id, event_kind: 'created', detail: { needs: body.needs.length, covered: covered.length }, recorded_by_person_id: p.personId });
      for (const proposal of proposals) await goalProgress.append(trx, { goal_id: row.id, event_kind: 'mandate_proposed', evidence_refs: [{ kind: 'mandate_proposal', id: proposal.id }], recorded_by_person_id: p.personId });
      await this.audit(trx, p, state, 'agents.goal_created', 'goal', row.id, { proposals: proposals.length, covered: covered.length });
      return { goal: goalView(row), confirmation: confirmationOf(row, covered, proposals) };
    });
  }
  getConfirmation(id: string, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await goals.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'goal not found');
      const proposals: MandateProposalRow[] = [];
      for (const pid of row.proposal_ids) {
        const proposal = await mandateProposals.get(trx, pid);
        if (proposal) proposals.push(proposal);
      }
      return confirmationOf(row, row.covered as GoalConfirmation['covered'], proposals);
    });
  }

  /**
   * One structured confirmation (step-up route): every mandate proposal of the goal is confirmed on the first-party
   * form exactly as proposed, then the goal is activated for the digest the person repeats. All in one transaction:
   * either everything is confirmed or nothing is.
   */
  confirmGoal(id: string, body: In<typeof ConfirmGoalCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const row = isUuid(id) ? await goals.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'goal not found');
      if (row.status !== 'proposed') throw new ApiError('validation.revision_conflict', 'the goal is no longer waiting for confirmation', { reason: 'goal_not_proposed' });
      if (body.digest.value !== row.confirmation_digest) throw new ApiError('access.approval_digest_mismatch', 'the confirmation does not match what was shown', { reason: 'digest_mismatch' });
      const stepUp = this.steppedUp(state);
      for (const proposalId of row.proposal_ids) {
        const proposal = await mandateProposals.get(trx, proposalId);
        if (!proposal || proposal.status !== 'pending') throw new ApiError('validation.revision_conflict', 'a proposal of the goal was already decided', { reason: 'proposal_not_pending' });
        const proposed = MandateV2Schema.parse(proposal.proposed);
        const confirmed = MandateV2Schema.parse({ ...proposed, status: 'active', confirmation: { via: 'first_party_form', personId: p.personId, at: iso(this.now()), stepUp } });
        const verdict = mandateChangeAllowed({ kind: 'person', personId: p.personId, via: 'first_party_form' }, null, confirmed);
        if (verdict !== 'ok') throw new ApiError('access.forbidden', verdict, { reason: verdict });
        const mandate = await mandates.confirm(trx, { snapshot: confirmed, contexts: confirmed.contexts, digest: mandateDigest(confirmed), expectedRevision: null, stepUp, proposalId });
        await goalProgress.append(trx, { goal_id: row.id, event_kind: 'mandate_confirmed', evidence_refs: [{ kind: 'mandate', id: mandate.id }], recorded_by_person_id: p.personId });
      }
      const goal = await goals.confirm(trx, row.id, body.digest.value, stepUp);
      await this.audit(trx, p, state, 'agents.goal_confirmed', 'goal', goal.id, { digest: goal.confirmation_digest, mandates: goal.mandate_ids.length, stepUp });
      return goalView(goal);
    });
  }
  setGoalStatus(id: string, body: In<typeof GoalStatusCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'goal not found');
      const goal = await goals.setStatus(trx, id, body.expectedRevision, body.status, body.outcome);
      await this.audit(trx, p, state, `agents.goal_${body.status}`, 'goal', goal.id, { outcome: body.outcome });
      return goalView(goal);
    });
  }
  /** The agent records evidence of progress (structured references and a code, never free text). */
  recordEvidence(id: string, body: In<typeof GoalEvidenceCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const goal = isUuid(id) ? await goals.get(trx, id) : undefined;
      if (!goal) throw new ApiError('access.not_found', 'goal not found');
      if (goal.status !== 'active') throw new ApiError('validation.revision_conflict', 'progress is recorded on an active goal', { reason: 'goal_not_active' });
      const row = await goalProgress.append(trx, { goal_id: id, event_kind: 'evidence', evidence_refs: body.evidenceRefs, detail: { code: body.code }, recorded_by_person_id: p.personId });
      await this.audit(trx, p, state, 'agents.goal_evidence', 'goal', id, { code: body.code, refs: body.evidenceRefs.length });
      return progressView(row);
    });
  }
  /** A deterministic report draft of the goal's progress (no model): counts per event kind with their evidence. */
  generateReport(id: string, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const goal = isUuid(id) ? await goals.get(trx, id) : undefined;
      if (!goal) throw new ApiError('access.not_found', 'goal not found');
      if (!state.session || state.session.personId !== p.personId) throw new ApiError('auth.session_invalid', 'session required');
      const binding = await servingHub(trx, this.ctx.config.publicOrigin);
      const run = await runs.start(trx, { principal_person_id: p.personId, kind: 'goal_report', goal_id: goal.id });
      await sql`SELECT trustwork.agent_modules_bind_run(${run.id}::uuid,${binding.id}::uuid,${state.session.id}::uuid)`.execute(trx);
      const sections = (await sql<{ sections: unknown[] }>`SELECT trustwork.agents_own_goal_report_sections(${goal.id}::uuid) AS sections`.execute(trx)).rows[0]!.sections;
      const now = this.now();
      const from = goal.created_at.getTime() < now.getTime() ? goal.created_at : new Date(now.getTime() - 1000);
      const report = await agentReports.insert(trx, { author_person_id: p.personId, principal_company_id: null, goal_id: goal.id, run_id: run.id, period_from: from, period_to: now, sections });
      if (goal.status !== 'closed') await goalProgress.append(trx, { goal_id: goal.id, event_kind: 'report', evidence_refs: [{ kind: 'agent_report', id: report.id }], recorded_by_person_id: p.personId });
      await runs.setState(trx, run.id, 'completed');
      await this.audit(trx, p, state, 'agents.report_generated', 'agent_report', report.id, { goalId: goal.id });
      return reportView(report, p.personId);
    });
  }
  listReports(state: RequestState) {
    return this.run(state, async (trx, p) => ({ reports: (await agentReports.list(trx)).map((r) => reportView(r, p.personId)) }));
  }
  shareReport(id: string, body: In<typeof ShareReportCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id) || !body.personIds.every(isUuid)) throw new ApiError('access.not_found', 'report not found');
      const report = await agentReports.share(trx, id, body.personIds);
      await this.audit(trx, p, state, 'agents.report_shared', 'agent_report', id, { readers: body.personIds.length });
      return reportView(report, p.personId);
    });
  }

  listJobSubscriptions(state: RequestState) {
    return this.run(state, async (trx, p) => ({ subscriptions: (await jobSubscriptions.list(trx, p.personId)).map(jobSubscriptionView) }));
  }
  createJobSubscription(body: In<typeof CreateJobSubscriptionCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const company = body.onBehalfOf?.kind === 'company' ? this.employer(p, body.onBehalfOf.id) : null;
      if ((body.mandateId !== null && !isUuid(body.mandateId)) || (body.trigger.kind === 'goal' && !isUuid(body.trigger.goalId))) throw new ApiError('access.not_found', 'mandate or goal not found');
      const row = await jobSubscriptions.insert(trx, {
        principal_person_id: p.personId, on_behalf_company_id: company, module_key: body.moduleKey, job_template_key: body.jobTemplateKey, trigger: body.trigger,
        goal_id: body.trigger.kind === 'goal' ? body.trigger.goalId : null, mandate_id: body.mandateId,
      });
      await this.audit(trx, p, state, 'agents.job_subscription_created', 'job_subscription', row.id, { moduleKey: row.module_key, trigger: body.trigger.kind });
      return jobSubscriptionView(row);
    });
  }
  setJobSubscriptionStatus(id: string, body: In<typeof JobSubscriptionStatusCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const row = isUuid(id) ? await jobSubscriptions.setStatus(trx, id, body.status, body.expectedRevision) : undefined;
      if (!row) throw new ApiError('validation.revision_conflict', 'the subscription changed meanwhile or does not exist', { reason: 'revision_conflict' });
      await this.audit(trx, p, state, 'agents.job_subscription_status', 'job_subscription', row.id, { status: row.status });
      return jobSubscriptionView(row);
    });
  }

  listEscalations(state: RequestState) {
    return this.run(state, async (trx) => ({ escalations: (await escalations.list(trx, 'open')).map(escalationView) }));
  }
  resolveEscalation(id: string, body: In<typeof ResolveEscalationCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'escalation not found');
      const row = await escalations.resolve(trx, id, body.status);
      await this.audit(trx, p, state, 'agents.escalation_resolved', 'agent_escalation', row.id, { status: row.status });
      return escalationView(row);
    });
  }
}

/** trustwork-digest-1 of what the goal confirmation shows: the goal's terms, the mandates it relies on and every proposal. */
function goalConfirmationDigest(input: { goalId: string; principal: string; company: string | null; body: CreateGoalCommand; allowedActions: string[]; covered: GoalConfirmation['covered']; proposals: { id: string; digest: string }[] }): string {
  const { body } = input;
  return computeDigest({
    kind: 'trustwork.agents.goal_confirmation', goalId: input.goalId, principal: input.principal, onBehalfOfCompany: input.company, text: body.text, successCriteria: body.successCriteria,
    allowedActions: input.allowedActions, needs: body.needs, budgetRange: body.budgetRange, horizon: iso(body.horizon), reportCadence: body.reportCadence,
    covered: input.covered.map((c) => ({ mandateId: c.mandateId, revision: c.revision })), proposals: input.proposals,
  }).value;
}
function confirmationOf(row: GoalRow, covered: GoalConfirmation['covered'], proposals: MandateProposalRow[]): GoalConfirmation {
  return {
    goalId: row.id, digest: digestOf(row.confirmation_digest), covered,
    proposals: proposals.map((r) => {
      const m = r.proposed as MandateV2;
      return { proposalId: r.id, mandateId: m.id, moduleKey: m.moduleKeys[0] as string, actions: m.actions, digest: digestOf(r.digest) };
    }),
  };
}
