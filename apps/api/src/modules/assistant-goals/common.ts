import { createHmac, randomBytes } from 'node:crypto';
import { DIGEST_ALGORITHM, type Digest, type Principal } from '../../deps/contracts.js';
import { auditEvents, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import { mapDatabaseError } from '../procurement/common.js';
import type {
  AgentEnvelopeRow, AgentEscalationRow, AgentReportRow, CompanyMandateRow, CompanyRepresentativeRow, GoalProgressRow, GoalRow, JobSubscriptionRow, NegotiationSessionRow,
} from './deps.js';

type ErrorCode = ConstructorParameters<typeof ApiError>[0];
export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : iso(value));
export const digestOf = (value: string): Digest => ({ algorithm: DIGEST_ALGORITHM, value });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Database hints of the agents commands (and the AST-001 commands they call), mapped to frozen contract codes. */
const HINTS: Record<string, { code: ErrorCode; reason: string }> = {
  'access.not_found': { code: 'access.not_found', reason: 'not_found' },
  'access.approval_digest_mismatch': { code: 'access.approval_digest_mismatch', reason: 'digest_mismatch' },
  'validation.revision_conflict': { code: 'validation.revision_conflict', reason: 'revision_conflict' },
  'mandate.not_principal': { code: 'access.forbidden', reason: 'not_principal' },
  'mandate.authority_basis': { code: 'access.forbidden', reason: 'authority_basis' },
  'mandate.budget_authority': { code: 'commercial.authority_missing', reason: 'budget_authority' },
  'mandate.invalid': { code: 'validation.schema', reason: 'mandate_invalid' },
  'mandate.final': { code: 'validation.schema', reason: 'mandate_final' },
  'mandate.not_active': { code: 'access.mandate_revoked', reason: 'mandate_not_active' },
  'mandate.limit': { code: 'access.mandate_scope', reason: 'mandate_limit' },
  'mandate.proposal_not_pending': { code: 'validation.revision_conflict', reason: 'proposal_not_pending' },
  'goal.not_proposed': { code: 'validation.revision_conflict', reason: 'goal_not_proposed' },
  'goal.proposals_unconfirmed': { code: 'validation.revision_conflict', reason: 'goal_proposals_unconfirmed' },
  'goal.basis_changed': { code: 'validation.revision_conflict', reason: 'goal_basis_changed' },
  'goal.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'goal.final': { code: 'validation.revision_conflict', reason: 'goal_final' },
  'goal.immutable': { code: 'validation.schema', reason: 'immutable' },
  'goal.not_principal': { code: 'access.forbidden', reason: 'not_principal' },
  'agents.immutable': { code: 'validation.schema', reason: 'immutable' },
  'agents.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'agents.command_only': { code: 'access.forbidden', reason: 'command_only' },
  'agents.report_private': { code: 'validation.schema', reason: 'report_private' },
  'agents.share_colleagues_only': { code: 'access.forbidden', reason: 'share_colleagues_only' },
  'agents.not_company_admin': { code: 'membership.permission_missing', reason: 'not_company_admin' },
  'agents.accountable_without_authority': { code: 'membership.permission_missing', reason: 'accountable_without_authority' },
  'agents.grant_without_authority': { code: 'membership.permission_missing', reason: 'grant_without_authority' },
  'agents.executor_not_colleague': { code: 'access.forbidden', reason: 'executor_not_colleague' },
  'agents.no_representative': { code: 'validation.revision_conflict', reason: 'no_representative' },
  'agents.not_company_grantee': { code: 'validation.schema', reason: 'not_company_grantee' },
  'agents.not_awaiting_reconfirmation': { code: 'validation.revision_conflict', reason: 'not_awaiting_reconfirmation' },
  'agents.reconfirmation_lapsed': { code: 'validation.revision_conflict', reason: 'reconfirmation_lapsed' },
  'agents.reconfirmation_mismatch': { code: 'access.forbidden', reason: 'reconfirmation_mismatch' },
  'agents.representative_inactive': { code: 'access.mandate_revoked', reason: 'representative_inactive' },
  'envelope.invalid': { code: 'validation.schema', reason: 'envelope_invalid' },
  'envelope.outside_mandate': { code: 'access.mandate_scope', reason: 'outside_mandate' },
  'envelope.dispatch_blocked': { code: 'access.mandate_revoked', reason: 'dispatch_blocked' },
  'envelope.context_parties': { code: 'access.forbidden', reason: 'context_parties' },
  'envelope.ref_invalid': { code: 'validation.schema', reason: 'ref_invalid' },
  'envelope.ref_mismatch': { code: 'commercial.digest_mismatch', reason: 'ref_mismatch' },
  'envelope.ref_not_between_parties': { code: 'access.forbidden', reason: 'ref_not_between_parties' },
  'envelope.ref_unverifiable': { code: 'validation.schema', reason: 'ref_unverifiable' },
  'envelope.refs_required': { code: 'validation.schema', reason: 'refs_required' },
  'envelope.private_constraint': { code: 'access.forbidden', reason: 'private_constraint' },
  'envelope.competitor_pricing': { code: 'access.forbidden', reason: 'competitor_pricing' },
  'envelope.rate_limited': { code: 'auth.throttled', reason: 'rate_limited' },
  'negotiation.no_session': { code: 'validation.revision_conflict', reason: 'no_session' },
  'negotiation.closed': { code: 'validation.revision_conflict', reason: 'session_closed' },
  'negotiation.not_your_turn': { code: 'validation.revision_conflict', reason: 'not_your_turn' },
  'auth.step_up_required': { code: 'auth.step_up_required', reason: 'step_up_required' },
};
export function mapAgentsError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDatabaseError(error);
}

/** Settings of agent-to-agent work; protection limits come from the hub agent policy when HUB-002 stores it. */
export interface AgentsSettings {
  hubId: string | null;
  /** Protection limits (identical across plans, never purchasable): `maxNegotiationRounds`, `envelopesPerCounterpartyPerDay`. */
  maxNegotiationRounds: number;
  envelopesPerCounterpartyPerDay: number;
  sessionTtlSeconds: number;
  homeNode: string;
  /** Node key for the keyed mandate proof (`hmac-sha256`); an ephemeral random key when none is configured. */
  proofKey: { keyId: string; secret: Buffer };
}
export function agentsSettingsFromEnv(env: NodeJS.ProcessEnv = process.env, hubId: string | null = null): AgentsSettings {
  const configured = env.TRUSTWORK_ENVELOPE_PROOF_KEY?.trim();
  const node = env.TRUSTWORK_NODE_ID?.trim();
  return {
    hubId,
    maxNegotiationRounds: 6,
    envelopesPerCounterpartyPerDay: 20,
    sessionTtlSeconds: 14 * 24 * 3600,
    homeNode: node && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(node) ? node : 'node-local',
    proofKey: configured && /^[0-9a-f]{64,}$/i.test(configured) ? { keyId: 'node-key-1', secret: Buffer.from(configured, 'hex') } : { keyId: 'node-key-ephemeral', secret: randomBytes(32) },
  };
}
/** Keyed proof that a mandate revision exists, without revealing its content (`MandateProofSchema`). */
export function mandateProof(settings: AgentsSettings, subject: string): { algorithm: 'hmac-sha256'; keyId: string; value: string } {
  return { algorithm: 'hmac-sha256', keyId: settings.proofKey.keyId, value: createHmac('sha256', settings.proofKey.secret).update(subject).digest('hex') };
}

/** Shared base: every route runs in one principal transaction that also completes its idempotency record (BE-005). */
export abstract class AgentsBase {
  protected constructor(protected readonly ctx: AppContext, protected readonly principals: { runAs<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> }) {}
  protected now(): Date {
    return this.ctx.clock.now();
  }
  protected run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapAgentsError);
  }
  protected steppedUp(state: RequestState): boolean {
    return state.session !== null && this.now().getTime() - state.session.authenticatedAt.getTime() <= this.ctx.config.session.stepUpMs;
  }
  protected async audit(trx: Transaction, p: Principal, state: RequestState | null, action: string, objectKind: string, objectId: string, basis: unknown, company: string | null = null): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: p.personId, on_behalf_of_company_id: company, action, object_kind: objectKind, object_id: objectId, request_id: state?.requestId ?? null, authz_epoch: p.authzEpoch, basis });
  }
  /** The principal's active employer, or a refusal when the request names another company. */
  protected employer(p: Principal, companyId: string): string {
    if (!p.membership || p.membership.companyId !== companyId) throw new ApiError('access.not_found', 'company not found');
    return companyId;
  }
}

/* ---------- Views (each is the reader's own projection; nothing private crosses parties) ---------- */

export function goalView(row: GoalRow) {
  return {
    id: row.id, principal: { personId: row.principal_person_id, onBehalfOf: row.on_behalf_company_id ? { kind: 'company' as const, id: row.on_behalf_company_id } : null },
    text: row.text, successCriteria: row.success_criteria, allowedActions: row.allowed_actions, needs: row.needs, budgetRange: row.budget_range, horizon: iso(row.horizon),
    reportCadence: row.report_cadence, status: row.status, outcome: row.outcome, proposedBy: row.proposed_by, mandateIds: row.mandate_ids, proposalIds: row.proposal_ids,
    confirmation: row.confirmed_at ? { via: 'first_party_form' as const, personId: row.confirmed_by_person_id, at: iso(row.confirmed_at), stepUp: row.confirmed_step_up } : null,
    revision: row.revision, createdAt: iso(row.created_at),
  };
}
export function progressView(row: GoalProgressRow) {
  return { id: row.id, eventKind: row.event_kind, evidenceRefs: row.evidence_refs, detail: row.detail, at: iso(row.at) };
}
export function jobSubscriptionView(row: JobSubscriptionRow) {
  return { id: row.id, moduleKey: row.module_key, jobTemplateKey: row.job_template_key, trigger: row.trigger, goalId: row.goal_id, mandateId: row.mandate_id, status: row.status, revision: row.revision };
}
export function reportView(row: AgentReportRow, viewerId: string) {
  const owner = row.author_person_id === viewerId;
  return {
    id: row.id, authorPersonId: row.author_person_id, principalCompanyId: row.principal_company_id, goalId: row.goal_id, generatedByRunId: row.run_id,
    period: { from: iso(row.period_from), to: iso(row.period_to) }, sections: row.sections, audience: row.audience,
    // Colleagues a report was shared with see the report, not the list of other readers.
    sharedWith: owner ? row.shared_with : [], revision: row.revision,
  };
}
const party = (kind: 'person' | 'company', id: string) => ({ kind, id });
/** What both parties see of an envelope: the shared row only (no sender mandate, no receiver decision). */
export function envelopeView(row: AgentEnvelopeRow) {
  return {
    id: row.id, envelopeVersion: 1 as const, from: party(row.from_kind, row.from_id), fromPersonId: row.from_person_id, actorKind: row.actor_kind, actorLabelKey: row.actor_label_key,
    accountablePersonId: row.accountable_person_id, to: party(row.to_kind, row.to_id), context: { kind: row.context_kind, id: row.context_id }, intent: row.intent, refs: row.refs,
    note: row.note_text === null ? null : { text: row.note_text, trust: 'untrusted' as const, locale: row.note_locale }, mandateProof: row.mandate_proof, negotiationSessionId: row.session_id,
    homeNode: row.home_node, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
  };
}
export function sessionView(row: NegotiationSessionRow, now: Date) {
  const expired = row.status === 'open' && row.expires_at.getTime() <= now.getTime();
  return {
    id: row.id, context: { kind: row.context_kind, id: row.context_id }, parties: [party(row.party_a_kind, row.party_a_id), party(row.party_b_kind, row.party_b_id)],
    maxRounds: row.max_rounds, roundsUsed: row.rounds_used, turn: row.turn_kind && row.turn_id ? party(row.turn_kind, row.turn_id) : null, expiresAt: iso(row.expires_at),
    status: expired ? 'expired' : row.status, escalationReason: expired ? 'expired' : row.escalation_reason, revision: row.revision,
  };
}
export function escalationView(row: AgentEscalationRow) {
  return {
    id: row.id, owner: party(row.owner_kind, row.owner_id), source: row.source, envelopeId: row.envelope_id, sessionId: row.session_id, companyMandateId: row.company_mandate_id,
    context: row.context_kind && row.context_id ? { kind: row.context_kind, id: row.context_id } : null, intent: row.intent, status: row.status, createdAt: iso(row.created_at),
    resolvedAt: isoOrNull(row.resolved_at), revision: row.revision,
  };
}
export function representativeView(row: CompanyRepresentativeRow, blockedBy: 'hub_kill_switch' | 'node_kill_switch' | null) {
  return {
    id: row.id, companyId: row.company_id, accountablePersonId: row.accountable_person_id, status: row.status, suspensionReason: row.suspension_reason, blockedBy,
    labelKey: 'agents.label.representative' as const, acceptedAt: isoOrNull(row.accepted_at), revision: row.revision,
  };
}
export function companyMandateView(row: CompanyMandateRow, now: Date) {
  const lapsed = row.status === 'awaiting_reconfirmation' && row.reconfirm_due_at !== null && row.reconfirm_due_at.getTime() <= now.getTime();
  return {
    id: row.id, companyId: row.company_id, mandateId: row.mandate_id, grantedByPersonId: row.granted_by_person_id,
    executor: row.executor_kind === 'company_representative' ? { kind: 'company_representative' as const, representativeId: row.representative_id as string } : { kind: 'colleague_agent' as const, personId: row.executor_person_id as string },
    terms: row.terms, termsDigest: digestOf(row.terms_digest), status: lapsed ? 'suspended' : row.status, statusReason: lapsed ? 'reconfirmation_lapsed' : row.status_reason,
    reconfirmDueAt: lapsed ? null : isoOrNull(row.reconfirm_due_at), reconfirmedAt: isoOrNull(row.reconfirmed_at), revision: row.revision,
  };
}
