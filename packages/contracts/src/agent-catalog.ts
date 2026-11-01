import { z } from 'zod';
import { PartySchema } from './access.js';
import { ActionStateSchema, ExternalOutcomeSchema, MandateActionSchema, MandateStatusSchema, type Mandate } from './assistant.js';
import { BudgetKindSchema, type BudgetKind } from './billing.js';
import { DigestSchema, Sha256HexSchema } from './common/digest-schema.js';
import { BusinessDateSchema, IanaTimeZoneSchema, IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { compareMoney, CurrencySchema, NonNegativeMinorUnitsSchema, NonNegativeMoneySchema, type Money } from './common/money.js';
import { ProjectionLayerSchema } from './common/projection.js';
import { AgentModuleKeySchema, LocaleTagSchema, type KillSwitch } from './hub.js';

/**
 * Agent catalogue contracts (AGT-002): mandate v2, the capability registry every module registers into, module manifests,
 * hub agent policy, subscription plans, meters and usage, goals, job triggers, agent-to-agent envelopes, reports, external
 * connections and participant stop controls. Source: docs/engine/agent-catalog.md (data model section), ADR 010
 * decisions 4, 9 and 17-23, ADR 012, names from docs/data/model.md section 21.
 *
 * Nothing here changes the frozen v1 shapes in `assistant.ts`: `MandateSchema` stays valid and is the v1 subset of
 * `MandateV2Schema` (see `upgradeMandateV1`). Status: Contract (frozen shapes); nothing in this file runs a live agent.
 *
 * Invariants carried by these schemas and pure functions:
 * - chat text, connections and agents never create, confirm or widen a mandate (`mandateChangeAllowed`);
 * - `confirm_execution` and `approve` are human-only: no schema-valid mandate pre-authorizes them (`evaluateMandateV2`);
 * - a note-kind (free text) condition is display-only and forces ask-each;
 * - money commitments need a budget of the right kind;
 * - a capability marked `commit` names a mandate kind and a confirmation policy (`capabilityViolations`);
 * - no field buys ranking, matching, reputation or introductions; protection limits are never plan quotas.
 */

/** Version of this contract file; JSON Schemas carry it in their `$id`. Breaking changes need a new version and an ADR. */
export const AGENT_CATALOG_CONTRACT_VERSION = 1 as const;

/* ---------- Shared vocabulary ---------- */

/** Honest status labels used across the handbook. */
export const StatusLabelSchema = z.enum(['live', 'demo', 'contract', 'designed', 'proposed']);
export type StatusLabel = z.infer<typeof StatusLabelSchema>;

/** ISO 3166-1 alpha-2 or ISO 3166-2 subdivision code (for example `US`, `US-TX`). */
export const RegionCodeSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, 'ISO 3166-1 or 3166-2 code');
export const CategoryCodeSchema = z.string().min(1).max(80);

/** Codes that a region code covers for restricted-place checks: the country and, for a subdivision, the subdivision. */
function regionCodes(region: string): string[] {
  const country = region.slice(0, 2);
  return region.length > 2 ? [country, region] : [country];
}
/** `US-TX` is inside `US`; `US` is not inside `US-TX`. */
export function regionWithin(region: string, container: string): boolean {
  return region === container || (container.length === 2 && region.startsWith(`${container}-`));
}

/** The person (or company member) who confirmed something on the first-party surface. Never an agent, a connection or chat. */
export const FirstPartyConfirmationSchema = z.strictObject({
  via: z.literal('first_party_form'),
  personId: IdSchema,
  at: TimestampSchema,
  stepUp: z.boolean(),
});
export type FirstPartyConfirmation = z.infer<typeof FirstPartyConfirmationSchema>;

/* ---------- Mandate v2 ---------- */

/**
 * v1 verbs plus the catalogue verbs. This is the "mandate kind" that capabilities and extensions declare.
 * `approve`, `release_payment` and `maintain_records` were appended by the procurement and supply contracts (PRC-000,
 * ADR 012 decision 36): `approve` is human-only, `release_payment` spends the transaction budget, `maintain_records`
 * changes the principal company's own internal records and needs no budget. Appending verbs keeps every v1 and v2
 * mandate valid.
 */
export const MANDATE_ACTIONS_V2 = [
  ...MandateActionSchema.options,
  'introduce', 'schedule', 'maintain_profile', 'publish', 'register', 'record_evidence', 'confirm_execution',
  'approve', 'release_payment', 'maintain_records',
] as const;
export const MandateActionV2Schema = z.enum(MANDATE_ACTIONS_V2);
export type MandateActionV2 = z.infer<typeof MandateActionV2Schema>;

/** Action classes that can never be pre-authorized, whatever a mandate or a hub policy says. */
export const HUMAN_ONLY_ACTIONS: readonly MandateActionV2[] = ['confirm_execution', 'approve'];
export function isHumanOnlyAction(action: MandateActionV2): boolean {
  return HUMAN_ONLY_ACTIONS.includes(action);
}

/** Budget kind each action consumes; consistent with `budgetKindFor` in billing.ts for the overlapping v1 verbs. */
export const BUDGET_KIND_BY_ACTION: Readonly<Record<MandateActionV2, BudgetKind | null>> = {
  prepare: null, research: null, communicate: null, send_quote: null, negotiate: null,
  place_order: 'transaction', accept_order: 'transaction', generate_deliverable: 'platform',
  introduce: null, schedule: null, maintain_profile: null, publish: null, register: 'transaction', record_evidence: null, confirm_execution: null,
  approve: null, release_payment: 'transaction', maintain_records: null,
};
/** Actions that commit the principal's money: a mandate covering them names a budget of the matching kind and a ceiling. */
export const MONEY_ACTIONS: readonly MandateActionV2[] = MANDATE_ACTIONS_V2.filter((a) => BUDGET_KIND_BY_ACTION[a] !== null);

export const CONTEXT_KINDS_V2 = [
  'project', 'rfq', 'quote', 'agreement', 'order', 'introduction', 'open_need', 'partner_post', 'event', 'course',
  'publication', 'profile', 'catalogue_offering', 'opportunity', 'company', 'plan_item', 'consultation', 'task_request', 'goal',
] as const;
export const ContextKindV2Schema = z.enum(CONTEXT_KINDS_V2);
export type ContextKindV2 = z.infer<typeof ContextKindV2Schema>;
export const ContextRefSchema = z.strictObject({ kind: ContextKindV2Schema, id: IdSchema });
export type ContextRef = z.infer<typeof ContextRefSchema>;

/**
 * Standing mandates: a selector resolved at action time; every action intent records the concrete context it resolved to.
 * A selector must constrain something: "every RFQ anywhere" is not a mandate.
 */
export const ContextSelectorSchema = z.strictObject({
  kind: ContextKindV2Schema,
  categories: z.array(CategoryCodeSchema).max(50),
  regions: z.array(RegionCodeSchema).max(50),
  projectId: IdSchema.nullable(),
}).refine((s) => s.categories.length > 0 || s.regions.length > 0 || s.projectId !== null, { message: 'a selector constrains categories, regions or a project', path: ['categories'] });
export type ContextSelector = z.infer<typeof ContextSelectorSchema>;
export const MandateContextSchema = z.union([ContextRefSchema, ContextSelectorSchema]);
export type MandateContext = z.infer<typeof MandateContextSchema>;
function isSelector(c: MandateContext): c is ContextSelector {
  return 'categories' in c;
}

export const CounterpartyStatusSchema = z.enum(['sourced', 'claimed', 'verified']);
export type CounterpartyStatus = z.infer<typeof CounterpartyStatusSchema>;
export const ConsentKindSchema = z.enum(['project_owner', 'client', 'participant']);

/** Structured conditions the engine evaluates outside the model. `note` is display-only and forces ask-each. */
export const ConditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('counterparty_status_at_least'), level: z.enum(['claimed', 'verified']) }),
  z.strictObject({ kind: z.literal('counterparty_region_in'), regions: z.array(RegionCodeSchema).min(1).max(50) }),
  z.strictObject({ kind: z.literal('category_in'), categories: z.array(CategoryCodeSchema).min(1).max(50) }),
  z.strictObject({ kind: z.literal('delivery_before'), date: BusinessDateSchema }),
  z.strictObject({ kind: z.literal('catalogue_lines_only') }),
  /** Floor or ceiling kept in a party-private constraint record; the id never leaves the owner projection. */
  z.strictObject({ kind: z.literal('within_private_constraint'), constraintRecordId: IdSchema }),
  z.strictObject({ kind: z.literal('max_open'), count: z.int().min(1).max(1000) }),
  z.strictObject({ kind: z.literal('screening_clear') }),
  z.strictObject({ kind: z.literal('credential_checked'), checkType: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal('consent_recorded'), consentKind: ConsentKindSchema }),
  z.strictObject({ kind: z.literal('note'), text: ShortTextSchema }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const ApprovalPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('ask_each') }),
  z.strictObject({ mode: z.literal('ask_first'), count: z.int().min(1).max(100) }),
  z.strictObject({ mode: z.literal('ask_above'), threshold: NonNegativeMoneySchema }),
  z.strictObject({ mode: z.literal('pre_authorized') }),
]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

/** Default approval per action for mandate templates that modules propose (catalogue, action vocabulary v2). */
export const DEFAULT_APPROVAL_BY_ACTION: Readonly<Record<MandateActionV2, ApprovalPolicy>> = {
  prepare: { mode: 'pre_authorized' }, research: { mode: 'pre_authorized' }, communicate: { mode: 'ask_first', count: 3 },
  send_quote: { mode: 'ask_each' }, negotiate: { mode: 'ask_each' }, place_order: { mode: 'ask_each' }, accept_order: { mode: 'ask_each' },
  generate_deliverable: { mode: 'ask_each' }, introduce: { mode: 'ask_first', count: 3 }, schedule: { mode: 'ask_each' },
  maintain_profile: { mode: 'ask_each' }, publish: { mode: 'ask_each' }, register: { mode: 'ask_each' }, record_evidence: { mode: 'ask_first', count: 5 },
  confirm_execution: { mode: 'ask_each' }, approve: { mode: 'ask_each' }, release_payment: { mode: 'ask_each' }, maintain_records: { mode: 'ask_first', count: 5 },
};

/** Company approvers: e.g. two of the named members above USD 350,000. `above: null` applies to every action. */
export const ApproverRuleSchema = z.strictObject({
  approverPersonIds: z.array(IdSchema).min(1).max(20),
  minApprovals: z.int().min(1).max(5),
  above: NonNegativeMoneySchema.nullable(),
})
  .refine((r) => new Set(r.approverPersonIds).size === r.approverPersonIds.length, { message: 'approvers are distinct', path: ['approverPersonIds'] })
  .refine((r) => r.minApprovals <= r.approverPersonIds.length, { message: 'enough approvers to reach the minimum', path: ['minApprovals'] });
export type ApproverRule = z.infer<typeof ApproverRuleSchema>;

export const EscalationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ask_principal') }),
  z.strictObject({ kind: z.literal('ask_person'), personId: IdSchema }),
  z.strictObject({ kind: z.literal('stop') }),
]);
export type Escalation = z.infer<typeof EscalationSchema>;

/** Who exercises the mandate. Always the principal's one agent, a colleague's one agent, or the company's one representative. */
export const GranteeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('own_agent') }),
  z.strictObject({ kind: z.literal('colleague_agent'), personId: IdSchema, companyId: IdSchema }),
  z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema }),
]);
export type Grantee = z.infer<typeof GranteeSchema>;

export const MandateLimitsV2Schema = z.strictObject({
  ceiling: NonNegativeMoneySchema.nullable(),
  perActionCeiling: NonNegativeMoneySchema.nullable(),
  transactionBudgetId: IdSchema.nullable(),
  platformBudgetId: IdSchema.nullable(),
  perWindow: z.strictObject({ count: z.int().min(1).max(10_000), windowHours: z.int().min(1).max(24 * 31) }).nullable(),
});
export type MandateLimitsV2 = z.infer<typeof MandateLimitsV2Schema>;

/** Mandate field set, without the cross-field invariants (`MandateV2Schema` adds them). */
const MandateV2Shape = z.strictObject({
  id: IdSchema,
  schemaVersion: z.literal(2),
  principal: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  grantee: GranteeSchema,
  moduleKeys: z.array(AgentModuleKeySchema).min(1).max(50),
  actions: z.array(MandateActionV2Schema).min(1),
  contexts: z.array(MandateContextSchema).min(1).max(200),
  limits: MandateLimitsV2Schema,
  conditions: z.array(ConditionSchema).max(50),
  approvalPolicy: ApprovalPolicySchema,
  approvers: z.array(ApproverRuleSchema).max(5),
  escalation: EscalationSchema,
  /** Mandates are confirmed only by the principal on the first-party surface; never by chat, an agent or a connection. */
  confirmation: FirstPartyConfirmationSchema.nullable(),
  validUntil: TimestampSchema,
  status: MandateStatusSchema,
  revision: RevisionSchema,
  revokedAt: TimestampSchema.nullable(),
});
type MandateV2Fields = z.infer<typeof MandateV2Shape>;

/** Cross-field invariants of a v2 mandate; empty when valid. Used by the schema and by `upgradeMandateV1`. */
export function mandateV2Violations(m: MandateV2Fields): string[] {
  const out: string[] = [];
  if (new Set(m.actions).size !== m.actions.length) out.push('actions are distinct');
  if (new Set(m.moduleKeys).size !== m.moduleKeys.length) out.push('module keys are distinct');
  if (new Set(m.contexts.map((c) => JSON.stringify(c))).size !== m.contexts.length) out.push('contexts are distinct');
  if (m.status !== 'draft' && m.confirmation === null) out.push('a non-draft mandate records the first-party confirmation');
  if (m.confirmation !== null && m.confirmation.personId !== m.principal.personId) out.push('only the principal confirms the mandate');
  if ((m.status === 'revoked') !== (m.revokedAt !== null)) out.push('revokedAt is set exactly when revoked');
  for (const action of m.actions) {
    const kind = BUDGET_KIND_BY_ACTION[action];
    if (kind === 'transaction' && (m.limits.transactionBudgetId === null || m.limits.ceiling === null)) out.push(`${action} needs a transaction budget and a ceiling`);
    if (kind === 'platform' && m.limits.platformBudgetId === null) out.push(`${action} needs a platform budget`);
  }
  const { ceiling, perActionCeiling } = m.limits;
  if (ceiling && perActionCeiling) {
    if (ceiling.currency !== perActionCeiling.currency) out.push('ceilings share one currency');
    else if (compareMoney(perActionCeiling, ceiling) > 0) out.push('per-action ceiling within the ceiling');
  }
  if (m.approvalPolicy.mode === 'ask_above' && ceiling && m.approvalPolicy.threshold.currency !== ceiling.currency) out.push('approval threshold in the ceiling currency');
  const company = m.principal.onBehalfOf?.kind === 'company' ? m.principal.onBehalfOf.id : null;
  if (m.grantee.kind !== 'own_agent' && m.grantee.companyId !== company) out.push('colleague and representative grantees act for the principal company');
  if (m.approvers.length > 0 && company === null) out.push('approver rules exist only for company mandates');
  return out;
}

/** Structured authority v2. A v1 mandate upgrades into it (`upgradeMandateV1`). */
export const MandateV2Schema = MandateV2Shape.superRefine((m, ctx) => {
  for (const message of mandateV2Violations(m)) ctx.addIssue({ code: 'custom', message, path: [] });
});
export type MandateV2 = z.infer<typeof MandateV2Schema>;

/**
 * Upgrades a frozen v1 mandate. Fail-closed: v1 free-text conditions become `note` conditions (display-only, so every
 * action asks), the approval policy is `ask_each` and escalation asks the principal. A v1 mandate whose money actions lack
 * a budget does not upgrade.
 */
export function upgradeMandateV1(
  v1: Mandate,
  options: { moduleKeys: readonly string[]; grantee: Grantee; confirmation: FirstPartyConfirmation | null },
): { ok: true; mandate: MandateV2 } | { ok: false; issues: string[] } {
  if (v1.limits.ceiling.minorUnits.startsWith('-') || v1.limits.perActionCeiling?.minorUnits.startsWith('-')) return { ok: false, issues: ['negative ceiling'] };
  const candidate = {
    id: v1.id,
    schemaVersion: 2,
    principal: v1.principal,
    grantee: options.grantee,
    moduleKeys: [...options.moduleKeys],
    actions: [...v1.actions],
    contexts: v1.contexts.map((c) => ({ kind: c.kind, id: c.id })),
    limits: { ceiling: v1.limits.ceiling, perActionCeiling: v1.limits.perActionCeiling, transactionBudgetId: v1.limits.transactionBudgetId, platformBudgetId: v1.limits.platformBudgetId, perWindow: null },
    conditions: v1.conditions.map((text) => ({ kind: 'note' as const, text })),
    approvalPolicy: { mode: 'ask_each' as const },
    approvers: [],
    escalation: { kind: 'ask_principal' as const },
    confirmation: options.confirmation,
    validUntil: v1.validUntil,
    status: v1.status,
    revision: v1.revision,
    revokedAt: v1.revokedAt,
  };
  const parsed = MandateV2Schema.safeParse(candidate);
  return parsed.success ? { ok: true, mandate: parsed.data } : { ok: false, issues: parsed.error.issues.map((i) => i.message) };
}

/* ---------- Mandate changes: proposals versus confirmations ---------- */

/** Where a proposed mandate change came from. None of these origins can apply it; only a first-party confirmation can. */
export const MandateProposalOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat_intent'), runId: IdSchema }),
  z.strictObject({ kind: z.literal('agent'), runId: IdSchema, moduleKey: AgentModuleKeySchema }),
  z.strictObject({ kind: z.literal('module_template'), moduleKey: AgentModuleKeySchema, templateKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/) }),
  z.strictObject({ kind: z.literal('goal'), goalId: IdSchema }),
  z.strictObject({ kind: z.literal('connection'), connectionId: IdSchema }),
  z.strictObject({ kind: z.literal('settings'), settingsVersionId: IdSchema }),
]);
export const MandateChangeProposalSchema = z.strictObject({
  id: IdSchema,
  /** `null` proposes a new mandate. */
  mandateId: IdSchema.nullable(),
  basisRevision: RevisionSchema.nullable(),
  origin: MandateProposalOriginSchema,
  /** The full proposed mandate, inert (status `draft`, no confirmation) until the principal confirms it. */
  proposed: MandateV2Schema,
  status: z.enum(['pending', 'confirmed', 'declined', 'expired', 'superseded']),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
})
  .refine((p) => p.proposed.status === 'draft' && p.proposed.confirmation === null, { message: 'a proposal is an unconfirmed draft', path: ['proposed'] })
  .refine((p) => (p.mandateId === null) === (p.basisRevision === null), { message: 'a change names the revision it is based on', path: ['basisRevision'] })
  .refine((p) => p.proposed.id === (p.mandateId ?? p.proposed.id) && p.proposed.revision === (p.basisRevision ?? 0) + 1, { message: 'the proposal is the next revision of the named mandate', path: ['proposed'] })
  .refine((p) => (p.status === 'pending') === (p.decidedAt === null), { message: 'decided proposals record when', path: ['decidedAt'] });
export type MandateChangeProposal = z.infer<typeof MandateChangeProposalSchema>;

/** Strictness order of approval policies: a higher rank asks less. */
function approvalWidens(before: ApprovalPolicy, after: ApprovalPolicy): boolean {
  const rank = { ask_each: 0, ask_first: 1, ask_above: 2, pre_authorized: 3 } as const;
  if (rank[after.mode] !== rank[before.mode]) return rank[after.mode] > rank[before.mode];
  if (before.mode === 'ask_first' && after.mode === 'ask_first') return after.count < before.count;
  if (before.mode === 'ask_above' && after.mode === 'ask_above') return before.threshold.currency !== after.threshold.currency || compareMoney(after.threshold, before.threshold) > 0;
  return false;
}
function moneyLimitWidens(before: Money | null, after: Money | null): boolean {
  if (after === null) return before !== null; // removing a ceiling widens
  if (before === null) return false;
  return before.currency !== after.currency || compareMoney(after, before) > 0;
}
const keys = <T>(items: readonly T[]) => new Set(items.map((i) => JSON.stringify(i)));
const adds = <T>(before: readonly T[], after: readonly T[]) => {
  const b = keys(before);
  return after.some((i) => !b.has(JSON.stringify(i)));
};
const removes = <T>(before: readonly T[], after: readonly T[]) => adds(after, before);

/** True when `after` authorizes anything `before` did not. Status moves towards active also widen. */
export function mandateWidens(before: MandateV2, after: MandateV2): boolean {
  if (before.id !== after.id || JSON.stringify(before.principal) !== JSON.stringify(after.principal)) return true;
  if (JSON.stringify(before.grantee) !== JSON.stringify(after.grantee)) return true;
  if (adds(before.actions, after.actions) || adds(before.moduleKeys, after.moduleKeys) || adds(before.contexts, after.contexts)) return true;
  if (removes(before.conditions, after.conditions)) return true;
  if (moneyLimitWidens(before.limits.ceiling, after.limits.ceiling) || moneyLimitWidens(before.limits.perActionCeiling, after.limits.perActionCeiling)) return true;
  for (const key of ['transactionBudgetId', 'platformBudgetId'] as const) if (after.limits[key] !== null && after.limits[key] !== before.limits[key]) return true;
  const bw = before.limits.perWindow;
  const aw = after.limits.perWindow;
  if (aw === null ? bw !== null : bw !== null && (aw.count > bw.count || aw.windowHours < bw.windowHours)) return true;
  if (approvalWidens(before.approvalPolicy, after.approvalPolicy)) return true;
  if (removes(before.approvers, after.approvers)) return true;
  if (before.escalation.kind === 'stop' && after.escalation.kind !== 'stop') return true;
  if (Date.parse(after.validUntil) > Date.parse(before.validUntil)) return true;
  if (after.status === 'active' && before.status !== 'active') return true;
  return false;
}

/** Who tries to apply a mandate change. Only `person` acting on the first-party surface may create, confirm or widen. */
export type MandateChangeActor =
  | { kind: 'person'; personId: string; via: 'first_party_form' }
  | { kind: 'system'; reason: 'authority_basis_lost' | 'kill_switch' | 'expiry' | 'membership_ended' }
  | { kind: 'agent' | 'connection' | 'chat' | 'module' | 'goal' | 'extension' };
export type MandateChangeResult = 'ok' | 'mandate.proposal_only' | 'mandate.not_principal' | 'mandate.system_may_only_narrow' | 'mandate.revision_conflict' | 'mandate.invalid';

/**
 * Pure gate for applying a mandate change (creation when `before` is null). Agents, connections, chat, modules, goals and
 * extensions only ever produce proposals. The system may only narrow (suspend, revoke, expire). The caller still checks
 * that the principal's current rights cover the mandate (rule 1 of docs/engine/agents.md).
 */
export function mandateChangeAllowed(actor: MandateChangeActor, before: MandateV2 | null, after: MandateV2): MandateChangeResult {
  if (!MandateV2Schema.safeParse(after).success) return 'mandate.invalid';
  if (before !== null && after.revision !== before.revision + 1) return 'mandate.revision_conflict';
  if (before === null && after.revision !== 1) return 'mandate.revision_conflict';
  switch (actor.kind) {
    case 'person':
      if (actor.via !== 'first_party_form' || actor.personId !== after.principal.personId) return 'mandate.not_principal';
      if ((before === null || mandateWidens(before, after)) && after.status !== 'draft' && (after.confirmation === null || after.confirmation.personId !== actor.personId)) return 'mandate.not_principal';
      return 'ok';
    case 'system': {
      if (before === null || mandateWidens(before, after)) return 'mandate.system_may_only_narrow';
      return after.status === 'active' ? 'mandate.system_may_only_narrow' : 'ok';
    }
    default:
      return 'mandate.proposal_only';
  }
}

/* ---------- Action intent v2 ---------- */

/** v1 `ActionIntentSchema` stays frozen; v2 intents add the catalogue verbs, the resolved context, the capability and the connection. */
export const ActionIntentV2Schema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  mandate: z.strictObject({ id: IdSchema, revision: RevisionSchema }),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  action: MandateActionV2Schema,
  /** The concrete context a standing selector resolved to at action time. */
  context: ContextRefSchema,
  resolvedFromSelector: z.boolean(),
  amount: NonNegativeMoneySchema.nullable(),
  actionDigest: DigestSchema,
  state: ActionStateSchema,
  reservationId: IdSchema.nullable(),
  attemptCount: z.int().min(0),
  effectCorrelationKey: z.string().min(1).max(200),
  outcome: ExternalOutcomeSchema.nullable(),
  viaConnectionId: IdSchema.nullable(),
  revision: RevisionSchema,
}).refine((i) => !(BUDGET_KIND_BY_ACTION[i.action] !== null && ['reserved', 'queued', 'executing', 'pending', 'succeeded'].includes(i.state)) || i.reservationId !== null, {
  message: 'a budgeted action past authorization holds a budget reservation',
  path: ['reservationId'],
});
export type ActionIntentV2 = z.infer<typeof ActionIntentV2Schema>;

/* ---------- Pure mandate v2 policy ---------- */

/** Facts resolved outside the model from first-party records. A missing fact makes its condition unevaluable. */
export type ConditionFacts = {
  counterpartyStatus?: CounterpartyStatus;
  counterpartyRegion?: string;
  categories?: readonly string[];
  deliveryDate?: { date: string; timeZone: string };
  catalogueLinesOnly?: boolean;
  /** constraintRecordId -> whether the action stays within the private floor or ceiling. */
  withinPrivateConstraint?: Readonly<Record<string, boolean>>;
  openCount?: number;
  screeningClear?: boolean;
  credentialsChecked?: readonly string[];
  consentsRecorded?: readonly z.infer<typeof ConsentKindSchema>[];
};

export type AgentActor =
  | { kind: 'own_agent'; personId: string }
  | { kind: 'colleague_agent'; personId: string; companyId: string }
  | { kind: 'company_representative'; companyId: string };

export type MandateV2CheckRequest = {
  moduleKey: string;
  action: MandateActionV2;
  context: ContextRef;
  /** Attributes of the concrete context used to match standing selectors. */
  contextFacts: { categories: readonly string[]; region: string | null; projectId: string | null };
  amount: Money | null;
  /** Already committed under this mandate (cumulative ceiling); same currency as the ceiling. */
  committedUnderMandate: Money | null;
  actionsInWindow: number;
  /** Approved actions under the current mandate revision (for `ask_first`; a material change restarts the count). */
  approvalsAtRevision: number;
  conditionFacts: ConditionFacts;
  actor: AgentActor;
  via: { kind: 'first_party' } | { kind: 'connection'; connection: ExternalConnection };
  hub: { forbiddenPreAuthorization: readonly MandateActionV2[] };
  /** Result of `agentDispatchBlocked` for this action; kill switches are effective before the next check. */
  blockedBySwitchId: string | null;
  /** Restricted-places predicate from `@trustwork/country-packs` (`isRestricted`). */
  isRestricted: (code: string) => boolean;
};

export type MandateDenyReason =
  | 'mandate_not_active' | 'mandate_expired' | 'kill_switch' | 'grantee_mismatch' | 'module_scope' | 'action_scope' | 'context_scope'
  | 'restricted_place' | 'budget_missing' | 'amount_missing' | 'currency_mismatch' | 'per_action_ceiling' | 'ceiling' | 'window_exhausted'
  | 'condition_failed' | 'condition_unevaluable' | 'connection_not_bound' | 'invalid_mandate';
export type MandateAskReason =
  | 'human_only' | 'note_condition' | 'condition_unevaluable' | 'ask_each' | 'ask_first' | 'above_threshold' | 'threshold_currency'
  | 'hub_forbids_pre_authorization' | 'approver_rule' | 'connection_propose_only';
export type MandateV2Decision =
  | { effect: 'allow'; mandate: { id: string; revision: number }; context: ContextRef; resolvedFromSelector: boolean }
  | {
      effect: 'ask';
      reasons: MandateAskReason[];
      requiredApprovals: ApproverRule[];
      escalation: Escalation | null;
      mandate: { id: string; revision: number };
      context: ContextRef;
      resolvedFromSelector: boolean;
    }
  | { effect: 'deny'; reason: MandateDenyReason };

/** Whether a concrete context is covered: an exact reference, or a selector matched on its facts (fail-closed). */
export function contextCovered(contexts: readonly MandateContext[], ref: ContextRef, facts: MandateV2CheckRequest['contextFacts']): { covered: boolean; viaSelector: boolean } {
  if (contexts.some((c) => !isSelector(c) && c.kind === ref.kind && c.id === ref.id)) return { covered: true, viaSelector: false };
  const match = contexts.some((c) => {
    if (!isSelector(c) || c.kind !== ref.kind) return false;
    if (c.categories.length > 0 && (facts.categories.length === 0 || !facts.categories.every((x) => c.categories.includes(x)))) return false;
    if (c.regions.length > 0 && (facts.region === null || !c.regions.some((r) => regionWithin(facts.region!, r)))) return false;
    if (c.projectId !== null && facts.projectId !== c.projectId) return false;
    return true;
  });
  return { covered: match, viaSelector: match };
}

type ConditionResult = 'pass' | 'fail' | 'unknown' | 'note';
const STATUS_RANK: Record<CounterpartyStatus, number> = { sourced: 0, claimed: 1, verified: 2 };
export function evaluateCondition(condition: Condition, facts: ConditionFacts): ConditionResult {
  const known = <T>(v: T | undefined, test: (v: T) => boolean): ConditionResult => (v === undefined ? 'unknown' : test(v) ? 'pass' : 'fail');
  switch (condition.kind) {
    case 'note':
      return 'note';
    case 'counterparty_status_at_least':
      return known(facts.counterpartyStatus, (s) => STATUS_RANK[s] >= STATUS_RANK[condition.level]);
    case 'counterparty_region_in':
      return known(facts.counterpartyRegion, (r) => condition.regions.some((c) => regionWithin(r, c)));
    case 'category_in':
      return known(facts.categories, (cs) => cs.length > 0 && cs.every((c) => condition.categories.includes(c)));
    case 'delivery_before':
      if (facts.deliveryDate === undefined || facts.deliveryDate.timeZone !== condition.date.timeZone) return 'unknown';
      return facts.deliveryDate.date < condition.date.date ? 'pass' : 'fail';
    case 'catalogue_lines_only':
      return known(facts.catalogueLinesOnly, (v) => v);
    case 'within_private_constraint':
      return known(facts.withinPrivateConstraint?.[condition.constraintRecordId], (v) => v);
    case 'max_open':
      return known(facts.openCount, (n) => n < condition.count);
    case 'screening_clear':
      return known(facts.screeningClear, (v) => v);
    case 'credential_checked':
      return known(facts.credentialsChecked, (list) => list.includes(condition.checkType));
    case 'consent_recorded':
      return known(facts.consentsRecorded, (list) => list.includes(condition.consentKind));
  }
}

function granteeMatches(m: MandateV2, actor: AgentActor): boolean {
  const g = m.grantee;
  if (g.kind === 'own_agent') return actor.kind === 'own_agent' && actor.personId === m.principal.personId;
  if (g.kind === 'colleague_agent') return actor.kind === 'colleague_agent' && actor.personId === g.personId && actor.companyId === g.companyId;
  return actor.kind === 'company_representative' && actor.companyId === g.companyId;
}

/**
 * Pure, fail-closed check of one proposed action against a v2 mandate. It takes no free text: chat, envelope notes and
 * connection prose cannot reach it. The database repeats balance and revision checks under a lock before the effect.
 * Human-only actions, note conditions, hub-forbidden pre-authorization and approver rules always end in `ask`.
 */
export function evaluateMandateV2(m: MandateV2, req: MandateV2CheckRequest, now: Date): MandateV2Decision {
  const deny = (reason: MandateDenyReason): MandateV2Decision => ({ effect: 'deny', reason });
  const t = now.getTime();
  if (!Number.isFinite(t) || !MandateV2Schema.safeParse(m).success) return deny('invalid_mandate');
  if (m.status !== 'active' || m.revokedAt !== null || m.confirmation === null) return deny('mandate_not_active');
  if (!(Date.parse(m.validUntil) > t)) return deny('mandate_expired');
  if (req.blockedBySwitchId !== null) return deny('kill_switch');
  if (!granteeMatches(m, req.actor)) return deny('grantee_mismatch');
  if (!m.moduleKeys.includes(req.moduleKey)) return deny('module_scope');
  if (!m.actions.includes(req.action)) return deny('action_scope');
  const { covered, viaSelector } = contextCovered(m.contexts, req.context, req.contextFacts);
  if (!covered) return deny('context_scope');

  const places = [req.contextFacts.region, req.conditionFacts.counterpartyRegion ?? null, ...m.contexts.flatMap((c) => (isSelector(c) ? c.regions : []))];
  if (places.some((p) => p !== null && regionCodes(p).some((code) => req.isRestricted(code)))) return deny('restricted_place');

  const budgetKind = BUDGET_KIND_BY_ACTION[req.action];
  if (budgetKind === 'transaction' && (m.limits.transactionBudgetId === null || m.limits.ceiling === null)) return deny('budget_missing');
  if (budgetKind === 'platform' && m.limits.platformBudgetId === null) return deny('budget_missing');
  if (budgetKind !== null && req.amount === null) return deny('amount_missing');
  if (req.amount !== null) {
    if (req.amount.minorUnits.startsWith('-')) return deny('amount_missing');
    const { ceiling, perActionCeiling } = m.limits;
    if (perActionCeiling) {
      if (perActionCeiling.currency !== req.amount.currency) return deny('currency_mismatch');
      if (compareMoney(req.amount, perActionCeiling) > 0) return deny('per_action_ceiling');
    }
    if (ceiling) {
      const committed = req.committedUnderMandate ?? { minorUnits: '0', currency: ceiling.currency };
      if (ceiling.currency !== req.amount.currency || committed.currency !== ceiling.currency) return deny('currency_mismatch');
      const total = { minorUnits: (BigInt(committed.minorUnits) + BigInt(req.amount.minorUnits)).toString(), currency: ceiling.currency };
      if (compareMoney(total, ceiling) > 0) return deny('ceiling');
    }
  }
  if (m.limits.perWindow && req.actionsInWindow >= m.limits.perWindow.count) return deny('window_exhausted');

  const reasons = new Set<MandateAskReason>();
  let escalation: Escalation | null = null;
  for (const condition of m.conditions) {
    const result = evaluateCondition(condition, req.conditionFacts);
    if (result === 'fail') return deny('condition_failed');
    if (result === 'note') reasons.add('note_condition');
    if (result === 'unknown') {
      if (m.escalation.kind === 'stop') return deny('condition_unevaluable');
      reasons.add('condition_unevaluable');
      escalation = m.escalation;
    }
  }

  if (isHumanOnlyAction(req.action)) reasons.add('human_only');
  const policy = m.approvalPolicy;
  if (policy.mode === 'ask_each') reasons.add('ask_each');
  if (policy.mode === 'ask_first' && req.approvalsAtRevision < policy.count) reasons.add('ask_first');
  if (policy.mode === 'ask_above' && req.amount !== null) {
    if (policy.threshold.currency !== req.amount.currency) reasons.add('threshold_currency');
    else if (compareMoney(req.amount, policy.threshold) > 0) reasons.add('above_threshold');
  }
  if (policy.mode !== 'ask_each' && req.hub.forbiddenPreAuthorization.includes(req.action)) reasons.add('hub_forbids_pre_authorization');

  const requiredApprovals = m.approvers.filter((rule) => rule.above === null || (req.amount !== null && rule.above.currency === req.amount.currency && compareMoney(req.amount, rule.above) >= 0) || (req.amount !== null && rule.above.currency !== req.amount.currency));
  if (requiredApprovals.length > 0) reasons.add('approver_rule');

  if (req.via.kind === 'connection') {
    const c = req.via.connection;
    const active = c.status === 'active' && ExternalConnectionSchema.safeParse(c).success;
    const bound = active && c.scopes.includes('act') && c.mandateBindings.some((b) => b.mandateId === m.id && b.revision === m.revision);
    const sameOwner = c.owner.kind === 'person' ? req.actor.kind === 'own_agent' && c.owner.personId === req.actor.personId : req.actor.kind === 'company_representative' && c.owner.companyId === req.actor.companyId;
    if (!active || !sameOwner) return deny('connection_not_bound');
    if (!bound) {
      if (!c.scopes.includes('propose')) return deny('connection_not_bound');
      reasons.add('connection_propose_only');
    }
  }

  const base = { mandate: { id: m.id, revision: m.revision }, context: req.context, resolvedFromSelector: viaSelector };
  if (reasons.size === 0) return { effect: 'allow', ...base };
  return { effect: 'ask', reasons: [...reasons], requiredApprovals, escalation, ...base };
}

/* ---------- Capability registry (ADR 010 decision 23: full agent parity) ---------- */

/**
 * `read` returns data; `draft` creates inert, owner-private drafts; `commit` moves shared state under a mandate;
 * `govern` changes the principal's own authority (confirm or revoke mandates, approve decisions, stop control, consent to a
 * connection). The agent surface prepares a `govern` step but the person performs it on the first-party form; no mandate
 * and no connection can perform it.
 */
export const CapabilityKindSchema = z.enum(['read', 'draft', 'commit', 'govern']);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
/**
 * - `none`: reads and inert drafts;
 * - `mandate`: commits follow the mandate's approval policy (`evaluateMandateV2`);
 * - `person_each` / `person_each_step_up`: every commit is confirmed by a person (human-only classes);
 * - `first_party_form` / `first_party_step_up`: governance on the first-party surface only.
 */
export const CapabilityConfirmationSchema = z.enum(['none', 'mandate', 'person_each', 'person_each_step_up', 'first_party_form', 'first_party_step_up']);
export type CapabilityConfirmation = z.infer<typeof CapabilityConfirmationSchema>;
/** Every participant-facing capability is reachable from the interface and from the person's agent; connections are optional extra hands. */
export const CapabilitySurfaceSchema = z.enum(['ui', 'agent', 'mcp', 'a2a']);
export type CapabilitySurface = z.infer<typeof CapabilitySurfaceSchema>;
export const SideEffectSchema = z.enum(['none', 'draft_state', 'state_change', 'outbound_message', 'publication', 'money_commitment', 'reputation_signal', 'external_call']);
export type SideEffect = z.infer<typeof SideEffectSchema>;
/** Party-private data classes that a connection may read only when the person opts in per class (`read.private`). */
export const PrivateDataClassSchema = z.enum(['negotiation_constraints', 'budgets', 'private_projects', 'drafts']);
export type PrivateDataClass = z.infer<typeof PrivateDataClassSchema>;
/** Projection layers a capability may read; `staff_case` is never reachable from a participant capability. */
export const CapabilityReadLayerSchema = ProjectionLayerSchema.exclude(['staff_case']);

/** Points at an exported Zod schema in `packages/contracts/src/<contract>.ts`; the contract registry test resolves every ref. */
export const ContractRefSchema = z.strictObject({
  contract: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  schema: z.string().regex(/^[A-Z][A-Za-z0-9]{1,80}Schema$/),
  version: z.int().min(1),
});
export type ContractRef = z.infer<typeof ContractRefSchema>;

export const CapabilitySourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('module'), moduleKey: AgentModuleKeySchema, moduleVersion: z.string().min(1).max(40) }),
  /** Hub-added capability through the governed extension registry (AGT-023); same invariants as built-in ones. */
  z.strictObject({ kind: z.literal('extension'), extensionId: IdSchema, extensionVersion: z.int().min(1) }),
]);
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;

export const MeterSchema = z.enum(['model_tokens', 'agent_actions', 'checks', 'document_pages', 'deliverables', 'translation_characters', 'retrieval_queries', 'external_calls']);
export type Meter = z.infer<typeof MeterSchema>;

const CapabilityShape = z.strictObject({
  /** `<module or extension key>.<operation>`, stable across versions. */
  id: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100),
  version: z.int().min(1),
  source: CapabilitySourceSchema,
  kind: CapabilityKindSchema,
  input: ContractRefSchema,
  output: ContractRefSchema,
  /** The mandate kind a commit needs; `null` for reads, drafts and governance. */
  mandateAction: MandateActionV2Schema.nullable(),
  contextKinds: z.array(ContextKindV2Schema).max(CONTEXT_KINDS_V2.length),
  confirmation: CapabilityConfirmationSchema,
  budgetKind: BudgetKindSchema.nullable(),
  reads: z.array(CapabilityReadLayerSchema).min(1),
  privateDataClasses: z.array(PrivateDataClassSchema),
  sideEffects: z.array(SideEffectSchema).min(1),
  /** Only `read` and `draft` may consume untrusted text (files, mail, web pages, other agents' notes) as input. */
  acceptsUntrustedText: z.boolean(),
  meters: z.array(MeterSchema),
  surfaces: z.array(CapabilitySurfaceSchema).min(1),
  status: StatusLabelSchema,
  labelKey: z.string().regex(/^[a-z][A-Za-z0-9_.]{2,120}$/),
});
export type AgentCapability = z.infer<typeof CapabilityShape>;

const COMMIT_CONFIRMATIONS: readonly CapabilityConfirmation[] = ['mandate', 'person_each', 'person_each_step_up'];
const PERSON_CONFIRMATIONS: readonly CapabilityConfirmation[] = ['person_each', 'person_each_step_up'];
const GOVERN_CONFIRMATIONS: readonly CapabilityConfirmation[] = ['first_party_form', 'first_party_step_up'];
const uniq = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

/**
 * Invariants of one capability, for built-in modules and hub extensions alike (an extension can add actions but never
 * bypass a mandate, a budget, a person's confirmation or the untrusted-text rule). Empty when valid.
 */
export function capabilityViolations(c: AgentCapability): string[] {
  const out: string[] = [];
  const effects = new Set(c.sideEffects);
  const sourceKey = c.source.kind === 'module' ? c.source.moduleKey : null;
  if (sourceKey !== null && !c.id.startsWith(`${sourceKey}.`)) out.push('id is prefixed with its module key');
  for (const [name, list] of [['contextKinds', c.contextKinds], ['reads', c.reads], ['privateDataClasses', c.privateDataClasses], ['sideEffects', c.sideEffects], ['meters', c.meters], ['surfaces', c.surfaces]] as const) {
    if (!uniq(list as readonly string[])) out.push(`${name} are distinct`);
  }
  if (c.privateDataClasses.length > 0 && !c.reads.some((r) => r === 'party_private' || r === 'owner_private')) out.push('private data classes need a private read layer');
  switch (c.kind) {
    case 'read':
      if (c.mandateAction !== null || c.confirmation !== 'none' || c.budgetKind !== null) out.push('reads need no mandate, confirmation or budget');
      if (!(effects.size === 1 && effects.has('none'))) out.push('reads have no side effects');
      break;
    case 'draft':
      if (c.confirmation !== 'none' || c.budgetKind !== null) out.push('drafts are inert: no confirmation or budget');
      if (c.mandateAction !== null && !['prepare', 'research', 'generate_deliverable'].includes(c.mandateAction)) out.push('a draft may only name a preparation mandate kind');
      if ([...effects].some((e) => e !== 'draft_state' && e !== 'external_call')) out.push('drafts only change draft state');
      break;
    case 'commit':
      if (c.mandateAction === null) out.push('a commit names the mandate kind it needs');
      if (!COMMIT_CONFIRMATIONS.includes(c.confirmation)) out.push('a commit names a confirmation policy');
      if (c.mandateAction !== null && isHumanOnlyAction(c.mandateAction) && !PERSON_CONFIRMATIONS.includes(c.confirmation)) out.push('human-only actions are confirmed by a person each time');
      if (c.mandateAction !== null && BUDGET_KIND_BY_ACTION[c.mandateAction] !== null && c.budgetKind !== BUDGET_KIND_BY_ACTION[c.mandateAction]) out.push('money actions name their budget kind');
      if (effects.has('money_commitment') && c.budgetKind === null) out.push('a money commitment needs a budget');
      if (effects.has('reputation_signal') && !PERSON_CONFIRMATIONS.includes(c.confirmation)) out.push('reputation signals are confirmed by a person each time');
      if (c.mandateAction === 'introduce' && c.budgetKind !== null) out.push('introductions are quota-bound, never bought');
      if (effects.has('none') || effects.has('draft_state')) out.push('a commit changes shared state');
      if (c.acceptsUntrustedText) out.push('commits accept only structured first-party input');
      break;
    case 'govern':
      if (c.mandateAction !== null || c.budgetKind !== null) out.push('governance is never delegated to a mandate');
      if (!GOVERN_CONFIRMATIONS.includes(c.confirmation)) out.push('governance happens on the first-party form');
      if (c.surfaces.includes('mcp') || c.surfaces.includes('a2a')) out.push('governance is never exposed to connections');
      if (c.acceptsUntrustedText) out.push('governance accepts only structured first-party input');
      if ([...effects].some((e) => e !== 'state_change')) out.push('governance only changes the principal\'s own authority');
      break;
  }
  if (c.kind !== 'commit' && c.budgetKind !== null) out.push('only commits consume a budget');
  if (c.source.kind === 'extension' && c.kind === 'govern') out.push('extensions cannot add governance');
  return out;
}

export const AgentCapabilitySchema = CapabilityShape.superRefine((c, ctx) => {
  for (const message of capabilityViolations(c)) ctx.addIssue({ code: 'custom', message, path: [] });
});

/** Capabilities that miss either the interface or the agent surface (CI reports these as parity gaps). */
export function parityGaps(capabilities: readonly AgentCapability[]): { id: string; missing: ('ui' | 'agent')[] }[] {
  return capabilities
    .map((c) => ({ id: c.id, missing: (['ui', 'agent'] as const).filter((s) => !c.surfaces.includes(s)) }))
    .filter((g) => g.missing.length > 0);
}

/** One registry consumed by the agent runtime, the MCP and A2A surfaces and the interface. */
export const CapabilityRegistrySchema = z.strictObject({
  registryVersion: z.int().min(1),
  /** `null`: the engine registry; otherwise the hub's registry after its policy and activated extensions. */
  hubId: IdSchema.nullable(),
  capabilities: z.array(AgentCapabilitySchema),
}).refine((r) => uniq(r.capabilities.map((c) => c.id)), { message: 'capability ids are unique', path: ['capabilities'] });
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

/* ---------- External connections (MCP, A2A) ---------- */

/** `read.private` is always paired with explicit `privateDataClasses`. */
export const ConnectionScopeSchema = z.enum(['read.public', 'read.me', 'read.contexts', 'read.private', 'propose', 'act']);
export type ConnectionScope = z.infer<typeof ConnectionScopeSchema>;

/** What a connection can never do, whatever its scopes (first-party surface only). */
export const CONNECTION_FORBIDDEN_OPERATIONS = [
  'approve_or_decline_decision', 'create_confirm_or_widen_mandate', 'step_up', 'change_credentials', 'change_email', 'change_membership_or_role',
  'accept_price_or_legal_terms', 'approve_plan_version', 'request_case_grant', 'bulk_export', 'press_or_release_kill_switch', 'disable_stop_control',
] as const;

export const ConnectionOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), personId: IdSchema }),
  /** A company system connected to its standing representative, approved by an administrator and the accountable person. */
  z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema, approvedBy: z.array(IdSchema).min(2).max(5) }),
]);
export const MandateBindingSchema = z.strictObject({ mandateId: IdSchema, revision: RevisionSchema });

/** Another hand of the person's one agent; never a second agent and never an authority of its own. */
export const ExternalConnectionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  owner: ConnectionOwnerSchema,
  protocol: z.enum(['mcp', 'a2a']),
  clientId: z.string().min(1).max(200),
  /** Self-asserted, shown as unverified unless the hub lists the client; listing never grants scope. */
  clientNameSelfAsserted: z.string().min(1).max(120),
  listedByHub: z.boolean(),
  scopes: z.array(ConnectionScopeSchema).min(1),
  privateDataClasses: z.array(PrivateDataClassSchema),
  mandateBindings: z.array(MandateBindingSchema).max(50),
  rateLimitProfile: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  consent: FirstPartyConfirmationSchema,
  status: z.enum(['active', 'suspended', 'revoked', 'expired']),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((c) => uniq(c.scopes) && uniq(c.privateDataClasses), { message: 'scopes and data classes are distinct', path: ['scopes'] })
  .refine((c) => c.scopes.includes('read.private') === c.privateDataClasses.length > 0, { message: 'read.private is opted in per data class', path: ['privateDataClasses'] })
  .refine((c) => c.mandateBindings.length === 0 || c.scopes.includes('act'), { message: 'mandate bindings need the act scope', path: ['mandateBindings'] })
  .refine((c) => !c.scopes.includes('act') || c.mandateBindings.length > 0, { message: 'act is bound to named mandate revisions', path: ['mandateBindings'] })
  .refine((c) => uniq(c.mandateBindings.map((b) => b.mandateId)), { message: 'one binding per mandate', path: ['mandateBindings'] })
  .refine((c) => c.owner.kind !== 'company_representative' || uniq(c.owner.approvedBy), { message: 'two distinct approvers', path: ['owner'] })
  .refine((c) => c.owner.kind !== 'person' || c.consent.personId === c.owner.personId, { message: 'the owner consents on the first-party surface', path: ['consent'] })
  .refine((c) => c.consent.stepUp, { message: 'consent to a connection requires step-up', path: ['consent'] })
  .refine((c) => (c.status === 'revoked') === (c.revokedAt !== null), { message: 'revokedAt is set exactly when revoked', path: ['revokedAt'] });
export type ExternalConnection = z.infer<typeof ExternalConnectionSchema>;

/** Opaque tokens; only hashes are stored, like sessions. Access tokens are short-lived and audience-bound. */
export const ConnectionTokenSchema = z.strictObject({
  id: IdSchema,
  connectionId: IdSchema,
  family: IdSchema,
  kind: z.enum(['access', 'refresh']),
  tokenHash: Sha256HexSchema,
  audience: z.url(),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  rotatedFromId: IdSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
})
  .refine((t) => Date.parse(t.expiresAt) > Date.parse(t.issuedAt), { message: 'expires after issue', path: ['expiresAt'] })
  .refine((t) => t.kind !== 'access' || Date.parse(t.expiresAt) - Date.parse(t.issuedAt) <= 60 * 60 * 1000, { message: 'access tokens live at most one hour', path: ['expiresAt'] });
export type ConnectionToken = z.infer<typeof ConnectionTokenSchema>;

/** Every connection call is audited by the digest of its arguments, never the arguments. */
export const ConnectionCallSchema = z.strictObject({
  id: IdSchema,
  connectionId: IdSchema,
  tokenFamily: IdSchema,
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100),
  argsDigest: DigestSchema,
  resultCode: z.string().regex(/^[a-z][a-z0-9_.]{1,79}$/),
  mandateRef: MandateBindingSchema.nullable(),
  actionIntentId: IdSchema.nullable(),
  at: TimestampSchema,
});
export type ConnectionCall = z.infer<typeof ConnectionCallSchema>;

/** Scopes a connection needs to reach a capability; `null` when no connection may ever reach it (governance). */
export function requiredConnectionScopes(c: AgentCapability): ConnectionScope[] | null {
  if (c.kind === 'govern') return null;
  const scopes = new Set<ConnectionScope>();
  if (c.reads.includes('public')) scopes.add('read.public');
  if (c.reads.includes('owner_private') || c.reads.includes('party_private')) scopes.add('read.me');
  if (c.reads.includes('shared_party')) scopes.add('read.contexts');
  if (c.privateDataClasses.length > 0) scopes.add('read.private');
  if (c.kind === 'draft' || c.kind === 'commit') scopes.add('propose');
  return [...scopes];
}
/**
 * How a connection may invoke a capability. `execute_under_mandate` still runs `evaluateMandateV2` with the bound mandate;
 * `propose_only` lands the action in the person's decisions.
 */
export function connectionMayInvoke(c: AgentCapability, connection: ExternalConnection): 'deny' | 'execute' | 'propose_only' | 'execute_under_mandate' {
  if (connection.status !== 'active' || !c.surfaces.includes(connection.protocol)) return 'deny';
  const required = requiredConnectionScopes(c);
  if (required === null || !required.every((s) => connection.scopes.includes(s))) return 'deny';
  if (!c.privateDataClasses.every((d) => connection.privateDataClasses.includes(d))) return 'deny';
  if (c.kind !== 'commit') return 'execute';
  return c.confirmation === 'mandate' && connection.scopes.includes('act') ? 'execute_under_mandate' : 'propose_only';
}

/* ---------- Modules, hub policy, subscription plans and metering ---------- */

export const ModuleFamilySchema = z.enum(['core', 'presence', 'opportunity', 'deal', 'plan_to_people', 'delivery', 'content', 'community', 'operations', 'connectivity']);
export const ProviderClassSchema = z.enum(['local', 'in_country', 'hosted_external']);
/** A suggestion lens, never a role; confers no rights; appears only in owner-private projections. */
export const ParticipantTypeSchema = z.enum([
  'individual_professional', 'job_seeker', 'small_contractor', 'general_contractor', 'subcontractor', 'supplier', 'manufacturer', 'design_office',
  'developer', 'homeowner', 'public_client', 'editor_author_expert', 'event_organizer', 'course_author', 'hub_staff', 'company_representative',
]);
export const QuotaWindowSchema = z.enum(['day', 'week', 'month']);
export const QuotaSchema = z.strictObject({ meter: MeterSchema, units: NonNegativeMinorUnitsSchema, window: QuotaWindowSchema });
export type Quota = z.infer<typeof QuotaSchema>;

/**
 * Bridge to the hub console's `MeteringUnitSchema` (hub.ts): which priced unit a raw meter rolls up into, if any.
 * Meters without a unit are reported but not priced by `MeteredPriceVersion`.
 */
export const METER_TO_METERING_UNIT: Readonly<Record<Meter, 'thousand_tokens' | 'action' | 'deliverable' | 'api_call' | null>> = {
  model_tokens: 'thousand_tokens', agent_actions: 'action', checks: 'action', document_pages: null, deliverables: 'deliverable',
  translation_characters: null, retrieval_queries: 'api_call', external_calls: 'api_call',
};

/**
 * Engine-defined, code-shipped module (stored as `agent_module_version` payload). Every capability the module offers is
 * registered here; hubs cannot widen a module and add capabilities only as governed extensions (AGT-023).
 */
export const AgentModuleManifestSchema = z.strictObject({
  key: AgentModuleKeySchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  family: ModuleFamilySchema,
  status: StatusLabelSchema,
  actions: z.array(MandateActionV2Schema),
  capabilities: z.array(AgentCapabilitySchema).min(1),
  meters: z.array(MeterSchema),
  suits: z.array(ParticipantTypeSchema),
  /** Engine free floor: a hub may be more generous, never less (ADR 012 decision 23, Q1). */
  freeFloor: z.array(QuotaSchema),
  safetySuite: z.string().regex(/^tests\/[A-Za-z0-9_./-]+$/),
})
  .refine((m) => m.capabilities.every((c) => c.source.kind === 'module' && c.source.moduleKey === m.key && c.source.moduleVersion === m.version), { message: 'capabilities belong to this module version', path: ['capabilities'] })
  .refine((m) => m.capabilities.every((c) => c.mandateAction === null || m.actions.includes(c.mandateAction)), { message: 'capability mandate kinds are declared module actions', path: ['actions'] })
  .refine((m) => m.capabilities.every((c) => c.meters.every((x) => m.meters.includes(x))), { message: 'capability meters are declared module meters', path: ['meters'] })
  .refine((m) => uniq(m.capabilities.map((c) => c.id)) && uniq(m.actions) && uniq(m.meters), { message: 'no duplicates', path: ['capabilities'] });
export type AgentModuleManifest = z.infer<typeof AgentModuleManifestSchema>;

/** Every module registers into one registry; extension capabilities join only with an `extension` source. */
export function buildCapabilityRegistry(input: { registryVersion: number; hubId: string | null; manifests: readonly AgentModuleManifest[]; extensionCapabilities: readonly AgentCapability[] }): CapabilityRegistry {
  if (input.extensionCapabilities.some((c) => c.source.kind !== 'extension')) throw new Error('extension capabilities carry an extension source');
  return CapabilityRegistrySchema.parse({
    registryVersion: input.registryVersion,
    hubId: input.hubId,
    capabilities: [...input.manifests.flatMap((m) => m.capabilities), ...input.extensionCapabilities],
  });
}

/** Protection limits protect recipients and the network; identical across plans and never purchasable. */
export const PROTECTION_LIMIT_KEYS = [
  'openIntroductionsPerPerson', 'newCounterpartiesPerDay', 'maxNegotiationRounds', 'consumerMaxRounds', 'envelopesPerCounterpartyPerDay',
  'publicRecordsPerConnectionPerDay', 'connectionsPerPerson', 'connectionIdleExpiryDays',
] as const;
export const ProtectionLimitsSchema = z.strictObject({
  openIntroductionsPerPerson: z.int().min(0).max(1000),
  newCounterpartiesPerDay: z.int().min(0).max(1000),
  maxNegotiationRounds: z.int().min(1).max(20),
  consumerMaxRounds: z.int().min(1).max(20),
  envelopesPerCounterpartyPerDay: z.int().min(0).max(1000),
  publicRecordsPerConnectionPerDay: z.int().min(0).max(100_000),
  connectionsPerPerson: z.int().min(1).max(20),
  connectionIdleExpiryDays: z.int().min(1).max(365),
});
export type ProtectionLimits = z.infer<typeof ProtectionLimitsSchema>;

/**
 * Stored as `hub_config_version` domain `agents`; drafted by one person, activated by another (hub.ts). Kill switches are
 * `KillSwitch` records (hub.ts); disclosure and liability wording is the jurisdiction domain (HUB-005).
 */
export const HubAgentPolicySchema = z.strictObject({
  hubId: IdSchema,
  enabledModules: z.array(z.strictObject({
    moduleKey: AgentModuleKeySchema,
    moduleVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    freeQuota: z.array(QuotaSchema),
    settings: z.record(z.string().regex(/^[a-z][A-Za-z0-9_]{1,60}$/), z.union([z.string().max(200), z.number(), z.boolean()])),
  })),
  protectionLimits: ProtectionLimitsSchema,
  forbiddenPreAuthorization: z.array(MandateActionV2Schema),
  activeExtensionVersionIds: z.array(IdSchema),
}).refine((p) => uniq(p.enabledModules.map((m) => m.moduleKey)) && uniq(p.forbiddenPreAuthorization), { message: 'no duplicates', path: ['enabledModules'] });
export type HubAgentPolicy = z.infer<typeof HubAgentPolicySchema>;

const quotaKey = (q: Pick<Quota, 'meter' | 'window'>) => `${q.meter}/${q.window}`;
/** A hub policy that enables unknown modules or lowers a module's free floor is refused. */
export function hubPolicyViolations(policy: HubAgentPolicy, manifests: readonly AgentModuleManifest[]): string[] {
  const out: string[] = [];
  for (const enabled of policy.enabledModules) {
    const manifest = manifests.find((m) => m.key === enabled.moduleKey && m.version === enabled.moduleVersion);
    if (!manifest) {
      out.push(`unknown module ${enabled.moduleKey}@${enabled.moduleVersion}`);
      continue;
    }
    for (const floor of manifest.freeFloor) {
      const given = enabled.freeQuota.find((q) => quotaKey(q) === quotaKey(floor));
      if (!given || BigInt(given.units) < BigInt(floor.units)) out.push(`free floor reduced: ${manifest.key} ${quotaKey(floor)}`);
    }
  }
  return out;
}
/** Introductions and other protection limits depend only on the hub policy: no plan, payment or entitlement is an input. */
export function protectionLimitReached(limits: ProtectionLimits, key: (typeof PROTECTION_LIMIT_KEYS)[number], current: number): boolean {
  return !Number.isInteger(current) || current < 0 || current >= limits[key];
}

/**
 * What an agent subscription plan includes (`subscription_plan_version` payload; "agent plan version" in the catalogue,
 * renamed to avoid the project plan). It buys capacity for the payer's own work: no field touches ranking, matching,
 * recommendations, reputation, introductions or other protection limits.
 */
export const SubscriptionPlanVersionSchema = z.strictObject({
  id: IdSchema,
  offerId: IdSchema,
  version: z.int().min(1),
  payerKind: z.enum(['person', 'company']),
  moduleKeys: z.array(AgentModuleKeySchema).min(1),
  includedQuota: z.array(z.strictObject({ moduleKey: AgentModuleKeySchema, meter: MeterSchema, units: NonNegativeMinorUnitsSchema, window: QuotaWindowSchema })),
  connections: z.int().min(1).max(20),
  channels: z.int().min(0).max(50),
  representativeIncluded: z.boolean(),
  /** Existing `PriceVersion` (billing.ts) with second-person activation and disclosure. */
  priceVersionId: IdSchema,
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
})
  .refine((p) => uniq(p.moduleKeys), { message: 'modules are distinct', path: ['moduleKeys'] })
  .refine((p) => p.includedQuota.every((q) => p.moduleKeys.includes(q.moduleKey)), { message: 'quotas belong to included modules', path: ['includedQuota'] })
  .refine((p) => uniq(p.includedQuota.map((q) => `${q.moduleKey}/${quotaKey(q)}`)), { message: 'one quota per module, meter and window', path: ['includedQuota'] })
  .refine((p) => !p.representativeIncluded || p.payerKind === 'company', { message: 'only companies have a representative', path: ['representativeIncluded'] });
export type SubscriptionPlanVersion = z.infer<typeof SubscriptionPlanVersionSchema>;

/** Price per thousand meter units for a hub; same activation discipline as `PriceVersion`. */
export const MeterRateVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  version: z.int().min(1),
  meter: MeterSchema,
  providerClass: ProviderClassSchema.nullable(),
  currency: CurrencySchema,
  pricePerThousandUnits: NonNegativeMoneySchema,
  passThrough: z.boolean(),
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
})
  .refine((r) => r.pricePerThousandUnits.currency === r.currency, { message: 'price in the rate currency', path: ['pricePerThousandUnits'] })
  .refine((r) => r.status === 'draft' || r.status === 'cancelled' || (r.activatedBy !== null && r.activatedAt !== null), { message: 'non-draft versions record activation', path: ['activatedBy'] })
  .refine((r) => r.activatedBy === null || r.activatedBy !== r.draftedBy, { message: 'activator must differ from drafter', path: ['activatedBy'] })
  .refine((r) => r.activatedAt === null || Date.parse(r.effectiveFrom) > Date.parse(r.activatedAt), { message: 'no back-dating', path: ['effectiveFrom'] })
  .refine((r) => r.effectiveTo === null || Date.parse(r.effectiveTo) > Date.parse(r.effectiveFrom), { message: 'effectiveTo after effectiveFrom', path: ['effectiveTo'] });
export type MeterRateVersion = z.infer<typeof MeterRateVersionSchema>;
export function meterRateVersionsOverlap(a: MeterRateVersion, b: MeterRateVersion): boolean {
  if (a.hubId !== b.hubId || a.meter !== b.meter || a.providerClass !== b.providerClass || a.status !== 'active' || b.status !== 'active') return false;
  const end = (r: MeterRateVersion) => (r.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(r.effectiveTo));
  return Date.parse(a.effectiveFrom) < end(b) && Date.parse(b.effectiveFrom) < end(a);
}

/** Append-only; idempotent per (runStepId, attemptId, meter). Usage beyond the included quota is priced and reserved first. */
export const UsageRecordSchema = z.strictObject({
  id: IdSchema,
  principal: PartySchema,
  billingAccountId: IdSchema,
  moduleKey: AgentModuleKeySchema,
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100).nullable(),
  runId: IdSchema,
  runStepId: IdSchema,
  attemptId: IdSchema,
  connectionId: IdSchema.nullable(),
  meter: MeterSchema,
  providerClass: ProviderClassSchema.nullable(),
  units: NonNegativeMinorUnitsSchema,
  withinIncludedQuota: z.boolean(),
  meterRateVersionId: IdSchema.nullable(),
  /** Platform-budget reservation; there is no overage without one. */
  reservationId: IdSchema.nullable(),
  recordedAt: TimestampSchema,
}).refine((u) => u.withinIncludedQuota || (u.meterRateVersionId !== null && u.reservationId !== null), { message: 'usage beyond the included quota is priced and reserved', path: ['reservationId'] });
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export function usageIdempotencyKey(u: Pick<UsageRecord, 'runStepId' | 'attemptId' | 'meter'>): string {
  return `${u.runStepId}:${u.attemptId}:${u.meter}`;
}
/** Splits new units across the remaining included quota; the remainder needs a meter rate and a platform-budget reservation. */
export function splitUsage(includedUnits: string, usedUnits: string, newUnits: string): { within: string; beyond: string } {
  const [inc, used, add] = [includedUnits, usedUnits, newUnits].map((v) => BigInt(NonNegativeMinorUnitsSchema.parse(v))) as [bigint, bigint, bigint];
  const left = inc > used ? inc - used : 0n;
  const within = add < left ? add : left;
  return { within: within.toString(), beyond: (add - within).toString() };
}

/* ---------- Goals, triggers, job subscriptions, envelopes and reports ---------- */

/** A goal informs the agent; it never widens authority. Creating one may propose mandate changes, which the principal confirms. */
export const GoalSchema = z.strictObject({
  id: IdSchema,
  principal: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  text: z.string().overwrite((v) => v.normalize('NFC')).min(1).max(2000),
  successCriteria: z.array(ShortTextSchema).min(1).max(20),
  /** A hint for planning, not authority: actions still need a confirmed mandate. */
  allowedActions: z.array(MandateActionV2Schema),
  mandateIds: z.array(IdSchema),
  /** Owner-private; never in envelopes, shared views, search, notifications or exports. */
  budgetRange: z.strictObject({ low: NonNegativeMoneySchema, high: NonNegativeMoneySchema }).nullable(),
  horizon: TimestampSchema,
  reportCadence: z.enum(['none', 'daily', 'weekly', 'monthly']),
  status: z.enum(['proposed', 'active', 'paused', 'closed']),
  outcome: z.enum(['achieved', 'partly', 'abandoned']).nullable(),
  proposedBy: z.enum(['principal', 'agent', 'connection']),
  confirmation: FirstPartyConfirmationSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((g) => g.status === 'proposed' || (g.confirmation !== null && g.confirmation.personId === g.principal.personId), { message: 'the principal confirms a goal before it is active', path: ['confirmation'] })
  .refine((g) => (g.status === 'closed') === (g.outcome !== null), { message: 'closed goals record an outcome', path: ['outcome'] })
  .refine((g) => g.budgetRange === null || (g.budgetRange.low.currency === g.budgetRange.high.currency && compareMoney(g.budgetRange.low, g.budgetRange.high) <= 0), { message: 'low <= high in one currency', path: ['budgetRange'] });
export type Goal = z.infer<typeof GoalSchema>;

/** A trigger only starts a run; authority still comes from the mandate. */
export const JobTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schedule'), rrule: z.string().regex(/^FREQ=(DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/).max(200), timeZone: IanaTimeZoneSchema }),
  z.strictObject({ kind: z.literal('event'), eventType: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(80) }),
  z.strictObject({ kind: z.literal('deadline'), contextKind: ContextKindV2Schema, offsetsDays: z.array(z.int().min(0).max(365)).min(1).max(10) }),
  z.strictObject({ kind: z.literal('goal'), goalId: IdSchema }),
  z.strictObject({ kind: z.literal('request') }),
]);
export type JobTrigger = z.infer<typeof JobTriggerSchema>;
export const JobSubscriptionSchema = z.strictObject({
  id: IdSchema,
  principal: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  moduleKey: AgentModuleKeySchema,
  jobTemplateKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  trigger: JobTriggerSchema,
  mandateId: IdSchema.nullable(),
  status: z.enum(['active', 'paused', 'ended']),
  revision: RevisionSchema,
});
export type JobSubscription = z.infer<typeof JobSubscriptionSchema>;

export const EnvelopeIntentSchema = z.enum([
  'request_proposal', 'propose', 'counter', 'clarify', 'answer', 'accept', 'decline', 'withdraw', 'schedule_meeting', 'introduce',
  'propose_slots', 'request_confirmation', 'express_interest', 'step_question',
]);
export type EnvelopeIntent = z.infer<typeof EnvelopeIntentSchema>;
/** Intents that move state carry structured, digest-pinned references; the note never does. */
export const STATE_MOVING_INTENTS: readonly EnvelopeIntent[] = ['propose', 'counter', 'accept', 'withdraw', 'request_confirmation'];
export const VersionedContextRefSchema = z.strictObject({ kind: ContextKindV2Schema, id: IdSchema, version: z.int().min(1), digest: DigestSchema });

/** Keyed HMAC over the mandate revision with a node key, so a counterparty cannot test guesses about the mandate's content. */
export const MandateProofSchema = z.strictObject({ algorithm: z.literal('hmac-sha256'), keyId: IdSchema, value: Sha256HexSchema });

/** Agent-to-agent message. Only structured parts move state, after the receiver's own mandate checks; the note is untrusted. */
export const AgentEnvelopeSchema = z.strictObject({
  id: IdSchema,
  envelopeVersion: z.literal(1),
  direction: z.enum(['outbound', 'inbound']),
  from: PartySchema,
  fromPersonId: IdSchema.nullable(),
  actorKind: z.enum(['person_agent', 'company_representative']),
  /** Disclosure label key rendered in the reader's language (jurisdiction settings, HUB-005). */
  actorLabelKey: z.string().regex(/^[a-z][A-Za-z0-9_.]{2,120}$/),
  accountablePersonId: IdSchema.nullable(),
  via: z.strictObject({ connectionId: IdSchema, clientLabel: z.string().min(1).max(120), listedByHub: z.boolean() }).nullable(),
  context: ContextRefSchema,
  intent: EnvelopeIntentSchema,
  refs: z.array(VersionedContextRefSchema).max(50),
  note: z.strictObject({ text: z.string().max(4000), trust: z.literal('untrusted'), locale: LocaleTagSchema.nullable() }).nullable(),
  mandateProof: MandateProofSchema,
  negotiationSessionId: IdSchema.nullable(),
  homeNode: IdSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  deliveryStatus: z.enum(['queued', 'delivered', 'rejected', 'expired']),
})
  .refine((e) => e.actorKind !== 'company_representative' || (e.from.kind === 'company' && e.accountablePersonId !== null), { message: 'a representative speaks for a company and names the accountable person', path: ['accountablePersonId'] })
  .refine((e) => e.actorKind !== 'person_agent' || e.fromPersonId !== null, { message: 'a person agent names its person', path: ['fromPersonId'] })
  .refine((e) => !STATE_MOVING_INTENTS.includes(e.intent) || e.refs.length > 0, { message: 'state-moving intents carry versioned references', path: ['refs'] })
  .refine((e) => Date.parse(e.expiresAt) > Date.parse(e.createdAt), { message: 'expires after creation', path: ['expiresAt'] });
export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;

export const ReportItemValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: ShortTextSchema }),
  z.strictObject({ kind: z.literal('count'), count: z.int().min(0) }),
  z.strictObject({ kind: z.literal('money'), money: NonNegativeMoneySchema }),
  z.strictObject({ kind: z.literal('ref'), ref: ContextRefSchema }),
]);
/** A draft for the principal; private unless the principal shares it with colleagues. Never sent to counterparties. */
export const AgentReportSchema = z.strictObject({
  id: IdSchema,
  principal: PartySchema,
  period: z.strictObject({ from: TimestampSchema, to: TimestampSchema }),
  goalId: IdSchema.nullable(),
  generatedByRunId: IdSchema,
  sections: z.array(z.strictObject({
    moduleKey: AgentModuleKeySchema,
    headingKey: z.string().regex(/^[a-z][A-Za-z0-9_.]{2,120}$/),
    items: z.array(z.strictObject({ labelKey: z.string().regex(/^[a-z][A-Za-z0-9_.]{2,120}$/), value: ReportItemValueSchema, evidenceRefs: z.array(IdSchema).max(20) })).max(100),
  })).max(30),
  audience: z.literal('owner_private'),
  sharedWith: z.array(IdSchema).max(50),
}).refine((r) => Date.parse(r.period.to) > Date.parse(r.period.from), { message: 'period ends after it starts', path: ['period'] });
export type AgentReport = z.infer<typeof AgentReportSchema>;

/* ---------- Participant stop controls and dispatch blocking ---------- */

/**
 * Participant-level switches next to the hub console's `KillSwitch` (hub.ts): the person's own stop control, a company
 * administrator suspending the representative, and the person revoking one connection.
 */
export const ParticipantStopSchema = z.strictObject({
  id: IdSchema,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('person_stop'), personId: IdSchema }),
    z.strictObject({ kind: z.literal('company_representative'), companyId: IdSchema }),
    z.strictObject({ kind: z.literal('connection'), connectionId: IdSchema }),
  ]),
  state: z.enum(['engaged', 'released']),
  engagedBy: IdSchema,
  engagedAt: TimestampSchema,
  releasedAt: TimestampSchema.nullable(),
}).refine((s) => s.scope.kind !== 'person_stop' || s.engagedBy === s.scope.personId, { message: 'the person stop is the person\'s own control', path: ['engagedBy'] })
  .refine((s) => (s.state === 'released') === (s.releasedAt !== null), { message: 'releasedAt is set exactly when released', path: ['releasedAt'] });
export type ParticipantStop = z.infer<typeof ParticipantStopSchema>;

/** Actions that send messages to other parties; the hub's outbound-messages switch stops them. */
const OUTBOUND_ACTIONS: readonly MandateActionV2[] = ['communicate', 'send_quote', 'negotiate', 'introduce', 'schedule'];
/** First engaged switch that blocks this dispatch, or null. Kill switches never delete history; executing actions go to reconciliation. */
export function agentDispatchBlocked(
  switches: { hub: readonly KillSwitch[]; participant: readonly ParticipantStop[] },
  target: { nodeId: string; hubId: string; moduleKey: string; action: MandateActionV2; personId: string; companyRepresentativeOf: string | null; connectionId: string | null; capabilityId?: string | null },
): string | null {
  for (const k of switches.hub) {
    if (k.state !== 'engaged') continue;
    const s = k.scope;
    const hit =
      (s.kind === 'node' && s.nodeId === target.nodeId) ||
      (s.kind === 'hub_agent_dispatch' && s.hubId === target.hubId) ||
      (s.kind === 'agent_module' && s.hubId === target.hubId && s.moduleKey === target.moduleKey) ||
      (s.kind === 'agent_capability' && s.hubId === target.hubId && s.capabilityId === (target.capabilityId ?? null)) ||
      (s.kind === 'agent_action' && s.hubId === target.hubId && s.action === target.action) ||
      (s.kind === 'external_agent_api' && s.hubId === target.hubId && target.connectionId !== null) ||
      (s.kind === 'outbound_messages' && s.hubId === target.hubId && OUTBOUND_ACTIONS.includes(target.action));
    if (hit) return k.id;
  }
  for (const p of switches.participant) {
    if (p.state !== 'engaged') continue;
    const s = p.scope;
    const hit =
      (s.kind === 'person_stop' && s.personId === target.personId) ||
      (s.kind === 'company_representative' && s.companyId === target.companyRepresentativeOf) ||
      (s.kind === 'connection' && s.connectionId === target.connectionId);
    if (hit) return p.id;
  }
  return null;
}

/* ---------- Non-owner projections (explicit allowlists) ---------- */

/** Fields that never appear in any non-owner projection of these records. Checked by the forbidden-field tests. */
export const OWNER_ONLY_FIELDS = [
  'budgetRange', 'constraintRecordId', 'privateDataClasses', 'tokenHash', 'argsDigest', 'limits', 'ceiling', 'perActionCeiling',
  'transactionBudgetId', 'platformBudgetId', 'conditions', 'approvers', 'approvalPolicy', 'mandateBindings', 'mandateIds', 'connectionId',
] as const;

/** What a counterparty's agent receives: the envelope without the sender's connection identifier. */
export function toEnvelopeCounterpartyView(e: AgentEnvelope) {
  return {
    id: e.id, envelopeVersion: e.envelopeVersion, from: e.from, fromPersonId: e.fromPersonId, actorKind: e.actorKind, actorLabelKey: e.actorLabelKey,
    accountablePersonId: e.accountablePersonId, via: e.via === null ? null : { clientLabel: e.via.clientLabel, listedByHub: e.via.listedByHub },
    context: e.context, intent: e.intent, refs: e.refs, note: e.note, mandateProof: e.mandateProof, negotiationSessionId: e.negotiationSessionId,
    homeNode: e.homeNode, createdAt: e.createdAt, expiresAt: e.expiresAt,
  };
}
/** What a counterparty learns about the mandate behind an action: who acts, never limits, conditions or budgets. */
export function toMandateCounterpartyView(m: MandateV2) {
  return { granteeKind: m.grantee.kind, onBehalfOf: m.principal.onBehalfOf, status: m.status };
}
/** Staff diagnostic subset under a case grant: no limits, budgets, conditions, approvers or contexts. */
export function toMandateStaffCaseView(m: MandateV2) {
  return { id: m.id, schemaVersion: m.schemaVersion, granteeKind: m.grantee.kind, moduleKeys: m.moduleKeys, actions: m.actions, status: m.status, revision: m.revision, validUntil: m.validUntil, revokedAt: m.revokedAt };
}
/** Colleagues who may see a company goal: no budget range and no mandate references. */
export function toGoalSharedView(g: Goal) {
  return { id: g.id, principal: g.principal, text: g.text, successCriteria: g.successCriteria, horizon: g.horizon, reportCadence: g.reportCadence, status: g.status, outcome: g.outcome, revision: g.revision };
}
export function toConnectionStaffCaseView(c: ExternalConnection) {
  return { id: c.id, hubId: c.hubId, ownerKind: c.owner.kind, protocol: c.protocol, clientId: c.clientId, clientNameSelfAsserted: c.clientNameSelfAsserted, listedByHub: c.listedByHub, scopes: c.scopes, status: c.status, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt };
}
/** Even the owner never sees a token hash. */
export function toConnectionTokenOwnerView(t: ConnectionToken) {
  return { id: t.id, kind: t.kind, issuedAt: t.issuedAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt };
}
export function toConnectionCallStaffCaseView(c: ConnectionCall) {
  return { id: c.id, capabilityId: c.capabilityId, resultCode: c.resultCode, at: c.at };
}
/** Public banner: whether something is stopped, never who stopped it or why. */
export function toKillSwitchBannerView(s: ParticipantStop) {
  return { scopeKind: s.scope.kind, state: s.state };
}

/* ---------- JSON Schema ---------- */

export const AGENT_CATALOG_SCHEMAS = {
  MandateV2: MandateV2Schema,
  MandateChangeProposal: MandateChangeProposalSchema,
  ActionIntentV2: ActionIntentV2Schema,
  AgentCapability: AgentCapabilitySchema,
  CapabilityRegistry: CapabilityRegistrySchema,
  AgentModuleManifest: AgentModuleManifestSchema,
  HubAgentPolicy: HubAgentPolicySchema,
  SubscriptionPlanVersion: SubscriptionPlanVersionSchema,
  MeterRateVersion: MeterRateVersionSchema,
  UsageRecord: UsageRecordSchema,
  Goal: GoalSchema,
  JobTrigger: JobTriggerSchema,
  JobSubscription: JobSubscriptionSchema,
  AgentEnvelope: AgentEnvelopeSchema,
  AgentReport: AgentReportSchema,
  ExternalConnection: ExternalConnectionSchema,
  ConnectionToken: ConnectionTokenSchema,
  ConnectionCall: ConnectionCallSchema,
  ParticipantStop: ParticipantStopSchema,
} as const;
export type AgentCatalogSchemaName = keyof typeof AGENT_CATALOG_SCHEMAS;

/**
 * Draft 2020-12 JSON Schemas with a versioned `$id`. Like `contractJsonSchemas()` they describe shapes only: refinements
 * (budgets for money actions, human-only confirmation, consent, no overage without reservation) are enforced by Zod.
 */
export function agentCatalogJsonSchemas(): Record<AgentCatalogSchemaName, Record<string, unknown>> {
  const out = {} as Record<AgentCatalogSchemaName, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(AGENT_CATALOG_SCHEMAS) as [AgentCatalogSchemaName, z.ZodType][]) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
    out[name] = { $id: `urn:trustwork:contracts:agent-catalog:v${AGENT_CATALOG_CONTRACT_VERSION}:${name}`, ...json };
  }
  return out;
}

/* ---------- Validated examples (synthetic, United States demo hub) ---------- */

const ex = {
  at: '2026-10-31T15:00:00Z',
  later: '2026-11-30T15:00:00Z',
  until: '2027-04-30T00:00:00Z',
  digest: { algorithm: 'trustwork-digest-1' as const, value: '0'.repeat(63) + '1' },
  person: 'person-demo-ana',
  colleague: 'person-demo-ben',
  company: 'company-demo-lone-star-facades',
  hub: 'hub-us-demo',
};
const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const capability = (c: Omit<AgentCapability, 'version' | 'status' | 'source'> & { moduleKey: string }): AgentCapability => {
  const { moduleKey, ...rest } = c;
  return { version: 1, status: 'proposed', source: { kind: 'module', moduleKey, moduleVersion: '1.0.0' }, ...rest };
};
const ref = (contract: string, schema: string): ContractRef => ({ contract, schema, version: 1 });

const coreCapabilities: AgentCapability[] = [
  capability({ moduleKey: 'core', id: 'core.list_mandates', kind: 'read', input: ref('agent-catalog', 'MandateV2Schema'), output: ref('agent-catalog', 'MandateV2Schema'), mandateAction: null, contextKinds: [], confirmation: 'none', budgetKind: null, reads: ['owner_private'], privateDataClasses: [], sideEffects: ['none'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'assistant.capability.listMandates' }),
  capability({ moduleKey: 'core', id: 'core.propose_mandate_change', kind: 'draft', input: ref('agent-catalog', 'MandateChangeProposalSchema'), output: ref('agent-catalog', 'MandateChangeProposalSchema'), mandateAction: null, contextKinds: [], confirmation: 'none', budgetKind: null, reads: ['owner_private'], privateDataClasses: [], sideEffects: ['draft_state'], acceptsUntrustedText: true, meters: ['model_tokens'], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'assistant.capability.proposeMandateChange' }),
  capability({ moduleKey: 'core', id: 'core.confirm_mandate', kind: 'govern', input: ref('agent-catalog', 'MandateChangeProposalSchema'), output: ref('agent-catalog', 'MandateV2Schema'), mandateAction: null, contextKinds: [], confirmation: 'first_party_form', budgetKind: null, reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent'], labelKey: 'assistant.capability.confirmMandate' }),
  capability({ moduleKey: 'core', id: 'core.approve_decision', kind: 'govern', input: ref('assistant', 'ApprovalSchema'), output: ref('assistant', 'ApprovalSchema'), mandateAction: null, contextKinds: [], confirmation: 'first_party_form', budgetKind: null, reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent'], labelKey: 'assistant.capability.approveDecision' }),
  capability({ moduleKey: 'core', id: 'core.stop_all', kind: 'govern', input: ref('agent-catalog', 'ParticipantStopSchema'), output: ref('agent-catalog', 'ParticipantStopSchema'), mandateAction: null, contextKinds: [], confirmation: 'first_party_form', budgetKind: null, reads: ['owner_private'], privateDataClasses: [], sideEffects: ['state_change'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent'], labelKey: 'assistant.capability.stopAll' }),
];
const quotingCapabilities: AgentCapability[] = [
  capability({ moduleKey: 'quoting', id: 'quoting.draft_quote', kind: 'draft', input: ref('sales', 'CreateQuoteDraftCommandSchema'), output: ref('sales', 'QuoteVersionSchema'), mandateAction: 'prepare', contextKinds: ['rfq'], confirmation: 'none', budgetKind: null, reads: ['shared_party', 'party_private'], privateDataClasses: ['negotiation_constraints'], sideEffects: ['draft_state'], acceptsUntrustedText: true, meters: ['model_tokens'], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'assistant.capability.draftQuote' }),
  capability({ moduleKey: 'quoting', id: 'quoting.send_quote', kind: 'commit', input: ref('sales', 'SendQuoteVersionCommandSchema'), output: ref('sales', 'SharedQuoteVersionSchema'), mandateAction: 'send_quote', contextKinds: ['rfq', 'quote'], confirmation: 'mandate', budgetKind: null, reads: ['shared_party', 'party_private'], privateDataClasses: [], sideEffects: ['state_change', 'outbound_message'], acceptsUntrustedText: false, meters: ['agent_actions'], surfaces: ['ui', 'agent', 'mcp', 'a2a'], labelKey: 'assistant.capability.sendQuote' }),
];
const deliveryCapabilities: AgentCapability[] = [
  capability({ moduleKey: 'execution_clerk', id: 'execution_clerk.place_order', kind: 'commit', input: ref('transactions', 'PlaceOrderCommandSchema'), output: ref('transactions', 'OrderSchema'), mandateAction: 'place_order', contextKinds: ['agreement'], confirmation: 'mandate', budgetKind: 'transaction', reads: ['shared_party', 'party_private'], privateDataClasses: [], sideEffects: ['state_change', 'money_commitment'], acceptsUntrustedText: false, meters: ['agent_actions'], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'assistant.capability.placeOrder' }),
  capability({ moduleKey: 'execution_clerk', id: 'execution_clerk.confirm_execution', kind: 'commit', input: ref('execution', 'AssertionSchema'), output: ref('execution', 'AcceptanceRecordSchema'), mandateAction: 'confirm_execution', contextKinds: ['agreement', 'order'], confirmation: 'person_each', budgetKind: null, reads: ['shared_party'], privateDataClasses: [], sideEffects: ['state_change', 'reputation_signal'], acceptsUntrustedText: false, meters: [], surfaces: ['ui', 'agent', 'mcp'], labelKey: 'assistant.capability.confirmExecution' }),
];

const exampleManifests: AgentModuleManifest[] = [
  { key: 'core', version: '1.0.0', family: 'core', status: 'proposed', actions: [], capabilities: coreCapabilities, meters: ['model_tokens'], suits: [], freeFloor: [{ meter: 'model_tokens', units: '200000', window: 'month' }], safetySuite: 'tests/agent-safety/core' },
  { key: 'quoting', version: '1.0.0', family: 'deal', status: 'proposed', actions: ['prepare', 'send_quote'], capabilities: quotingCapabilities, meters: ['model_tokens', 'agent_actions'], suits: ['supplier', 'small_contractor', 'subcontractor'], freeFloor: [{ meter: 'agent_actions', units: '20', window: 'month' }], safetySuite: 'tests/agent-safety/modules/quoting' },
  { key: 'execution_clerk', version: '1.0.0', family: 'delivery', status: 'proposed', actions: ['place_order', 'confirm_execution'], capabilities: deliveryCapabilities, meters: ['agent_actions'], suits: ['general_contractor', 'homeowner', 'developer'], freeFloor: [], safetySuite: 'tests/agent-safety/modules/execution-clerk' },
];

const exampleMandate: MandateV2 = {
  id: 'mandate-demo-facade-quotes',
  schemaVersion: 2,
  principal: { personId: ex.person, onBehalfOf: { kind: 'company', id: ex.company } },
  grantee: { kind: 'own_agent' },
  moduleKeys: ['quoting'],
  actions: ['prepare', 'send_quote'],
  contexts: [{ kind: 'rfq', categories: ['facade_works'], regions: ['US-TX'], projectId: null }],
  limits: { ceiling: usd('25000000'), perActionCeiling: usd('25000000'), transactionBudgetId: null, platformBudgetId: null, perWindow: { count: 10, windowHours: 24 } },
  conditions: [{ kind: 'catalogue_lines_only' }, { kind: 'counterparty_status_at_least', level: 'claimed' }, { kind: 'screening_clear' }],
  approvalPolicy: { mode: 'ask_above', threshold: usd('5000000') },
  approvers: [{ approverPersonIds: [ex.person, ex.colleague], minApprovals: 2, above: usd('35000000') }],
  escalation: { kind: 'ask_principal' },
  confirmation: { via: 'first_party_form', personId: ex.person, at: ex.at, stepUp: false },
  validUntil: ex.until,
  status: 'active',
  revision: 1,
  revokedAt: null,
};
const exampleConnection: ExternalConnection = {
  id: 'connection-demo-mcp',
  hubId: ex.hub,
  owner: { kind: 'person', personId: ex.person },
  protocol: 'mcp',
  clientId: 'client-demo-desktop-agent',
  clientNameSelfAsserted: 'Demo desktop agent',
  listedByHub: false,
  scopes: ['read.public', 'read.me', 'read.contexts', 'propose', 'act'],
  privateDataClasses: [],
  mandateBindings: [{ mandateId: exampleMandate.id, revision: 1 }],
  rateLimitProfile: 'standard',
  consent: { via: 'first_party_form', personId: ex.person, at: ex.at, stepUp: true },
  status: 'active',
  createdAt: ex.at,
  lastUsedAt: null,
  revokedAt: null,
  revision: 1,
};

/** One synthetic example per schema (US demo hub, USD); the contract tests validate every entry. */
export const AGENT_CATALOG_EXAMPLES: { readonly [K in AgentCatalogSchemaName]: readonly z.input<(typeof AGENT_CATALOG_SCHEMAS)[K]>[] } = {
  MandateV2: [exampleMandate],
  MandateChangeProposal: [{
    id: 'proposal-demo-1', mandateId: exampleMandate.id, basisRevision: 1, origin: { kind: 'chat_intent', runId: 'run-demo-1' },
    proposed: { ...exampleMandate, approvalPolicy: { mode: 'pre_authorized' }, status: 'draft', confirmation: null, revision: 2 },
    status: 'pending', createdAt: ex.at, decidedAt: null,
  }],
  ActionIntentV2: [{
    id: 'intent-demo-1', runId: 'run-demo-1', mandate: { id: exampleMandate.id, revision: 1 }, capabilityId: 'quoting.send_quote', action: 'send_quote',
    context: { kind: 'rfq', id: 'rfq-demo-austin-facade' }, resolvedFromSelector: true, amount: usd('1850000'), actionDigest: ex.digest, state: 'authorized',
    reservationId: null, attemptCount: 0, effectCorrelationKey: 'send-quote-rfq-demo-austin-facade-1', outcome: null, viaConnectionId: exampleConnection.id, revision: 1,
  }],
  AgentCapability: [...coreCapabilities, ...quotingCapabilities, ...deliveryCapabilities],
  CapabilityRegistry: [{ registryVersion: 1, hubId: null, capabilities: [...coreCapabilities, ...quotingCapabilities, ...deliveryCapabilities] }],
  AgentModuleManifest: exampleManifests,
  HubAgentPolicy: [{
    hubId: ex.hub,
    enabledModules: [
      { moduleKey: 'core', moduleVersion: '1.0.0', freeQuota: [{ meter: 'model_tokens', units: '250000', window: 'month' }], settings: {} },
      { moduleKey: 'quoting', moduleVersion: '1.0.0', freeQuota: [{ meter: 'agent_actions', units: '20', window: 'month' }], settings: { consumerMode: true } },
    ],
    protectionLimits: { openIntroductionsPerPerson: 10, newCounterpartiesPerDay: 20, maxNegotiationRounds: 6, consumerMaxRounds: 3, envelopesPerCounterpartyPerDay: 20, publicRecordsPerConnectionPerDay: 2000, connectionsPerPerson: 3, connectionIdleExpiryDays: 90 },
    forbiddenPreAuthorization: ['publish'],
    activeExtensionVersionIds: [],
  }],
  SubscriptionPlanVersion: [{
    id: 'plan-version-demo-pro-1', offerId: 'offer-demo-agent-pro', version: 1, payerKind: 'company', moduleKeys: ['core', 'quoting'],
    includedQuota: [{ moduleKey: 'quoting', meter: 'agent_actions', units: '500', window: 'month' }, { moduleKey: 'core', meter: 'model_tokens', units: '2000000', window: 'month' }],
    connections: 2, channels: 2, representativeIncluded: true, priceVersionId: 'price-version-demo-pro-1', status: 'draft',
  }],
  MeterRateVersion: [{
    id: 'meter-rate-demo-1', hubId: ex.hub, version: 1, meter: 'model_tokens', providerClass: 'hosted_external', currency: 'USD', pricePerThousandUnits: usd('2'),
    passThrough: true, effectiveFrom: ex.later, effectiveTo: null, status: 'active', draftedBy: 'person-demo-ops-1', activatedBy: 'person-demo-ops-2', activatedAt: ex.at,
  }],
  UsageRecord: [{
    id: 'usage-demo-1', principal: { kind: 'company', id: ex.company }, billingAccountId: 'billing-demo-1', moduleKey: 'quoting', capabilityId: 'quoting.draft_quote',
    runId: 'run-demo-1', runStepId: 'run-step-demo-1', attemptId: 'attempt-demo-1', connectionId: null, meter: 'model_tokens', providerClass: 'hosted_external',
    units: '4200', withinIncludedQuota: true, meterRateVersionId: null, reservationId: null, recordedAt: ex.at,
  }],
  Goal: [{
    id: 'goal-demo-1', principal: { personId: ex.person, onBehalfOf: { kind: 'company', id: ex.company } }, text: 'Win two facade projects in Central Texas this quarter.',
    successCriteria: ['Two signed agreements'], allowedActions: ['send_quote'], mandateIds: [exampleMandate.id], budgetRange: null, horizon: ex.until,
    reportCadence: 'weekly', status: 'active', outcome: null, proposedBy: 'agent', confirmation: { via: 'first_party_form', personId: ex.person, at: ex.at, stepUp: false }, revision: 1,
  }],
  JobTrigger: [{ kind: 'schedule', rrule: 'FREQ=WEEKLY;BYDAY=MO', timeZone: 'America/Chicago' }, { kind: 'event', eventType: 'rfq.invitation_received' }],
  JobSubscription: [{
    id: 'job-demo-1', principal: { personId: ex.person, onBehalfOf: { kind: 'company', id: ex.company } }, moduleKey: 'quoting', jobTemplateKey: 'answer_rfq_invitations',
    trigger: { kind: 'event', eventType: 'rfq.invitation_received' }, mandateId: exampleMandate.id, status: 'active', revision: 1,
  }],
  AgentEnvelope: [{
    id: 'envelope-demo-1', envelopeVersion: 1, direction: 'outbound', from: { kind: 'company', id: ex.company }, fromPersonId: ex.person, actorKind: 'person_agent',
    actorLabelKey: 'agent.disclosure.personAgent', accountablePersonId: null, via: null, context: { kind: 'rfq', id: 'rfq-demo-austin-facade' }, intent: 'propose',
    refs: [{ kind: 'quote', id: 'quote-demo-1', version: 1, digest: ex.digest }], note: { text: 'Lead time is three weeks.', trust: 'untrusted', locale: 'en' },
    mandateProof: { algorithm: 'hmac-sha256', keyId: 'node-key-demo-1', value: 'c'.repeat(64) }, negotiationSessionId: null, homeNode: 'node-us-demo',
    createdAt: ex.at, expiresAt: ex.later, deliveryStatus: 'queued',
  }],
  AgentReport: [{
    id: 'report-demo-1', principal: { kind: 'person', id: ex.person }, period: { from: ex.at, to: ex.later }, goalId: 'goal-demo-1', generatedByRunId: 'run-demo-2',
    sections: [{ moduleKey: 'quoting', headingKey: 'agent.report.quoting', items: [{ labelKey: 'agent.report.quotesSent', value: { kind: 'count', count: 3 }, evidenceRefs: [] }] }],
    audience: 'owner_private', sharedWith: [],
  }],
  ExternalConnection: [exampleConnection],
  ConnectionToken: [{
    id: 'token-demo-1', connectionId: exampleConnection.id, family: 'token-family-demo-1', kind: 'access', tokenHash: 'd'.repeat(64),
    audience: 'https://hub-us.example.invalid/mcp', issuedAt: ex.at, expiresAt: '2026-10-31T15:15:00Z', rotatedFromId: null, revokedAt: null,
  }],
  ConnectionCall: [{
    id: 'call-demo-1', connectionId: exampleConnection.id, tokenFamily: 'token-family-demo-1', capabilityId: 'quoting.send_quote', argsDigest: ex.digest,
    resultCode: 'ok.proposed', mandateRef: { mandateId: exampleMandate.id, revision: 1 }, actionIntentId: 'intent-demo-1', at: ex.at,
  }],
  ParticipantStop: [{ id: 'stop-demo-1', scope: { kind: 'person_stop', personId: ex.person }, state: 'engaged', engagedBy: ex.person, engagedAt: ex.at, releasedAt: null }],
};
