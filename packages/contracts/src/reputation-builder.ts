import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import { AgentModuleManifestSchema, type AgentCapability, type AgentModuleManifest, type ContractRef } from './agent-catalog.js';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema, NonNegativeMinorUnitsSchema } from './common/money.js';

/**
 * The reputation builder (REP-001, ADR 010 decision 18). Every participant builds and confirms their own reputation
 * from evidence: credentials checked by the hub, a portfolio backed by execution records, confirmations from real
 * counterparties of real interactions, knowledge contributions counted by outcome, and timeliness signals from shared
 * contexts. The tools never change a score: snapshots stay EXE-001's explainable summaries, there is no public numeric
 * score until the owner decides O07, and nothing here reads entitlements, payments, sponsorship or staff input.
 * Storage: packages/data/migrations/reputation. Routes: apps/api/src/modules/reputation.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = z.iso.date();

/* ---------- Rules (mirrored by the database guards) ---------- */

export const REPUTATION_RULES = Object.freeze({
  /** A request may be answered for this long; afterwards it is expired (unknown, never a failure). */
  requestTtlDays: 30,
  /** The single reminder waits this long after the request. */
  reminderDelayDays: 3,
  /** Requests a requester may send in 24 hours (abuse protection, never purchasable). */
  dailyRequestLimit: 20,
});

/* ---------- Credentials ---------- */

export const CredentialKindSchema = z.enum(['licence', 'insurance', 'bond', 'certificate', 'training', 'membership', 'registration']);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;
export const CredentialCheckOutcomeSchema = z.enum(['match', 'mismatch', 'not_found', 'suspended', 'revoked', 'unavailable']);
export type CredentialCheckOutcome = z.infer<typeof CredentialCheckOutcomeSchema>;
/** Derived, never stored: "checked" only with a passing check by the hub, "expired" from the dates. */
export const CredentialStatusSchema = z.enum(['self_declared', 'checked', 'expired', 'suspended', 'revoked']);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export const VisibilitySchema = z.enum(['public', 'private']);
const JurisdictionSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/);

/** No actor field: the holder records its own credential in person (agent delegation arrives with AGT-005). */
export const RecordCredentialCommandSchema = z.strictObject({
  holder: PartySchema,
  kind: CredentialKindSchema,
  jurisdiction: JurisdictionSchema,
  /** The country pack's credential type, for example `US-CA-CSLB-B` or `US-GL-INSURANCE`. */
  credentialType: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
  issuer: Text(200),
  number: Text(100).nullable(),
  classification: Text(200).nullable(),
  coverage: z.strictObject({ minorUnits: NonNegativeMinorUnitsSchema, currency: CurrencySchema }).nullable(),
  validFrom: IsoDate.nullable(),
  validUntil: IsoDate.nullable(),
  visibility: VisibilitySchema,
  supersedesId: IdSchema.nullable(),
}).refine((c) => c.coverage === null || c.kind === 'insurance' || c.kind === 'bond', { message: 'only insurance and bonds carry a coverage', path: ['coverage'] })
  .refine((c) => c.validFrom === null || c.validUntil === null || c.validFrom <= c.validUntil, { message: 'valid from precedes valid until', path: ['validUntil'] });
export const CheckCredentialCommandSchema = z.strictObject({});

export const CredentialCheckViewSchema = z.strictObject({
  id: IdSchema, outcome: CredentialCheckOutcomeSchema, hubId: IdSchema, registerCode: z.string(), registerValidUntil: IsoDate.nullable(), checkedAt: TimestampSchema,
});
export const CredentialViewSchema = z.strictObject({
  id: IdSchema, holder: PartySchema, kind: CredentialKindSchema, jurisdiction: z.string(), credentialType: z.string(), issuer: z.string(), number: z.string().nullable(),
  classification: z.string().nullable(), coverage: z.strictObject({ minorUnits: NonNegativeMinorUnitsSchema, currency: CurrencySchema }).nullable(), validFrom: IsoDate.nullable(),
  validUntil: IsoDate.nullable(), visibility: VisibilitySchema, supersedesId: IdSchema.nullable(), supersededBy: IdSchema.nullable(), status: CredentialStatusSchema,
  checks: z.array(CredentialCheckViewSchema), createdAt: TimestampSchema,
});
export type CredentialView = z.infer<typeof CredentialViewSchema>;

/**
 * The status of a credential on `today` (an ISO date): a revoked or suspended register answer wins; then the earlier of
 * the stated and the register's expiry; "checked" only when the latest check matched; otherwise self-declared.
 */
export function credentialStatus(input: { validUntil: string | null; lastCheck: { outcome: CredentialCheckOutcome; registerValidUntil: string | null } | null }, today: string): CredentialStatus {
  const last = input.lastCheck;
  if (last?.outcome === 'revoked') return 'revoked';
  if (last?.outcome === 'suspended') return 'suspended';
  const expiries = [input.validUntil, last?.outcome === 'match' ? last.registerValidUntil : null].filter((d): d is string => d !== null);
  if (expiries.some((d) => d < today)) return 'expired';
  return last?.outcome === 'match' ? 'checked' : 'self_declared';
}

/* ---------- Portfolio ---------- */

export const ConfirmationContextKindSchema = z.enum(['agreement', 'task_assignment', 'project']);
export type ConfirmationContextKind = z.infer<typeof ConfirmationContextKindSchema>;
export const ConfirmationContextSchema = z.strictObject({ kind: ConfirmationContextKindSchema, id: IdSchema });
/** "client confirmed" only through a counterparty's confirmed or partial answer; everything else is self-reported. */
export const PortfolioConfirmationSchema = z.enum(['self_reported', 'client_confirmed']);

export const CreatePortfolioEntryCommandSchema = z.strictObject({
  holder: PartySchema,
  /** A platform context the holder took part in, or null with an external description (stays self-reported). */
  context: ConfirmationContextSchema.nullable(),
  externalDescription: Text(500).nullable(),
  title: Text(200),
  role: Text(200),
  period: z.strictObject({ from: IsoDate.nullable(), to: IsoDate.nullable() }),
  scopeSummary: Text(2000).nullable(),
  visibility: VisibilitySchema,
  supersedesId: IdSchema.nullable(),
}).refine((e) => (e.context === null) !== (e.externalDescription === null), { message: 'a platform context or an external description', path: ['context'] })
  .refine((e) => e.period.from === null || e.period.to === null || e.period.from <= e.period.to, { message: 'the period starts before it ends', path: ['period'] });

export const PortfolioEntryViewSchema = z.strictObject({
  id: IdSchema, holder: PartySchema, context: ConfirmationContextSchema.nullable(), externalDescription: z.string().nullable(), title: z.string(), role: z.string(),
  period: z.strictObject({ from: IsoDate.nullable(), to: IsoDate.nullable() }), scopeSummary: z.string().nullable(), visibility: VisibilitySchema,
  supersedesId: IdSchema.nullable(), supersededBy: IdSchema.nullable(), confirmation: PortfolioConfirmationSchema, confirmedAt: TimestampSchema.nullable(),
  /** Shown publicly: public, not corrected, and (for a platform context) the counterparty consented in its answer. */
  publiclyShown: z.boolean(), createdAt: TimestampSchema,
});
export type PortfolioEntryView = z.infer<typeof PortfolioEntryViewSchema>;

/* ---------- Declared relationships ---------- */

export const RelationKindSchema = z.enum(['relative', 'household', 'close_personal']);
export const DeclareRelationCommandSchema = z.strictObject({ otherPersonId: IdSchema, kind: RelationKindSchema });
export const RelationViewSchema = z.strictObject({ id: IdSchema, otherPersonId: IdSchema, kind: RelationKindSchema, declaredAt: TimestampSchema });

/* ---------- Confirmations ---------- */

export const StatementKindSchema = z.enum(['delivered', 'on_time', 'quality_met', 'role_performed', 'paid_on_time', 'advice_delivered']);
export type StatementKind = z.infer<typeof StatementKindSchema>;
export const ConfirmationDecisionSchema = z.enum(['confirmed', 'partially', 'declined']);
export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;

/**
 * No actor field and no incentive field: the request is the requester's own act, and the requester attests that
 * nothing was offered and that the addressee is neither an employee nor a relative. The database refuses requests
 * without a recorded relationship, between employees and the subject, between relatives, to oneself, twice, or above
 * the daily limit.
 */
export const RequestConfirmationCommandSchema = z.strictObject({
  requester: PartySchema,
  addressedTo: PartySchema,
  context: ConfirmationContextSchema,
  portfolioEntryId: IdSchema.nullable(),
  statementKind: StatementKindSchema,
  statement: Text(1000),
  attestation: z.strictObject({ noIncentiveOffered: z.literal(true), notEmployeeOrRelative: z.literal(true) }),
});
export const RemindConfirmationCommandSchema = z.strictObject({});
export const WithdrawConfirmationCommandSchema = z.strictObject({});
/** Human only (confirm_execution): the counterparty's person answers in person; the answer is final and appealable. */
export const AnswerConfirmationCommandSchema = z.strictObject({
  onBehalfOf: PartySchema,
  decision: ConfirmationDecisionSchema,
  comment: Text(1000).nullable(),
  /** The counterparty's consent to show the confirmed work publicly (never the address, never the amount). */
  consentToShow: z.boolean(),
  attestation: z.strictObject({ noIncentiveReceived: z.literal(true), notEmployeeOrRelative: z.literal(true) }),
}).refine((a) => a.decision === 'confirmed' || a.comment !== null, { message: 'a partial or declined answer says why', path: ['comment'] })
  .refine((a) => a.decision !== 'declined' || !a.consentToShow, { message: 'nothing is shown from a declined answer', path: ['consentToShow'] });

export const AppealStatusSchema = z.enum(['submitted', 'in_review', 'upheld', 'overturned', 'partially_overturned', 'withdrawn']);
export type AppealStatus = z.infer<typeof AppealStatusSchema>;
/** Requester-facing status: a declined answer reads "not confirmed", an unanswered request past its deadline "expired". */
export const ConfirmationStatusSchema = z.enum(['requested', 'confirmed', 'partially_confirmed', 'not_confirmed', 'expired', 'withdrawn']);
export type ConfirmationStatus = z.infer<typeof ConfirmationStatusSchema>;

export function confirmationStatus(input: { withdrawnAt: string | null; dueAt: string; decision: ConfirmationDecision | null }, now: Date): ConfirmationStatus {
  if (input.decision === 'confirmed') return 'confirmed';
  if (input.decision === 'partially') return 'partially_confirmed';
  if (input.decision === 'declined') return 'not_confirmed';
  if (input.withdrawnAt !== null) return 'withdrawn';
  return Date.parse(input.dueAt) < now.getTime() ? 'expired' : 'requested';
}

export const ConfirmationResponseViewSchema = z.strictObject({
  id: IdSchema, decision: ConfirmationDecisionSchema, comment: z.string().nullable(), consentToShow: z.boolean(), respondedAt: TimestampSchema, appeal: AppealStatusSchema.nullable(),
});
export const ConfirmationRequestViewSchema = z.strictObject({
  id: IdSchema, requester: PartySchema, addressedTo: PartySchema, context: ConfirmationContextSchema, portfolioEntryId: IdSchema.nullable(), statementKind: StatementKindSchema,
  statement: z.string(), status: ConfirmationStatusSchema, requestedAt: TimestampSchema, dueAt: TimestampSchema, reminderSentAt: TimestampSchema.nullable(),
  /** When the single reminder becomes available; null once sent or when the request is closed. */
  reminderAvailableAt: TimestampSchema.nullable(), withdrawnAt: TimestampSchema.nullable(), response: ConfirmationResponseViewSchema.nullable(),
});
export type ConfirmationRequestView = z.infer<typeof ConfirmationRequestViewSchema>;

/* ---------- Automated limitations: reason, evidence and appeal path ---------- */

export const LimitationScopeSchema = z.enum(['confirmation_request', 'confirmation_response', 'introductions', 'agent_module', 'observation']);
export type LimitationScope = z.infer<typeof LimitationScopeSchema>;

/**
 * Every automated limitation of a person carries one of these reason codes (the database's automated_limitation check
 * lists the same codes). State conflicts (a second reminder, an answered or expired request) are not limitations of a
 * person and answer 409 without one. `owner` is the module that applies it; `planned` codes belong to modules not live yet
 * (introductions: DIR/CONN packages; paused agent modules: AGT packages) and use the same shape when they land.
 */
export const LIMITATION_REASONS = Object.freeze({
  no_recorded_relationship: { scopes: ['confirmation_request'], owner: 'reputation', status: 'live' },
  self_confirmation: { scopes: ['confirmation_request', 'confirmation_response'], owner: 'reputation', status: 'live' },
  employee_of_subject: { scopes: ['confirmation_request', 'confirmation_response'], owner: 'reputation', status: 'live' },
  relative_of_subject: { scopes: ['confirmation_request', 'confirmation_response'], owner: 'reputation', status: 'live' },
  already_requested: { scopes: ['confirmation_request'], owner: 'reputation', status: 'live' },
  rate_limited: { scopes: ['confirmation_request'], owner: 'reputation', status: 'live' },
  excluded_client_caused_change: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  excluded_external_change: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  excluded_unattributed_change: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  excluded_no_due_date: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  excluded_appeal_pending: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  excluded_appeal_overturned: { scopes: ['observation'], owner: 'reputation', status: 'live' },
  introductions_throttled: { scopes: ['introductions'], owner: 'introductions', status: 'planned' },
  module_paused: { scopes: ['agent_module'], owner: 'assistant', status: 'planned' },
} as const satisfies Record<string, { scopes: readonly LimitationScope[]; owner: 'reputation' | 'introductions' | 'assistant'; status: 'live' | 'planned' }>);
export type LimitationReasonCode = keyof typeof LIMITATION_REASONS;
export const LIMITATION_REASON_CODES = Object.keys(LIMITATION_REASONS) as LimitationReasonCode[];
export const LimitationReasonCodeSchema = z.enum(LIMITATION_REASON_CODES as [LimitationReasonCode, ...LimitationReasonCode[]]);

/** What a person posts back to appeal a refusal: the rule is evaluated again before anything is recorded. */
export const LimitationRefSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('confirmation_request'), reasonCode: LimitationReasonCodeSchema, requester: PartySchema, addressedTo: PartySchema, context: ConfirmationContextSchema,
    statementKind: StatementKindSchema,
  }),
  z.strictObject({ scope: z.literal('confirmation_response'), reasonCode: LimitationReasonCodeSchema, requestId: IdSchema, onBehalfOf: PartySchema }),
]);
export type LimitationRef = z.infer<typeof LimitationRefSchema>;

export const REPUTATION_APPEAL_HREF = '/v1/reputation-builder/appeals';
export const LIMITATION_APPEAL_HREF = '/v1/reputation-builder/limitations/appeals';
export const AppealSubjectKindSchema = z.enum(['confirmation_response', 'timeliness_observation', 'contribution_record']);
export const AppealLinkSchema = z.strictObject({
  method: z.literal('POST'),
  href: z.string().regex(/^\/v1\/[a-z0-9/-]+$/),
  /** The recorded decision or observation to appeal, or null when the refusal itself is appealed (`limitation`). */
  subject: z.strictObject({ kind: AppealSubjectKindSchema, id: IdSchema }).nullable(),
  limitation: LimitationRefSchema.nullable(),
}).refine((l) => (l.subject === null) !== (l.limitation === null), { message: 'an appeal names a subject or a limitation', path: ['subject'] });
export type AppealLink = z.infer<typeof AppealLinkSchema>;
export const EvidenceRefSchema = z.strictObject({ kind: z.string().regex(/^[a-z][a-z_]{1,40}$/), id: IdSchema });

export const AutomatedLimitationSchema = z.strictObject({
  reasonCode: LimitationReasonCodeSchema,
  scope: LimitationScopeSchema,
  /** Locale key of the human explanation (`reputation.limitation.<code>`), rendered by the interface. */
  explanationKey: z.string().regex(/^reputation\.limitation\.[a-z_]+$/),
  evidence: z.array(EvidenceRefSchema).max(20),
  appeal: AppealLinkSchema,
});
export type AutomatedLimitation = z.infer<typeof AutomatedLimitationSchema>;

/** Builds the limitation every refusal and exclusion carries: reason code, explanation key, evidence and appeal link. */
export function buildLimitation(reasonCode: LimitationReasonCode, input: { evidence: readonly { kind: string; id: string }[]; subject?: { kind: z.infer<typeof AppealSubjectKindSchema>; id: string }; limitation?: LimitationRef }): AutomatedLimitation {
  const subject = input.subject ?? null;
  const limitation = subject ? null : input.limitation ?? null;
  return AutomatedLimitationSchema.parse({
    reasonCode, scope: input.limitation?.scope ?? LIMITATION_REASONS[reasonCode].scopes[0], explanationKey: `reputation.limitation.${reasonCode}`, evidence: input.evidence.map((e) => ({ kind: e.kind, id: e.id })),
    appeal: { method: 'POST', href: subject ? REPUTATION_APPEAL_HREF : LIMITATION_APPEAL_HREF, subject, limitation },
  });
}

export const FileReputationAppealCommandSchema = z.strictObject({ subject: z.strictObject({ kind: AppealSubjectKindSchema, id: IdSchema }), reason: Text(4000) });
export const AppealLimitationCommandSchema = z.strictObject({ limitation: LimitationRefSchema, reason: Text(4000) });
export const ReputationAppealViewSchema = z.strictObject({
  id: IdSchema, subject: z.strictObject({ kind: z.enum(['confirmation_response', 'performance_observation', 'automated_limitation']), id: IdSchema }), status: AppealStatusSchema,
  filedAt: TimestampSchema,
});
export const PersistedLimitationViewSchema = z.strictObject({
  id: IdSchema, reasonCode: LimitationReasonCodeSchema, scope: LimitationScopeSchema, explanationKey: z.string(), evidence: z.array(EvidenceRefSchema), startsAt: TimestampSchema,
  endsAt: TimestampSchema.nullable(), appeal: AppealStatusSchema.nullable(),
});

/* ---------- Contributions and timeliness (derived from canonical records only) ---------- */

export const ContributionKindSchema = z.enum(['publication', 'accepted_answer', 'consultation_given', 'mentoring', 'course_taught', 'event_talk', 'document_review', 'knowledge_item']);
export type ContributionKind = z.infer<typeof ContributionKindSchema>;
/**
 * The canonical records each contribution kind is derived from. `planned` kinds wait for their source module; no kind
 * is ever self-asserted, and counts are by outcome (an accepted deliverable, a confirmed answer), never by volume.
 */
export const CONTRIBUTION_SOURCES = Object.freeze({
  consultation_given: { status: 'live', sources: ['confirmation_response:advice_delivered:confirmed', 'agreement:consultation:completed'] },
  publication: { status: 'planned', sources: ['KNOW-001'] },
  accepted_answer: { status: 'planned', sources: ['KNOW-001'] },
  mentoring: { status: 'planned', sources: ['KNOW-001'] },
  course_taught: { status: 'planned', sources: ['LEARN packages'] },
  event_talk: { status: 'planned', sources: ['EVT packages'] },
  document_review: { status: 'planned', sources: ['CONS-001'] },
  knowledge_item: { status: 'planned', sources: ['KNOW-001'] },
} as const satisfies Record<ContributionKind, { status: 'live' | 'planned'; sources: readonly string[] }>);

export const TimelinessKindSchema = z.enum(['response', 'delivery', 'payment', 'consultation_start', 'milestone']);
export const TimelinessAttributionSchema = z.enum(['subject', 'counterparty', 'external', 'unknown']);
export const TimelinessExcludedReasonSchema = z.enum(['client_caused_change', 'external_change', 'unattributed_change', 'no_due_date']);
export type TimelinessExcludedReason = z.infer<typeof TimelinessExcludedReasonSchema>;
/**
 * The only tables timeliness and contributions are derived from. Activity tracking (sessions, logins, reading,
 * follows, bookmarks, assistant runs, audit and access logs) and per-employee records are never inputs; the subject is
 * always the party of the context, never the employee who acted for it.
 */
export const REPUTATION_DERIVATION_SOURCES = Object.freeze(['performance_observation', 'execution_claim', 'agreement', 'confirmation_request', 'confirmation_response'] as const);
export const FORBIDDEN_REPUTATION_INPUTS = Object.freeze([
  'session', 'login_failure', 'auth_token', 'reading_progress', 'follow', 'bookmark', 'audit_event', 'access_log_entry', 'admin_audit_event', 'run', 'run_step', 'conversation_turn',
  'action_attempt', 'membership', 'idempotency_record', 'outbox_event',
] as const);

export const ContributionViewSchema = z.strictObject({
  id: IdSchema, kind: ContributionKindSchema, source: z.strictObject({ kind: z.enum(['confirmation_response', 'agreement']), id: IdSchema }), outcome: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema, counted: z.boolean(), limitation: AutomatedLimitationSchema.nullable(), appeal: AppealLinkSchema, appealStatus: AppealStatusSchema.nullable(),
});
export type ContributionView = z.infer<typeof ContributionViewSchema>;
export const TimelinessOutcomeSchema = z.enum(['on_time', 'late', 'excused', 'unknown']);
export const TimelinessObservationViewSchema = z.strictObject({
  id: IdSchema, kind: TimelinessKindSchema, agreementId: IdSchema, sourceObservationId: IdSchema, expectedAt: TimestampSchema.nullable(), actualAt: TimestampSchema.nullable(),
  deltaSeconds: z.int().nullable(), attribution: TimelinessAttributionSchema, planChangeIds: z.array(IdSchema), outcome: TimelinessOutcomeSchema, counted: z.boolean(),
  limitation: AutomatedLimitationSchema.nullable(), appeal: AppealLinkSchema, appealStatus: AppealStatusSchema.nullable(),
});
export type TimelinessObservationView = z.infer<typeof TimelinessObservationViewSchema>;
const Count = z.int().min(0);
export const TimelinessSummarySchema = z.strictObject({
  counted: Count, onTime: Count, late: Count, excluded: z.record(z.string(), Count), byKind: z.record(z.string(), z.strictObject({ counted: Count, onTime: Count, late: Count })),
});
export type TimelinessSummary = z.infer<typeof TimelinessSummarySchema>;

const EXCLUSION_CODE: Record<TimelinessExcludedReason, LimitationReasonCode> = {
  client_caused_change: 'excluded_client_caused_change', external_change: 'excluded_external_change', unattributed_change: 'excluded_unattributed_change', no_due_date: 'excluded_no_due_date',
};

/**
 * Classifies one timeliness observation: an exclusion from fair timing (client-caused or external change, unattributed
 * change, no due date) or a pending or overturned appeal excludes it, with a limitation the subject can appeal;
 * otherwise it counts as on time or late against the plan as agreed.
 */
export function classifyTimeliness(o: { id: string; agreementId: string; sourceObservationId: string; deltaSeconds: number | null; excludedReason: TimelinessExcludedReason | null; planChangeIds: readonly string[]; appealStatus: AppealStatus | null }): {
  outcome: z.infer<typeof TimelinessOutcomeSchema>; counted: boolean; limitation: AutomatedLimitation | null; appeal: AppealLink;
} {
  const subject = { kind: 'timeliness_observation' as const, id: o.id };
  const appeal = AppealLinkSchema.parse({ method: 'POST', href: REPUTATION_APPEAL_HREF, subject, limitation: null });
  const evidence = [{ kind: 'agreement', id: o.agreementId }, { kind: 'performance_observation', id: o.sourceObservationId }, ...o.planChangeIds.map((id) => ({ kind: 'plan_change', id }))].slice(0, 20);
  const appealCode: LimitationReasonCode | null = o.appealStatus === 'submitted' || o.appealStatus === 'in_review' ? 'excluded_appeal_pending'
    : o.appealStatus === 'overturned' || o.appealStatus === 'partially_overturned' ? 'excluded_appeal_overturned' : null;
  const code = o.excludedReason ? EXCLUSION_CODE[o.excludedReason] : appealCode;
  const outcome = o.excludedReason === 'client_caused_change' || o.excludedReason === 'external_change' ? 'excused'
    : o.excludedReason !== null || o.deltaSeconds === null ? 'unknown' : o.deltaSeconds > 0 ? 'late' : 'on_time';
  if (code) return { outcome, counted: false, limitation: buildLimitation(code, { evidence, subject }), appeal };
  return { outcome, counted: true, limitation: null, appeal };
}

export function summarizeTimeliness(items: readonly { kind: string; counted: boolean; outcome: string; limitation: AutomatedLimitation | null }[]): TimelinessSummary {
  const summary: TimelinessSummary = { counted: 0, onTime: 0, late: 0, excluded: {}, byKind: {} };
  for (const item of items) {
    if (!item.counted) {
      const code = item.limitation?.reasonCode ?? 'excluded_no_due_date';
      summary.excluded[code] = (summary.excluded[code] ?? 0) + 1;
      continue;
    }
    const k = (summary.byKind[item.kind] ??= { counted: 0, onTime: 0, late: 0 });
    summary.counted += 1; k.counted += 1;
    if (item.outcome === 'late') { summary.late += 1; k.late += 1; } else { summary.onTime += 1; k.onTime += 1; }
  }
  return summary;
}

/* ---------- Views ---------- */

export const ReputationBuilderOwnViewSchema = z.strictObject({
  projection: z.literal('owner_private'),
  subject: PartySchema,
  credentials: z.array(CredentialViewSchema),
  portfolio: z.array(PortfolioEntryViewSchema),
  confirmationsSent: z.array(ConfirmationRequestViewSchema),
  contributions: z.array(ContributionViewSchema),
  timeliness: z.strictObject({ observations: z.array(TimelinessObservationViewSchema), summary: TimelinessSummarySchema }),
  limitations: z.array(PersistedLimitationViewSchema),
  relations: z.array(RelationViewSchema),
  /** O07: no public numeric score exists; the builder never computes one. */
  publicScore: z.null(),
});
export type ReputationBuilderOwnView = z.infer<typeof ReputationBuilderOwnViewSchema>;
export const ConfirmationInboxViewSchema = z.strictObject({ projection: z.literal('shared_party'), addressedTo: PartySchema, requests: z.array(ConfirmationRequestViewSchema) });
export type ConfirmationInboxView = z.infer<typeof ConfirmationInboxViewSchema>;
export const ReputationBuilderPublicViewSchema = z.strictObject({
  projection: z.literal('public'),
  subject: PartySchema,
  credentials: z.array(z.strictObject({
    kind: CredentialKindSchema, jurisdiction: z.string(), credentialType: z.string(), issuer: z.string(), validUntil: IsoDate.nullable(), status: CredentialStatusSchema,
    checkedAt: TimestampSchema.nullable(), checkedByHubId: IdSchema.nullable(),
  })),
  portfolio: z.array(z.strictObject({
    title: z.string(), role: z.string(), period: z.strictObject({ from: IsoDate.nullable(), to: IsoDate.nullable() }), scopeSummary: z.string().nullable(), confirmation: PortfolioConfirmationSchema,
    confirmedAt: TimestampSchema.nullable(),
  })),
  publicScore: z.null(),
});
export type ReputationBuilderPublicView = z.infer<typeof ReputationBuilderPublicViewSchema>;
export const ReputationBuilderQuerySchema = z.strictObject({ subject: PartySchema });

/** Identifier-only payload keys of reputation outbox events (never statements, comments or credential numbers). */
export const REPUTATION_EVENT_PAYLOAD_KEYS = ['subjectKind', 'subjectId', 'credentialId', 'checkId', 'entryId', 'requestId', 'responseId', 'appealId', 'limitationId', 'relationId'] as const;

export const subjectKey = (p: Party): string => `${p.kind}:${p.id}`;

/* ---------- Capability registry (ADR 010 decision 23): every operation for the interface and the person's agent ---------- */

const ref = (schema: string): ContractRef => ({ contract: 'reputation-builder', schema, version: 1 });
const MODULE = { key: 'reputation_builder', version: '1.0.0' } as const;
const capability = (c: Omit<AgentCapability, 'version' | 'status' | 'source' | 'surfaces' | 'acceptsUntrustedText' | 'meters' | 'budgetKind' | 'privateDataClasses'> & Partial<Pick<AgentCapability, 'surfaces' | 'meters'>>): AgentCapability => ({
  version: 1, status: 'live', source: { kind: 'module', moduleKey: MODULE.key, moduleVersion: MODULE.version }, budgetKind: null, surfaces: ['ui', 'agent'], privateDataClasses: [],
  acceptsUntrustedText: false, meters: c.kind === 'commit' ? ['agent_actions'] : [], ...c,
});
/**
 * In this slice every commit is confirmed by the person each time (stricter than the catalogue's mandate policy for
 * portfolio and requests); delegation under mandates arrives with AGT-005. Answers and appeals stay human-only.
 */
export const REPUTATION_BUILDER_CAPABILITIES: readonly AgentCapability[] = [
  capability({ id: 'reputation_builder.explain_my_reputation', kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'], input: ref('ReputationBuilderQuerySchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['profile'], reads: ['owner_private'], labelKey: 'reputation.capability.explainMine' }),
  capability({ id: 'reputation_builder.list_confirmation_requests', kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'], input: ref('ReputationBuilderQuerySchema'), output: ref('ConfirmationInboxViewSchema'), contextKinds: ['agreement', 'project'], reads: ['shared_party'], labelKey: 'reputation.capability.inbox' }),
  capability({ id: 'reputation_builder.view_public_reputation', kind: 'read', mandateAction: null, confirmation: 'none', sideEffects: ['none'], input: ref('ReputationBuilderQuerySchema'), output: ref('ReputationBuilderPublicViewSchema'), contextKinds: ['profile', 'company'], reads: ['public'], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'reputation.capability.viewPublic' }),
  capability({ id: 'reputation_builder.record_credential', kind: 'commit', mandateAction: 'maintain_profile', confirmation: 'person_each', sideEffects: ['state_change'], input: ref('RecordCredentialCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['profile'], reads: ['owner_private'], labelKey: 'reputation.capability.recordCredential' }),
  capability({ id: 'reputation_builder.check_credential', kind: 'commit', mandateAction: 'maintain_profile', confirmation: 'person_each', sideEffects: ['state_change', 'external_call'], input: ref('CheckCredentialCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['profile'], reads: ['owner_private'], meters: ['agent_actions', 'checks'], labelKey: 'reputation.capability.checkCredential' }),
  capability({ id: 'reputation_builder.publish_portfolio_entry', kind: 'commit', mandateAction: 'publish', confirmation: 'person_each', sideEffects: ['state_change', 'publication'], input: ref('CreatePortfolioEntryCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['profile', 'agreement', 'project'], reads: ['owner_private'], labelKey: 'reputation.capability.publishPortfolioEntry' }),
  capability({ id: 'reputation_builder.send_confirmation_request', kind: 'commit', mandateAction: 'communicate', confirmation: 'person_each', sideEffects: ['state_change', 'outbound_message'], input: ref('RequestConfirmationCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['agreement', 'project'], reads: ['shared_party'], labelKey: 'reputation.capability.sendConfirmationRequest' }),
  capability({ id: 'reputation_builder.remind_confirmation_request', kind: 'commit', mandateAction: 'communicate', confirmation: 'person_each', sideEffects: ['state_change', 'outbound_message'], input: ref('RemindConfirmationCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['agreement', 'project'], reads: ['shared_party'], labelKey: 'reputation.capability.remindConfirmationRequest' }),
  capability({ id: 'reputation_builder.withdraw_confirmation_request', kind: 'commit', mandateAction: 'communicate', confirmation: 'person_each', sideEffects: ['state_change'], input: ref('WithdrawConfirmationCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['agreement', 'project'], reads: ['shared_party'], labelKey: 'reputation.capability.withdrawConfirmationRequest' }),
  capability({ id: 'reputation_builder.answer_confirmation_request', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'reputation_signal'], input: ref('AnswerConfirmationCommandSchema'), output: ref('ConfirmationInboxViewSchema'), contextKinds: ['agreement', 'project'], reads: ['shared_party'], labelKey: 'reputation.capability.answerConfirmationRequest' }),
  capability({ id: 'reputation_builder.declare_relation', kind: 'commit', mandateAction: 'maintain_profile', confirmation: 'person_each', sideEffects: ['state_change'], input: ref('DeclareRelationCommandSchema'), output: ref('ReputationBuilderOwnViewSchema'), contextKinds: ['profile'], reads: ['owner_private'], labelKey: 'reputation.capability.declareRelation' }),
  capability({ id: 'reputation_builder.submit_appeal', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'reputation_signal'], input: ref('FileReputationAppealCommandSchema'), output: ref('ReputationAppealViewSchema'), contextKinds: ['agreement', 'project'], reads: ['owner_private'], labelKey: 'reputation.capability.submitAppeal' }),
  capability({ id: 'reputation_builder.appeal_limitation', kind: 'commit', mandateAction: 'confirm_execution', confirmation: 'person_each', sideEffects: ['state_change', 'reputation_signal'], input: ref('AppealLimitationCommandSchema'), output: ref('ReputationAppealViewSchema'), contextKinds: ['agreement', 'project'], reads: ['owner_private'], labelKey: 'reputation.capability.appealLimitation' }),
];
export const REPUTATION_BUILDER_MANIFEST: AgentModuleManifest = AgentModuleManifestSchema.parse({
  key: MODULE.key, version: MODULE.version, family: 'presence', status: 'live', actions: ['maintain_profile', 'publish', 'communicate', 'confirm_execution'],
  capabilities: REPUTATION_BUILDER_CAPABILITIES, meters: ['agent_actions', 'checks'],
  suits: ['individual_professional', 'job_seeker', 'small_contractor', 'general_contractor', 'subcontractor', 'supplier', 'manufacturer', 'design_office', 'developer', 'homeowner',
    'public_client', 'editor_author_expert', 'event_organizer', 'course_author', 'company_representative'],
  freeFloor: [], safetySuite: 'tests/reputation',
});
