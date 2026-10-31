import type { z } from 'zod';
import type { Party, Principal } from '../../deps/contracts.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { columnsOf, partyOf } from '../execution/execution.service.js';
import { iso, isoDate, mapDatabaseError, UUID } from '../procurement/common.js';
import {
  AppealLinkSchema, buildLimitation, classifyTimeliness, confirmationRequests, confirmationResponses, confirmationStatus, ConfirmationInboxViewSchema, credentials, credentialStatus,
  derivedRecords, LIMITATION_REASONS, portfolio, relations, REPUTATION_APPEAL_HREF, REPUTATION_EVENT_PAYLOAD_KEYS, REPUTATION_RULES, reputationAppeals, ReputationAppealViewSchema,
  ReputationBuilderOwnViewSchema, ReputationBuilderPublicViewSchema, reputationPublic, summarizeTimeliness, trustAppeals,
  type AnswerConfirmationCommandSchema, type AppealLimitationCommandSchema, type AppealStatus, type ConfirmationInboxView, type ConfirmationRequestRow, type ConfirmationRequestView,
  type ConfirmationResponseRow, type CreatePortfolioEntryCommandSchema, type DeclareRelationCommandSchema, type FileReputationAppealCommandSchema, type LimitationReasonCode,
  type LimitationRef, type RecordCredentialCommandSchema, type ReputationBuilderOwnView, type ReputationBuilderPublicView, type RequestConfirmationCommandSchema,
} from './deps.js';
import { boundedLookup, type CredentialRegisterPort } from './register.js';

type In<T extends z.ZodType> = z.infer<T>;
type EventPayload = Partial<Record<(typeof REPUTATION_EVENT_PAYLOAD_KEYS)[number], string | null>>;
type AppealView = z.infer<typeof ReputationAppealViewSchema>;

/** Refusals that are automated limitations of a person: they carry the limitation with its appeal link. */
const LIMITATION_CODES = new Set<string>(Object.keys(LIMITATION_REASONS));
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'reputation.not_found': { code: 'access.not_found', reason: 'not_found' },
  'reputation.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'reputation.no_recorded_relationship': { code: 'access.forbidden', reason: 'no_recorded_relationship' },
  'reputation.self_confirmation': { code: 'access.forbidden', reason: 'self_confirmation' },
  'reputation.employee_of_subject': { code: 'access.forbidden', reason: 'employee_of_subject' },
  'reputation.relative_of_subject': { code: 'access.forbidden', reason: 'relative_of_subject' },
  'reputation.already_requested': { code: 'validation.revision_conflict', reason: 'already_requested' },
  'reputation.rate_limited': { code: 'auth.throttled', reason: 'rate_limited' },
  'reputation.reminder_already_sent': { code: 'validation.revision_conflict', reason: 'reminder_already_sent' },
  'reputation.reminder_too_early': { code: 'validation.revision_conflict', reason: 'reminder_too_early' },
  'reputation.request_closed': { code: 'validation.revision_conflict', reason: 'request_closed' },
  'reputation.already_answered': { code: 'validation.revision_conflict', reason: 'already_answered' },
  'reputation.limitation_not_found': { code: 'access.not_found', reason: 'limitation_not_found' },
  'reputation.appeal_kind': { code: 'validation.schema', reason: 'appeal_kind' },
  'reputation.append_only': { code: 'validation.revision_conflict', reason: 'append_only' },
  'trust.not_found': { code: 'access.not_found', reason: 'not_found' },
  'trust.appeal_kind': { code: 'validation.schema', reason: 'appeal_kind' },
};
/** Unique constraints whose violation means a rule already decided the outcome (concurrent duplicates). */
const CONSTRAINTS: Record<string, string> = {
  confirmation_request_once: 'already_requested',
  confirmation_response_confirmation_request_id_key: 'already_answered',
  relation_declaration_once: 'already_declared',
  appeal_one_path: 'appeal_exists',
  professional_credential_supersedes_id_key: 'already_corrected',
  portfolio_entry_supersedes_id_key: 'already_corrected',
};

/** Maps a database refusal; a refusal that limits the person carries the limitation built from `ref`. */
function mapReputationError(error: unknown, ref?: (code: LimitationReasonCode) => LimitationRef): never {
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    let reason = pg.hint ? HINTS[pg.hint]?.reason : undefined;
    let code = pg.hint ? HINTS[pg.hint]?.code : undefined;
    if (!reason && pg.code === '23505' && pg.constraint && CONSTRAINTS[pg.constraint]) {
      reason = CONSTRAINTS[pg.constraint];
      code = 'validation.revision_conflict';
    }
    if (reason && code) {
      const details: Record<string, unknown> = { reason };
      if (ref && LIMITATION_CODES.has(reason)) {
        const limitationRef = ref(reason as LimitationReasonCode);
        const evidence = limitationRef.scope === 'confirmation_request' ? [limitationRef.context] : [{ kind: 'confirmation_request', id: limitationRef.requestId }];
        details.limitation = buildLimitation(reason as LimitationReasonCode, { evidence, limitation: limitationRef });
      }
      throw new ApiError(code, reason, details);
    }
  }
  return mapDatabaseError(error);
}

const ts = (value: Date | string | null): string | null => (value === null ? null : iso(value));
const day = (value: Date | string | null): string | null => (value === null ? null : isoDate(value));
const appealStatus = (status: string | undefined): AppealStatus | null => (status === undefined ? null : status as AppealStatus);

export interface ReputationServiceOptions {
  /** The hub this API serves (TRUSTWORK_HUB_ID): credential checks are recorded by it and appeals go to its queue. */
  hubId: string | null | (() => string | null);
  register: CredentialRegisterPort;
}

/**
 * The reputation builder (REP-001). The subject records credentials (checked through the hub's register adapter),
 * portfolio entries on contexts it took part in, and declared close relationships; it asks real counterparties to
 * confirm, once plus one reminder; counterparties answer in person; contributions and timeliness are derived from
 * canonical records when the subject reads its own view; refusals and exclusions carry a reason code, evidence and an
 * appeal path. One `withPrincipal` transaction per request (BE-005); outbox events carry identifiers only. Nothing here
 * reads a billing table or changes a reputation snapshot.
 */
export class ReputationService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly options: ReputationServiceOptions) {}

  private now(): Date {
    return this.ctx.clock.now();
  }
  private hub(): string {
    const hubId = typeof this.options.hubId === 'function' ? this.options.hubId() : this.options.hubId;
    if (!hubId) throw new ApiError('validation.schema', 'this needs the hub this API serves (TRUSTWORK_HUB_ID)', { reason: 'hub_not_configured' });
    return hubId;
  }
  private run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>, ref?: (code: LimitationReasonCode) => LimitationRef): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => mapReputationError(error, ref));
  }
  private actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  private requireActsFor(principal: Principal, party: Party): void {
    if (!UUID.test(party.id)) throw new ApiError('access.not_found');
    if (!this.actsFor(principal, party)) throw new ApiError('access.forbidden', 'you act for yourself or the company whose deals you manage', { reason: 'not_authorised' });
  }
  private async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }
  private async event(trx: Transaction, aggregateKind: string, aggregateId: string, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(REPUTATION_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision: 1, type, payload });
  }

  /* ---------- Views ---------- */

  private requestView(r: ConfirmationRequestRow, response: ConfirmationResponseRow | undefined, appeal: string | undefined): ConfirmationRequestView {
    const status = confirmationStatus({ withdrawnAt: ts(r.withdrawn_at), dueAt: iso(r.due_at), decision: response?.decision ?? null }, this.now());
    const reminderAvailableAt = status === 'requested' && r.reminder_sent_at === null ? iso(new Date(new Date(r.requested_at).getTime() + REPUTATION_RULES.reminderDelayDays * 86_400_000)) : null;
    return {
      id: r.id, requester: partyOf(r.requester_person_id, r.requester_company_id), addressedTo: partyOf(r.addressed_person_id, r.addressed_company_id),
      context: { kind: r.context_kind, id: r.context_id }, portfolioEntryId: r.portfolio_entry_id, statementKind: r.statement_kind, statement: r.statement, status,
      requestedAt: iso(r.requested_at), dueAt: iso(r.due_at), reminderSentAt: ts(r.reminder_sent_at), reminderAvailableAt, withdrawnAt: ts(r.withdrawn_at),
      response: response ? { id: response.id, decision: response.decision, comment: response.comment, consentToShow: response.consent_to_show, respondedAt: iso(response.responded_at), appeal: appealStatus(appeal) } : null,
    };
  }

  private async requestViews(trx: Transaction, rows: ConfirmationRequestRow[]): Promise<ConfirmationRequestView[]> {
    const responses = await confirmationResponses.forRequests(trx, rows.map((r) => r.id));
    const appeals = await reputationAppeals.states(trx, 'confirmation_response', responses.map((x) => x.id));
    return rows.map((r) => {
      const response = responses.find((x) => x.confirmation_request_id === r.id);
      return this.requestView(r, response, response ? appeals.get(response.id) : undefined);
    });
  }

  /** The subject's own view; derives contribution and timeliness records from canonical records first (idempotent). */
  private async ownView(trx: Transaction, subject: Party, principal: Principal): Promise<ReputationBuilderOwnView> {
    const cols = columnsOf(subject);
    await derivedRecords.derive(trx, cols);
    const today = isoDate(this.now().toISOString());
    const [credentialRows, entryRows, sentRows, contributionRows, timelinessRows, limitationRows, relationRows] = await Promise.all([
      credentials.listFor(trx, cols), portfolio.listFor(trx, cols), confirmationRequests.listSent(trx, cols), derivedRecords.contributions(trx, cols), derivedRecords.timeliness(trx, cols),
      derivedRecords.limitations(trx, cols), subject.kind === 'person' && subject.id === principal.personId ? relations.listMine(trx, principal.personId) : Promise.resolve([]),
    ]);
    const checkRows = await credentials.checks(trx, credentialRows.map((c) => c.id));
    const sent = await this.requestViews(trx, sentRows);
    const contributionResponseIds = contributionRows.filter((c) => c.appeal_subject_kind === 'confirmation_response').map((c) => c.appeal_subject_id);
    const observationIds = [...contributionRows.filter((c) => c.appeal_subject_kind === 'performance_observation').map((c) => c.appeal_subject_id), ...timelinessRows.map((t) => t.source_observation_id)];
    const [responseAppeals, observationAppeals, limitationAppeals] = await Promise.all([
      reputationAppeals.states(trx, 'confirmation_response', contributionResponseIds), trustAppeals.states(trx, 'performance_observation', [...new Set(observationIds)]),
      reputationAppeals.states(trx, 'automated_limitation', limitationRows.map((l) => l.id)),
    ]);

    const supersededBy = <T extends { id: string; supersedes_id: string | null }>(rows: T[]) => new Map(rows.filter((r) => r.supersedes_id).map((r) => [r.supersedes_id as string, r.id]));
    const credentialSuperseded = supersededBy(credentialRows);
    const entrySuperseded = supersededBy(entryRows);

    const credentialViews = credentialRows.map((c) => {
      const checks = checkRows.filter((k) => k.credential_id === c.id);
      const last = checks.at(-1);
      return {
        id: c.id, holder: partyOf(c.holder_person_id, c.holder_company_id), kind: c.kind, jurisdiction: c.jurisdiction, credentialType: c.credential_type, issuer: c.issuer, number: c.number,
        classification: c.classification, coverage: c.coverage_minor !== null ? { minorUnits: String(c.coverage_minor), currency: c.coverage_currency as string } : null,
        validFrom: day(c.valid_from), validUntil: day(c.valid_until), visibility: c.visibility, supersedesId: c.supersedes_id, supersededBy: credentialSuperseded.get(c.id) ?? null,
        status: credentialStatus({ validUntil: day(c.valid_until), lastCheck: last ? { outcome: last.outcome, registerValidUntil: day(last.register_valid_until) } : null }, today),
        checks: checks.map((k) => ({ id: k.id, outcome: k.outcome, hubId: k.hub_id, registerCode: k.register_code, registerValidUntil: day(k.register_valid_until), checkedAt: iso(k.checked_at) })),
        createdAt: iso(c.created_at),
      };
    });

    const portfolioViews = entryRows.map((e) => {
      const answers = sent.filter((r) => r.portfolioEntryId === e.id && r.response && (r.response.decision === 'confirmed' || r.response.decision === 'partially')
        && r.response.appeal !== 'overturned');
      const confirmed = answers.at(-1)?.response ?? null;
      const consented = answers.some((r) => r.response?.consentToShow);
      const superseded = entrySuperseded.has(e.id);
      return {
        id: e.id, holder: partyOf(e.holder_person_id, e.holder_company_id), context: e.context_kind && e.context_id ? { kind: e.context_kind, id: e.context_id } : null,
        externalDescription: e.external_description, title: e.title, role: e.role, period: { from: day(e.period_from), to: day(e.period_to) }, scopeSummary: e.scope_summary,
        visibility: e.visibility, supersedesId: e.supersedes_id, supersededBy: entrySuperseded.get(e.id) ?? null, confirmation: confirmed ? 'client_confirmed' as const : 'self_reported' as const,
        confirmedAt: confirmed ? confirmed.respondedAt : null, publiclyShown: e.visibility === 'public' && !superseded && (e.context_id === null || consented), createdAt: iso(e.created_at),
      };
    });

    const contributionViews = contributionRows.map((c) => {
      const status = appealStatus(c.appeal_subject_kind === 'confirmation_response' ? responseAppeals.get(c.appeal_subject_id) : observationAppeals.get(c.appeal_subject_id));
      const subject = { kind: 'contribution_record' as const, id: c.id };
      const code: LimitationReasonCode | null = status === 'submitted' || status === 'in_review' ? 'excluded_appeal_pending' : status === 'overturned' || status === 'partially_overturned' ? 'excluded_appeal_overturned' : null;
      return {
        id: c.id, kind: c.kind, source: { kind: c.source_kind, id: c.source_id }, outcome: c.outcome as Record<string, unknown>, occurredAt: iso(c.occurred_at), counted: code === null,
        limitation: code ? buildLimitation(code, { evidence: [{ kind: c.source_kind, id: c.source_id }], subject }) : null,
        appeal: AppealLinkSchema.parse({ method: 'POST', href: REPUTATION_APPEAL_HREF, subject, limitation: null }), appealStatus: status,
      };
    });

    const timelinessViews = timelinessRows.map((t) => {
      const status = appealStatus(observationAppeals.get(t.source_observation_id));
      const deltaSeconds = t.delta_seconds === null ? null : Number(t.delta_seconds);
      const classified = classifyTimeliness({ id: t.id, agreementId: t.agreement_id, sourceObservationId: t.source_observation_id, deltaSeconds, excludedReason: t.excluded_reason, planChangeIds: t.plan_change_ids, appealStatus: status });
      return {
        id: t.id, kind: t.kind, agreementId: t.agreement_id, sourceObservationId: t.source_observation_id, expectedAt: ts(t.expected_at), actualAt: ts(t.actual_at), deltaSeconds,
        attribution: t.attribution, planChangeIds: t.plan_change_ids, ...classified, appealStatus: status,
      };
    });

    return ReputationBuilderOwnViewSchema.parse({
      projection: 'owner_private', subject, credentials: credentialViews, portfolio: portfolioViews, confirmationsSent: sent, contributions: contributionViews,
      timeliness: { observations: timelinessViews, summary: summarizeTimeliness(timelinessViews) },
      limitations: limitationRows.map((l) => ({
        id: l.id, reasonCode: l.reason_code, scope: l.scope, explanationKey: `reputation.limitation.${l.reason_code}`, evidence: l.evidence, startsAt: iso(l.starts_at), endsAt: ts(l.ends_at),
        appeal: appealStatus(limitationAppeals.get(l.id)),
      })),
      relations: relationRows.map((r) => ({ id: r.id, otherPersonId: r.other_person_id, kind: r.kind, declaredAt: iso(r.declared_at) })),
      publicScore: null,
    });
  }

  async own(subject: Party, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(subject.id) || !this.actsFor(p, subject)) throw new ApiError('access.not_found');
      return this.ownView(trx, subject, p);
    });
  }

  private async inboxView(trx: Transaction, addressedTo: Party): Promise<ConfirmationInboxView> {
    const rows = await confirmationRequests.listAddressed(trx, columnsOf(addressedTo));
    return ConfirmationInboxViewSchema.parse({ projection: 'shared_party', addressedTo, requests: await this.requestViews(trx, rows) });
  }

  async inbox(addressedTo: Party, state: RequestState): Promise<ConfirmationInboxView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(addressedTo.id) || !this.actsFor(p, addressedTo)) throw new ApiError('access.not_found');
      return this.inboxView(trx, addressedTo);
    });
  }

  /** Anyone, signed in or not: public credentials and consented portfolio entries; never numbers, documents or counterparties. */
  async publicView(subject: Party, state: RequestState): Promise<ReputationBuilderPublicView> {
    if (!UUID.test(subject.id)) throw new ApiError('access.not_found');
    const today = isoDate(this.now().toISOString());
    const read = async (trx: Transaction): Promise<ReputationBuilderPublicView> => {
      const cols = columnsOf(subject);
      const [creds, entries] = await Promise.all([reputationPublic.credentials(trx, cols), reputationPublic.portfolio(trx, cols)]);
      return ReputationBuilderPublicViewSchema.parse({
        projection: 'public', subject,
        credentials: creds.map((c) => ({
          kind: c.kind, jurisdiction: c.jurisdiction, credentialType: c.credential_type, issuer: c.issuer, validUntil: day(c.valid_until),
          status: credentialStatus({ validUntil: day(c.valid_until), lastCheck: c.check_outcome ? { outcome: c.check_outcome, registerValidUntil: day(c.register_valid_until) } : null }, today),
          checkedAt: c.check_outcome === 'match' ? ts(c.checked_at) : null, checkedByHubId: c.check_outcome === 'match' ? c.check_hub_id : null,
        })),
        portfolio: entries.map((e) => ({ title: e.title, role: e.role, period: { from: day(e.period_from), to: day(e.period_to) }, scopeSummary: e.scope_summary, confirmation: e.confirmation, confirmedAt: ts(e.confirmed_at) })),
        publicScore: null,
      });
    };
    return (state.principal ? this.principals.runAs(state, (trx) => read(trx)) : withoutPrincipal(this.ctx.pool, read)).catch((error: unknown) => mapReputationError(error));
  }

  /* ---------- Credentials ---------- */

  async recordCredential(input: In<typeof RecordCredentialCommandSchema>, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      this.requireActsFor(p, input.holder);
      if (input.supersedesId !== null && !UUID.test(input.supersedesId)) throw new ApiError('access.not_found');
      const holder = columnsOf(input.holder);
      const row = await credentials.insert(trx, {
        holder_person_id: holder.person, holder_company_id: holder.company, kind: input.kind, jurisdiction: input.jurisdiction, credential_type: input.credentialType, issuer: input.issuer,
        number: input.number, classification: input.classification, coverage_minor: input.coverage?.minorUnits ?? null, coverage_currency: input.coverage?.currency ?? null,
        valid_from: input.validFrom, valid_until: input.validUntil, visibility: input.visibility, supersedes_id: input.supersedesId, recorded_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'reputation.credential_recorded', 'professional_credential', row.id, { holder: input.holder, kind: input.kind, supersedes: input.supersedesId });
      await this.event(trx, 'professional_credential', row.id, 'reputation.credential_recorded', { credentialId: row.id, subjectKind: input.holder.kind, subjectId: input.holder.id });
      return this.ownView(trx, input.holder, p);
    });
  }

  /** Looks the credential up in the hub's register (a read-only adapter call) and records the outcome as the hub's check. */
  async checkCredential(credentialId: string, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(credentialId)) throw new ApiError('access.not_found');
      const credential = await credentials.get(trx, credentialId);
      if (!credential) throw new ApiError('access.not_found');
      const hubId = this.hub();
      const result = await boundedLookup(this.options.register, { jurisdiction: credential.jurisdiction, credentialType: credential.credential_type, issuer: credential.issuer, number: credential.number });
      const check = await credentials.insertCheck(trx, {
        credential_id: credential.id, hub_id: hubId, register_code: this.options.register.code, outcome: result.outcome, register_valid_until: result.validUntil, source_ref: result.sourceRef,
        requested_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'reputation.credential_checked', 'credential_check', check.id, { credentialId, outcome: result.outcome, register: this.options.register.code });
      await this.event(trx, 'professional_credential', credential.id, 'reputation.credential_checked', { credentialId, checkId: check.id });
      return this.ownView(trx, partyOf(credential.holder_person_id, credential.holder_company_id), p);
    });
  }

  /* ---------- Portfolio and relationships ---------- */

  async addPortfolioEntry(input: In<typeof CreatePortfolioEntryCommandSchema>, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      this.requireActsFor(p, input.holder);
      if ((input.context && !UUID.test(input.context.id)) || (input.supersedesId !== null && !UUID.test(input.supersedesId))) throw new ApiError('access.not_found');
      const holder = columnsOf(input.holder);
      const row = await portfolio.insert(trx, {
        holder_person_id: holder.person, holder_company_id: holder.company, context_kind: input.context?.kind ?? null, context_id: input.context?.id ?? null,
        external_description: input.externalDescription, title: input.title, role: input.role, period_from: input.period.from, period_to: input.period.to, scope_summary: input.scopeSummary,
        visibility: input.visibility, supersedes_id: input.supersedesId, recorded_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'reputation.portfolio_entry_added', 'portfolio_entry', row.id, { holder: input.holder, context: input.context, supersedes: input.supersedesId });
      await this.event(trx, 'portfolio_entry', row.id, 'reputation.portfolio_entry_added', { entryId: row.id, subjectKind: input.holder.kind, subjectId: input.holder.id });
      return this.ownView(trx, input.holder, p);
    });
  }

  /** A person declares a close relationship; it blocks confirmations between the two. No event: nobody is notified. */
  async declareRelation(input: In<typeof DeclareRelationCommandSchema>, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(input.otherPersonId)) throw new ApiError('access.not_found');
      if (input.otherPersonId === p.personId) throw new ApiError('validation.schema', 'a relationship is with another person', { reason: 'self_relation' });
      const row = await relations.insert(trx, { declarer_person_id: p.personId, other_person_id: input.otherPersonId, kind: input.kind });
      await this.audit(trx, p, state, 'reputation.relation_declared', 'relation_declaration', row.id, { kind: input.kind });
      return this.ownView(trx, { kind: 'person', id: p.personId }, p);
    });
  }

  /* ---------- Confirmations ---------- */

  async requestConfirmation(input: In<typeof RequestConfirmationCommandSchema>, state: RequestState): Promise<ReputationBuilderOwnView> {
    const ref = (reasonCode: LimitationReasonCode): LimitationRef => ({
      scope: 'confirmation_request', reasonCode, requester: input.requester, addressedTo: input.addressedTo, context: input.context, statementKind: input.statementKind,
    });
    return this.run(state, async (trx, p) => {
      this.requireActsFor(p, input.requester);
      if (!UUID.test(input.addressedTo.id) || !UUID.test(input.context.id) || (input.portfolioEntryId !== null && !UUID.test(input.portfolioEntryId))) throw new ApiError('access.not_found');
      const requester = columnsOf(input.requester);
      const addressed = columnsOf(input.addressedTo);
      const row = await confirmationRequests.insert(trx, {
        requester_person_id: requester.person, requester_company_id: requester.company, addressed_person_id: addressed.person, addressed_company_id: addressed.company,
        context_kind: input.context.kind, context_id: input.context.id, portfolio_entry_id: input.portfolioEntryId, statement_kind: input.statementKind, statement: input.statement,
        no_incentive: input.attestation.noIncentiveOffered, no_conflict: input.attestation.notEmployeeOrRelative, requested_by_person_id: p.personId,
      });
      await this.audit(trx, p, state, 'reputation.confirmation_requested', 'confirmation_request', row.id, { requester: input.requester, addressedTo: input.addressedTo, context: input.context, statementKind: input.statementKind });
      await this.event(trx, 'confirmation_request', row.id, 'reputation.confirmation_requested', { requestId: row.id, subjectKind: input.addressedTo.kind, subjectId: input.addressedTo.id });
      return this.ownView(trx, input.requester, p);
    }, ref);
  }

  private async changeRequest(id: string, state: RequestState, change: 'remind' | 'withdraw'): Promise<ReputationBuilderOwnView> {
    return this.run(state, async (trx, p) => {
      if (!UUID.test(id)) throw new ApiError('access.not_found');
      const row = change === 'remind' ? await confirmationRequests.remind(trx, id) : await confirmationRequests.withdraw(trx, id);
      if (!row) throw new ApiError('access.not_found');
      const requester = partyOf(row.requester_person_id, row.requester_company_id);
      const action = change === 'remind' ? 'reputation.confirmation_reminded' : 'reputation.confirmation_withdrawn';
      await this.audit(trx, p, state, action, 'confirmation_request', row.id, { requester });
      await this.event(trx, 'confirmation_request', row.id, action, { requestId: row.id });
      return this.ownView(trx, requester, p);
    });
  }
  remind(id: string, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.changeRequest(id, state, 'remind');
  }
  withdraw(id: string, state: RequestState): Promise<ReputationBuilderOwnView> {
    return this.changeRequest(id, state, 'withdraw');
  }

  /** The counterparty's person answers in person (no actor field, no agent path); the answer is final and appealable. */
  async answer(id: string, input: In<typeof AnswerConfirmationCommandSchema>, state: RequestState): Promise<ConfirmationInboxView> {
    const ref = (reasonCode: LimitationReasonCode): LimitationRef => ({ scope: 'confirmation_response', reasonCode, requestId: id, onBehalfOf: input.onBehalfOf });
    return this.run(state, async (trx, p) => {
      if (!UUID.test(id)) throw new ApiError('access.not_found');
      this.requireActsFor(p, input.onBehalfOf);
      const request = await confirmationRequests.get(trx, id);
      if (!request) throw new ApiError('access.not_found');
      const onBehalf = columnsOf(input.onBehalfOf);
      const row = await confirmationResponses.insert(trx, {
        confirmation_request_id: id, responder_person_id: p.personId, on_behalf_person_id: onBehalf.person, on_behalf_company_id: onBehalf.company, decision: input.decision,
        comment: input.comment, consent_to_show: input.consentToShow, no_conflict: input.attestation.notEmployeeOrRelative && input.attestation.noIncentiveReceived,
      });
      await this.audit(trx, p, state, 'reputation.confirmation_answered', 'confirmation_response', row.id, { requestId: id, decision: input.decision });
      await this.event(trx, 'confirmation_request', id, 'reputation.confirmation_answered', { requestId: id, responseId: row.id });
      return this.inboxView(trx, input.onBehalfOf);
    }, ref);
  }

  /* ---------- Appeals ---------- */

  /**
   * Appeals of a counterparty's response (DATA-002 queue through reputation_file_appeal) and of timeliness and
   * contribution records (their source decision: EXE-001's trust_file_appeal on the performance observation, or the
   * response). Decided by a person other than the original decider.
   */
  async fileAppeal(input: In<typeof FileReputationAppealCommandSchema>, state: RequestState): Promise<AppealView> {
    return this.run(state, async (trx, p) => {
      const hubId = this.hub();
      if (!UUID.test(input.subject.id)) throw new ApiError('access.not_found');
      let target: { kind: 'confirmation_response' | 'performance_observation'; id: string };
      if (input.subject.kind === 'confirmation_response') target = { kind: 'confirmation_response', id: input.subject.id };
      else if (input.subject.kind === 'timeliness_observation') {
        const row = await trx.selectFrom('timeliness_observation').select(['source_observation_id']).where('id', '=', input.subject.id).executeTakeFirst();
        if (!row) throw new ApiError('access.not_found');
        target = { kind: 'performance_observation', id: row.source_observation_id };
      } else {
        const row = await trx.selectFrom('contribution_record').select(['appeal_subject_kind', 'appeal_subject_id']).where('id', '=', input.subject.id).executeTakeFirst();
        if (!row) throw new ApiError('access.not_found');
        target = { kind: row.appeal_subject_kind, id: row.appeal_subject_id };
      }
      const appeal = target.kind === 'confirmation_response'
        ? await reputationAppeals.file(trx, { hubId, subjectKind: 'confirmation_response', subjectId: target.id, reason: input.reason })
        : await trustAppeals.file(trx, { hubId, subjectKind: 'performance_observation', subjectId: target.id, reason: input.reason });
      await this.audit(trx, p, state, 'reputation.appeal_filed', 'appeal', appeal.id, { subject: input.subject, target });
      await this.event(trx, 'appeal', appeal.id, 'reputation.appeal_filed', { appealId: appeal.id, subjectKind: target.kind, subjectId: target.id });
      return ReputationAppealViewSchema.parse({ id: appeal.id, subject: target, status: appeal.status, filedAt: iso(appeal.filed_at) });
    });
  }

  /** Appeals an automated refusal: the rule is evaluated again, then the limitation and its appeal are recorded together. */
  async appealLimitation(input: In<typeof AppealLimitationCommandSchema>, state: RequestState): Promise<AppealView> {
    return this.run(state, async (trx, p) => {
      const hubId = this.hub();
      const l = input.limitation;
      const ids = l.scope === 'confirmation_request' ? [l.requester.id, l.addressedTo.id, l.context.id] : [l.requestId, l.onBehalfOf.id];
      if (ids.some((x) => !UUID.test(x))) throw new ApiError('access.not_found');
      const appeal = await reputationAppeals.appealLimitation(trx, l.scope === 'confirmation_request'
        ? { hubId, reasonCode: l.reasonCode, scope: l.scope, requester: columnsOf(l.requester), addressed: columnsOf(l.addressedTo), contextKind: l.context.kind, contextId: l.context.id, statementKind: l.statementKind, requestId: null, reason: input.reason }
        : { hubId, reasonCode: l.reasonCode, scope: l.scope, requester: null, addressed: columnsOf(l.onBehalfOf), contextKind: null, contextId: null, statementKind: null, requestId: l.requestId, reason: input.reason });
      await this.audit(trx, p, state, 'reputation.limitation_appealed', 'appeal', appeal.id, { reasonCode: l.reasonCode, scope: l.scope, limitationId: appeal.subject_id });
      await this.event(trx, 'appeal', appeal.id, 'reputation.limitation_appealed', { appealId: appeal.id, limitationId: appeal.subject_id });
      return ReputationAppealViewSchema.parse({ id: appeal.id, subject: { kind: 'automated_limitation', id: appeal.subject_id }, status: appeal.status, filedAt: iso(appeal.filed_at) });
    });
  }
}
