import { z } from 'zod';
import {
  BUDGET_KIND_BY_ACTION, CONTEXT_KINDS_V2, HubAgentPolicySchema, hubPolicyViolations, JobTriggerSchema, MandateActionV2Schema, PrivateDataClassSchema, isHumanOnlyAction,
  type AgentCapability, type AgentModuleManifest, type HubAgentPolicy, type JobTrigger, type MandateActionV2,
} from './agent-catalog.js';
import { IanaTimeZoneSchema, IdSchema, TimestampSchema } from './common/ids.js';
import { AGGREGATE_MIN_COHORT, AgentModuleKeySchema, COMMITMENT_MANDATE_KINDS, consoleCommand } from './hub.js';

/**
 * Agent module registry, hub agent policy, job subscriptions and kill switches (AGT-003). Source:
 * docs/engine/hub-console/user-agents-admin.md (the complete control set of ADR 010 decision 25), docs/engine/agent-catalog.md
 * (anatomy of a job), ADR 010 decisions 22, 23 and 25. Builds on AGT-002 (`agent-catalog.ts`: manifests, `HubAgentPolicySchema`,
 * `JobTriggerSchema`, `JobSubscriptionSchema`) and the console contract (`hub.ts`: `KillSwitchScopeSchema`, which gained the
 * additive `agent_capability` scope with the integrator's agreement) without changing their frozen shapes.
 *
 * The payload of the `agents` configuration domain is an `AgentPolicyDocument`: the AGT-002 `HubAgentPolicy` unchanged,
 * plus per-module controls, per-capability switches (hub, participant type, plan), participant defaults and maximums, job
 * templates, the hub calendar and the preview the drafter saw. The preview travels inside the payload, so the second
 * person's approval of the payload digest binds it; activation recomputes it and fails when it went stale.
 *
 * Invariants carried here (the database repeats the ones it can, packages/data/migrations/agent-modules):
 * - a hub never widens a module beyond its manifest: actions, capabilities (tools) and private data classes are subsets;
 * - a module with commitment actions never acts for an unverified company (persons acting for themselves stay eligible
 *   where the hub lists them; "verified companies only" is principal kinds without `person` plus this flag);
 * - a default never exceeds its maximum; participants may tighten, never widen;
 * - no key of this document can disable mandates, the person's confirmation for commitments, sanctions gates, restricted
 *   places or payment neutrality (`GUARD_RAIL_KEY_PATTERN`, schema-tested);
 * - nothing here names a person: previews are cohort counts (`AGGREGATE_MIN_COHORT`) and staff never read one
 *   participant's agent, mandates, settings, goals, job subscriptions or connections;
 * - no code path here branches on a country code: country differences are data (calendar, defaults) or adapters.
 * Status: Live in the API with fake ports (no entitlement provider, no extension registry, no model).
 */
export const AGENT_MODULES_CONTRACT_VERSION = 1 as const;

/* ---------- Vocabulary ---------- */

/**
 * "Participant type" of ADR 010 decision 25 for capability switches: who the agent acts for. External clients are a
 * surface (MCP, A2A), not a participant type, so a switch here refuses alike on every surface (decision 23 parity).
 */
export const AGENT_PRINCIPAL_KINDS = ['person', 'company_member', 'company_representative'] as const;
export const AgentPrincipalKindSchema = z.enum(AGENT_PRINCIPAL_KINDS);
export type AgentPrincipalKind = z.infer<typeof AgentPrincipalKindSchema>;

/** A plan key resolved by the entitlement port (AGT-004 implements it; the default fake answers `free`). */
export const PlanKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const DEFAULT_PLAN_KEY = 'free' as const;

/** `draft → beta → active → retired`; only `beta` and `active` serve participants. */
export const ModuleStatusSchema = z.enum(['draft', 'beta', 'active', 'retired']);
export type ModuleStatus = z.infer<typeof ModuleStatusSchema>;
export const SERVING_MODULE_STATUSES: readonly ModuleStatus[] = ['beta', 'active'];

export const ReportCadenceSchema = z.enum(['none', 'monthly', 'weekly', 'daily']);
export type ReportCadence = z.infer<typeof ReportCadenceSchema>;
const CADENCE_RANK: Record<ReportCadence, number> = { none: 0, monthly: 1, weekly: 2, daily: 3 };
/** Approval modes from strictest to loosest (the AGT-002 order of `ApprovalPolicySchema`). */
export const ApprovalModeSchema = z.enum(['ask_each', 'ask_first', 'ask_above', 'pre_authorized']);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
const APPROVAL_RANK: Record<ApprovalMode, number> = { ask_each: 0, ask_first: 1, ask_above: 2, pre_authorized: 3 };
export const ChannelSchema = z.enum(['platform', 'email', 'sms', 'push']);
export type Channel = z.infer<typeof ChannelSchema>;

/** Engine floor for schedule intervals: no hub or template may let a job fire more often. */
export const ENGINE_MIN_JOB_INTERVAL_MINUTES = 60;
/** Default local time of a schedule trigger without BYHOUR/BYMINUTE. */
export const DEFAULT_SCHEDULE_HOUR = 9;
/** Engine floor of verbs no hub may ever let a mandate pre-authorize (ADR 010 decision 25 guard rails). */
export const ENGINE_FORBIDDEN_PRE_AUTHORIZATION: readonly MandateActionV2[] = ['release_payment'];

/**
 * Guard rails no administrator can switch off (ADR 010 decision 25). No key of a hub configuration document may name
 * them; strict schemas reject unknown keys and the free-form module `settings` map is checked against this pattern.
 */
export const GUARD_RAIL_KEY_PATTERN = /mandate|confirm|sanction|screen|restrict|neutral|ranking|impersonat|egress|staff/i;
/** Object keys (any depth) of a payload that touch a guard rail. Empty when the payload is clean (the server-computed preview is not walked). */
export function guardRailKeys(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') for (const [k, child] of Object.entries(v)) {
      if (GUARD_RAIL_KEY_PATTERN.test(k)) out.add(k);
      walk(child);
    }
  };
  walk(payload);
  return [...out].sort();
}

/* ---------- Policy document (payload of the `agents` configuration domain) ---------- */

const uniq = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

export const ModuleLimitsSchema = z.strictObject({
  runsPerDay: z.int().min(0).max(10_000),
  actionsPerDay: z.int().min(0).max(10_000),
  concurrentRuns: z.int().min(1).max(100),
  /** Required for modules that `communicate`, `introduce` or `negotiate` (outreach shares the person's weekly quota). */
  outreachPerWeek: z.int().min(0).max(1000).nullable(),
});
export type ModuleLimits = z.infer<typeof ModuleLimitsSchema>;

/** What a hub turns on for one enabled module; every list is a subset of the manifest (never a widening). */
export const ModuleControlSchema = z.strictObject({
  moduleKey: AgentModuleKeySchema,
  status: ModuleStatusSchema,
  principalKinds: z.array(AgentPrincipalKindSchema).min(1).max(AGENT_PRINCIPAL_KINDS.length),
  /** When the agent acts for a company (member or representative), the company must be verified. */
  verifiedCompanyRequired: z.boolean(),
  /** Mandate verbs the module may use in this hub: a subset of the manifest's actions. */
  actions: z.array(MandateActionV2Schema),
  /** Capability registry entries (tools) the module offers in this hub: a subset of the manifest's capabilities. */
  capabilityIds: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100)).min(1),
  /** Private data classes the module may read here: a subset of what its capabilities declare. */
  dataClasses: z.array(PrivateDataClassSchema),
  limits: ModuleLimitsSchema,
}).refine((m) => uniq(m.principalKinds) && uniq(m.actions) && uniq(m.capabilityIds) && uniq(m.dataClasses), { message: 'no duplicates', path: ['actions'] });
export type ModuleControl = z.infer<typeof ModuleControlSchema>;

/** One capability switch: off for the whole hub, for participant types, or for plans (decisions 23 and 25). */
export const CapabilitySwitchSchema = z.strictObject({
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100),
  offForHub: z.boolean(),
  offForPrincipalKinds: z.array(AgentPrincipalKindSchema).max(AGENT_PRINCIPAL_KINDS.length),
  offForPlans: z.array(PlanKeySchema).max(50),
}).refine((c) => uniq(c.offForPrincipalKinds) && uniq(c.offForPlans), { message: 'no duplicates', path: ['offForPlans'] })
  .refine((c) => c.offForHub || c.offForPrincipalKinds.length > 0 || c.offForPlans.length > 0, { message: 'a switch turns something off', path: ['offForHub'] });
export type CapabilitySwitch = z.infer<typeof CapabilitySwitchSchema>;

const Bound = <T extends z.ZodType>(value: T) => z.strictObject({ default: value, max: value });
/** Hub defaults the participant's agent starts with and the hub maximum of each (AGT-022 lets participants tighten). */
export const ParticipantSettingsBoundsSchema = z.strictObject({
  approval: z.strictObject({ defaultMode: ApprovalModeSchema, loosestMode: ApprovalModeSchema }),
  outreachPerWeek: Bound(z.int().min(0).max(1000)),
  reportCadence: Bound(ReportCadenceSchema),
  scheduleMinIntervalMinutes: z.int().min(ENGINE_MIN_JOB_INTERVAL_MINUTES).max(60 * 24 * 31),
  channels: z.strictObject({ defaults: z.array(ChannelSchema), allowed: z.array(ChannelSchema).min(1) }),
});
export type ParticipantSettingsBounds = z.infer<typeof ParticipantSettingsBoundsSchema>;

/** The hub's business calendar for schedule triggers; closed dates are data (for example US federal holidays). */
export const HubCalendarSchema = z.strictObject({
  timeZone: IanaTimeZoneSchema,
  closedDates: z.array(z.iso.date()).max(400),
}).refine((c) => uniq(c.closedDates), { message: 'closed dates are distinct', path: ['closedDates'] });
export type HubCalendar = z.infer<typeof HubCalendarSchema>;

export const ClosedDayRuleSchema = z.enum(['skip', 'next_open_day', 'run']);
export type ClosedDayRule = z.infer<typeof ClosedDayRuleSchema>;
export const JobTriggerKindSchema = z.enum(['schedule', 'event', 'deadline', 'goal', 'request']);
export type JobTriggerKind = z.infer<typeof JobTriggerKindSchema>;

/** A job a module offers: default trigger, minimum interval and the mandate verbs its proposal asks for. */
export const JobTemplateSchema = z.strictObject({
  moduleKey: AgentModuleKeySchema,
  templateKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  labelKey: z.string().regex(/^[a-z][A-Za-z0-9_.]{2,120}$/),
  actions: z.array(MandateActionV2Schema).min(1),
  triggerKinds: z.array(JobTriggerKindSchema).min(1),
  defaultTrigger: JobTriggerSchema,
  minIntervalMinutes: z.int().min(ENGINE_MIN_JOB_INTERVAL_MINUTES).max(60 * 24 * 31),
  onClosedDay: ClosedDayRuleSchema,
}).refine((t) => uniq(t.actions) && uniq(t.triggerKinds), { message: 'no duplicates', path: ['actions'] })
  .refine((t) => t.triggerKinds.includes(t.defaultTrigger.kind), { message: 'the default trigger is an offered kind', path: ['defaultTrigger'] });
export type JobTemplate = z.infer<typeof JobTemplateSchema>;

/** Cohort count: a number of at least `AGGREGATE_MIN_COHORT`, or `null` meaning "fewer than 10". */
export const PreviewCountSchema = z.int().min(AGGREGATE_MIN_COHORT).nullable();
export function cohortCount(n: number): number | null {
  return Number.isInteger(n) && n >= AGGREGATE_MIN_COHORT ? n : null;
}
const ChangeSchema = z.enum(['enabled', 'disabled', 'narrowed', 'widened', 'changed']);
/** What activating the version changes, computed on current data, never naming a participant. */
export const PolicyPreviewSchema = z.strictObject({
  computedAt: TimestampSchema,
  baseVersionId: IdSchema.nullable(),
  modules: z.array(z.strictObject({ moduleKey: AgentModuleKeySchema, change: ChangeSchema })).max(200),
  capabilities: z.array(z.strictObject({ capabilityId: z.string().max(100), change: ChangeSchema })).max(2000),
  /** Modules the engine registry knew when the version was drafted; modules without a manifest are not governed yet. */
  registeredModuleKeys: z.array(AgentModuleKeySchema).max(500),
  /** Modules whose running authority may stop (disabled or narrowed); the counts below are over these. */
  narrowedModuleKeys: z.array(AgentModuleKeySchema).max(200),
  principalKinds: z.array(AgentPrincipalKindSchema),
  plans: z.array(PlanKeySchema),
  affected: z.strictObject({ mandates: PreviewCountSchema, jobSubscriptions: PreviewCountSchema, connections: PreviewCountSchema, openRuns: PreviewCountSchema }),
});
export type PolicyPreview = z.infer<typeof PolicyPreviewSchema>;
export type PreviewCounts = PolicyPreview['affected'];

const AgentPolicyDraftShape = z.strictObject({
  schemaVersion: z.literal(AGENT_MODULES_CONTRACT_VERSION),
  /** The AGT-002 hub agent policy, unchanged: enabled module versions, free quotas, protection limits, extensions. */
  policy: HubAgentPolicySchema,
  modules: z.array(ModuleControlSchema).max(200),
  capabilities: z.array(CapabilitySwitchSchema).max(2000),
  participantSettings: ParticipantSettingsBoundsSchema,
  calendar: HubCalendarSchema,
  jobTemplates: z.array(JobTemplateSchema).max(500),
});
type DraftShape = z.infer<typeof AgentPolicyDraftShape>;
const documentRefinements = <T extends z.ZodType<DraftShape>>(schema: T) => schema
  .refine((d) => uniq(d.modules.map((m) => m.moduleKey)), { message: 'one control per module', path: ['modules'] })
  .refine((d) => uniq(d.capabilities.map((c) => c.capabilityId)), { message: 'one switch per capability', path: ['capabilities'] })
  .refine((d) => uniq(d.jobTemplates.map((t) => `${t.moduleKey}/${t.templateKey}`)), { message: 'one template per key', path: ['jobTemplates'] });
/** A document as drafted: the server computes the preview. */
export const AgentPolicyDraftSchema = documentRefinements(AgentPolicyDraftShape);
export type AgentPolicyDraft = z.infer<typeof AgentPolicyDraftShape>;
/** The stored payload: the draft plus the preview its drafter saw. */
export const AgentPolicyDocumentSchema = documentRefinements(AgentPolicyDraftShape.extend({ preview: PolicyPreviewSchema }));
export type AgentPolicyDocument = AgentPolicyDraft & { preview: PolicyPreview };

/* ---------- Registry: engine manifests plus activated extension capabilities ---------- */

export interface ModuleRegistry {
  manifests: readonly AgentModuleManifest[];
  /** Capabilities of activated extension versions (AGT-023), keyed by extension version id. */
  extensions: readonly { extensionVersionId: string; moduleKey: string; capabilities: readonly AgentCapability[] }[];
}

export function manifestOf(registry: ModuleRegistry, moduleKey: string, version?: string): AgentModuleManifest | undefined {
  return registry.manifests.find((m) => m.key === moduleKey && (version === undefined || m.version === version));
}

/** Every capability a module offers in a hub: manifest capabilities plus those of activated extension versions. */
export function moduleCapabilities(registry: ModuleRegistry, moduleKey: string, version: string, activeExtensionVersionIds: readonly string[]): AgentCapability[] {
  const manifest = manifestOf(registry, moduleKey, version);
  const extra = registry.extensions.filter((e) => e.moduleKey === moduleKey && activeExtensionVersionIds.includes(e.extensionVersionId)).flatMap((e) => e.capabilities);
  return [...(manifest?.capabilities ?? []), ...extra];
}

const OUTREACH_ACTIONS: readonly MandateActionV2[] = ['communicate', 'introduce', 'negotiate'];

/**
 * Every reason a drafted document is refused, given the registry (empty when valid). Covers step 1 (no widening beyond the
 * manifest), eligibility (commitment modules only for verified companies), the free floor, defaults within maximums, job
 * templates and the guard rails.
 */
export function policyDocumentViolations(doc: AgentPolicyDraft, registry: ModuleRegistry): string[] {
  const out: string[] = [];
  out.push(...hubPolicyViolations(doc.policy, registry.manifests));
  const enabled = new Map(doc.policy.enabledModules.map((m) => [m.moduleKey, m]));
  for (const action of ENGINE_FORBIDDEN_PRE_AUTHORIZATION) if (!doc.policy.forbiddenPreAuthorization.includes(action)) out.push(`guard rail: ${action} is never pre-authorized`);
  for (const key of guardRailKeys(doc.policy.enabledModules.map((m) => m.settings))) out.push(`guard rail: settings key ${key}`);
  for (const control of doc.modules) {
    const entry = enabled.get(control.moduleKey);
    if (!entry) {
      out.push(`module ${control.moduleKey} has controls but is not enabled`);
      continue;
    }
    const manifest = manifestOf(registry, entry.moduleKey, entry.moduleVersion);
    if (!manifest) continue; // reported by hubPolicyViolations
    const capabilities = moduleCapabilities(registry, entry.moduleKey, entry.moduleVersion, doc.policy.activeExtensionVersionIds);
    const capabilityIds = new Set(capabilities.map((c) => c.id));
    const extensionActions = capabilities.filter((c) => c.source.kind === 'extension' && c.mandateAction !== null).map((c) => c.mandateAction as MandateActionV2);
    for (const a of control.actions) if (!manifest.actions.includes(a) && !extensionActions.includes(a)) out.push(`widening: ${control.moduleKey} action ${a} is not in its manifest`);
    for (const id of control.capabilityIds) if (!capabilityIds.has(id)) out.push(`widening: ${control.moduleKey} capability ${id} is not in its manifest`);
    const declaredClasses = new Set(capabilities.flatMap((c) => c.privateDataClasses));
    for (const d of control.dataClasses) if (!declaredClasses.has(d)) out.push(`widening: ${control.moduleKey} data class ${d} is not declared by its capabilities`);
    for (const id of control.capabilityIds) {
      const c = capabilities.find((x) => x.id === id);
      if (c?.mandateAction && !control.actions.includes(c.mandateAction)) out.push(`${control.moduleKey}: capability ${id} needs action ${c.mandateAction}`);
      if (c && !c.privateDataClasses.every((d) => control.dataClasses.includes(d))) out.push(`${control.moduleKey}: capability ${id} needs its private data classes`);
    }
    const commits = control.actions.some((a) => (COMMITMENT_MANDATE_KINDS as readonly string[]).includes(a));
    if (commits && !control.verifiedCompanyRequired) out.push(`eligibility: ${control.moduleKey} has commitment actions and never acts for an unverified company`);
    if (control.actions.some((a) => OUTREACH_ACTIONS.includes(a)) && control.limits.outreachPerWeek === null) out.push(`limits: ${control.moduleKey} communicates and needs outreach per week`);
    if (control.limits.outreachPerWeek !== null && control.limits.outreachPerWeek > doc.participantSettings.outreachPerWeek.max) out.push(`limits: ${control.moduleKey} outreach above the hub maximum`);
  }
  for (const entry of doc.policy.enabledModules) if (!doc.modules.some((c) => c.moduleKey === entry.moduleKey)) out.push(`module ${entry.moduleKey} is enabled without controls`);
  const knownCapabilities = new Set(doc.policy.enabledModules.flatMap((m) => moduleCapabilities(registry, m.moduleKey, m.moduleVersion, doc.policy.activeExtensionVersionIds).map((c) => c.id)));
  for (const s of doc.capabilities) if (!knownCapabilities.has(s.capabilityId)) out.push(`capability switch ${s.capabilityId} names no enabled capability`);
  const ps = doc.participantSettings;
  if (APPROVAL_RANK[ps.approval.defaultMode] > APPROVAL_RANK[ps.approval.loosestMode]) out.push('defaults: approval default is looser than the hub maximum');
  if (ps.outreachPerWeek.default > ps.outreachPerWeek.max) out.push('defaults: outreach per week above its maximum');
  if (CADENCE_RANK[ps.reportCadence.default] > CADENCE_RANK[ps.reportCadence.max]) out.push('defaults: report cadence above its maximum');
  if (!ps.channels.defaults.every((c) => ps.channels.allowed.includes(c))) out.push('defaults: a default channel is not allowed');
  for (const t of doc.jobTemplates) {
    const control = doc.modules.find((m) => m.moduleKey === t.moduleKey);
    if (!control) {
      out.push(`job ${t.moduleKey}/${t.templateKey}: module not enabled`);
      continue;
    }
    for (const a of t.actions) {
      if (!control.actions.includes(a)) out.push(`job ${t.moduleKey}/${t.templateKey}: action ${a} not offered by the module`);
      if (isHumanOnlyAction(a) || (COMMITMENT_MANDATE_KINDS as readonly string[]).includes(a) || BUDGET_KIND_BY_ACTION[a] !== null) out.push(`job ${t.moduleKey}/${t.templateKey}: ${a} is never a standing job`);
    }
    if (t.minIntervalMinutes < ps.scheduleMinIntervalMinutes) out.push(`job ${t.moduleKey}/${t.templateKey}: interval below the hub minimum`);
    if (t.defaultTrigger.kind === 'schedule' && scheduleIntervalMinutes(t.defaultTrigger.rrule) < t.minIntervalMinutes) out.push(`job ${t.moduleKey}/${t.templateKey}: default schedule below its minimum interval`);
  }
  return out;
}

/** A participant setting value against the hub bounds: tightening is always allowed, widening never (AGT-022). */
export function participantSettingAllowed(bounds: ParticipantSettingsBounds, setting:
  | { key: 'approval'; mode: ApprovalMode }
  | { key: 'outreachPerWeek'; value: number }
  | { key: 'reportCadence'; value: ReportCadence }
  | { key: 'scheduleIntervalMinutes'; value: number }
  | { key: 'channels'; value: readonly Channel[] }): boolean {
  switch (setting.key) {
    case 'approval': return APPROVAL_RANK[setting.mode] <= APPROVAL_RANK[bounds.approval.loosestMode];
    case 'outreachPerWeek': return Number.isInteger(setting.value) && setting.value >= 0 && setting.value <= bounds.outreachPerWeek.max;
    case 'reportCadence': return CADENCE_RANK[setting.value] <= CADENCE_RANK[bounds.reportCadence.max];
    case 'scheduleIntervalMinutes': return setting.value >= bounds.scheduleMinIntervalMinutes;
    case 'channels': return setting.value.every((c) => bounds.channels.allowed.includes(c));
  }
}

/* ---------- Engine default policy (no agents version active) ---------- */

/**
 * What applies while a hub has no active `agents` version: every shipped module at its manifest's full extent for every
 * participant type, nothing switched off, conservative participant bounds. Kill switches and guard rails always apply.
 */
export function engineDefaultPolicy(hubId: string, registry: ModuleRegistry, calendarTimeZone = 'UTC'): AgentPolicyDraft {
  const policy: HubAgentPolicy = {
    hubId,
    enabledModules: registry.manifests.map((m) => ({ moduleKey: m.key, moduleVersion: m.version, freeQuota: m.freeFloor.map((q) => ({ ...q })), settings: {} })),
    protectionLimits: {
      openIntroductionsPerPerson: 5, newCounterpartiesPerDay: 10, maxNegotiationRounds: 6, consumerMaxRounds: 4, envelopesPerCounterpartyPerDay: 20,
      publicRecordsPerConnectionPerDay: 1000, connectionsPerPerson: 3, connectionIdleExpiryDays: 90,
    },
    forbiddenPreAuthorization: [...ENGINE_FORBIDDEN_PRE_AUTHORIZATION],
    activeExtensionVersionIds: [],
  };
  return {
    schemaVersion: AGENT_MODULES_CONTRACT_VERSION,
    policy,
    modules: registry.manifests.map((m) => {
      const commits = m.actions.some((a) => (COMMITMENT_MANDATE_KINDS as readonly string[]).includes(a));
      return {
        moduleKey: m.key, status: 'active' as const, principalKinds: [...AGENT_PRINCIPAL_KINDS], verifiedCompanyRequired: commits, actions: [...m.actions], capabilityIds: m.capabilities.map((c) => c.id), dataClasses: [...new Set(m.capabilities.flatMap((c) => c.privateDataClasses))],
        limits: { runsPerDay: 50, actionsPerDay: 100, concurrentRuns: 2, outreachPerWeek: m.actions.some((a) => OUTREACH_ACTIONS.includes(a)) ? 10 : null },
      };
    }),
    capabilities: [],
    participantSettings: {
      approval: { defaultMode: 'ask_each', loosestMode: 'pre_authorized' }, outreachPerWeek: { default: 5, max: 10 }, reportCadence: { default: 'weekly', max: 'daily' },
      scheduleMinIntervalMinutes: ENGINE_MIN_JOB_INTERVAL_MINUTES, channels: { defaults: ['platform'], allowed: ['platform', 'email'] },
    },
    calendar: { timeZone: calendarTimeZone, closedDates: [] },
    jobTemplates: [],
  };
}

/* ---------- The shared authority check (pure mirror of the database function) ---------- */

export type CapabilityRefusalReason =
  | 'capability.unknown' | 'module.not_enabled' | 'module.not_serving' | 'module.not_eligible' | 'module.verified_company_required'
  | 'capability.off_for_hub' | 'capability.off_for_principal_kind' | 'capability.off_for_plan';
export interface CapabilityPrincipal { kind: AgentPrincipalKind; planKey: string; companyVerified: boolean }

/**
 * Whether the hub policy lets this principal use a capability; `null` when allowed. Surface-independent by construction:
 * the interface, the agent runtime and MCP ask the same question and get the same answer (ADR 010 decision 23 parity).
 * Kill switches are a separate, later check (`agentDispatchBlocked` and the database's dispatch refusal).
 */
export function capabilityRefusal(doc: AgentPolicyDraft, registry: ModuleRegistry, capabilityId: string, principal: CapabilityPrincipal): CapabilityRefusalReason | null {
  const moduleKey = capabilityId.split('.')[0] ?? '';
  const module = moduleRefusal(doc, registry, moduleKey, principal);
  if (module !== null) return module === 'module.unregistered' ? null : module;
  const entry = doc.policy.enabledModules.find((m) => m.moduleKey === moduleKey) as HubAgentPolicy['enabledModules'][number];
  const control = doc.modules.find((m) => m.moduleKey === moduleKey) as ModuleControl;
  if (!control.capabilityIds.includes(capabilityId)) {
    const offered = moduleCapabilities(registry, entry.moduleKey, entry.moduleVersion, doc.policy.activeExtensionVersionIds).some((c) => c.id === capabilityId);
    return offered ? 'capability.off_for_hub' : 'capability.unknown';
  }
  const s = doc.capabilities.find((x) => x.capabilityId === capabilityId);
  if (s?.offForHub) return 'capability.off_for_hub';
  if (s?.offForPrincipalKinds.includes(principal.kind)) return 'capability.off_for_principal_kind';
  if (s?.offForPlans.includes(principal.planKey)) return 'capability.off_for_plan';
  return null;
}

/** Whether a module is registered in the engine (a manifest or an activated extension); unregistered modules are not governed yet. */
export function isRegisteredModule(registry: ModuleRegistry, moduleKey: string): boolean {
  return registry.manifests.some((m) => m.key === moduleKey) || registry.extensions.some((e) => e.moduleKey === moduleKey);
}

/** The module-level part of the check: enabled, serving, eligible for this participant type and company status. */
export function moduleRefusal(doc: AgentPolicyDraft, registry: ModuleRegistry, moduleKey: string, principal: CapabilityPrincipal): CapabilityRefusalReason | 'module.unregistered' | null {
  if (!isRegisteredModule(registry, moduleKey)) return 'module.unregistered';
  const entry = doc.policy.enabledModules.find((m) => m.moduleKey === moduleKey);
  const control = doc.modules.find((m) => m.moduleKey === moduleKey);
  if (!entry || !control) return 'module.not_enabled';
  if (!SERVING_MODULE_STATUSES.includes(control.status)) return 'module.not_serving';
  if (!control.principalKinds.includes(principal.kind)) return 'module.not_eligible';
  if (control.verifiedCompanyRequired && principal.kind !== 'person' && !principal.companyVerified) return 'module.verified_company_required';
  return null;
}

/* ---------- Preview: what changes between two documents ---------- */

/** The changes of `after` against `before` (null: the engine default applies now). Counts are filled from the database. */
export function diffPolicies(before: AgentPolicyDraft | null, after: AgentPolicyDraft, registry: ModuleRegistry): Omit<PolicyPreview, 'computedAt' | 'baseVersionId' | 'affected' | 'registeredModuleKeys'> {
  const base = before ?? engineDefaultPolicy(after.policy.hubId, registry);
  const modules: PolicyPreview['modules'] = [];
  const narrowed = new Set<string>();
  const keys = [...new Set([...base.modules.map((m) => m.moduleKey), ...after.modules.map((m) => m.moduleKey)])].sort();
  const subset = <T>(a: readonly T[], b: readonly T[]) => a.every((x) => b.includes(x));
  for (const key of keys) {
    const b = base.modules.find((m) => m.moduleKey === key);
    const a = after.modules.find((m) => m.moduleKey === key);
    const bServing = !!b && SERVING_MODULE_STATUSES.includes(b.status);
    const aServing = !!a && SERVING_MODULE_STATUSES.includes(a.status);
    if (!bServing && aServing) modules.push({ moduleKey: key, change: 'enabled' });
    else if (bServing && !aServing) { modules.push({ moduleKey: key, change: 'disabled' }); narrowed.add(key); }
    else if (a && b && JSON.stringify(a) !== JSON.stringify(b)) {
      const narrower = !subset(b.actions, a.actions) || !subset(b.capabilityIds, a.capabilityIds) || !subset(b.principalKinds, a.principalKinds) || !subset(b.dataClasses, a.dataClasses)
        || (a.verifiedCompanyRequired && !b.verifiedCompanyRequired);
      const wider = !subset(a.actions, b.actions) || !subset(a.capabilityIds, b.capabilityIds) || !subset(a.principalKinds, b.principalKinds) || !subset(a.dataClasses, b.dataClasses);
      modules.push({ moduleKey: key, change: narrower ? 'narrowed' : wider ? 'widened' : 'changed' });
      if (narrower) narrowed.add(key);
    }
  }
  const capabilities: PolicyPreview['capabilities'] = [];
  const principalKinds = new Set<AgentPrincipalKind>();
  const plans = new Set<string>();
  const ids = [...new Set([...base.capabilities.map((c) => c.capabilityId), ...after.capabilities.map((c) => c.capabilityId)])].sort();
  for (const id of ids) {
    const b = base.capabilities.find((c) => c.capabilityId === id);
    const a = after.capabilities.find((c) => c.capabilityId === id);
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    const off = (s: CapabilitySwitch | undefined) => ({ hub: s?.offForHub ?? false, kinds: s?.offForPrincipalKinds ?? [], plans: s?.offForPlans ?? [] });
    const ob = off(b);
    const oa = off(a);
    const narrower = (oa.hub && !ob.hub) || oa.kinds.some((k) => !ob.kinds.includes(k)) || oa.plans.some((p) => !ob.plans.includes(p));
    capabilities.push({ capabilityId: id, change: !a ? 'enabled' : narrower ? 'narrowed' : 'widened' });
    for (const k of [...oa.kinds, ...ob.kinds]) principalKinds.add(k);
    for (const p of [...oa.plans, ...ob.plans]) plans.add(p);
    if (narrower) narrowed.add(id.split('.')[0] as string);
  }
  return { modules, capabilities, narrowedModuleKeys: [...narrowed].sort(), principalKinds: [...principalKinds].sort(), plans: [...plans].sort() };
}

/** Two previews show the same thing to a person (the time it was computed aside). */
export function samePreview(a: PolicyPreview, b: PolicyPreview): boolean {
  const strip = (p: PolicyPreview) => JSON.stringify({ ...p, computedAt: null });
  return strip(a) === strip(b);
}

/* ---------- Job triggers in the principal's time zone and the hub calendar ---------- */

const RRULE_PART = /^([A-Z]+)=([A-Z0-9,+-]+)$/;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
interface Rule { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; byDay: number[] | null; byMonthDay: number[] | null; hours: number[]; minutes: number[] }

/** Parses the RRULE subset of `JobTriggerSchema` (FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYHOUR, BYMINUTE); throws on others. */
export function parseRrule(rrule: string): Rule {
  const parts = rrule.split(';');
  const map = new Map<string, string>();
  for (const part of parts) {
    const m = RRULE_PART.exec(part);
    if (!m || map.has(m[1] as string)) throw new Error(`invalid rrule part ${part}`);
    map.set(m[1] as string, m[2] as string);
  }
  const freq = map.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') throw new Error('FREQ is DAILY, WEEKLY or MONTHLY');
  for (const k of map.keys()) if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE'].includes(k)) throw new Error(`unsupported rrule part ${k}`);
  const ints = (v: string | undefined, lo: number, hi: number): number[] | null => {
    if (v === undefined) return null;
    const xs = v.split(',').map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : NaN));
    if (xs.some((x) => !Number.isInteger(x) || x < lo || x > hi) || !uniq(xs)) throw new Error(`invalid rrule list ${v}`);
    return xs.sort((a, b) => a - b);
  };
  const interval = map.has('INTERVAL') ? Number(map.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('INTERVAL is 1..365');
  const byDayRaw = map.get('BYDAY');
  const byDay = byDayRaw === undefined ? null : byDayRaw.split(',').map((d) => {
    const i = (WEEKDAYS as readonly string[]).indexOf(d);
    if (i < 0) throw new Error(`invalid BYDAY ${d}`);
    return i;
  });
  return {
    freq, interval, byDay, byMonthDay: ints(map.get('BYMONTHDAY'), 1, 31),
    hours: ints(map.get('BYHOUR'), 0, 23) ?? [DEFAULT_SCHEDULE_HOUR], minutes: ints(map.get('BYMINUTE'), 0, 59) ?? [0],
  };
}

/** The smallest gap between two firings a rule allows, in minutes (used against minimum intervals). */
export function scheduleIntervalMinutes(rrule: string): number {
  const r = parseRrule(rrule);
  const times = r.hours.flatMap((h) => r.minutes.map((m) => h * 60 + m)).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < times.length; i += 1) gap = Math.min(gap, (times[i] as number) - (times[i - 1] as number));
  const dayGap = r.freq === 'DAILY' ? r.interval : r.freq === 'WEEKLY' ? (r.byDay && r.byDay.length > 1 ? minCircularGap(r.byDay, 7) : 7 * r.interval) : 28 * r.interval;
  if (r.freq === 'MONTHLY' && r.byMonthDay && r.byMonthDay.length > 1) gap = Math.min(gap, 24 * 60 * minCircularGap(r.byMonthDay, 28));
  return Math.min(gap, dayGap * 24 * 60 - ((times.at(-1) as number) - (times[0] as number)));
}
function minCircularGap(xs: readonly number[], period: number): number {
  let gap = period;
  const s = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < s.length; i += 1) gap = Math.min(gap, (((s[(i + 1) % s.length] as number) - (s[i] as number)) + period) % period || period);
  return gap;
}

const dtf = new Map<string, Intl.DateTimeFormat>();
function partsIn(timeZone: string, at: number): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  let f = dtf.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    dtf.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday as string) };
}
/** The UTC instant of a local wall-clock time; a time inside a DST gap moves forward by the gap. */
export function localToInstant(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(timeZone, guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const delta = wall - shown;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}
const isoDate = (y: number, mo: number, d: number) => `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dayNumber = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);

/**
 * The next firing of a schedule strictly after `after`, in the trigger's time zone, honouring INTERVAL from the anchor
 * (the subscription's start) and the hub calendar's closed dates by the template's rule. `null` when none within 400 days.
 */
export function nextScheduleOccurrence(trigger: Extract<JobTrigger, { kind: 'schedule' }>, after: Date, anchor: Date, calendar: HubCalendar, onClosedDay: ClosedDayRule): Date | null {
  const r = parseRrule(trigger.rrule);
  const tz = trigger.timeZone;
  const closed = new Set(calendar.closedDates);
  const a = partsIn(tz, anchor.getTime());
  const anchorDay = dayNumber(a.y, a.mo, a.d);
  const anchorWeek = Math.floor((anchorDay - a.wd + 4) / 7);
  const start = partsIn(tz, after.getTime());
  let deferred: { h: number; mi: number } | null = null;
  for (let i = 0; i <= 400; i += 1) {
    const base = Date.UTC(start.y, start.mo - 1, start.d + i);
    const dt = new Date(base);
    const y = dt.getUTCFullYear(); const mo = dt.getUTCMonth() + 1; const d = dt.getUTCDate(); const wd = dt.getUTCDay();
    const day = dayNumber(y, mo, d);
    const isClosed = closed.has(isoDate(y, mo, d));
    if (deferred && !isClosed) {
      const at = localToInstant(tz, y, mo, d, deferred.h, deferred.mi);
      if (at > after.getTime()) return new Date(at);
    }
    let matches: boolean;
    if (r.freq === 'DAILY') matches = (day - anchorDay) % r.interval === 0 && (r.byDay === null || r.byDay.includes(wd));
    else if (r.freq === 'WEEKLY') matches = (Math.floor((day - wd + 4) / 7) - anchorWeek) % r.interval === 0 && (r.byDay ?? [a.wd]).includes(wd);
    else matches = (((y - a.y) * 12 + (mo - a.mo)) % r.interval === 0) && (r.byMonthDay ?? [a.d]).includes(d) && (r.byDay === null || r.byDay.includes(wd));
    if (!matches) continue;
    for (const h of r.hours) for (const mi of r.minutes) {
      const at = localToInstant(tz, y, mo, d, h, mi);
      if (at <= after.getTime()) continue;
      if (isClosed && onClosedDay === 'skip') continue;
      if (isClosed && onClosedDay === 'next_open_day') {
        deferred ??= { h, mi };
        continue;
      }
      return new Date(at);
    }
  }
  return null;
}

/** Firing times of a deadline trigger: at the default local hour, `offsetsDays` before the context's deadline date. */
export function deadlineOccurrences(trigger: Extract<JobTrigger, { kind: 'deadline' }>, deadline: Date, timeZone: string): Date[] {
  const p = partsIn(timeZone, deadline.getTime());
  return [...trigger.offsetsDays].sort((x, y) => y - x).map((offset) => {
    const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d - offset));
    return new Date(localToInstant(timeZone, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), DEFAULT_SCHEDULE_HOUR, 0));
  });
}

/** Whether an event starts a job: event triggers by type, goal triggers by the goal's progress events. */
export function triggerMatchesEvent(trigger: JobTrigger, event: { type: string; goalId?: string | null }): boolean {
  if (trigger.kind === 'event') return trigger.eventType === event.type;
  if (trigger.kind === 'goal') return event.type === 'agents.goal_progress' && event.goalId === trigger.goalId;
  return false;
}

/** A requested trigger against the template: offered kind, minimum interval, known context kind. Empty when valid. */
export function jobTriggerViolations(template: JobTemplate, trigger: JobTrigger, hubMinIntervalMinutes: number): string[] {
  const out: string[] = [];
  if (!template.triggerKinds.includes(trigger.kind)) out.push('trigger_kind_not_offered');
  if (trigger.kind === 'schedule') {
    try {
      if (scheduleIntervalMinutes(trigger.rrule) < Math.max(template.minIntervalMinutes, hubMinIntervalMinutes)) out.push('interval_below_minimum');
    } catch {
      out.push('schedule_invalid');
    }
  }
  if (trigger.kind === 'deadline' && !(CONTEXT_KINDS_V2 as readonly string[]).includes(trigger.contextKind)) out.push('context_kind_unknown');
  return out;
}

/* ---------- Commands and views ---------- */

export const ActingForSchema = z.enum(['self', 'employer']);
export const TurnOnJobCommandSchema = z.strictObject({
  /** `employer`: the job acts for the person's active employer (a company member's agent). */
  actingFor: ActingForSchema,
  moduleKey: AgentModuleKeySchema,
  templateKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  /** `null` takes the template's default trigger (a schedule in the hub's time zone becomes the principal's choice). */
  trigger: JobTriggerSchema.nullable(),
  /** The mandate's validity; at most one year. */
  validUntil: TimestampSchema,
});
export type TurnOnJobCommand = z.infer<typeof TurnOnJobCommandSchema>;

export const JobRequestStatusSchema = z.enum(['pending', 'active', 'withdrawn', 'lapsed']);
export const JobRequestViewSchema = z.strictObject({
  id: IdSchema,
  moduleKey: AgentModuleKeySchema,
  templateKey: z.string(),
  trigger: JobTriggerSchema,
  status: JobRequestStatusSchema,
  reason: z.string().nullable(),
  mandateProposalId: IdSchema,
  jobSubscriptionId: IdSchema.nullable(),
  nextDueAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type JobRequestView = z.infer<typeof JobRequestViewSchema>;

export const CapabilityAvailabilitySchema = z.strictObject({
  capabilityId: z.string(),
  moduleKey: AgentModuleKeySchema,
  labelKey: z.string(),
  available: z.boolean(),
  /** Locale key of the explanation shown when unavailable (`agentModules.refusal.*`). */
  reason: z.string().nullable(),
});
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

/** Locale keys of refusals, the same on every surface. */
export const REFUSAL_MESSAGE_KEYS: Record<CapabilityRefusalReason | 'kill_switch', string> = {
  'capability.unknown': 'agentModules.refusal.unknown',
  'module.not_enabled': 'agentModules.refusal.moduleNotEnabled',
  'module.not_serving': 'agentModules.refusal.moduleNotServing',
  'module.not_eligible': 'agentModules.refusal.notEligible',
  'module.verified_company_required': 'agentModules.refusal.verifiedCompanyRequired',
  'capability.off_for_hub': 'agentModules.refusal.offForHub',
  'capability.off_for_principal_kind': 'agentModules.refusal.offForPrincipalKind',
  'capability.off_for_plan': 'agentModules.refusal.offForPlan',
  kill_switch: 'agentModules.refusal.paused',
};

/** Kill-switch scopes this package engages and releases (the agent levels of `KillSwitchScopeSchema`). */
export const AGENT_KILL_SWITCH_KINDS = ['hub_agent_dispatch', 'agent_module', 'agent_capability', 'agent_action', 'external_agent_api'] as const;
/** Console commands (contract version, idempotency key restated from the header, staff reason), like every hub console command. */
export const EngageAgentKillSwitchCommandSchema = consoleCommand({
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('hub_agent_dispatch') }),
    z.strictObject({ kind: z.literal('agent_module'), moduleKey: AgentModuleKeySchema }),
    z.strictObject({ kind: z.literal('agent_capability'), capabilityId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/).max(100) }),
    z.strictObject({ kind: z.literal('agent_action'), action: MandateActionV2Schema }),
    z.strictObject({ kind: z.literal('external_agent_api') }),
  ]),
});
export type EngageAgentKillSwitchCommand = z.infer<typeof EngageAgentKillSwitchCommandSchema>;
/** Without `approvalId` the release asks a second person (`kill_switch.release`); the releaser then calls again with it. */
export const ReleaseAgentKillSwitchCommandSchema = consoleCommand({ incidentNote: z.string().min(1).max(500), approvalId: IdSchema.nullable() });
export type ReleaseAgentKillSwitchCommand = z.infer<typeof ReleaseAgentKillSwitchCommandSchema>;
export const DraftAgentPolicyCommandSchema = consoleCommand({ document: AgentPolicyDraftSchema });
export type DraftAgentPolicyCommand = z.infer<typeof DraftAgentPolicyCommandSchema>;
export const PreviewAgentPolicyCommandSchema = z.strictObject({ document: AgentPolicyDraftSchema });
/** Activation of an `agents` version: the HUB-001 activation command (second person through `/v1/admin/approvals`). */
export const ActivateAgentPolicyCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), approvalId: IdSchema.nullable() });
export type ActivateAgentPolicyCommand = z.infer<typeof ActivateAgentPolicyCommandSchema>;

/** Every schema of this contract, for the JSON schema export and the registry test. */
export const AGENT_MODULES_SCHEMAS = {
  AgentPolicyDocument: AgentPolicyDocumentSchema, ModuleControl: ModuleControlSchema, CapabilitySwitch: CapabilitySwitchSchema, ParticipantSettingsBounds: ParticipantSettingsBoundsSchema,
  HubCalendar: HubCalendarSchema, JobTemplate: JobTemplateSchema, PolicyPreview: PolicyPreviewSchema, TurnOnJobCommand: TurnOnJobCommandSchema, JobRequestView: JobRequestViewSchema,
  CapabilityAvailability: CapabilityAvailabilitySchema, EngageAgentKillSwitchCommand: EngageAgentKillSwitchCommandSchema, ReleaseAgentKillSwitchCommand: ReleaseAgentKillSwitchCommandSchema,
  DraftAgentPolicyCommand: DraftAgentPolicyCommandSchema, ActivateAgentPolicyCommand: ActivateAgentPolicyCommandSchema,
} as const;
