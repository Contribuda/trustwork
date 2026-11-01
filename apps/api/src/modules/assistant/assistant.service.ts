import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { z } from 'zod';
import {
  computeDigest, DIGEST_ALGORITHM, mandateChangeAllowed, MandateV2Schema, type ContextRef, type Digest, type MandateV2, type Money, type Principal,
} from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import { completionRecordId } from '../../common/idempotency/completion.js';
import { assistantModelTurns } from '../../../../../packages/data/src/repositories/assistant-model.js';
import type { AssistantModelTurnRow } from '../../../../../packages/data/src/schema/assistant-model.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { agentRuntimeGate, CapabilityAuthority } from '../agent-modules/authority.js';
import { findServingHub, servingHub } from '../agent-modules/serving-hub.js';
import { mapDatabaseError } from '../procurement/common.js';
import {
  actionIntents, conversationTurns, mandateProposals, mandates, runs, runSteps, serviceBacklog, stops,
  type ActionIntentRow, type ConversationTurnRow, type MandateProposalRow, type MandateRow, type RunRow, type RunStepRow, type ServiceBacklogItemRow,
} from './deps.js';
import { actionDigest, assertShareable, decide, isUuid, mandateDigest, mandateOf, PrivateFieldError, type PolicySettings } from './policy.js';
import { UnavailableModel } from './ports.js';
import type { ModelInput, ModelPort, ModelToolCall, RetrievalPort } from './ports.js';
import type {
  BacklogStatusCommandSchema, CancelRunCommandSchema, ConfirmProposalCommandSchema, ConversationCommandSchema, CreateMandateCommandSchema, DeclineCommandSchema, DecideCommandSchema,
  MandateDraft, NarrowMandateCommandSchema, ReviseMandateCommandSchema,
} from './schemas.js';

type In<T extends z.ZodType> = z.infer<T>;
type ErrorCode = ConstructorParameters<typeof ApiError>[0];
const iso = (value: Date | string): string => new Date(value).toISOString();
const digestOf = (value: string): Digest => ({ algorithm: DIGEST_ALGORITHM, value });
const money = (minor: string | null, currency: string | null): Money | null => (minor !== null && currency !== null ? { minorUnits: String(minor), currency } : null);

/** Database hints of the assistant commands (and the BILL-001 reservation they call), mapped to frozen contract codes. */
const HINTS: Record<string, { code: ErrorCode; reason: string }> = {
  'validation.idempotency_in_progress': { code: 'validation.idempotency_in_progress', reason: 'in_progress' },
  'validation.idempotency_conflict': { code: 'validation.idempotency_conflict', reason: 'conflict' },
  'mandate.not_principal': { code: 'access.forbidden', reason: 'not_principal' },
  'mandate.authority_basis': { code: 'access.forbidden', reason: 'authority_basis' },
  'mandate.budget_authority': { code: 'commercial.authority_missing', reason: 'budget_authority' },
  'mandate.final': { code: 'validation.schema', reason: 'mandate_final' },
  'mandate.invalid': { code: 'validation.schema', reason: 'mandate_invalid' },
  'mandate.immutable': { code: 'validation.schema', reason: 'mandate_immutable' },
  'mandate.not_active': { code: 'access.mandate_revoked', reason: 'mandate_not_active' },
  'mandate.revision_changed': { code: 'access.mandate_revoked', reason: 'mandate_revised' },
  'mandate.limit': { code: 'access.mandate_scope', reason: 'mandate_limit' },
  'mandate.human_only': { code: 'access.approval_required', reason: 'human_only' },
  'mandate.proposal_not_pending': { code: 'validation.revision_conflict', reason: 'proposal_not_pending' },
  'mandate.proposal_only': { code: 'access.forbidden', reason: 'proposal_only' },
  'assistant.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'assistant.immutable': { code: 'validation.schema', reason: 'immutable' },
  'access.approval_digest_mismatch': { code: 'access.approval_digest_mismatch', reason: 'digest_mismatch' },
  'auth.step_up_required': { code: 'auth.step_up_required', reason: 'step_up_required' },
  'access.not_found': { code: 'access.not_found', reason: 'not_found' },
  'validation.revision_conflict': { code: 'validation.revision_conflict', reason: 'revision_conflict' },
  'commercial.budget_insufficient': { code: 'commercial.budget_insufficient', reason: 'budget_insufficient' },
  'commercial.authority_missing': { code: 'commercial.authority_missing', reason: 'budget_authority' },
  'commercial.currency_mismatch': { code: 'commercial.currency_mismatch', reason: 'currency_mismatch' },
  'billing.budget_kind_mismatch': { code: 'commercial.authority_missing', reason: 'budget_kind_mismatch' },
  'billing.budget_inactive': { code: 'commercial.authority_missing', reason: 'budget_inactive' },
  'billing.scope_mismatch': { code: 'commercial.authority_missing', reason: 'budget_scope_mismatch' },
};
function mapAssistantError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDatabaseError(error);
}

/* ---------- Owner views (the principal's own records; nothing here reaches another party) ---------- */

function mandateView(row: MandateRow) {
  return {
    id: row.id, revision: row.revision, status: row.status, statusReason: row.status_reason, mandate: row.snapshot as MandateV2, digest: row.digest ? digestOf(row.digest) : null,
    confirmedAt: iso(row.confirmed_at), confirmedStepUp: row.confirmed_step_up, validUntil: iso(row.valid_until), revokedAt: row.revoked_at ? iso(row.revoked_at) : null, updatedAt: iso(row.updated_at),
  };
}
function proposalView(row: MandateProposalRow) {
  return {
    id: row.id, mandateId: row.mandate_id, basisRevision: row.basis_revision, origin: row.origin_kind, proposed: row.proposed as MandateV2, digest: digestOf(row.digest), status: row.status,
    createdAt: iso(row.created_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
  };
}
function intentView(row: ActionIntentRow) {
  return {
    id: row.id, runId: row.run_id, origin: row.origin, mandate: { id: row.mandate_id, revision: row.mandate_revision }, capabilityId: row.capability_id, moduleKey: row.module_key,
    action: row.action, context: { kind: row.context_kind, id: row.context_id }, resolvedFromSelector: row.resolved_from_selector, amount: money(row.amount_minor, row.currency),
    actionDigest: digestOf(row.action_digest), askReasons: row.ask_reasons, state: row.state, stateReason: row.state_reason, outcomeKind: row.outcome_kind, attemptCount: row.attempt_count,
    effect: row.effect, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function runView(row: RunRow) {
  return { id: row.id, kind: row.kind, mandateId: row.mandate_id, state: row.state, startedAt: iso(row.started_at), endedAt: row.ended_at ? iso(row.ended_at) : null, endedReason: row.ended_reason, revision: row.revision };
}
function stepView(row: RunStepRow) {
  return { id: row.id, seq: Number(row.seq), kind: row.kind, tool: row.tool, state: row.state, output: row.output_ref, at: iso(row.started_at) };
}
function turnView(row: ConversationTurnRow) {
  return { id: row.id, role: row.role, content: row.content, runId: row.run_id, createdAt: iso(row.created_at) };
}
function backlogView(row: ServiceBacklogItemRow) {
  return { id: row.id, title: row.title, proposal: row.proposal, sourceRunId: row.source_run_id, status: row.status, revision: row.revision, createdAt: iso(row.created_at) };
}
type ConversationResult = { run: ReturnType<typeof runView>; turns: ReturnType<typeof turnView>[]; proposals: ReturnType<typeof proposalView>[]; actions: ActionProposalResult[]; citations: string[] };

export interface AssistantRuntimeSettings {
  /** How long an approval of an asked action stays usable (module checks keep it until the identical retry). */
  approvalTtlSeconds: number;
  /** Lifetime of a budget reservation for an agent action; an unknown outcome keeps it until a definitive result. */
  reservationTtlSeconds: number;
}
export const DEFAULT_RUNTIME_SETTINGS: AssistantRuntimeSettings = { approvalTtlSeconds: 24 * 3600, reservationTtlSeconds: 30 * 86400 };

/**
 * The shared capability check of AGT-003 (agent-modules `agentRuntimeGate`), asked before an agent action is recorded:
 * a module or capability the hub switched off, or a kill switch, refuses it here exactly as on the interface and MCP.
 */
export type AgentCapabilityGate = (trx: Transaction, input: {
  hubId: string;
  personId: string;
  mandate: { onBehalfCompanyId: string | null; granteeKind: 'own_agent' | 'colleague_agent' | 'company_representative'; granteeCompanyId: string | null };
  capabilityId: string;
  action: string;
}) => Promise<{ reason: string; messageKey: string } | null>;

export type ActionProposalResult =
  | { state: 'queued' | 'proposed'; intentId: string; reasons: readonly string[] }
  | { state: 'denied'; reason: string };

/**
 * The person's one agent (AST-001): governance on the first-party form, decisions waiting for the person, runs and the
 * conversation. Governance (confirm, approve, stop, revoke) is reachable only from a person's session on these routes;
 * the agent side (`converse`, `proposeAction`, `proposeMandateChange`) can only propose. Every route runs in one
 * principal transaction that also completes its idempotency record (BE-005).
 */
export class AssistantService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly settings: PolicySettings,
    private readonly runtime: AssistantRuntimeSettings,
    private readonly model: ModelPort,
    private readonly retrieval: RetrievalPort,
    private readonly capabilityGate: AgentCapabilityGate | null = null,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapAssistantError);
  }
  /** A recent authentication on this session (the step-up window of the identity module). */
  private steppedUp(state: RequestState): boolean {
    return state.session !== null && this.now().getTime() - state.session.authenticatedAt.getTime() <= this.ctx.config.session.stepUpMs;
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState | null, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state?.requestId ?? null, authz_epoch: principal.authzEpoch, basis });
  }

  /* ---------- Reads ---------- */

  listMandates(state: RequestState) {
    return this.run(state, async (trx, p) => ({ mandates: (await mandates.list(trx, p.personId)).map(mandateView) }));
  }
  getMandate(id: string, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await mandates.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'mandate not found');
      const revisions = await mandates.revisions(trx, id);
      return { ...mandateView(row), revisions: revisions.map((r) => ({ revision: r.revision, changeKind: r.change_kind, reason: r.reason, digest: r.digest ? digestOf(r.digest) : null, changedAt: iso(r.changed_at) })) };
    });
  }
  listProposals(state: RequestState) {
    return this.run(state, async (trx, p) => ({ proposals: (await mandateProposals.listPending(trx, p.personId)).map(proposalView) }));
  }
  listDecisions(state: RequestState) {
    return this.run(state, async (trx, p) => ({ decisions: (await actionIntents.listWaiting(trx, p.personId)).map(intentView) }));
  }
  listRuns(state: RequestState) {
    return this.run(state, async (trx, p) => ({ runs: (await runs.list(trx, p.personId)).map(runView) }));
  }
  getRun(id: string, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await runs.get(trx, id) : undefined;
      if (!row) throw new ApiError('access.not_found', 'run not found');
      const intents = await actionIntents.listForRun(trx, id);
      // One connection per transaction: read the outcomes one intent after the other.
      const withOutcomes = [];
      for (const intent of intents) {
        const outcomes = await actionIntents.outcomes(trx, intent.id);
        withOutcomes.push({ ...intentView(intent), outcomes: outcomes.map((o) => ({ kind: o.kind, reason: o.reason, result: o.result, providerReference: o.provider_reference, reconciled: o.reconciliation_id !== null, observedAt: iso(o.observed_at) })) });
      }
      return { ...runView(row), steps: (await runSteps.list(trx, id)).map(stepView), actions: withOutcomes };
    });
  }
  stopState(state: RequestState) {
    return this.run(state, async (trx, p) => {
      const stop = await stops.current(trx, p.personId);
      return { engaged: Boolean(stop), engagedAt: stop ? iso(stop.engaged_at) : null };
    });
  }
  conversation(state: RequestState) {
    return this.run(state, async (trx, p) => ({ turns: (await conversationTurns.list(trx, p.personId)).reverse().map(turnView) }));
  }
  backlog(state: RequestState) {
    return this.run(state, async (trx, p) => ({ items: (await serviceBacklog.list(trx, p.personId)).map(backlogView) }));
  }

  /* ---------- Governance on the first-party form ---------- */

  /**
   * Creates and confirms a mandate on the first-party form (step-up route). The server builds the whole MandateV2
   * (id, principal, revision, status, confirmation) and refuses anything `mandateChangeAllowed` refuses.
   */
  createMandate(body: In<typeof CreateMandateCommandSchema>, state: RequestState) {
    return this.run(state, (trx, p) => this.confirm(trx, p, state, null, null, body.draft, null));
  }
  reviseMandate(id: string, body: In<typeof ReviseMandateCommandSchema>, state: RequestState) {
    return this.run(state, (trx, p) => this.confirm(trx, p, state, id, body.expectedRevision, body.draft, null));
  }
  /** Confirms exactly the proposal the person was shown (digest repeated); the proposal itself never authorized anything. */
  confirmProposal(id: string, body: In<typeof ConfirmProposalCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const proposal = isUuid(id) ? await mandateProposals.get(trx, id) : undefined;
      if (!proposal) throw new ApiError('access.not_found', 'proposal not found');
      if (proposal.status !== 'pending') throw new ApiError('validation.revision_conflict', 'the proposal is no longer pending', { reason: 'proposal_not_pending' });
      if (body.digest.value !== proposal.digest) throw new ApiError('access.approval_digest_mismatch', 'the confirmation does not match the proposal', { reason: 'digest_mismatch' });
      const proposed = MandateV2Schema.parse(proposal.proposed);
      return this.confirm(trx, p, state, proposal.mandate_id ?? proposed.id, proposal.basis_revision, draftOf(proposed), proposal.id, proposal.mandate_id === null ? proposed.id : null);
    });
  }
  declineProposal(id: string, state: RequestState) {
    return this.run(state, async (trx, p) => {
      const row = isUuid(id) ? await mandateProposals.decline(trx, id, p.personId) : undefined;
      if (!row) throw new ApiError('access.not_found', 'proposal not found or already decided');
      await this.audit(trx, p, state, 'assistant.mandate_proposal_declined', 'mandate_proposal', row.id, { origin: row.origin_kind });
      return proposalView(row);
    });
  }
  narrowMandate(id: string, status: 'suspended' | 'revoked', body: In<typeof NarrowMandateCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'mandate not found');
      const row = await mandates.narrow(trx, id, body.expectedRevision, status, body.reason);
      await this.audit(trx, p, state, `assistant.mandate_${status}`, 'mandate', row.id, { revision: row.revision, reason: body.reason });
      return mandateView(row);
    });
  }

  private async confirm(trx: Transaction, p: Principal, state: RequestState, mandateId: string | null, expectedRevision: number | null, draft: MandateDraft, proposalId: string | null, newId: string | null = null) {
    let before: MandateV2 | null = null;
    if (mandateId !== null && newId === null) {
      const row = isUuid(mandateId) ? await mandates.get(trx, mandateId) : undefined;
      if (!row) throw new ApiError('access.not_found', 'mandate not found');
      before = mandateOf(row);
      if (!before) throw new ApiError('validation.schema', 'the stored mandate cannot be revised', { reason: 'mandate_invalid' });
      if (expectedRevision !== before.revision) throw new ApiError('validation.revision_conflict', 'the mandate changed meanwhile', { reason: 'revision_conflict' });
    }
    // Colleague agents and the company representative act under company mandates once AGT-001 delivers their runtime.
    if (draft.grantee.kind !== 'own_agent') throw new ApiError('validation.schema', 'only the person\'s own agent can be granted a mandate in this release', { reason: 'grantee_not_available' });
    const candidate = {
      id: newId ?? mandateId ?? randomUUID(), schemaVersion: 2 as const, principal: { personId: p.personId, onBehalfOf: draft.onBehalfOf }, grantee: draft.grantee, moduleKeys: draft.moduleKeys,
      actions: draft.actions, contexts: draft.contexts, limits: draft.limits, conditions: draft.conditions, approvalPolicy: draft.approvalPolicy, approvers: draft.approvers,
      escalation: draft.escalation, confirmation: { via: 'first_party_form' as const, personId: p.personId, at: iso(this.now()), stepUp: this.steppedUp(state) },
      validUntil: draft.validUntil, status: 'active' as const, revision: (before?.revision ?? 0) + 1, revokedAt: null,
    };
    const parsed = MandateV2Schema.safeParse(candidate);
    if (!parsed.success) throw new ApiError('validation.schema', 'the mandate is not valid', { reason: 'mandate_invalid', issues: parsed.error.issues.slice(0, 10).map((i) => i.message) });
    const verdict = mandateChangeAllowed({ kind: 'person', personId: p.personId, via: 'first_party_form' }, before, parsed.data);
    if (verdict !== 'ok') throw new ApiError(verdict === 'mandate.revision_conflict' ? 'validation.revision_conflict' : 'access.forbidden', verdict, { reason: verdict });
    const row = await mandates.confirm(trx, {
      snapshot: parsed.data, contexts: parsed.data.contexts, digest: mandateDigest(parsed.data), expectedRevision: before?.revision ?? null, stepUp: candidate.confirmation.stepUp, proposalId,
    });
    const binding = await findServingHub(trx, this.ctx.config.publicOrigin);
    if (binding && state.session) await sql`SELECT trustwork.agent_modules_bind_mandate(${row.id}::uuid,${binding.id}::uuid,${state.session.id}::uuid)`.execute(trx);
    await this.audit(trx, p, state, 'assistant.mandate_confirmed', 'mandate', row.id, { revision: row.revision, digest: row.digest, proposalId, actions: parsed.data.actions });
    return mandateView(row);
  }

  /**
   * The person approves exactly the action they were shown (digest). A run action is authorized at once and queued
   * (budget reserved, dispatch job persisted) in the same transaction; a module check keeps the approval for its
   * identical retry. Money and human-only actions need a recent authentication on this session.
   */
  approveDecision(id: string, body: In<typeof DecideCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'decision not found');
      let intent = await actionIntents.approve(trx, id, body.digest.value, this.runtime.approvalTtlSeconds, this.steppedUp(state));
      if (intent.origin === 'run' && intent.state === 'authorized') intent = await actionIntents.queue(trx, id, this.runtime.reservationTtlSeconds, projectOf(intent));
      await this.audit(trx, p, state, 'assistant.decision_approved', 'action_intent', intent.id, { digest: intent.action_digest, mandateId: intent.mandate_id, revision: intent.mandate_revision });
      return intentView(intent);
    });
  }
  declineDecision(id: string, body: In<typeof DeclineCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'decision not found');
      const intent = await actionIntents.decline(trx, id, body.reason ?? 'declined by the person');
      await this.audit(trx, p, state, 'assistant.decision_declined', 'action_intent', intent.id, { reason: body.reason });
      return intentView(intent);
    });
  }
  cancelRun(id: string, body: In<typeof CancelRunCommandSchema>, state: RequestState) {
    return this.run(state, async (trx, p) => {
      if (!isUuid(id)) throw new ApiError('access.not_found', 'run not found');
      await assistantModelTurns.lockConversation(trx, p.personId);
      const existing = await assistantModelTurns.forRun(trx, id);
      const turn = existing ? await assistantModelTurns.lock(trx, existing.id) : undefined;
      const row = await runs.cancel(trx, id, body.reason ?? 'cancelled by the person');
      if (turn?.state === 'pending') await this.finishUnavailableTurn(trx, p, turn, row);
      await this.audit(trx, p, state, 'assistant.run_cancelled', 'run', row.id, { reason: body.reason });
      return runView(row);
    });
  }
  /** The stop control: one action, never step-up, never disabled. */
  engageStop(state: RequestState) {
    return this.run(state, async (trx, p) => {
      const result = await stops.engage(trx);
      await this.audit(trx, p, state, 'assistant.stop_engaged', 'participant_stop', result.stopId, { suspendedMandates: result.suspendedMandates, revokedActions: result.revokedActions });
      return { engaged: true, engagedAt: result.engagedAt, suspendedMandates: result.suspendedMandates, revokedActions: result.revokedActions };
    });
  }
  releaseStop(state: RequestState) {
    return this.run(state, async (trx, p) => {
      const result = await stops.release(trx);
      await this.audit(trx, p, state, 'assistant.stop_released', 'person', p.personId, result);
      return { engaged: false, released: result.released };
    });
  }
  setBacklogStatus(id: string, body: In<typeof BacklogStatusCommandSchema>, state: RequestState) {
    return this.run(state, async (trx) => {
      const row = isUuid(id) ? await serviceBacklog.setStatus(trx, id, body.status, body.expectedRevision) : undefined;
      if (!row) throw new ApiError('validation.revision_conflict', 'the item changed meanwhile or does not exist', { reason: 'revision_conflict' });
      return backlogView(row);
    });
  }

  /* ---------- The agent side: it can only propose ---------- */

  /** Local finalization never settles or releases model accounting. Unknown effects remain reconcile-only. */
  private async finishUnavailableTurn(trx: Transaction, p: Principal, turn: AssistantModelTurnRow, run: RunRow): Promise<ConversationResult> {
    await assistantModelTurns.fence(trx, turn.id);
    const asked = await trx.selectFrom('conversation_turn').selectAll().where('id', '=', turn.asked_id).executeTakeFirstOrThrow();
    const answer = await conversationTurns.append(trx, { person_id: p.personId, role: 'system', content: 'assistant.overlay.stateUnavailable', run_id: run.id });
    const result: ConversationResult = { run: runView(run), turns: [turnView(asked), turnView(answer)], proposals: [], actions: [], citations: [] };
    await assistantModelTurns.finish(trx, turn.id, result);
    return result;
  }

  private async closeStoppedTurns(trx: Transaction, p: Principal, unavailable: boolean): Promise<void> {
    await assistantModelTurns.lockConversation(trx, p.personId);
    for (const pending of await assistantModelTurns.pending(trx, p.personId)) {
      const turn = await assistantModelTurns.lock(trx, pending.id);
      if (!turn || turn.state === 'completed') continue;
      let run = await trx.selectFrom('run').selectAll().where('id', '=', turn.run_id).forUpdate().executeTakeFirstOrThrow();
      if (unavailable && !['cancelled', 'failed', 'completed'].includes(run.state)) {
        run = (await runs.setState(trx, run.id, 'failed'))!;
      }
      if (['cancelled', 'failed', 'completed'].includes(run.state)) await this.finishUnavailableTurn(trx, p, turn, run);
    }
  }

  /**
   * One conversation turn. The person's text is stored as content and handed to the model as data; the model's reply
   * is stored as content; its tool calls become proposals (mandate changes, backlog items) or actions decided by the
   * mandate policy. Nothing typed here confirms, approves, widens or stops anything.
   */
  async converse(body: In<typeof ConversationCommandSchema>, state: RequestState) {
    // The built-in unavailable model has no effect or adapter; retain the existing single-commit no-model route.
    if (this.model instanceof UnavailableModel) return this.run(state, async (trx, p) => {
      await this.closeStoppedTurns(trx, p, true);
      // A restarted process may receive the old command after replacing its model with the default.
      const previous = await trx.selectFrom('assistant_model_turn').selectAll().where('person_id', '=', p.personId)
        .where('request_key', '=', completionRecordId(state) ?? state.requestId).executeTakeFirst();
      if (previous) {
        if (previous.input_digest !== computeDigest(body).value) throw new ApiError('validation.idempotency_conflict', 'different conversation command');
        return previous.result as ConversationResult;
      }
      const run = await runs.start(trx, { principal_person_id: p.personId, kind: 'conversation' });
      const asked = await conversationTurns.append(trx, { person_id: p.personId, role: 'person', content: body.text, run_id: run.id });
      const answer = await conversationTurns.append(trx, { person_id: p.personId, role: 'system', content: 'assistant.overlay.stateUnavailable', run_id: run.id });
      await runSteps.append(trx, { run_id: run.id, kind: 'model_call', tool: null, input_digest: computeDigest({ text: body.text }).value,
        output_ref: { provider: 'none', usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0 }, state: 'succeeded' });
      await runs.setState(trx, run.id, 'completed');
      return { run: runView((await runs.get(trx, run.id))!), turns: [turnView(asked), turnView(answer)], proposals: [] as ReturnType<typeof proposalView>[], actions: [] as ActionProposalResult[], citations: [] as string[] };
    });
    const key = completionRecordId(state) ?? state.requestId;
    // Commit intent first. The HTTP idempotency completion belongs only to the final transaction.
    const prepared = await this.run({ ...state }, async (trx, p) => {
      if (!state.session || state.session.personId !== p.personId) throw new ApiError('auth.session_invalid', 'session required');
      await this.closeStoppedTurns(trx, p, false);
      const begun = await assistantModelTurns.begin(trx, key, computeDigest(body).value, body.text);
      if (begun.fresh) {
        const binding = await servingHub(trx, this.ctx.config.publicOrigin);
        await sql`SELECT trustwork.agent_modules_bind_run(${begun.turn.run_id}::uuid,${binding.id}::uuid,${state.session.id}::uuid)`.execute(trx);
      }
      // Recovery reloads original provenance without requiring fresh-dispatch permission or an active binding.
      const provenance = await trx.selectFrom('agent_run_provenance').select('hub_id').where('run_id', '=', begun.turn.run_id).executeTakeFirst();
      const history = (await conversationTurns.list(trx, p.personId, 21)).filter((t) => t.id !== begun.turn.asked_id).slice(0, 20).reverse().map((t) => ({ role: t.role, content: t.content }));
      return { ...begun, principal: p, history, executionHubId: provenance?.hub_id ?? null };
    });
    type Result = ConversationResult;
    if (prepared.turn.state === 'completed') return this.run(state, async () => prepared.turn.result as Result);
    const input: ModelInput = { personId: prepared.principal.personId, history: prepared.history, text: body.text, evidence: [],
      execution: { operationId: prepared.turn.id, runId: prepared.turn.run_id, hubId: prepared.executionHubId, principal: prepared.principal, sessionId: state.session!.id } };
    // A pending turn after a crash is never reclaimed for dispatch, even after an HTTP lease expires.
    const reply = prepared.fresh ? await this.model.respond(input) : await this.model.recover?.(input);
    if (!prepared.fresh && !this.model.recover) return this.run(state, async (trx, p) => {
      const turn = (await assistantModelTurns.lock(trx, prepared.turn.id))!;
      if (turn.state === 'completed') return turn.result as Result;
      let run = await trx.selectFrom('run').selectAll().where('id', '=', turn.run_id).forUpdate().executeTakeFirstOrThrow();
      if (!['cancelled', 'failed', 'completed'].includes(run.state)) run = (await runs.setState(trx, run.id, 'failed'))!;
      return this.finishUnavailableTurn(trx, p, turn, run);
    });
    if (!reply) throw new ApiError('validation.idempotency_in_progress', 'model outcome unresolved');
    return this.run(state, async (trx, p) => {
      const turn = await assistantModelTurns.lock(trx, prepared.turn.id);
      if (!turn) throw new ApiError('access.not_found', 'turn not found');
      if (turn.state === 'completed') return turn.result as Result;
      const run = await trx.selectFrom('run').selectAll().where('id', '=', turn.run_id).forUpdate().executeTakeFirst();
      const asked = await trx.selectFrom('conversation_turn').selectAll().where('id','=',turn.asked_id).executeTakeFirst();
      if (!run || !asked) throw new ApiError('access.not_found', 'active conversation not found');
      if (['cancelled', 'failed', 'completed'].includes(run.state)) return this.finishUnavailableTurn(trx, p, turn, run);
      await runSteps.append(trx, { run_id: run.id, kind: 'model_call', tool: null, input_digest: computeDigest({ text: body.text }).value, output_ref: { provider: this.model.provider, usage: reply.usage, toolCalls: reply.toolCalls.length }, state: 'succeeded' });
      const proposals: ReturnType<typeof proposalView>[] = [];
      const actions: ActionProposalResult[] = [];
      const citations: string[] = [];
      for (const call of reply.toolCalls) {
        // Each tool call is isolated: a refusal (limit, budget, private field) is recorded and the turn continues.
        await sql`SAVEPOINT assistant_tool_call`.execute(trx);
        try {
          const outcome = await this.applyToolCall(trx, p, run.id, call);
          if (outcome.kind === 'proposal') proposals.push(outcome.proposal);
          if (outcome.kind === 'action') actions.push(outcome.result);
          if (outcome.kind === 'citations') citations.push(...outcome.ids);
          await sql`RELEASE SAVEPOINT assistant_tool_call`.execute(trx);
        } catch (error) {
          await sql`ROLLBACK TO SAVEPOINT assistant_tool_call`.execute(trx);
          const hint = (error as { hint?: string }).hint;
          const reason = typeof hint === 'string' ? hint : error instanceof ApiError ? error.code : 'refused';
          await runSteps.append(trx, { run_id: run.id, kind: 'decision', tool: call.kind, output_ref: { reason }, state: 'denied' });
          if (call.kind === 'propose_action') actions.push({ state: 'denied', reason });
        }
      }
      const answer = await conversationTurns.append(trx, { person_id: p.personId, role: reply.text ? 'agent' : 'system', content: reply.text ?? reply.messageKey ?? 'assistant.overlay.stateUnavailable', run_id: run.id });
      const intents = await actionIntents.listForRun(trx, run.id);
      if (intents.length === 0) await runs.setState(trx, run.id, 'completed');
      const finished = (await runs.get(trx, run.id))!;
      const result: Result = { run: runView(finished), turns: [turnView(asked), turnView(answer)], proposals, actions, citations };
      await assistantModelTurns.finish(trx, turn.id, result);
      return result;
    });
  }

  private async applyToolCall(trx: Transaction, p: Principal, runId: string, call: ModelToolCall):
    Promise<{ kind: 'proposal'; proposal: ReturnType<typeof proposalView> } | { kind: 'action'; result: ActionProposalResult } | { kind: 'citations'; ids: string[] } | { kind: 'recorded' }> {
    switch (call.kind) {
      case 'propose_mandate_change': {
        const row = await this.proposeMandateChange(trx, p, { kind: 'chat_intent', runId }, call.mandateId, call.draft);
        await runSteps.append(trx, { run_id: runId, kind: 'decision', tool: 'core.propose_mandate_change', output_ref: { proposalId: row.id }, state: 'recorded' });
        return { kind: 'proposal', proposal: proposalView(row) };
      }
      case 'propose_action':
        return { kind: 'action', result: await this.proposeAction(trx, p, runId, call) };
      case 'retrieve': {
        const result = await this.retrieval.search(
          { query: call.query.slice(0, 1000), kinds: ['publication', 'company', 'project', 'conversation'], temporal: { kind: 'current' }, topK: 5, filters: {} },
          { principalId: p.personId, scopeFingerprint: `person:${p.personId}`, policyEpoch: String(p.authzEpoch) },
        );
        const ids = result.evidence.map((e) => e.citation.id);
        await runSteps.append(trx, { run_id: runId, kind: 'tool_call', tool: 'core.ask_cited', input_digest: computeDigest({ query: call.query }).value, output_ref: { status: result.status, citations: ids }, state: 'succeeded' });
        return { kind: 'citations', ids };
      }
      case 'propose_backlog_item': {
        const row = await serviceBacklog.propose(trx, { person_id: p.personId, title: call.title.slice(0, 200), proposal: call.proposal, source_run_id: runId });
        await runSteps.append(trx, { run_id: runId, kind: 'decision', tool: 'core.propose_backlog_item', output_ref: { backlogItemId: row.id }, state: 'recorded' });
        return { kind: 'recorded' };
      }
    }
  }

  /**
   * An inert proposal of a new mandate or of the next revision of one: status `draft`, no confirmation. Only the
   * principal's confirmation on the first-party form (`confirmProposal`) can turn it into authority.
   */
  async proposeMandateChange(trx: Transaction, p: Principal, origin: { kind: 'chat_intent' | 'agent'; runId: string } | { kind: 'goal'; goalId: string }, mandateId: string | null, draft: MandateDraft): Promise<MandateProposalRow> {
    let basis: MandateV2 | null = null;
    if (mandateId !== null) {
      const row = isUuid(mandateId) ? await mandates.get(trx, mandateId) : undefined;
      basis = row ? mandateOf(row) : null;
      if (!basis) throw new ApiError('access.not_found', 'mandate not found');
    }
    const proposed = MandateV2Schema.parse({
      id: basis?.id ?? randomUUID(), schemaVersion: 2, principal: { personId: p.personId, onBehalfOf: draft.onBehalfOf }, grantee: draft.grantee, moduleKeys: draft.moduleKeys, actions: draft.actions,
      contexts: draft.contexts, limits: draft.limits, conditions: draft.conditions, approvalPolicy: draft.approvalPolicy, approvers: draft.approvers, escalation: draft.escalation,
      confirmation: null, validUntil: draft.validUntil, status: 'draft', revision: (basis?.revision ?? 0) + 1, revokedAt: null,
    });
    // The pure gate says the same: an agent or chat actor only ever proposes.
    if (mandateChangeAllowed({ kind: origin.kind === 'goal' ? 'goal' : origin.kind === 'agent' ? 'agent' : 'chat' }, basis, proposed) !== 'mandate.proposal_only') throw new Error('unreachable: agents only propose');
    return mandateProposals.insert(trx, {
      principal_person_id: p.personId, mandate_id: basis?.id ?? null, basis_revision: basis?.revision ?? null, origin_kind: origin.kind, origin, proposed, digest: mandateDigest(proposed),
    });
  }

  /**
   * An action proposed by the agent inside a run. The payload must carry no private constraint; the policy decides
   * allow (budget reserved and dispatch queued at once), ask (a decision waiting for the person) or deny (recorded,
   * nothing else happens).
   */
  async proposeAction(trx: Transaction, p: Principal, runId: string, call: Extract<ModelToolCall, { kind: 'propose_action' }>): Promise<ActionProposalResult> {
    const deny = async (reason: string): Promise<ActionProposalResult> => {
      await runSteps.append(trx, { run_id: runId, kind: 'decision', tool: call.capabilityId, output_ref: { reason }, state: 'denied' });
      return { state: 'denied', reason };
    };
    try {
      assertShareable(call.effect.payload);
    } catch (error) {
      if (error instanceof PrivateFieldError) return deny('private_field');
      throw error;
    }
    if (!call.capabilityId.startsWith(`${call.moduleKey}.`) || !/^[a-z][a-z0-9_]{1,40}$/.test(call.effect.provider) || !/^[a-z][a-z0-9_.]{1,80}$/.test(call.effect.operation)) return deny('invalid_capability');
    const provenance = await trx.selectFrom('agent_run_provenance').select('hub_id').where('run_id', '=', runId).where('principal_person_id', '=', p.personId).executeTakeFirst();
    if (!provenance) return deny('hub_provenance_unavailable');
    const context: ContextRef = call.context;
    const { outcome, row } = await decide(trx, { personId: p.personId, mandateId: call.mandateId, moduleKeys: [call.moduleKey], action: call.action, context, amount: call.amount, projectId: call.projectId, at: this.now() }, { ...this.settings, hubId: provenance.hub_id });
    if (outcome.effect === 'deny' || !row) return deny(outcome.effect === 'deny' ? outcome.reason : 'not_found');
    {
      const gate = this.capabilityGate ?? agentRuntimeGate(new CapabilityAuthority({ hubId: provenance.hub_id }));
      const refused = await gate(trx, {
        hubId: provenance.hub_id, personId: p.personId, mandate: { onBehalfCompanyId: row.on_behalf_company_id, granteeKind: row.grantee_kind, granteeCompanyId: row.grantee_company_id }, capabilityId: call.capabilityId, action: call.action,
      });
      if (refused) return deny(refused.reason);
    }
    const capability = await sql<{ document: { kind: string; confirmation: string } | null }>`SELECT
      trustwork.agent_modules_capability_binding(${provenance.hub_id}::uuid,${call.capabilityId}) AS document`.execute(trx);
    const bound = capability.rows[0]?.document;
    if (!bound) return deny('capability.unknown');
    if (bound.kind === 'govern' || ['first_party_form', 'first_party_step_up', 'person_each', 'person_each_step_up'].includes(bound.confirmation)) return deny('first_party_required');
    const handler = await sql<{ allowed: boolean }>`SELECT trustwork.agent_modules_effect_binding(
      ${provenance.hub_id}::uuid,${call.capabilityId},${call.effect.provider},${call.effect.operation}) AS allowed`.execute(trx);
    if (!handler.rows[0]?.allowed) return deny('handler_unavailable');
    const recorded = await actionIntents.record(trx, {
      runId, mandateId: row.id, mandateRevision: row.revision, capabilityId: call.capabilityId, moduleKey: outcome.moduleKey, action: call.action, context: outcome.context,
      resolvedFromSelector: outcome.resolvedFromSelector, amount: call.amount,
      digest: actionDigest({ mandate: { id: row.id, revision: row.revision }, capabilityId: call.capabilityId, action: call.action, context: outcome.context, amount: call.amount, effect: call.effect }),
      effect: call.effect, decision: outcome.effect, askReasons: outcome.effect === 'ask' ? outcome.reasons : [],
    });
    const intentId = recorded.intentId!;
    if (recorded.state === 'authorized') {
      await actionIntents.queue(trx, intentId, this.runtime.reservationTtlSeconds, call.projectId ?? (context.kind === 'project' ? context.id : null));
      await runSteps.append(trx, { run_id: runId, kind: 'decision', tool: call.capabilityId, output_ref: { intentId }, state: 'allowed' });
      await this.audit(trx, p, null, 'assistant.action_queued', 'action_intent', intentId, { capabilityId: call.capabilityId, mandateId: row.id, revision: row.revision, via: 'agent' });
      return { state: 'queued', intentId, reasons: [] };
    }
    const reasons = outcome.effect === 'ask' ? outcome.reasons : [];
    await runSteps.append(trx, { run_id: runId, kind: 'decision', tool: call.capabilityId, output_ref: { intentId, reasons }, state: 'asked' });
    return { state: 'proposed', intentId, reasons };
  }
}

/** The project a reservation is scoped to: the action's project context, if any. */
function projectOf(intent: ActionIntentRow): string | null {
  return intent.context_kind === 'project' && isUuid(intent.context_id) ? intent.context_id : null;
}
/** The editable fields of a mandate (what a proposal shows and a confirmation repeats). */
function draftOf(m: MandateV2): MandateDraft {
  return {
    onBehalfOf: m.principal.onBehalfOf, grantee: m.grantee, moduleKeys: m.moduleKeys, actions: m.actions, contexts: m.contexts, limits: m.limits, conditions: m.conditions,
    approvalPolicy: m.approvalPolicy, approvers: m.approvers, escalation: m.escalation, validUntil: m.validUntil,
  };
}
