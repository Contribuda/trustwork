import { z } from 'zod';
import { PartySchema, type Party } from './access.js';
import {
  AgentCapabilitySchema, AgentModuleManifestSchema, type AgentCapability, type CapabilityConfirmation, type CapabilityKind, type ContextKindV2, type PrivateDataClass, type SideEffect,
  ApprovalPolicySchema, ApproverRuleSchema, ConditionSchema, EnvelopeIntentSchema, EscalationSchema, MandateActionV2Schema, MandateContextSchema, MandateLimitsV2Schema,
  MONEY_ACTIONS, HUMAN_ONLY_ACTIONS, VersionedContextRefSchema, type EnvelopeIntent, type MandateActionV2,
} from './agent-catalog.js';
import { DigestSchema } from './common/digest-schema.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { NonNegativeMoneySchema, compareMoney } from './common/money.js';
import { AgentModuleKeySchema, LocaleTagSchema } from './hub.js';

/**
 * Goals, agent-to-agent envelopes, negotiation sessions, the company representative and company mandates (AGT-001).
 * Source: docs/engine/agents.md (goals, negotiation, company representation), docs/data/model.md section 21, ADR 010
 * decisions 4, 9 and 23, ADR 012 decision 32. Builds on the agent catalogue contracts (`agent-catalog.ts`: GoalSchema,
 * JobSubscriptionSchema, AgentEnvelopeSchema, AgentReportSchema) without changing them.
 *
 * Invariants carried here (the database repeats them, packages/data/migrations/agents):
 * - a goal never widens authority; its missing mandate changes are proposals confirmed together on the first-party form;
 * - goals never pre-authorize money or human-only verbs: those need their own mandate with a budget;
 * - an envelope's note is untrusted text; only the intent and digest-pinned references move state;
 * - a negotiation session has a round limit, an expiry and a turn; deadlock, expiry and agreement escalate to people;
 * - a company has at most one representative, always with an accountable person; company mandates are re-confirmed with
 *   identical terms within `RECONFIRMATION_WINDOW_DAYS` after the granting member leaves, or they stay suspended.
 * Status: Live in the API with fake providers only (no model, no external delivery).
 */
export const AGENTS_CONTRACT_VERSION = 1 as const;

/* ---------- Goals ---------- */

/** Actions a goal may ask for: never a money commitment and never a human-only verb. */
export function goalActionAllowed(action: MandateActionV2): boolean {
  return !MONEY_ACTIONS.includes(action) && !HUMAN_ONLY_ACTIONS.includes(action);
}
/** What the agent needs to pursue a goal in one module; becomes a proposed own-agent mandate when nothing covers it. */
export const GoalNeedSchema = z.strictObject({
  moduleKey: AgentModuleKeySchema,
  actions: z.array(MandateActionV2Schema).min(1).max(10),
  contexts: z.array(MandateContextSchema).min(1).max(20),
  perWindow: z.strictObject({ count: z.int().min(1).max(10_000), windowHours: z.int().min(1).max(24 * 31) }).nullable(),
  approvalPolicy: ApprovalPolicySchema,
})
  .refine((n) => n.actions.every(goalActionAllowed), { message: 'goals never pre-authorize money or human-only actions', path: ['actions'] })
  .refine((n) => new Set(n.actions).size === n.actions.length, { message: 'actions are distinct', path: ['actions'] });
export type GoalNeed = z.infer<typeof GoalNeedSchema>;

export const CreateGoalCommandSchema = z.strictObject({
  onBehalfOf: PartySchema.nullable(),
  text: z.string().trim().min(1).max(2000),
  successCriteria: z.array(ShortTextSchema).min(1).max(20),
  needs: z.array(GoalNeedSchema).max(10),
  budgetRange: z.strictObject({ low: NonNegativeMoneySchema, high: NonNegativeMoneySchema }).nullable(),
  horizon: TimestampSchema,
  reportCadence: z.enum(['none', 'daily', 'weekly', 'monthly']),
}).refine((g) => g.budgetRange === null || (g.budgetRange.low.currency === g.budgetRange.high.currency && compareMoney(g.budgetRange.low, g.budgetRange.high) <= 0), {
  message: 'low <= high in one currency', path: ['budgetRange'],
});
export type CreateGoalCommand = z.infer<typeof CreateGoalCommandSchema>;

/** The one structured confirmation a goal asks for: the exact digest covers the goal, the covering mandates and every proposal. */
export const GoalConfirmationSchema = z.strictObject({
  goalId: IdSchema,
  digest: DigestSchema,
  covered: z.array(z.strictObject({ mandateId: IdSchema, revision: RevisionSchema, moduleKey: AgentModuleKeySchema })),
  proposals: z.array(z.strictObject({ proposalId: IdSchema, mandateId: IdSchema, moduleKey: AgentModuleKeySchema, actions: z.array(MandateActionV2Schema), digest: DigestSchema })),
});
export type GoalConfirmation = z.infer<typeof GoalConfirmationSchema>;

export const ConfirmGoalCommandSchema = z.strictObject({ digest: DigestSchema });
export const GoalStatusCommandSchema = z.strictObject({
  status: z.enum(['active', 'paused', 'closed']),
  outcome: z.enum(['achieved', 'partly', 'abandoned']).nullable(),
  expectedRevision: RevisionSchema,
}).refine((c) => (c.status === 'closed') === (c.outcome !== null), { message: 'closing records an outcome', path: ['outcome'] });
export const GoalEvidenceCommandSchema = z.strictObject({
  evidenceRefs: z.array(z.strictObject({ kind: z.string().regex(/^[a-z][a-z_]{1,40}$/), id: IdSchema })).min(1).max(20),
  code: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
});

/* ---------- Envelopes and negotiation ---------- */

/** The mandate action the sender of each intent needs. */
export const ENVELOPE_INTENT_ACTION: Readonly<Record<EnvelopeIntent, MandateActionV2>> = {
  request_proposal: 'communicate', propose: 'negotiate', counter: 'negotiate', clarify: 'communicate', answer: 'communicate', accept: 'negotiate', decline: 'communicate',
  withdraw: 'negotiate', schedule_meeting: 'schedule', introduce: 'introduce', propose_slots: 'schedule', request_confirmation: 'negotiate', express_interest: 'communicate',
  step_question: 'communicate',
};
/** Intents that act on a negotiation session (open, count a round, close it or ask for confirmation). */
export const NEGOTIATION_INTENTS: readonly EnvelopeIntent[] = ['propose', 'counter', 'accept', 'decline', 'withdraw', 'request_confirmation'];
/** Contexts an envelope can belong to in this release: their parties and versions are verifiable. */
export const ENVELOPE_CONTEXT_KINDS = ['rfq', 'quote'] as const;
/** Module keys whose mandates may speak through envelopes (catalogue modules `negotiation`, `representative`, `quoting`, `sourcing_desk`). */
export const ENVELOPE_MODULE_KEYS = ['negotiation', 'representative', 'quoting', 'sourcing_desk'] as const;

/** Disclosure label keys (rendered in the reader's language): counterparties always know they deal with an agent. */
export const AGENT_LABEL_KEYS = {
  personAgent: 'agents.label.personAgent',
  personAgentForCompany: 'agents.label.personAgentForCompany',
  representative: 'agents.label.representative',
} as const;

/** Who speaks: the principal's own agent, a colleague's agent under a company mandate, or the company's representative. */
export const EnvelopeActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('own_agent'), mandateId: IdSchema }),
  z.strictObject({ kind: z.literal('colleague_agent'), companyMandateId: IdSchema }),
  z.strictObject({ kind: z.literal('company_representative'), companyMandateId: IdSchema }),
]);
export type EnvelopeActor = z.infer<typeof EnvelopeActorSchema>;

/** The agent side of sending an envelope. `from` is never accepted: the server derives it from the actor. */
export const SendEnvelopeCommandSchema = z.strictObject({
  actingAs: EnvelopeActorSchema,
  to: PartySchema,
  context: z.strictObject({ kind: z.enum(ENVELOPE_CONTEXT_KINDS), id: IdSchema }),
  intent: EnvelopeIntentSchema,
  refs: z.array(VersionedContextRefSchema).max(50),
  note: z.strictObject({ text: z.string().max(4000), locale: LocaleTagSchema.nullable() }).nullable(),
  negotiationSessionId: IdSchema.nullable(),
  expiresAt: TimestampSchema,
});
export type SendEnvelopeCommand = z.infer<typeof SendEnvelopeCommandSchema>;

export const NegotiationStatusSchema = z.enum(['open', 'agreed_pending_confirmation', 'escalated', 'declined', 'withdrawn', 'expired']);
export const NegotiationEscalationReasonSchema = z.enum(['rounds_exhausted', 'expired', 'agreement_needs_confirmation']);
/** Shared by the two parties; never carries a constraint, a price or a mandate. */
export const NegotiationSessionSchema = z.strictObject({
  id: IdSchema,
  context: z.strictObject({ kind: z.enum(ENVELOPE_CONTEXT_KINDS), id: IdSchema }),
  parties: z.tuple([PartySchema, PartySchema]),
  maxRounds: z.int().min(1).max(20),
  roundsUsed: z.int().min(0),
  turn: PartySchema.nullable(),
  expiresAt: TimestampSchema,
  status: NegotiationStatusSchema,
  escalationReason: NegotiationEscalationReasonSchema.nullable(),
  revision: RevisionSchema,
}).refine((s) => s.roundsUsed <= s.maxRounds, { message: 'rounds within the limit', path: ['roundsUsed'] })
  .refine((s) => JSON.stringify(s.parties[0]) !== JSON.stringify(s.parties[1]), { message: 'two distinct parties', path: ['parties'] });
export type NegotiationSession = z.infer<typeof NegotiationSessionSchema>;

export type NegotiationStepResult =
  | { kind: 'apply'; status: z.infer<typeof NegotiationStatusSchema>; roundsUsed: number; turn: Party | null; escalate: z.infer<typeof NegotiationEscalationReasonSchema> | null }
  | { kind: 'refuse'; reason: 'negotiation.closed' | 'negotiation.not_your_turn' }
  | { kind: 'end'; status: 'escalated' | 'expired'; reason: 'rounds_exhausted' | 'expired' };

const sameParty = (a: Party | null, b: Party) => a !== null && a.kind === b.kind && a.id === b.id;
/**
 * Pure transition of a session for one state-moving intent (the database applies the same rules under the session lock):
 * proposals and counters alternate and count rounds; the round past the limit is not delivered and the session escalates;
 * an expired session escalates; `accept` answers the other side's last proposal and only moves the session to
 * "agreed, pending confirmation" by the people on both sides.
 */
export function negotiationStep(
  session: Pick<NegotiationSession, 'status' | 'maxRounds' | 'roundsUsed' | 'turn' | 'expiresAt'>, sender: Party, receiver: Party, intent: EnvelopeIntent, now: Date,
): NegotiationStepResult {
  if (session.status === 'open' && Date.parse(session.expiresAt) <= now.getTime()) return { kind: 'end', status: 'expired', reason: 'expired' };
  if (session.status !== 'open') return { kind: 'refuse', reason: 'negotiation.closed' };
  switch (intent) {
    case 'propose':
    case 'counter':
      if (session.turn !== null && !sameParty(session.turn, sender)) return { kind: 'refuse', reason: 'negotiation.not_your_turn' };
      if (session.roundsUsed + 1 > session.maxRounds) return { kind: 'end', status: 'escalated', reason: 'rounds_exhausted' };
      return { kind: 'apply', status: 'open', roundsUsed: session.roundsUsed + 1, turn: receiver, escalate: null };
    case 'accept':
      if (!sameParty(session.turn, sender)) return { kind: 'refuse', reason: 'negotiation.not_your_turn' };
      return { kind: 'apply', status: 'agreed_pending_confirmation', roundsUsed: session.roundsUsed, turn: null, escalate: 'agreement_needs_confirmation' };
    case 'decline':
      return { kind: 'apply', status: 'declined', roundsUsed: session.roundsUsed, turn: null, escalate: null };
    case 'withdraw':
      return { kind: 'apply', status: 'withdrawn', roundsUsed: session.roundsUsed, turn: null, escalate: null };
    default:
      return { kind: 'apply', status: session.status, roundsUsed: session.roundsUsed, turn: session.turn, escalate: null };
  }
}

/**
 * Whether an untrusted note repeats one of the amounts (minor units as decimal strings), written with or without digit
 * separators, in minor units or (for whole amounts) in major units. Amounts below three digits are ignored. The database
 * function `agents_note_leaks` applies the same rule before an envelope is stored.
 */
export function noteMentionsAmount(note: string, minorAmounts: readonly string[]): boolean {
  const strip = (s: string) => s.replace(/^0+/, '');
  const runs = [...note.matchAll(/\d(?:[\d,.'_ ]*\d)?/g)].map((m) => strip(m[0].replace(/\D/g, '')));
  const forms = new Set<string>();
  for (const amount of minorAmounts) {
    if (!/^\d{3,}$/.test(amount)) continue;
    forms.add(strip(amount));
    if (/^\d{5,}$/.test(amount) && amount.endsWith('00')) forms.add(strip(amount.slice(0, -2)));
  }
  return runs.some((r) => r.length >= 3 && forms.has(r));
}

export const ReceiptDecisionSchema = z.enum(['informational', 'within_mandate', 'escalated']);
/** Receiver-private: the receiver's own mandate decision on an inbound intent. Never shown to the sender. */
export const EnvelopeReceiptSchema = z.strictObject({
  envelopeId: IdSchema,
  receiver: PartySchema,
  decision: ReceiptDecisionSchema,
  reason: z.enum(['informational', 'covered', 'human_only', 'outside_mandate', 'needs_approval', 'dispatch_blocked', 'no_representative', 'session_closed']),
  decidedAt: TimestampSchema,
});
export const AgentEscalationSchema = z.strictObject({
  id: IdSchema,
  owner: PartySchema,
  source: z.enum(['inbound_needs_decision', 'outbound_outside_mandate', 'rounds_exhausted', 'session_expired', 'agreement_needs_confirmation', 'confirmation_requested']),
  envelopeId: IdSchema.nullable(),
  sessionId: IdSchema.nullable(),
  context: z.strictObject({ kind: z.enum(ENVELOPE_CONTEXT_KINDS), id: IdSchema }).nullable(),
  intent: EnvelopeIntentSchema.nullable(),
  status: z.enum(['open', 'resolved', 'dismissed']),
  createdAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
});
export type AgentEscalation = z.infer<typeof AgentEscalationSchema>;
export const ResolveEscalationCommandSchema = z.strictObject({ status: z.enum(['resolved', 'dismissed']) });

/* ---------- The company representative and company mandates ---------- */

export const RECONFIRMATION_WINDOW_DAYS = 7 as const;
export const RepresentativeStatusSchema = z.enum(['pending_acceptance', 'active', 'suspended', 'disabled']);
export const RepresentativeSuspensionReasonSchema = z.enum(['no_accountable_person', 'no_confirmed_mandate', 'admin_suspended']);
/** What blocks the representative right now, beyond its stored state (hub and node kill switches). */
export const RepresentativeBlockSchema = z.enum(['hub_kill_switch', 'node_kill_switch']);
export const CompanyRepresentativeSchema = z.strictObject({
  id: IdSchema,
  companyId: IdSchema,
  accountablePersonId: IdSchema.nullable(),
  status: RepresentativeStatusSchema,
  suspensionReason: RepresentativeSuspensionReasonSchema.nullable(),
  blockedBy: RepresentativeBlockSchema.nullable(),
  labelKey: z.literal(AGENT_LABEL_KEYS.representative),
  acceptedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
}).refine((r) => (r.status === 'suspended') === (r.suspensionReason !== null), { message: 'a suspension names its reason', path: ['suspensionReason'] })
  .refine((r) => r.status !== 'active' || r.accountablePersonId !== null, { message: 'an active representative has an accountable person', path: ['accountablePersonId'] });
export type CompanyRepresentative = z.infer<typeof CompanyRepresentativeSchema>;

export const ConfigureRepresentativeCommandSchema = z.strictObject({ accountablePersonId: IdSchema, expectedRevision: RevisionSchema.nullable() });
export const RevisionCommandSchema = z.strictObject({ expectedRevision: RevisionSchema });

/** The editable terms of a company mandate (a MandateV2 without principal, grantee, status and confirmation). */
export const CompanyMandateTermsSchema = z.strictObject({
  moduleKeys: z.array(AgentModuleKeySchema).min(1).max(50),
  actions: z.array(MandateActionV2Schema).min(1),
  contexts: z.array(MandateContextSchema).min(1).max(200),
  limits: MandateLimitsV2Schema,
  conditions: z.array(ConditionSchema).max(50),
  approvalPolicy: ApprovalPolicySchema,
  approvers: z.array(ApproverRuleSchema).max(5),
  escalation: EscalationSchema,
  validUntil: TimestampSchema,
});
export type CompanyMandateTerms = z.infer<typeof CompanyMandateTermsSchema>;
export const CompanyMandateExecutorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('company_representative') }),
  z.strictObject({ kind: z.literal('colleague_agent'), personId: IdSchema }),
]);
export const GrantCompanyMandateCommandSchema = z.strictObject({ executor: CompanyMandateExecutorSchema, terms: CompanyMandateTermsSchema });
/** A re-confirmation repeats the digest of the terms the member was shown; it can never change them. */
export const ReconfirmCompanyMandateCommandSchema = z.strictObject({ termsDigest: DigestSchema });

export const CompanyMandateStatusSchema = z.enum(['active', 'awaiting_reconfirmation', 'suspended', 'revoked']);
export const CompanyMandateSchema = z.strictObject({
  id: IdSchema,
  companyId: IdSchema,
  mandateId: IdSchema,
  grantedByPersonId: IdSchema,
  executor: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('company_representative'), representativeId: IdSchema }),
    z.strictObject({ kind: z.literal('colleague_agent'), personId: IdSchema }),
  ]),
  terms: CompanyMandateTermsSchema,
  termsDigest: DigestSchema,
  status: CompanyMandateStatusSchema,
  statusReason: z.string().nullable(),
  reconfirmDueAt: TimestampSchema.nullable(),
  reconfirmedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
}).refine((m) => (m.status === 'awaiting_reconfirmation') === (m.reconfirmDueAt !== null), { message: 'awaiting re-confirmation names its deadline', path: ['reconfirmDueAt'] });
export type CompanyMandate = z.infer<typeof CompanyMandateSchema>;

export const CreateJobSubscriptionCommandSchema = z.strictObject({
  onBehalfOf: PartySchema.nullable(),
  moduleKey: AgentModuleKeySchema,
  jobTemplateKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  trigger: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('schedule'), rrule: z.string().regex(/^FREQ=(DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/).max(200), timeZone: z.string().min(1).max(64) }),
    z.strictObject({ kind: z.literal('event'), eventType: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(80) }),
    z.strictObject({ kind: z.literal('goal'), goalId: IdSchema }),
    z.strictObject({ kind: z.literal('request') }),
  ]),
  mandateId: IdSchema.nullable(),
});
export const JobSubscriptionStatusCommandSchema = z.strictObject({ status: z.enum(['active', 'paused', 'ended']), expectedRevision: RevisionSchema });
export const ShareReportCommandSchema = z.strictObject({ personIds: z.array(IdSchema).max(50) });

/* ---------- Capabilities (ADR 010 decision 23: one registry for the interface, the agent and connections) ---------- */

export interface AgentsCapabilityEntry { capability: AgentCapability; apiRoute: string }
interface Spec {
  id: string;
  kind: CapabilityKind;
  action?: MandateActionV2;
  confirmation?: CapabilityConfirmation;
  input: string;
  output: string;
  contexts?: ContextKindV2[];
  reads: AgentCapability['reads'];
  privateData?: PrivateDataClass[];
  effects: SideEffect[];
  route: string;
}
const camel = (s: string) => s.replace(/[._]([a-z])/g, (_, ch: string) => ch.toUpperCase());
function entry(s: Spec): AgentsCapabilityEntry {
  const [moduleKey] = s.id.split('.') as [string];
  const contract = (schema: string) => ({ contract: schema === 'MandateV2Schema' || schema === 'AgentReportSchema' || schema === 'JobSubscriptionSchema' || schema === 'AgentEnvelopeSchema' ? 'agent-catalog' : 'agents', schema, version: 1 });
  const governed = s.kind === 'govern';
  const capability = AgentCapabilitySchema.parse({
    id: s.id, version: 1, source: { kind: 'module', moduleKey, moduleVersion: '1.0.0' }, kind: s.kind, input: contract(s.input), output: contract(s.output),
    mandateAction: s.action ?? null, contextKinds: s.contexts ?? [], confirmation: s.confirmation ?? (s.kind === 'commit' ? 'mandate' : governed ? 'first_party_form' : 'none'), budgetKind: null,
    reads: s.reads, privateDataClasses: s.privateData ?? [], sideEffects: s.effects, acceptsUntrustedText: false,
    meters: s.kind === 'commit' ? ['agent_actions'] : [], surfaces: governed ? ['ui', 'agent'] : s.kind === 'commit' ? ['ui', 'agent', 'mcp', 'a2a'] : ['ui', 'agent', 'mcp'],
    status: 'live', labelKey: `agents.capability.${camel(s.id)}`,
  });
  return { capability, apiRoute: s.route };
}
const OWNER: AgentCapability['reads'] = ['owner_private'];
const SHARED: AgentCapability['reads'] = ['shared_party'];
const PARTY: AgentCapability['reads'] = ['party_private'];
const ENVELOPE_CONTEXTS: ContextKindV2[] = ['rfq', 'quote'];

/**
 * Every AGT-001 operation, defined once. `core.*` are the person's goals, reports, subscriptions and decisions;
 * `negotiation.*` the agent-to-agent envelopes (one capability per mandate verb, one route); `representative.*` the
 * company page. Authority-changing governance is first-party handoff-only. Declared MCP reads require their exact
 * stored consent and narrow summary projection; the full first-party company page is not that projection.
 */
export const AGENT_CAPABILITIES: readonly AgentsCapabilityEntry[] = [
  entry({ id: 'core.list_goals', kind: 'read', input: 'CreateGoalCommandSchema', output: 'GoalConfirmationSchema', reads: OWNER, privateData: ['budgets'], effects: ['none'], route: 'GET /v1/assistant/goals' }),
  entry({ id: 'core.get_goal', kind: 'read', input: 'CreateGoalCommandSchema', output: 'GoalConfirmationSchema', contexts: ['goal'], reads: OWNER, privateData: ['budgets'], effects: ['none'], route: 'GET /v1/assistant/goals/:id' }),
  entry({ id: 'core.get_goal_confirmation', kind: 'read', input: 'ConfirmGoalCommandSchema', output: 'GoalConfirmationSchema', contexts: ['goal'], reads: OWNER, effects: ['none'], route: 'GET /v1/assistant/goals/:id/confirmation' }),
  entry({ id: 'core.create_goal', kind: 'draft', input: 'CreateGoalCommandSchema', output: 'GoalConfirmationSchema', contexts: ['goal'], reads: OWNER, privateData: ['budgets'], effects: ['draft_state'], route: 'POST /v1/assistant/goals' }),
  entry({ id: 'core.confirm_goal', kind: 'govern', confirmation: 'first_party_step_up', input: 'ConfirmGoalCommandSchema', output: 'GoalConfirmationSchema', reads: OWNER, effects: ['state_change'], route: 'POST /v1/assistant/goals/:id/confirm' }),
  entry({ id: 'core.set_goal_status', kind: 'govern', input: 'GoalStatusCommandSchema', output: 'GoalConfirmationSchema', reads: OWNER, effects: ['state_change'], route: 'POST /v1/assistant/goals/:id/status' }),
  entry({ id: 'core.record_goal_evidence', kind: 'draft', input: 'GoalEvidenceCommandSchema', output: 'GoalConfirmationSchema', contexts: ['goal'], reads: OWNER, effects: ['draft_state'], route: 'POST /v1/assistant/goals/:id/progress' }),
  entry({ id: 'core.generate_goal_report', kind: 'draft', action: 'prepare', input: 'ConfirmGoalCommandSchema', output: 'AgentReportSchema', contexts: ['goal'], reads: OWNER, effects: ['draft_state'], route: 'POST /v1/assistant/goals/:id/report' }),
  entry({ id: 'core.list_reports', kind: 'read', input: 'ShareReportCommandSchema', output: 'AgentReportSchema', reads: OWNER, effects: ['none'], route: 'GET /v1/assistant/reports' }),
  entry({ id: 'core.share_report', kind: 'govern', input: 'ShareReportCommandSchema', output: 'AgentReportSchema', reads: OWNER, effects: ['state_change'], route: 'POST /v1/assistant/reports/:id/share' }),
  entry({ id: 'core.list_job_subscriptions', kind: 'read', input: 'CreateJobSubscriptionCommandSchema', output: 'JobSubscriptionSchema', reads: OWNER, effects: ['none'], route: 'GET /v1/assistant/job-subscriptions' }),
  entry({ id: 'core.create_job_subscription', kind: 'govern', input: 'CreateJobSubscriptionCommandSchema', output: 'JobSubscriptionSchema', reads: OWNER, effects: ['state_change'], route: 'POST /v1/assistant/job-subscriptions' }),
  entry({ id: 'core.set_job_subscription_status', kind: 'govern', input: 'JobSubscriptionStatusCommandSchema', output: 'JobSubscriptionSchema', reads: OWNER, effects: ['state_change'], route: 'POST /v1/assistant/job-subscriptions/:id/status' }),
  entry({ id: 'core.list_escalations', kind: 'read', input: 'ResolveEscalationCommandSchema', output: 'AgentEscalationSchema', reads: PARTY, effects: ['none'], route: 'GET /v1/assistant/escalations' }),
  entry({ id: 'core.resolve_escalation', kind: 'govern', input: 'ResolveEscalationCommandSchema', output: 'AgentEscalationSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/assistant/escalations/:id/resolve' }),
  entry({ id: 'negotiation.list_envelopes', kind: 'read', input: 'SendEnvelopeCommandSchema', output: 'AgentEnvelopeSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['none'], route: 'GET /v1/assistant/envelopes' }),
  entry({ id: 'negotiation.list_sessions', kind: 'read', input: 'SendEnvelopeCommandSchema', output: 'NegotiationSessionSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['none'], route: 'GET /v1/assistant/negotiations' }),
  entry({ id: 'negotiation.get_session', kind: 'read', input: 'SendEnvelopeCommandSchema', output: 'NegotiationSessionSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['none'], route: 'GET /v1/assistant/negotiations/:id' }),
  entry({ id: 'negotiation.negotiate', kind: 'commit', action: 'negotiate', input: 'SendEnvelopeCommandSchema', output: 'NegotiationSessionSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['state_change', 'outbound_message'], route: 'POST /v1/assistant/envelopes' }),
  entry({ id: 'negotiation.message', kind: 'commit', action: 'communicate', input: 'SendEnvelopeCommandSchema', output: 'AgentEnvelopeSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['state_change', 'outbound_message'], route: 'POST /v1/assistant/envelopes' }),
  entry({ id: 'negotiation.schedule', kind: 'commit', action: 'schedule', input: 'SendEnvelopeCommandSchema', output: 'AgentEnvelopeSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['state_change', 'outbound_message'], route: 'POST /v1/assistant/envelopes' }),
  entry({ id: 'negotiation.introduce', kind: 'commit', action: 'introduce', input: 'SendEnvelopeCommandSchema', output: 'AgentEnvelopeSchema', contexts: ENVELOPE_CONTEXTS, reads: SHARED, effects: ['state_change', 'outbound_message'], route: 'POST /v1/assistant/envelopes' }),
  entry({ id: 'representative.list_my_company_mandates', kind: 'read', input: 'GrantCompanyMandateCommandSchema', output: 'CompanyMandateSchema', reads: OWNER, effects: ['none'], route: 'GET /v1/assistant/company-mandates' }),
  entry({ id: 'representative.get', kind: 'read', input: 'ConfigureRepresentativeCommandSchema', output: 'CompanyRepresentativeSchema', contexts: ['company'], reads: PARTY, effects: ['none'], route: 'GET /v1/companies/:id/representative' }),
  entry({ id: 'representative.configure', kind: 'govern', confirmation: 'first_party_step_up', input: 'ConfigureRepresentativeCommandSchema', output: 'CompanyRepresentativeSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/representative' }),
  entry({ id: 'representative.accept', kind: 'govern', confirmation: 'first_party_step_up', input: 'ConfigureRepresentativeCommandSchema', output: 'CompanyRepresentativeSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/representative/accept' }),
  entry({ id: 'representative.suspend', kind: 'govern', input: 'RevisionCommandSchema', output: 'CompanyRepresentativeSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/representative/suspend' }),
  entry({ id: 'representative.resume', kind: 'govern', confirmation: 'first_party_step_up', input: 'RevisionCommandSchema', output: 'CompanyRepresentativeSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/representative/resume' }),
  entry({ id: 'representative.disable', kind: 'govern', confirmation: 'first_party_step_up', input: 'RevisionCommandSchema', output: 'CompanyRepresentativeSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/representative/disable' }),
  entry({ id: 'representative.list_company_mandates', kind: 'read', input: 'GrantCompanyMandateCommandSchema', output: 'CompanyMandateSchema', contexts: ['company'], reads: PARTY, effects: ['none'], route: 'GET /v1/companies/:id/agent-mandates' }),
  entry({ id: 'representative.grant_company_mandate', kind: 'govern', confirmation: 'first_party_step_up', input: 'GrantCompanyMandateCommandSchema', output: 'CompanyMandateSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/agent-mandates' }),
  entry({ id: 'representative.reconfirm_company_mandate', kind: 'govern', confirmation: 'first_party_step_up', input: 'ReconfirmCompanyMandateCommandSchema', output: 'CompanyMandateSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/agent-mandates/:mandateId/reconfirm' }),
  entry({ id: 'representative.revoke_company_mandate', kind: 'govern', input: 'RevisionCommandSchema', output: 'CompanyMandateSchema', reads: PARTY, effects: ['state_change'], route: 'POST /v1/companies/:id/agent-mandates/:mandateId/revoke' }),
];

/** Existing goal/report operations, registered without adding a new participant agent or standing action class. */
export const CORE_AGENT_MANIFEST = AgentModuleManifestSchema.parse({
  key: 'core', version: '1.0.0', family: 'core', status: 'live', actions: ['prepare'],
  capabilities: AGENT_CAPABILITIES.filter((entry) => entry.capability.id.startsWith('core.')).map((entry) => entry.capability),
  meters: [], suits: [], freeFloor: [], safetySuite: 'tests/agent-modules',
});

/** Existing AGT-001 vocabulary only; hubs must explicitly activate these newly registered modules. */
export const NEGOTIATION_MANIFEST = AgentModuleManifestSchema.parse({
  key: 'negotiation', version: '1.0.0', family: 'deal', status: 'live', actions: ['negotiate', 'communicate', 'schedule', 'introduce'],
  capabilities: AGENT_CAPABILITIES.filter(entry => entry.capability.id.startsWith('negotiation.')).map(entry => entry.capability),
  meters: ['agent_actions'], suits: [], freeFloor: [], safetySuite: 'tests/assistant-goals',
});
export const REPRESENTATIVE_MANIFEST = AgentModuleManifestSchema.parse({
  key: 'representative', version: '1.0.0', family: 'core', status: 'live', actions: [],
  capabilities: AGENT_CAPABILITIES.filter(entry => entry.capability.id.startsWith('representative.')).map(entry => entry.capability),
  meters: [], suits: [], freeFloor: [], safetySuite: 'tests/assistant-goals',
});
