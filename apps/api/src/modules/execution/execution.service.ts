import type { z } from 'zod';
import type { Party, Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { iso, mapDatabaseError, UUID } from '../procurement/common.js';
import {
  claimState, disputeOutcome, EXECUTION_EVENT_PAYLOAD_KEYS, ExecutionViewSchema,
  type AppealDisputeCommandSchema, type AttachEvidenceCommandSchema, type DecideClaimCommandSchema, type ExecutionActorInput, type ExecutionView, type OpenDisputeCommandSchema,
  type RecordClaimCommandSchema, type ReportDefectCommandSchema,
} from './contracts.js';
import {
  executionAgreements, executionClaims, executionConfirmations, executionDefects, executionDisputes, executionEvidence, performanceObservations,
  type ExecutionDisputeRow, type ExecutionEvidenceRow,
} from './deps.js';
import type { ExecutionMandatePort } from './mandates.js';

type In<T extends z.ZodType> = z.infer<T>;
type EventPayload = Partial<Record<(typeof EXECUTION_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;
interface ResolvedActor { via: 'person' | 'agent'; mandateId: string | null }

export const partyOf = (person: string | null, company: string | null): Party => (person ? { kind: 'person', id: person } : { kind: 'company', id: company as string });
export const columnsOf = (party: Party) => (party.kind === 'person' ? { person: party.id, company: null } : { person: null, company: party.id });
const dateOnly = (value: Date | string | null): string | null => {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

/** Database hints of the execution guards, mapped to frozen contract codes (specific reasons in `details.reason`). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'execution.not_found': { code: 'access.not_found', reason: 'not_found' },
  'execution.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'execution.not_obligor': { code: 'access.forbidden', reason: 'not_obligor' },
  'execution.self_confirmation': { code: 'access.forbidden', reason: 'self_confirmation' },
  'execution.agreement_not_live': { code: 'validation.revision_conflict', reason: 'agreement_not_live' },
  'execution.unknown_obligation': { code: 'validation.schema', reason: 'unknown_obligation' },
  'execution.unknown_claim': { code: 'validation.schema', reason: 'unknown_claim' },
  'execution.kind_mismatch': { code: 'validation.schema', reason: 'kind_mismatch' },
  'execution.task_records': { code: 'validation.schema', reason: 'task_records' },
  'execution.in_future': { code: 'validation.schema', reason: 'in_future' },
  'execution.obligation_fulfilled': { code: 'validation.revision_conflict', reason: 'obligation_fulfilled' },
  'execution.defect_resolved': { code: 'validation.revision_conflict', reason: 'defect_resolved' },
  'execution.claim_open': { code: 'validation.revision_conflict', reason: 'claim_open' },
  'execution.claim_not_open': { code: 'validation.revision_conflict', reason: 'claim_not_open' },
  'execution.claim_superseded': { code: 'validation.revision_conflict', reason: 'claim_superseded' },
  'execution.not_supersedable': { code: 'validation.revision_conflict', reason: 'not_supersedable' },
  'execution.artifact_not_attachable': { code: 'validation.schema', reason: 'artifact_not_attachable' },
  'execution.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'execution.dispute_immutable': { code: 'validation.revision_conflict', reason: 'dispute_immutable' },
};
export function mapExecutionError(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDatabaseError(error);
}

export interface ExecutionServiceOptions {
  /** The hub this API serves (TRUSTWORK_HUB_ID): disputes are decided by that hub's trust reviewers. */
  hubId: string | null;
}

/**
 * Evidence-aware execution (EXE-001) on agreements accepted by both parties. The obligor claims (goods delivered, work
 * or service performed, payment made, a defect remedied), attaches evidence from the agreement's files, and may
 * supersede its own open claim; the counterparty's person accepts, partially accepts or rejects it (never an agent);
 * either party reports defects; the party a decision went against opens a dispute that a trust reviewer decides and a
 * different reviewer decides on appeal (staff commands, DATA-002). Every decision materializes performance
 * observations in the same transaction (`trustwork.execution_observe`). One `withPrincipal` transaction per request,
 * which also completes the idempotency record (BE-005); outbox events carry identifiers only.
 */
export class ExecutionService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly mandates: ExecutionMandatePort,
    private readonly options: ExecutionServiceOptions,
  ) {}

  /* ---------- Plumbing ---------- */

  private now(): Date {
    return this.ctx.clock.now();
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapExecutionError);
  }
  /** A person acts for themself; a company through members holding company.deals.manage. */
  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  private async actor(principal: Principal, input: ExecutionActorInput, agreementId: string): Promise<ResolvedActor> {
    if (input.via === 'person') return { via: 'person', mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, action: 'record_evidence', context: { kind: 'agreement', id: agreementId }, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', 'the agent needs a record_evidence mandate for this agreement');
    return { via: 'agent', mandateId: input.mandateId };
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  private async event(trx: Transaction, aggregateKind: string, aggregateId: string, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(EXECUTION_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision: 1, type, payload });
  }
  /** The agreement the principal is a party of, or not found (nothing reveals that it exists). */
  private async partyAgreement(trx: Transaction, agreementId: string) {
    if (!UUID.test(agreementId)) throw new ApiError('access.not_found');
    const side = await executionAgreements.side(trx, agreementId);
    const row = side ? await executionAgreements.get(trx, agreementId) : undefined;
    if (!side || !row) throw new ApiError('access.not_found');
    return { side, row };
  }

  /* ---------- View ---------- */

  async view(agreementId: string, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      // Task milestone decisions live in TASK-001 records: materialize their observations lazily (idempotent, deterministic).
      if (row.status === 'accepted_by_both' || row.status === 'superseded') await executionAgreements.observe(trx, agreementId);
      return this.buildView(trx, agreementId, side, row);
    });
  }

  private async buildView(trx: Transaction, agreementId: string, side: 'buyer' | 'seller', row: NonNullable<Awaited<ReturnType<typeof executionAgreements.get>>>): Promise<ExecutionView> {
    const [obligationRows, claimRows, evidenceRows, confirmationRows, defectRows, disputeRows, observationRows, facts, completed] = await Promise.all([
      executionAgreements.obligations(trx, agreementId), executionClaims.listFor(trx, agreementId), executionEvidence.listFor(trx, agreementId),
      executionConfirmations.listFor(trx, agreementId), executionDefects.listFor(trx, agreementId), executionDisputes.listFor(trx, agreementId),
      performanceObservations.listFor(trx, agreementId), executionAgreements.timingFacts(trx, agreementId), executionAgreements.completed(trx, agreementId),
    ]);
    const supersededIds = new Set(claimRows.map((c) => c.supersedes_claim_id).filter((x): x is string => x !== null));
    const decisionOf = new Map(confirmationRows.map((f) => [f.claim_id, f]));
    const disputeOf = new Map(disputeRows.map((d) => [`${d.target_kind}:${d.target_id}`, d]));
    const disputeState = (d: ExecutionDisputeRow | undefined) => (d ? { pending: d.status === 'open' || d.status === 'appealed', outcome: disputeOutcome({ status: d.status, decision: d.decision, appealDecision: d.appeal_decision }) } : null);
    const evidenceView = (e: ExecutionEvidenceRow) => ({ id: e.id, artifactId: e.artifact_id, artifactSha256: e.artifact_sha256, kind: e.kind, observedAt: e.observed_at ? iso(e.observed_at) : null, note: e.note, attachedAt: iso(e.created_at) });

    const claims = claimRows.map((c) => {
      const f = decisionOf.get(c.id);
      const evidence = evidenceRows.filter((e) => e.claim_id === c.id);
      return {
        id: c.id, obligationId: c.obligation_id, defectId: c.defect_id, kind: c.kind, claimant: partyOf(c.claimant_person_id, c.claimant_company_id),
        counterparty: partyOf(c.counterparty_person_id, c.counterparty_company_id), lines: c.lines as never, period: c.period_from ? { from: dateOnly(c.period_from)!, to: dateOnly(c.period_to)! } : null,
        performedAt: iso(c.performed_at), statement: c.statement, supersedesClaimId: c.supersedes_claim_id, via: c.via,
        state: claimState({ superseded: supersededIds.has(c.id), evidenceCount: evidence.length, decision: f?.decision ?? null, dispute: f ? disputeState(disputeOf.get(`confirmation:${f.id}`)) : null }),
        evidence: evidence.map(evidenceView),
        decision: f ? { id: f.id, decision: f.decision, lines: f.lines as never, note: f.note, stageCode: f.stage_code, onBehalfOf: partyOf(f.on_behalf_person_id, f.on_behalf_company_id), decidedAt: iso(f.decided_at) } : null,
        createdAt: iso(c.created_at),
      };
    });
    const live = claims.filter((c) => c.state !== 'superseded');
    const obligations = obligationRows.map((o) => {
      const mine = live.filter((c) => c.obligationId === o.id);
      const taskAccepted = observationRows.some((x) => x.obligation_id === o.id && x.source_kind === 'task_acceptance' && x.dimension === 'quality');
      const progress = o.status === 'waived' ? 'waived'
        : mine.some((c) => c.decision?.decision === 'accepted' && c.state !== 'reversed') || taskAccepted ? 'fulfilled'
        : mine.some((c) => c.decision?.decision === 'partially_accepted' && c.state !== 'reversed') ? 'partially_accepted'
        : mine.some((c) => c.decision === null) ? 'claimed' : 'open';
      return { id: o.id, position: o.position, kind: o.kind, obligor: partyOf(o.obligor_person_id, o.obligor_company_id), due: o.due ? iso(o.due) : null, progress };
    });
    const defects = defectRows.map((d) => {
      const remedies = live.filter((c) => c.defectId === d.id);
      const dispute = disputeState(disputeOf.get(`defect:${d.id}`));
      const state = dispute?.pending ? 'disputed' : dispute?.outcome === 'overturned' ? 'dismissed'
        : remedies.some((c) => c.decision?.decision === 'accepted') ? 'resolved' : remedies.some((c) => c.decision === null) ? 'remediation_claimed' : 'open';
      return {
        id: d.id, obligationId: d.obligation_id, claimId: d.claim_id, reporter: partyOf(d.reporter_person_id, d.reporter_company_id), subject: partyOf(d.subject_person_id, d.subject_company_id),
        severity: d.severity, location: d.location, description: d.description, observedAt: iso(d.observed_at), state, evidence: evidenceRows.filter((e) => e.defect_id === d.id).map(evidenceView),
        createdAt: iso(d.created_at),
      };
    });
    const disputes = disputeRows.map((d) => ({
      id: d.id, target: { kind: d.target_kind, id: d.target_id }, opener: partyOf(d.opener_person_id, d.opener_company_id), reason: d.reason, status: d.status, decision: d.decision,
      decisionReason: d.decision_reason, decidedAt: d.decided_at ? iso(d.decided_at) : null, appealReason: d.appeal_reason, appealDecision: d.appeal_decision,
      appealDecisionReason: d.appeal_decision_reason, appealDecidedAt: d.appeal_decided_at ? iso(d.appeal_decided_at) : null,
      outcome: disputeOutcome({ status: d.status, decision: d.decision, appealDecision: d.appeal_decision }), revision: d.revision, createdAt: iso(d.created_at),
    }));
    const observations = observationRows.map((x) => ({
      id: x.id, source: { kind: x.source_kind, id: x.source_id }, obligationId: x.obligation_id, subject: partyOf(x.subject_person_id, x.subject_company_id), dimension: x.dimension,
      outcome: x.outcome, dueAt: x.due_at ? iso(x.due_at) : null, performedAt: x.performed_at ? iso(x.performed_at) : null, allowanceDays: x.allowance_days, lateDays: x.late_days,
      attribution: x.attribution, excludedReason: x.excluded_reason, planChangeIds: x.plan_change_ids, baselinePlanVersionId: x.baseline_plan_version_id, createdAt: iso(x.created_at),
    }));
    return ExecutionViewSchema.parse({
      projection: 'shared_party',
      agreement: { id: row.id, termsKind: row.terms_kind, status: row.status, buyer: partyOf(row.buyer_person_id, row.buyer_company_id), seller: partyOf(row.seller_person_id, row.seller_company_id), side },
      obligations, claims, defects, disputes, observations,
      timingFacts: facts.map((f) => ({ changeId: f.change_id, cause: f.cause, accountable: partyOf(f.accountable_person_id, f.accountable_company_id), scheduleImpactDays: f.schedule_impact_days, decidedAt: iso(f.decided_at) })),
      completed,
    });
  }

  /* ---------- Commands ---------- */

  async recordClaim(agreementId: string, input: In<typeof RecordClaimCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      if (!this.actsFor(p, input.claimant)) throw new ApiError('access.forbidden', 'claims are made for a party you act for', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, agreementId);
      const claimant = columnsOf(input.claimant);
      const claim = await executionClaims.insert(trx, {
        agreement_id: agreementId, obligation_id: input.obligationId, defect_id: input.defectId, kind: input.kind, claimant_person_id: claimant.person, claimant_company_id: claimant.company,
        lines: input.lines, period_from: input.period?.from ?? null, period_to: input.period?.to ?? null, performed_at: new Date(input.performedAt), statement: input.statement,
        supersedes_claim_id: input.supersedesClaimId, recorded_by_person_id: p.personId, via: actor.via, mandate_id: actor.mandateId,
      });
      await this.audit(trx, p, state, input.supersedesClaimId ? 'execution.claim_superseded' : 'execution.claim_recorded', 'execution_claim', claim.id, { agreementId, kind: input.kind, obligationId: input.obligationId, defectId: input.defectId, supersedes: input.supersedesClaimId, via: actor.via, mandateId: actor.mandateId });
      await this.event(trx, 'agreement', agreementId, 'execution.claim_recorded', { agreementId, claimId: claim.id, kind: input.kind, via: actor.via });
      return this.buildView(trx, agreementId, side, row);
    });
  }

  async attachEvidence(agreementId: string, input: In<typeof AttachEvidenceCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      const actor = await this.actor(p, input.actor, agreementId);
      const evidence = await executionEvidence.insert(trx, {
        agreement_id: agreementId, claim_id: input.target.kind === 'claim' ? input.target.id : null, defect_id: input.target.kind === 'defect' ? input.target.id : null,
        artifact_id: input.artifactId, artifact_sha256: input.artifactSha256, kind: input.kind, observed_at: input.observedAt ? new Date(input.observedAt) : null, note: input.note,
        attached_by_person_id: p.personId, via: actor.via, mandate_id: actor.mandateId,
      });
      await this.audit(trx, p, state, 'execution.evidence_attached', 'execution_evidence', evidence.id, { agreementId, target: input.target, artifactId: input.artifactId, sha256: input.artifactSha256, via: actor.via });
      await this.event(trx, 'agreement', agreementId, 'execution.evidence_attached', { agreementId, evidenceId: evidence.id, via: actor.via });
      return this.buildView(trx, agreementId, side, row);
    });
  }

  /** The counterparty's person decides; the observations of the decision are materialized in the same transaction. */
  async decideClaim(claimId: string, input: In<typeof DecideClaimCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(claimId)) throw new ApiError('access.not_found');
      const claim = await executionClaims.get(trx, claimId);
      if (!claim) throw new ApiError('access.not_found');
      const { side, row } = await this.partyAgreement(trx, claim.agreement_id);
      if (!this.actsFor(p, input.onBehalfOf)) throw new ApiError('access.forbidden', 'decisions are made for a party you act for', { reason: 'not_authorised' });
      const onBehalf = columnsOf(input.onBehalfOf);
      const confirmation = await executionConfirmations.insert(trx, {
        claim_id: claimId, agreement_id: claim.agreement_id, decision: input.decision, lines: input.lines, note: input.note, stage_code: input.stageCode, decided_by_person_id: p.personId,
        on_behalf_person_id: onBehalf.person, on_behalf_company_id: onBehalf.company,
      });
      await executionAgreements.observe(trx, claim.agreement_id);
      await this.audit(trx, p, state, 'execution.claim_decided', 'execution_confirmation', confirmation.id, { agreementId: claim.agreement_id, claimId, decision: input.decision, via: 'person' });
      await this.event(trx, 'agreement', claim.agreement_id, 'execution.claim_decided', { agreementId: claim.agreement_id, claimId, confirmationId: confirmation.id, decision: input.decision });
      return this.buildView(trx, claim.agreement_id, side, row);
    });
  }

  async reportDefect(agreementId: string, input: In<typeof ReportDefectCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      if (!this.actsFor(p, input.reporter)) throw new ApiError('access.forbidden', 'defects are reported for a party you act for', { reason: 'not_authorised' });
      const actor = await this.actor(p, input.actor, agreementId);
      const reporter = columnsOf(input.reporter);
      const defect = await executionDefects.insert(trx, {
        agreement_id: agreementId, obligation_id: input.obligationId, claim_id: input.claimId, reporter_person_id: reporter.person, reporter_company_id: reporter.company, reported_by_person_id: p.personId,
        via: actor.via, mandate_id: actor.mandateId, severity: input.severity, location: input.location, description: input.description, observed_at: new Date(input.observedAt),
      });
      await this.audit(trx, p, state, 'execution.defect_reported', 'execution_defect', defect.id, { agreementId, severity: input.severity, obligationId: input.obligationId, claimId: input.claimId, via: actor.via });
      await this.event(trx, 'agreement', agreementId, 'execution.defect_reported', { agreementId, defectId: defect.id, via: actor.via });
      return this.buildView(trx, agreementId, side, row);
    });
  }

  async openDispute(agreementId: string, input: In<typeof OpenDisputeCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      const { side, row } = await this.partyAgreement(trx, agreementId);
      if (!this.options.hubId) throw new ApiError('validation.schema', 'disputes need the hub this API serves (TRUSTWORK_HUB_ID)', { reason: 'hub_not_configured' });
      if (!this.actsFor(p, input.opener)) throw new ApiError('access.forbidden', 'disputes are opened for a party you act for', { reason: 'not_authorised' });
      const opener = columnsOf(input.opener);
      const dispute = await executionDisputes.insert(trx, {
        agreement_id: agreementId, hub_id: this.options.hubId, target_kind: input.target.kind, target_id: input.target.id, opened_by_person_id: p.personId, opener_person_id: opener.person,
        opener_company_id: opener.company, reason: input.reason,
      });
      await this.audit(trx, p, state, 'execution.dispute_opened', 'execution_dispute', dispute.id, { agreementId, target: input.target });
      await this.event(trx, 'execution_dispute', dispute.id, 'execution.dispute_opened', { agreementId, disputeId: dispute.id, kind: input.target.kind });
      return this.buildView(trx, agreementId, side, row);
    });
  }

  async appealDispute(disputeId: string, input: In<typeof AppealDisputeCommandSchema>, state: RequestState): Promise<ExecutionView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(disputeId)) throw new ApiError('access.not_found');
      const dispute = await executionDisputes.get(trx, disputeId);
      if (!dispute) throw new ApiError('access.not_found');
      const { side, row } = await this.partyAgreement(trx, dispute.agreement_id);
      if (dispute.status !== 'decided') throw new ApiError('validation.revision_conflict', 'only a decided dispute is appealed, once', { reason: 'invalid_transition' });
      const saved = await executionDisputes.appeal(trx, disputeId, input.expectedRevision, { personId: p.personId, reason: input.reason, at: this.now() });
      if (!saved) throw new ApiError('validation.revision_conflict');
      await this.audit(trx, p, state, 'execution.dispute_appealed', 'execution_dispute', disputeId, { agreementId: dispute.agreement_id });
      await this.event(trx, 'execution_dispute', disputeId, 'execution.dispute_appealed', { agreementId: dispute.agreement_id, disputeId });
      return this.buildView(trx, dispute.agreement_id, side, row);
    });
  }
}
