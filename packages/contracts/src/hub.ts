import { z } from 'zod';
import { PartySchema } from './access.js';
import { A_PLUS_2_ACTIONS, ADMIN_PERMISSIONS, SENSITIVE_STAFF_ROLES, SodModeSchema, STAFF_ROLES } from './admin.js';
import { MandateActionSchema } from './assistant.js';
import { DigestSchema, Sha256HexSchema } from './common/digest-schema.js';
import { IanaTimeZoneSchema, IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { IdempotencyKeySchema } from './common/idempotency.js';
import { CurrencySchema, NonNegativeMinorUnitsSchema, NonNegativeMoneySchema } from './common/money.js';
import { DecimalSchema, decimalToScaled } from './common/quantity.js';
import { DataClassSchema } from './retrieval.js';

/**
 * Hub console contracts, frozen as version `HUB_CONSOLE_CONTRACT_VERSION` by HUBC-000 (docs/engine/hub-console/README.md,
 * section "Frozen contract"). Configuration of one hub on one node: identity, modes, launch gates, versioned
 * configuration, scoped staff and second-person approvals, provider connections with secret references (never secret
 * values), model routing, egress, budgets, kill switches, ingestion and data-mining pipelines, schedules and runs,
 * editorial items, the participant-agent product (modules, extension references, hub agent policy), metered prices,
 * marketplace fees, payment settings, plan to people, credentials, recommendations, setup, support and operations.
 *
 * Conventions (docs/data/model.md): field names are camelCase here and snake_case in tables (the mapping and the recorded
 * naming differences are in docs/engine/hub-console/data-model.md); owners are `PartySchema` (person XOR company);
 * configuration, prices and policies are versioned records drafted by one person and activated by another where the
 * domain is sensitive. Every object schema is strict. Console commands and command results carry the contract version.
 * Nothing here widens access to private data, sets a score, a position, a badge or a ranking weight, or holds money.
 */

/** Semantic version of the frozen console contract. A breaking change bumps the major and needs a new integrator review. */
export const HUB_CONSOLE_CONTRACT_VERSION = '1.0.0' as const;
export const HubConsoleContractVersionSchema = z.literal(HUB_CONSOLE_CONTRACT_VERSION);

/* ---------- Shared vocabulary ---------- */

/** BCP 47 tag limited to language, optional script and optional region: `en`, `es-US`, `uz-Latn`, `az-Latn`. */
export const LocaleTagSchema = z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-(?:[A-Z]{2}|\d{3}))?$/, 'BCP 47 language tag');
export type LocaleTag = z.infer<typeof LocaleTagSchema>;
/** One display value per locale; used for hub names and catalogue labels (product copy still lives in locale files). */
export const LocalizedNameSchema = z.record(LocaleTagSchema, NameSchema).refine((v) => Object.keys(v).length > 0, { message: 'at least one locale' });
export type LocalizedName = z.infer<typeof LocalizedNameSchema>;
const PersonActorSchema = z.strictObject({ kind: z.literal('person'), personId: IdSchema });
const PipelineActorSchema = z.strictObject({ kind: z.literal('pipeline'), pipelineId: IdSchema, runId: IdSchema });
/** Who proposed something: a person or an automated pipeline run. Pipelines may propose; only people decide. */
export const ProposerSchema = z.discriminatedUnion('kind', [PersonActorSchema, PipelineActorSchema]);
export type Proposer = z.infer<typeof ProposerSchema>;
/**
 * Every console command is a strict object carrying the contract version, an idempotency key and a staff reason; the
 * server adds the actor, the elevated session and the audit record. Unknown fields are rejected.
 */
export const ConsoleCommandBaseShape = {
  contractVersion: HubConsoleContractVersionSchema,
  idempotencyKey: IdempotencyKeySchema,
  reason: ShortTextSchema,
} as const;
export function consoleCommand<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({ ...ConsoleCommandBaseShape, ...shape });
}
const UnitIntervalSchema = DecimalSchema.refine((v) => {
  const { scaled, scale } = decimalToScaled(v);
  return scaled >= 0n && scaled <= 10n ** BigInt(scale);
}, { message: 'decimal between 0 and 1' });

/* ---------- Territory ---------- */

/**
 * Territories are descriptive and never exclusive. Country: ISO 3166-1 alpha-2 (`US`); region: ISO 3166-2 (`US-TX`);
 * place: a place key from the country pack or the hub's local additions (`US-TX:austin`, `UZ-SA:samarkand`).
 */
export const HubTerritorySchema = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('country'), code: z.string().regex(/^[A-Z]{2}$/) }),
  z.strictObject({ level: z.literal('region'), code: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/) }),
  z.strictObject({
    level: z.literal('place'),
    code: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?:[a-z0-9][a-z0-9-]{0,62}$/),
    wikidata: z.string().regex(/^Q[1-9]\d*$/).nullable(),
    osmRelation: z.string().regex(/^[1-9]\d*$/).nullable(),
  }),
]);
export type HubTerritory = z.infer<typeof HubTerritorySchema>;

/**
 * Jurisdiction code (`jur` in docs/data/model.md): ISO 3166-1 alpha-2 (`US`), ISO 3166-2 (`US-CA`) or a pack-defined
 * sub-jurisdiction (`US-CA:los-angeles-county`). The same grammar as territory codes, so one restriction check serves both.
 */
export const JurisdictionCodeSchema = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$/, 'jurisdiction code');
export type JurisdictionCode = z.infer<typeof JurisdictionCodeSchema>;
/** Every code a restriction check must see for a jurisdiction or place code: the country, the region and the full key. */
export function placeCodes(code: string): string[] {
  const [area] = code.split(':') as [string];
  const country = area.slice(0, 2);
  return [...new Set([country, area, code])];
}
/** Every code a restriction check must see: the country, the region and the full place key. */
export function territoryCodes(territory: HubTerritory): string[] {
  return placeCodes(territory.code);
}
/** A predicate over codes; the engine passes `isRestricted` from `@trustwork/country-packs`. */
export type RestrictedPredicate = (code: string) => boolean;
/**
 * The restricted-places list is code in `@trustwork/country-packs` (`isRestricted`); contracts take it as a predicate so
 * this package keeps no copy that could drift. A place inside a restricted region is restricted too.
 */
export function territoryRestricted(territory: HubTerritory, isRestricted: RestrictedPredicate): boolean {
  return territoryCodes(territory).some((code) => isRestricted(code));
}
export function jurisdictionRestricted(code: JurisdictionCode, isRestricted: RestrictedPredicate): boolean {
  return placeCodes(code).some((c) => isRestricted(c));
}

/* ---------- Hub, lifecycle and launch gates ---------- */

export const HUB_LIFECYCLE = ['draft', 'preparing', 'soft_launch', 'public', 'suspended', 'closing', 'closed'] as const;
export const HubLifecycleSchema = z.enum(HUB_LIFECYCLE);
export type HubLifecycle = z.infer<typeof HubLifecycleSchema>;
const HUB_TRANSITIONS: Record<HubLifecycle, readonly HubLifecycle[]> = {
  draft: ['preparing', 'closed'],
  preparing: ['draft', 'soft_launch', 'closed'],
  soft_launch: ['preparing', 'public', 'suspended', 'closing'],
  public: ['suspended', 'closing'],
  suspended: ['soft_launch', 'public', 'closing'],
  closing: ['closed'],
  closed: [],
};
export function hubTransitionAllowed(from: HubLifecycle, to: HubLifecycle): boolean {
  return HUB_TRANSITIONS[from].includes(to);
}

export const HubSchema = z.strictObject({
  id: IdSchema,
  nodeId: IdSchema,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  name: LocalizedNameSchema,
  lifecycle: HubLifecycleSchema,
  territories: z.array(HubTerritorySchema).min(1).max(200),
  /** Country pack code bound to the hub, or null for the generic profile with local additions. */
  countryPack: z.strictObject({ code: z.string().regex(/^[A-Z]{2}$/), version: z.string().min(1).max(40) }).nullable(),
  defaultLocale: LocaleTagSchema,
  locales: z.array(LocaleTagSchema).min(1).max(12),
  timeZone: IanaTimeZoneSchema,
  currency: CurrencySchema,
  brandOverlay: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).nullable(),
  revision: RevisionSchema,
})
  .refine((h) => h.locales.includes(h.defaultLocale), { message: 'default locale must be one of the hub locales', path: ['defaultLocale'] })
  .refine((h) => new Set(h.locales).size === h.locales.length, { message: 'duplicate locale', path: ['locales'] })
  .refine((h) => h.locales.every((l) => typeof h.name[l] === 'string'), { message: 'hub name is required in every hub locale', path: ['name'] });
export type Hub = z.infer<typeof HubSchema>;

/** The twelve gates of docs/engine/hubs.md plus two proposed by the console design (demo purge, AI egress review). */
export const LAUNCH_GATES = [
  'operator_recorded_and_screened', 'legal_documents_counsel_approved', 'data_residency_configured', 'two_staff_with_second_factor',
  'editorial_team_and_policy', 'community_rules_all_languages', 'information_source_registered', 'verification_recipe_enabled',
  'sanctions_screening_configured', 'i18n_complete', 'backup_restore_exercised', 'brand_accessibility_checked',
  'demo_data_purged', 'ai_egress_policy_reviewed',
] as const;
export const LaunchGateIdSchema = z.enum(LAUNCH_GATES);
export type LaunchGateId = z.infer<typeof LaunchGateIdSchema>;
/** Gates required before invited participants arrive; the rest are required for `public`. */
export const SOFT_LAUNCH_GATES: readonly LaunchGateId[] = [
  'operator_recorded_and_screened', 'legal_documents_counsel_approved', 'data_residency_configured', 'two_staff_with_second_factor', 'demo_data_purged', 'ai_egress_policy_reviewed',
];
/**
 * There is no waiver state: a gate is open, passed with evidence, or invalidated by a later change (for example an
 * expired legal version); an invalidated gate blocks like an open one until it is checked again.
 */
export const LaunchGateSchema = z.strictObject({
  hubId: IdSchema,
  gate: LaunchGateIdSchema,
  state: z.enum(['open', 'passed', 'invalidated']),
  evidenceRef: IdSchema.nullable(),
  checkedBy: IdSchema.nullable(),
  checkedAt: TimestampSchema.nullable(),
  invalidatedAt: TimestampSchema.nullable(),
  invalidationReason: ShortTextSchema.nullable(),
})
  .refine((g) => g.state === 'open' || (g.evidenceRef !== null && g.checkedBy !== null && g.checkedAt !== null), {
    message: 'a passed gate records evidence, checker and time',
    path: ['evidenceRef'],
  })
  .refine((g) => (g.state === 'invalidated') === (g.invalidatedAt !== null && g.invalidationReason !== null), {
    message: 'an invalidated gate records when and why, and only it does',
    path: ['invalidationReason'],
  });
export type LaunchGate = z.infer<typeof LaunchGateSchema>;
/** Returns the gates still blocking `target`; empty means the transition may be requested (it still needs a second person). */
export function blockingGates(target: 'soft_launch' | 'public', gates: readonly LaunchGate[]): LaunchGateId[] {
  const required = target === 'public' ? LAUNCH_GATES : SOFT_LAUNCH_GATES;
  return required.filter((id) => !gates.some((g) => g.gate === id && g.state === 'passed'));
}

/* ---------- System modes ---------- */

export const HUB_MODULES = [
  'publications', 'magazine', 'events', 'learning', 'matching', 'catalogue', 'procurement', 'sales', 'execution_reputation', 'agents',
  'external_agent_api', 'search', 'knowledge_answers', 'communications', 'billing', 'federation', 'editorial_automation', 'data_mining',
  'project_planner', 'expert_marketplace', 'shared_knowledge', 'reputation_passport', 'plan_recommendations',
] as const;
export const HubModuleSchema = z.enum(HUB_MODULES);
export type HubModule = z.infer<typeof HubModuleSchema>;
/** A module may be enabled only when the modules it builds on are enabled. */
export const MODULE_DEPENDENCIES: Readonly<Partial<Record<HubModule, readonly HubModule[]>>> = {
  magazine: ['publications'],
  sales: ['procurement', 'catalogue'],
  procurement: ['catalogue'],
  execution_reputation: ['procurement'],
  knowledge_answers: ['search'],
  editorial_automation: ['publications'],
  external_agent_api: ['agents'],
  matching: ['search'],
  expert_marketplace: ['project_planner', 'billing'],
  shared_knowledge: ['publications'],
  plan_recommendations: ['project_planner', 'search'],
};
export const DataModeSchema = z.enum(['demo', 'live']);
export const RegistrationModeSchema = z.enum(['closed', 'invite_only', 'open']);
export const ModerationStrictnessSchema = z.enum(['pre_moderate_all', 'pre_moderate_new_authors', 'post_moderate']);
/** `supervised_autonomous` runs whole pipelines without a person starting each step; human gates still apply. */
export const AutomationLevelSchema = z.enum(['manual', 'assisted', 'supervised_autonomous']);
export type AutomationLevel = z.infer<typeof AutomationLevelSchema>;
export const AUTOMATION_DOMAINS = ['editorial', 'translation', 'magazine_assembly', 'data_mining', 'entity_resolution', 'verification_rechecks', 'moderation_triage'] as const;
/** Decisions that always belong to a person, at every automation level. There is no setting that removes them. */
export const HUMAN_GATES = [
  'source_activation', 'dataset_activation', 'publication', 'magazine_release', 'claim_decision', 'link_decision', 'moderation_sanction', 'price_activation',
] as const;
export const HumanGateSchema = z.enum(HUMAN_GATES);

export const HubModesSchema = z.strictObject({
  dataMode: DataModeSchema,
  registration: RegistrationModeSchema,
  modules: z.array(HubModuleSchema),
  moderation: ModerationStrictnessSchema,
  automation: z.strictObject(Object.fromEntries(AUTOMATION_DOMAINS.map((d) => [d, AutomationLevelSchema])) as Record<(typeof AUTOMATION_DOMAINS)[number], typeof AutomationLevelSchema>),
  searchEngineIndexing: z.boolean(),
  maintenance: z.boolean(),
});
export type HubModes = z.infer<typeof HubModesSchema>;
/** Cross-checks modes against the lifecycle; returns violation codes (empty = consistent). */
export function modesViolations(lifecycle: HubLifecycle, modes: HubModes): string[] {
  const out: string[] = [];
  if (modes.dataMode === 'demo' && !['draft', 'preparing'].includes(lifecycle)) out.push('demo_data_only_before_soft_launch');
  if (modes.dataMode === 'demo' && modes.searchEngineIndexing) out.push('demo_data_never_indexed');
  if (modes.dataMode === 'demo' && modes.modules.includes('federation')) out.push('demo_data_never_federated');
  if (modes.registration === 'open' && lifecycle !== 'public') out.push('open_registration_only_when_public');
  if (modes.registration !== 'closed' && ['draft', 'preparing'].includes(lifecycle)) out.push('registration_closed_before_soft_launch');
  if (modes.searchEngineIndexing && !['soft_launch', 'public'].includes(lifecycle)) out.push('indexing_only_after_launch');
  for (const m of modes.modules) for (const dep of MODULE_DEPENDENCIES[m] ?? []) if (!modes.modules.includes(dep)) out.push(`module_${m}_requires_${dep}`);
  return out;
}

/* ---------- One admin vocabulary: permissions, second-person actions, scoped staff (ADR 012 decision 1) ---------- */

/** Hub console actions that need a second person in addition to the frozen A+2 set of `admin.ts`. */
export const HUB_SECOND_PERSON_ACTIONS = [
  'hub.transition_soft_launch', 'hub.transition_public', 'hub.change_residency', 'legal.activate_document_version', 'federation.raise_peering_level',
  'models.activate_private_route', 'egress.allow_private_class', 'pipelines.activate_personal_data_dataset', 'datasets.activate_court_or_debt',
  'automation.raise_to_supervised_autonomous', 'agents.enable_commitment_module', 'agents.activate_extension', 'jurisdiction.activate_settings',
  'billing.activate_fee_version', 'billing.release_payout_batch', 'payments.change_settings', 'sponsored.enable', 'staff.grant_breakglass',
  'support.reset_second_factor', 'support.rebind_recovery_email', 'ops.execute_restore', 'ops.apply_production_migration', 'ops.rotate_node_key',
  'kill_switch.release',
] as const;
export const HubSecondPersonActionSchema = z.enum(HUB_SECOND_PERSON_ACTIONS);
/** The merged second-person vocabulary: the frozen A+2 actions plus the console actions. */
export const CONSOLE_SECOND_PERSON_ACTIONS = [...A_PLUS_2_ACTIONS, ...HUB_SECOND_PERSON_ACTIONS] as const;
export const ConsoleSecondPersonActionSchema = z.enum(CONSOLE_SECOND_PERSON_ACTIONS);
export type ConsoleSecondPersonAction = z.infer<typeof ConsoleSecondPersonActionSchema>;
export function consoleActionNeedsSecondPerson(action: string): boolean {
  return (CONSOLE_SECOND_PERSON_ACTIONS as readonly string[]).includes(action);
}

/** Additions to the frozen `admin.*` vocabulary for the hub and node consoles (none duplicates `ADMIN_PERMISSIONS`). */
export const HUB_CONSOLE_PERMISSIONS = [
  'admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.modes.edit', 'admin.hub.lifecycle.request', 'admin.hub.legal.edit', 'admin.hub.legal.activate',
  'admin.hub.residency.edit', 'admin.hub.country.edit', 'admin.hub.launch.check', 'admin.hub.jurisdiction.edit', 'admin.hub.jurisdiction.activate',
  'admin.hub.payments.edit',
  'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test', 'admin.models.route.edit', 'admin.models.route.activate', 'admin.usage.read',
  'admin.pipelines.read', 'admin.pipelines.edit', 'admin.pipelines.activate', 'admin.pipelines.run', 'admin.pipelines.pause',
  'admin.datasets.read', 'admin.datasets.edit', 'admin.datasets.activate', 'admin.links.decide',
  'admin.editorial.items.review', 'admin.editorial.calendar.edit', 'admin.editorial.automation.edit',
  'admin.events.read', 'admin.events.review', 'admin.events.policy.edit', 'admin.events.refund.decide',
  'admin.learning.read', 'admin.learning.review', 'admin.learning.accreditation.record', 'admin.learning.certificate.revoke',
  'admin.matching.read', 'admin.matching.policy.edit', 'admin.matching.method.release',
  'admin.commerce.flows.read', 'admin.commerce.category_rules.edit',
  'admin.agents.read', 'admin.agents.modules.edit', 'admin.agents.modules.activate', 'admin.agents.policy.edit', 'admin.agents.clients.manage', 'admin.agents.kill',
  'admin.agents.extensions.edit', 'admin.agents.extensions.activate', 'admin.agents.extensions.suspend',
  'admin.billing.invoices.read', 'admin.billing.payouts.read', 'admin.billing.payouts.release', 'admin.billing.fees.draft', 'admin.billing.fees.activate',
  'admin.federation.read', 'admin.federation.peer.edit', 'admin.federation.defederate',
  'admin.support.account.read', 'admin.support.sessions.revoke', 'admin.support.second_factor.reset', 'admin.support.recovery.rebind', 'admin.support.explain',
  'admin.ops.backups.read', 'admin.ops.restore.drill', 'admin.ops.restore.execute', 'admin.ops.updates.apply', 'admin.ops.locales.read',
  'admin.node.hubs.manage', 'admin.node.keys.rotate',
  'admin.planner.templates.edit', 'admin.planner.templates.publish', 'admin.marketplace.rules.edit', 'admin.knowledge.shares.review',
  'admin.credentials.types.edit', 'admin.credentials.issue', 'admin.credentials.revoke', 'admin.trust.appeals.decide',
  'admin.recommendations.rules.edit', 'admin.sponsored.policy.edit',
] as const;
/** The merged admin vocabulary every console role definition, assignment and audit event uses. */
export const CONSOLE_PERMISSIONS = [...ADMIN_PERMISSIONS, ...HUB_CONSOLE_PERMISSIONS] as const;
export const ConsolePermissionSchema = z.enum(CONSOLE_PERMISSIONS);
export type ConsolePermission = z.infer<typeof ConsolePermissionSchema>;
/**
 * Words no permission, field or enum value may contain: staff never set a score, a rank, a position, a badge, a weight or
 * a boost. (`rerank` is the retrieval model job, not a ranking control.)
 */
export const FORBIDDEN_CONTROL_WORDS = /(score|(?<!re)rank|position|badge|weight|boost|promot|priorit)/i;

/** Staff scope: the platform (every node of this installation), one node, or one hub. */
export const StaffScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({ kind: z.literal('node'), nodeId: IdSchema }),
  z.strictObject({ kind: z.literal('hub'), hubId: IdSchema }),
]);
export type StaffScope = z.infer<typeof StaffScopeSchema>;
export type StaffScopeKind = StaffScope['kind'];
/** Permissions that act on the installation itself and are never granted inside a single hub. */
export const NODE_ONLY_PERMISSIONS: readonly ConsolePermission[] = [
  'admin.node.hubs.manage', 'admin.node.keys.rotate', 'admin.ops.restore.execute', 'admin.ops.restore.drill', 'admin.ops.updates.apply',
];
export function permissionAllowedInScope(permission: ConsolePermission, scope: StaffScopeKind): boolean {
  return scope !== 'hub' || !NODE_ONLY_PERMISSIONS.includes(permission);
}

export const HUB_STAFF_ROLES = [...STAFF_ROLES, 'hub-owner', 'compliance-officer', 'node-operator'] as const;
export const HubStaffRoleSchema = z.enum(HUB_STAFF_ROLES);
export type HubStaffRole = z.infer<typeof HubStaffRoleSchema>;
export const SENSITIVE_HUB_STAFF_ROLES: readonly HubStaffRole[] = [...SENSITIVE_STAFF_ROLES, 'hub-owner', 'compliance-officer', 'node-operator'];
/** Where each role may be held; roles not listed may be held at any scope. */
export const ROLE_SCOPES: Readonly<Partial<Record<HubStaffRole, readonly StaffScopeKind[]>>> = {
  'platform-owner': ['platform'],
  'node-operator': ['node'],
  'hub-owner': ['hub'],
  'compliance-officer': ['node', 'hub'],
};
export function roleAllowedInScope(role: HubStaffRole, scope: StaffScopeKind): boolean {
  return (ROLE_SCOPES[role] ?? ['platform', 'node', 'hub']).includes(scope);
}

/** A role definition over the merged vocabulary; it names the scopes it may be held at. */
export const ScopedStaffRoleDefinitionSchema = z.strictObject({
  version: z.int().min(1),
  role: HubStaffRoleSchema,
  scopes: z.array(z.enum(['platform', 'node', 'hub'])).min(1),
  permissions: z.array(ConsolePermissionSchema).min(1),
  caps: z.strictObject({ creditCapMinorUnits: NonNegativeMinorUnitsSchema.nullable(), grantMaxHours: z.int().min(1).max(72) }),
  sodConflicts: z.array(HubStaffRoleSchema),
  sodMode: SodModeSchema,
  releasedAt: TimestampSchema,
  releasedBy: IdSchema,
})
  .refine((d) => new Set(d.permissions).size === d.permissions.length && new Set(d.scopes).size === d.scopes.length, { message: 'each permission and scope once', path: ['permissions'] })
  .refine((d) => d.scopes.every((s) => roleAllowedInScope(d.role, s)), { message: 'the role definition names a scope the role cannot be held at', path: ['scopes'] })
  .refine((d) => !d.scopes.includes('hub') || d.permissions.every((p) => permissionAllowedInScope(p, 'hub')), {
    message: 'node-only permissions are never granted inside a hub',
    path: ['permissions'],
  })
  .refine((d) => !d.sodConflicts.includes(d.role), { message: 'a role does not conflict with itself', path: ['sodConflicts'] });
export type ScopedStaffRoleDefinition = z.infer<typeof ScopedStaffRoleDefinitionSchema>;

/** Break-glass roles last hours, not days (docs/engine/hub-console/operations.md). */
export const BREAKGLASS_MAX_HOURS = 12;
const hoursBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
/**
 * `staff_role_assignment` with the scope extension of ADR 012 decision 1 (the frozen `platform` literal of `admin.ts`
 * becomes one of three scopes). A person keeps one identity whatever roles they hold; nobody grants a role to themselves.
 */
export const ScopedStaffRoleAssignmentSchema = z.strictObject({
  id: IdSchema,
  personId: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  definitionVersion: z.int().min(1),
  grantedBy: IdSchema,
  approvedBy: IdSchema.nullable(),
  reason: ShortTextSchema,
  breakglass: z.boolean(),
  incidentRef: IdSchema.nullable(),
  validFrom: TimestampSchema,
  validUntil: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  revokedBy: IdSchema.nullable(),
})
  .refine((a) => a.grantedBy !== a.personId, { message: 'nobody grants a staff role to themselves', path: ['grantedBy'] })
  .refine((a) => !(SENSITIVE_HUB_STAFF_ROLES.includes(a.role) || a.breakglass) || (a.approvedBy !== null && a.approvedBy !== a.grantedBy && a.approvedBy !== a.personId), {
    message: 'sensitive and break-glass roles require a second approver distinct from the grantor and the holder',
    path: ['approvedBy'],
  })
  .refine((a) => roleAllowedInScope(a.role, a.scope.kind), { message: 'the role cannot be held at this scope', path: ['scope'] })
  .refine((a) => a.validUntil === null || Date.parse(a.validUntil) > Date.parse(a.validFrom), { message: 'validUntil after validFrom', path: ['validUntil'] })
  .refine((a) => !a.breakglass || (a.incidentRef !== null && a.validUntil !== null && hoursBetween(a.validFrom, a.validUntil) <= BREAKGLASS_MAX_HOURS), {
    message: `break-glass names an incident and expires within ${BREAKGLASS_MAX_HOURS} hours`,
    path: ['validUntil'],
  })
  .refine((a) => (a.revokedAt === null) === (a.revokedBy === null), { message: 'revocation records who and when', path: ['revokedBy'] });
export type ScopedStaffRoleAssignment = z.infer<typeof ScopedStaffRoleAssignmentSchema>;
export function sameStaffScope(a: StaffScope, b: StaffScope): boolean {
  if (a.kind === 'platform' || b.kind === 'platform') return a.kind === b.kind;
  if (a.kind === 'node') return b.kind === 'node' && a.nodeId === b.nodeId;
  return b.kind === 'hub' && a.hubId === b.hubId;
}
/** True when an assignment held at `scope` covers an action on `target` (a hub on a node, or the node itself). */
export function staffScopeCovers(scope: StaffScope, target: { nodeId: string; hubId: string | null }): boolean {
  if (scope.kind === 'platform') return true;
  if (scope.kind === 'node') return scope.nodeId === target.nodeId;
  return target.hubId !== null && scope.hubId === target.hubId;
}
export function staffAssignmentActive(a: ScopedStaffRoleAssignment, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && a.revokedAt === null && Date.parse(a.validFrom) <= t && (a.validUntil === null || Date.parse(a.validUntil) > t);
}

/** Second-person approvals are short-lived; a stale approval is requested again. */
export const SECOND_PERSON_APPROVAL_MAX_HOURS = 72;
/** The merged-vocabulary approval: bound to one action, one scope and the exact action digest. */
export const ConsoleSecondPersonApprovalSchema = z.strictObject({
  id: IdSchema,
  action: ConsoleSecondPersonActionSchema,
  scope: StaffScopeSchema,
  actionDigest: DigestSchema,
  requestedBy: IdSchema,
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
})
  .refine((a) => a.requestedBy !== a.approvedBy, { message: 'actor must differ from approver', path: ['approvedBy'] })
  .refine((a) => hoursBetween(a.approvedAt, a.expiresAt) > 0 && hoursBetween(a.approvedAt, a.expiresAt) <= SECOND_PERSON_APPROVAL_MAX_HOURS, {
    message: `an approval expires within ${SECOND_PERSON_APPROVAL_MAX_HOURS} hours of approval`,
    path: ['expiresAt'],
  });
export type ConsoleSecondPersonApproval = z.infer<typeof ConsoleSecondPersonApprovalSchema>;
/** An approval authorizes exactly one action with one digest at one scope, while unexpired and unrevoked; never its own requester. */
export function consoleApprovalBinds(
  approval: ConsoleSecondPersonApproval,
  request: { action: ConsoleSecondPersonAction; scope: StaffScope; actionDigest: { value: string }; actorPersonId: string },
  now: Date,
): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && approval.revokedAt === null && approval.action === request.action && sameStaffScope(approval.scope, request.scope) &&
    approval.actionDigest.value === request.actionDigest.value && approval.requestedBy === request.actorPersonId &&
    approval.approvedBy !== request.actorPersonId && Date.parse(approval.approvedAt) <= t && Date.parse(approval.expiresAt) > t;
}

/**
 * The console's mutation audit record over the merged vocabulary: `admin_audit_event` with the console permission,
 * the scoped role and the scope it acted in. Before/after are digests, never payloads; sequences are monotonic.
 */
export const ConsoleAuditEventSchema = z.strictObject({
  id: IdSchema,
  sequence: z.int().min(1),
  occurredAt: TimestampSchema,
  actorPersonId: IdSchema,
  actorRole: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  permission: ConsolePermissionSchema,
  sessionElevationId: IdSchema,
  caseId: IdSchema.nullable(),
  secondApproverPersonId: IdSchema.nullable(),
  approvalDigest: DigestSchema.nullable(),
  action: z.string().min(1).max(100).regex(/^[a-z][A-Za-z0-9_.]*$/),
  objectType: z.string().min(1).max(64),
  objectId: IdSchema,
  beforeDigest: DigestSchema.nullable(),
  afterDigest: DigestSchema.nullable(),
  reasonCode: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  reasonText: ShortTextSchema,
  outcome: z.enum(['applied', 'denied', 'failed']),
  requestId: IdSchema,
  retentionClass: z.enum(['audit_long', 'audit_standard']),
})
  .refine((e) => !consoleActionNeedsSecondPerson(e.action) || e.outcome !== 'applied' || (e.secondApproverPersonId !== null && e.approvalDigest !== null), {
    message: 'applied second-person actions record the second approver and the approval digest',
    path: ['secondApproverPersonId'],
  })
  .refine((e) => e.secondApproverPersonId === null || e.secondApproverPersonId !== e.actorPersonId, { message: 'the actor is never their own second approver', path: ['secondApproverPersonId'] })
  .refine((e) => permissionAllowedInScope(e.permission, e.scope.kind), { message: 'a node-only permission was used inside a hub', path: ['permission'] });
export type ConsoleAuditEvent = z.infer<typeof ConsoleAuditEventSchema>;

/* ---------- Versioned hub configuration ---------- */

export const HUB_CONFIG_DOMAINS = [
  'identity', 'modes', 'legal', 'residency', 'country', 'sources', 'verification', 'screening', 'editorial', 'events', 'learning', 'matching',
  'commerce', 'tax', 'payments', 'agents', 'agent_extensions', 'jurisdiction', 'communications', 'privacy', 'federation', 'providers', 'routing',
  'egress', 'budgets',
] as const;
export const HubConfigDomainSchema = z.enum(HUB_CONFIG_DOMAINS);
export type HubConfigDomain = z.infer<typeof HubConfigDomainSchema>;
/** Domains whose activation always needs a second person. */
export const SENSITIVE_CONFIG_DOMAINS: readonly HubConfigDomain[] = [
  'legal', 'residency', 'providers', 'egress', 'federation', 'agents', 'agent_extensions', 'jurisdiction', 'payments', 'privacy',
];
export const ConfigVersionStatusSchema = z.enum(['draft', 'active', 'superseded', 'cancelled']);
/** Configuration is never edited in place: each change is a version drafted, (approved,) activated and superseded. */
export const HubConfigVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  domain: HubConfigDomainSchema,
  version: z.int().min(1),
  payloadDigest: DigestSchema,
  status: ConfigVersionStatusSchema,
  reason: ShortTextSchema,
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  approvalId: IdSchema.nullable(),
  effectiveFrom: TimestampSchema.nullable(),
})
  .refine((c) => c.status === 'draft' || c.status === 'cancelled' || (c.activatedBy !== null && c.activatedAt !== null && c.effectiveFrom !== null), {
    message: 'activated versions record activator, time and effective date',
    path: ['activatedBy'],
  })
  .refine((c) => c.activatedAt === null || c.effectiveFrom === null || Date.parse(c.effectiveFrom) >= Date.parse(c.activatedAt), {
    message: 'effectiveFrom cannot precede activation (no back-dating)',
    path: ['effectiveFrom'],
  })
  .refine((c) => !SENSITIVE_CONFIG_DOMAINS.includes(c.domain) || c.activatedBy === null || (c.approvalId !== null && c.activatedBy !== c.draftedBy), {
    message: 'sensitive domains are activated by a different person under a second-person approval',
    path: ['approvalId'],
  });
export type HubConfigVersion = z.infer<typeof HubConfigVersionSchema>;

/* ---------- Secrets: references only ---------- */

export const SecretStoreSchema = z.enum(['envelope_db', 'env', 'file', 'external_kms', 'external_vault']);
const KNOWN_SECRET_PREFIXES = /^(sk-|sk_|rk_|pk_live|whsec_|xox[abpr]-|ghp_|gho_|ghs_|github_pat_|glpat-|AKIA|ASIA|AIza|ya29\.|hf_|r8_|SG\.|key-)/;
/** Heuristic guard: true when a string looks like a credential rather than a reference name. */
export function looksLikeSecretValue(value: string): boolean {
  return KNOWN_SECRET_PREFIXES.test(value) || (/^[A-Za-z0-9+/=_-]{32,}$/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value));
}
/**
 * Where a secret lives, never what it is. `keyedFingerprint` is a truncated HMAC under a node key so staff can see that
 * a rotation happened without anything that helps guess the value. Read models, logs, audit and outbox carry only this.
 */
export const SecretRefSchema = z.strictObject({
  id: IdSchema,
  store: SecretStoreSchema,
  ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/),
  keyedFingerprint: z.string().regex(/^[a-f0-9]{12}$/),
  version: z.int().min(1),
  createdAt: TimestampSchema,
  createdBy: IdSchema,
  rotatedAt: TimestampSchema.nullable(),
  lastUsedAt: TimestampSchema.nullable(),
}).refine((s) => !looksLikeSecretValue(s.ref), { message: 'ref must name a secret, not contain one', path: ['ref'] });
export type SecretRef = z.infer<typeof SecretRefSchema>;
/**
 * Write-only command, and the only schema in this module that carries a secret value: the value is accepted by the
 * secret endpoint alone and never echoed, logged, audited, exported or put in the outbox. The result is a reference.
 */
export const SecretSubmitCommandSchema = consoleCommand({
  connectionId: IdSchema,
  value: z.string().min(8).max(16_384),
  expectedRevision: RevisionSchema,
});
export type SecretSubmitCommand = z.infer<typeof SecretSubmitCommandSchema>;
/** What the secret endpoint answers: the new reference and the connection revision, never the value. */
export const SecretSubmitResultSchema = z.strictObject({
  contractVersion: HubConsoleContractVersionSchema,
  secretRef: SecretRefSchema,
  connectionRevision: RevisionSchema,
});
export type SecretSubmitResult = z.infer<typeof SecretSubmitResultSchema>;

/* ---------- Provider connections ---------- */

export const PROVIDER_CAPABILITIES = [
  'llm', 'embeddings', 'rerank', 'image_generation', 'translation', 'speech_to_text', 'text_to_speech', 'ocr', 'web_search', 'web_fetch',
  'email', 'sms', 'messenger', 'payments', 'payouts', 'e_invoicing', 'e_signature', 'register_lookup', 'sanctions_list', 'maps_geocoding',
  'object_storage', 'tax_calculation',
] as const;
export const ProviderCapabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
/** Adapter identifiers are engine code; `openai_compatible` covers self-hosted endpoints (Ollama, vLLM, llama.cpp servers). */
export const ProviderAdapterIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const KNOWN_MODEL_ADAPTERS = ['fake', 'openrouter', 'openai', 'anthropic', 'google', 'mistral', 'openai_compatible'] as const;
export const ProviderModeSchema = z.enum(['fake', 'manual', 'live']);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;
const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
/** Where data is processed. A broker (OpenRouter) forwards to other vendors; its terms and the routed vendor's both apply. */
export const ProviderHostingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('self_hosted'), country: CountryCodeSchema }),
  z.strictObject({ kind: z.literal('vendor'), country: CountryCodeSchema, zeroRetention: z.boolean(), trainsOnInputs: z.boolean(), broker: z.boolean() }),
]);
export type ProviderHosting = z.infer<typeof ProviderHostingSchema>;
export const ConnectionTestOutcomeSchema = z.enum(['ok', 'auth_failed', 'unreachable', 'rate_limited', 'quota_exceeded', 'residency_mismatch', 'model_missing', 'error']);
/** A test sends only engine-supplied synthetic input, never customer data. */
export const ConnectionTestResultSchema = z.strictObject({
  at: TimestampSchema,
  by: IdSchema,
  outcome: ConnectionTestOutcomeSchema,
  latencyMs: z.int().min(0).nullable(),
  modelsListed: z.int().min(0).nullable(),
  cost: NonNegativeMoneySchema.nullable(),
  syntheticInputOnly: z.literal(true),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;
export const ConnectionStatusSchema = z.enum(['draft', 'testing', 'enabled', 'disabled', 'killed']);
export const ProviderConnectionSchema = z.strictObject({
  id: IdSchema,
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('node'), nodeId: IdSchema }), z.strictObject({ kind: z.literal('hub'), hubId: IdSchema })]),
  adapterId: ProviderAdapterIdSchema,
  label: NameSchema,
  capabilities: z.array(ProviderCapabilitySchema).min(1),
  mode: ProviderModeSchema,
  endpoint: z.url({ protocol: /^https?$/ }).nullable(),
  secretRef: SecretRefSchema.nullable(),
  hosting: ProviderHostingSchema,
  status: ConnectionStatusSchema,
  lastTest: ConnectionTestResultSchema.nullable(),
  enabledBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((p) => p.mode !== 'fake' || p.secretRef === null, { message: 'fake adapters never hold secrets', path: ['secretRef'] })
  .refine((p) => p.mode !== 'live' || p.secretRef !== null || p.hosting.kind === 'self_hosted', { message: 'live vendor connections need a secret reference', path: ['secretRef'] })
  .refine((p) => p.endpoint === null || p.endpoint.startsWith('https://') || p.hosting.kind === 'self_hosted', { message: 'plain http only for self-hosted endpoints', path: ['endpoint'] })
  .refine((p) => p.status !== 'enabled' || p.lastTest?.outcome === 'ok', { message: 'enable only after a successful connection test', path: ['lastTest'] })
  .refine((p) => p.status !== 'enabled' || p.mode === 'fake' || (p.enabledBy !== null && p.approvalId !== null), {
    message: 'enabling a non-fake provider needs a second-person approval',
    path: ['approvalId'],
  });
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

/* ---------- Models and routing ---------- */

export const MODEL_JOBS = [
  'editorial_rewrite', 'summarisation', 'translation', 'fact_check_assist', 'classification', 'entity_resolution_assist', 'agent_reasoning', 'agent_drafting',
  'moderation_triage', 'embeddings', 'rerank', 'image_generation', 'speech_to_text', 'text_to_speech', 'ocr',
] as const;
export const ModelJobSchema = z.enum(MODEL_JOBS);
export type ModelJob = z.infer<typeof ModelJobSchema>;
export const ModelRefSchema = z.strictObject({ connectionId: IdSchema, modelId: z.string().min(1).max(200), modelRevision: z.string().min(1).max(200).nullable() });
export type ModelRef = z.infer<typeof ModelRefSchema>;
/** Cost price of a model as the operator pays it, in major units of `currency` per unit, as exact decimals. */
export const ModelPricingSchema = z.strictObject({
  connectionId: IdSchema,
  modelId: z.string().min(1).max(200),
  currency: CurrencySchema,
  inputPerMillionTokens: DecimalSchema.nullable(),
  outputPerMillionTokens: DecimalSchema.nullable(),
  perImage: DecimalSchema.nullable(),
  perAudioMinute: DecimalSchema.nullable(),
  basis: z.enum(['provider_list', 'contract', 'measured']),
  observedAt: TimestampSchema,
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
export const RouteStatusSchema = z.enum(['draft', 'active', 'superseded', 'disabled']);
/** Which model serves which job, for which data classes, with ordered fallbacks and limits. */
export const ModelRouteSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  job: ModelJobSchema,
  version: z.int().min(1),
  primary: ModelRefSchema,
  fallbacks: z.array(ModelRefSchema).max(3),
  allowedDataClasses: z.array(DataClassSchema).min(1),
  limits: z.strictObject({ maxInputTokens: z.int().min(1), maxOutputTokens: z.int().min(1), timeoutMs: z.int().min(100).max(600_000) }),
  budgetId: IdSchema.nullable(),
  status: RouteStatusSchema,
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
})
  .refine((r) => !r.fallbacks.some((f) => f.connectionId === r.primary.connectionId && f.modelId === r.primary.modelId), { message: 'fallback repeats the primary', path: ['fallbacks'] })
  .refine((r) => new Set(r.fallbacks.map((f) => `${f.connectionId}/${f.modelId}`)).size === r.fallbacks.length, { message: 'duplicate fallback', path: ['fallbacks'] })
  .refine((r) => r.job !== 'embeddings' || r.fallbacks.length === 0, { message: 'embedding vectors never mix models: no fallbacks', path: ['fallbacks'] })
  .refine((r) => r.job !== 'image_generation' || (r.allowedDataClasses.length === 1 && r.allowedDataClasses[0] === 'public'), {
    message: 'image prompts may contain public data only',
    path: ['allowedDataClasses'],
  })
  .refine((r) => r.status !== 'active' || r.activatedBy !== null, { message: 'active routes record the activator', path: ['activatedBy'] })
  .refine((r) => r.status !== 'active' || r.allowedDataClasses.every((c) => c === 'public') || (r.approvalId !== null && r.activatedBy !== r.draftedBy), {
    message: 'routes that may carry non-public data need a second person',
    path: ['approvalId'],
  });
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

/* ---------- Egress policy ---------- */

/** One cell of the data class × connection matrix. A missing cell is a deny. */
export const EgressRuleSchema = z.strictObject({
  hubId: IdSchema,
  connectionId: IdSchema,
  dataClass: DataClassSchema,
  decision: z.enum(['allow', 'deny']),
  requireInResidency: z.boolean(),
  requireZeroRetention: z.boolean(),
  version: z.int().min(1),
  approvalId: IdSchema.nullable(),
}).refine((r) => r.decision === 'deny' || r.dataClass === 'public' || (r.approvalId !== null && r.requireInResidency && r.requireZeroRetention), {
  message: 'allowing non-public data needs a second person, in-residency processing and zero retention',
  path: ['approvalId'],
});
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type EgressReason = 'allowed' | 'no_rule' | 'denied' | 'connection_not_enabled' | 'residency' | 'retention' | 'training';
/** Default deny; a vendor that trains on inputs never receives non-public data, whatever a rule says. */
export function egressDecision(
  rules: readonly EgressRule[],
  input: { connection: Pick<ProviderConnection, 'id' | 'status' | 'hosting'>; dataClass: z.infer<typeof DataClassSchema>; residencyCountry: string },
): { allowed: boolean; reason: EgressReason } {
  const { connection, dataClass } = input;
  if (connection.status !== 'enabled') return { allowed: false, reason: 'connection_not_enabled' };
  const rule = rules.filter((r) => r.connectionId === connection.id && r.dataClass === dataClass).sort((a, b) => b.version - a.version)[0];
  if (!rule) return { allowed: false, reason: 'no_rule' };
  if (rule.decision === 'deny') return { allowed: false, reason: 'denied' };
  const vendor = connection.hosting.kind === 'vendor' ? connection.hosting : null;
  if (dataClass !== 'public' && vendor?.trainsOnInputs) return { allowed: false, reason: 'training' };
  if (rule.requireInResidency && connection.hosting.country !== input.residencyCountry) return { allowed: false, reason: 'residency' };
  if (rule.requireZeroRetention && vendor && !vendor.zeroRetention) return { allowed: false, reason: 'retention' };
  return { allowed: true, reason: 'allowed' };
}

/* ---------- Spending caps, usage and kill switches ---------- */

/** Operator spending caps on providers (the hub's own costs). Participant platform budgets live in billing.ts. */
export const ProviderBudgetSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('hub') }),
    z.strictObject({ kind: z.literal('job'), job: ModelJobSchema }),
    z.strictObject({ kind: z.literal('pipeline'), pipelineId: IdSchema }),
    z.strictObject({ kind: z.literal('agent_module'), moduleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }),
    z.strictObject({ kind: z.literal('connection'), connectionId: IdSchema }),
  ]),
  period: z.enum(['day', 'month']),
  limit: NonNegativeMoneySchema,
  alertAtPercent: z.array(z.int().min(1).max(100)).max(5),
  onExhausted: z.enum(['pause', 'deny_new']),
  revision: RevisionSchema,
});
export type ProviderBudget = z.infer<typeof ProviderBudgetSchema>;
/** `exhausted` blocks new paid calls; there is no "allow overspend" state. */
export function providerBudgetState(budget: ProviderBudget, spentMinorUnits: string): 'ok' | 'alert' | 'exhausted' {
  const limit = BigInt(budget.limit.minorUnits);
  const spent = BigInt(NonNegativeMinorUnitsSchema.parse(spentMinorUnits));
  if (spent >= limit) return 'exhausted';
  const percent = limit === 0n ? 100n : (spent * 100n) / limit;
  return budget.alertAtPercent.some((p) => percent >= BigInt(p)) ? 'alert' : 'ok';
}

export const UsageAggregateSchema = z.strictObject({
  hubId: IdSchema,
  from: TimestampSchema,
  to: TimestampSchema,
  job: ModelJobSchema.nullable(),
  connectionId: IdSchema.nullable(),
  modelId: z.string().min(1).max(200).nullable(),
  pipelineId: IdSchema.nullable(),
  moduleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).nullable(),
  calls: z.int().min(0),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  images: z.int().min(0),
  audioSeconds: z.int().min(0),
  cost: NonNegativeMoneySchema,
}).refine((u) => Date.parse(u.to) > Date.parse(u.from), { message: 'to after from', path: ['to'] });
export type UsageAggregate = z.infer<typeof UsageAggregateSchema>;

/** Participant statistics are cohorts, never people: any count below this is suppressed. */
export const AGGREGATE_MIN_COHORT = 10;
export function suppressSmallCount(count: number): number | null {
  return Number.isInteger(count) && count >= AGGREGATE_MIN_COHORT ? count : null;
}
const CohortCountSchema = z.int().min(AGGREGATE_MIN_COHORT).nullable();

export const KillSwitchScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('node'), nodeId: IdSchema }),
  z.strictObject({ kind: z.literal('hub_agent_dispatch'), hubId: IdSchema }),
  z.strictObject({ kind: z.literal('agent_module'), hubId: IdSchema, moduleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }),
  z.strictObject({ kind: z.literal('agent_action'), hubId: IdSchema, action: MandateActionSchema }),
  z.strictObject({ kind: z.literal('agent_extension'), hubId: IdSchema, extensionId: IdSchema }),
  z.strictObject({ kind: z.literal('external_agent_api'), hubId: IdSchema }),
  z.strictObject({ kind: z.literal('provider_connection'), connectionId: IdSchema }),
  z.strictObject({ kind: z.literal('model_job'), hubId: IdSchema, job: ModelJobSchema }),
  z.strictObject({ kind: z.literal('pipeline'), pipelineId: IdSchema }),
  z.strictObject({ kind: z.literal('outbound_messages'), hubId: IdSchema }),
]);
/** Engaging is immediate and needs one person; releasing needs a second person and an incident note. */
export const KillSwitchSchema = z.strictObject({
  id: IdSchema,
  scope: KillSwitchScopeSchema,
  state: z.enum(['engaged', 'released']),
  engagedBy: IdSchema,
  engagedAt: TimestampSchema,
  reason: ShortTextSchema,
  releasedBy: IdSchema.nullable(),
  releasedAt: TimestampSchema.nullable(),
  releaseApprovalId: IdSchema.nullable(),
  incidentNote: ShortTextSchema.nullable(),
}).refine((k) => k.state === 'engaged' || (k.releasedBy !== null && k.releasedAt !== null && k.releaseApprovalId !== null && k.incidentNote !== null), {
  message: 'release records who, when, the approval and an incident note',
  path: ['incidentNote'],
});
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

/* ---------- Sources, datasets and entity links ---------- */

export const HUB_SOURCE_KINDS = [
  'rss', 'atom', 'sitemap', 'api', 'web_page', 'file_drop', 'register_open_data', 'register_api', 'procurement_portal', 'standards_body',
  'statistics', 'press_inbox', 'peer_feed', 'manual',
] as const;
export const HubSourceKindSchema = z.enum(HUB_SOURCE_KINDS);
/** Kinds that crawl pages and therefore need recorded robots and terms checks. */
export const CRAWLING_SOURCE_KINDS: readonly (typeof HUB_SOURCE_KINDS)[number][] = ['sitemap', 'web_page'];
export const SourcePurposeSchema = z.enum(['news_desk', 'company_directory', 'people_directory', 'knowledge_base', 'opportunities', 'events_calendar', 'verification_evidence']);
export const AllowedUsesSchema = z.strictObject({
  displayHeadlineAndLink: z.boolean(),
  displaySummary: z.boolean(),
  storeFullText: z.boolean(),
  indexForSearch: z.boolean(),
  sendToModelProviders: z.boolean(),
  translate: z.boolean(),
  rewriteWithAttribution: z.boolean(),
  reuseImages: z.boolean(),
  syndicateToPeers: z.boolean(),
});
export type AllowedUses = z.infer<typeof AllowedUsesSchema>;
export const SourceLicenceSchema = z.strictObject({
  kind: z.enum(['open_licence', 'public_domain', 'statutory_public', 'publisher_agreement', 'press_release', 'all_rights_reserved', 'unknown']),
  name: z.string().min(1).max(200).nullable(),
  url: z.url().nullable(),
  agreementRef: IdSchema.nullable(),
});
export const RobotsCheckSchema = z.strictObject({
  checkedAt: TimestampSchema,
  robotsUrl: z.url(),
  userAgent: z.string().min(1).max(200),
  allowed: z.boolean(),
  crawlDelaySeconds: z.int().min(0).nullable(),
  robotsDigest: Sha256HexSchema,
});
export const TermsCheckSchema = z.strictObject({
  checkedAt: TimestampSchema,
  termsUrl: z.url().nullable(),
  termsDigest: Sha256HexSchema.nullable(),
  automatedAccess: z.enum(['permitted', 'forbidden', 'unclear', 'not_applicable']),
  reviewedBy: IdSchema.nullable(),
  notes: z.string().max(2000),
});
export const LegalBasisSchema = z.enum(['statutory_public_register', 'open_licence', 'contract', 'consent', 'legitimate_interest_assessed', 'public_professional_data']);
export const SourceStatusSchema = z.enum(['proposed', 'in_review', 'approved', 'active', 'paused', 'rejected', 'retired', 'taken_down']);
export const SourcePauseReasonSchema = z.enum(['robots_changed', 'terms_changed', 'licence_ended', 'error_streak', 'budget', 'manual', 'takedown']);
const RESTRICTIVE_LICENCES = ['all_rights_reserved', 'unknown'] as const;
export const HubSourceSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: HubSourceKindSchema,
  name: NameSchema,
  url: z.url().nullable(),
  purposes: z.array(SourcePurposeSchema).min(1),
  licence: SourceLicenceSchema,
  robots: RobotsCheckSchema.nullable(),
  terms: TermsCheckSchema.nullable(),
  allowedUses: AllowedUsesSchema,
  attributionTemplate: ShortTextSchema,
  takedownContact: ShortTextSchema,
  ownerPersonId: IdSchema,
  personalData: z.boolean(),
  legalBasis: LegalBasisSchema.nullable(),
  proposedBy: ProposerSchema,
  status: SourceStatusSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  pauseReason: SourcePauseReasonSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((s) => !CRAWLING_SOURCE_KINDS.includes(s.kind) || (s.robots?.allowed === true && s.terms?.automatedAccess === 'permitted'), {
    message: 'crawling needs robots permission and terms that permit automated access, both recorded',
    path: ['terms'],
  })
  .refine((s) => !['approved', 'active', 'paused'].includes(s.status) || (s.activatedBy !== null && s.activatedAt !== null), {
    message: 'only a person activates a source',
    path: ['activatedBy'],
  })
  .refine((s) => !(RESTRICTIVE_LICENCES as readonly string[]).includes(s.licence.kind) ||
    !(s.allowedUses.storeFullText || s.allowedUses.sendToModelProviders || s.allowedUses.rewriteWithAttribution || s.allowedUses.syndicateToPeers || s.allowedUses.reuseImages || s.allowedUses.translate), {
    message: 'without a licence only headline, link, short summary and search indexing are possible',
    path: ['allowedUses'],
  })
  .refine((s) => !s.allowedUses.rewriteWithAttribution || s.allowedUses.storeFullText, { message: 'rewriting needs the stored text it is checked against', path: ['allowedUses'] })
  .refine((s) => !s.personalData || s.legalBasis !== null, { message: 'personal data needs a recorded legal basis', path: ['legalBasis'] })
  .refine((s) => s.status !== 'paused' || s.pauseReason !== null, { message: 'a paused source says why', path: ['pauseReason'] });
export type HubSource = z.infer<typeof HubSourceSchema>;

export const DATASET_SUBJECTS = ['companies', 'licences_permits', 'court_cases', 'debts_tax_arrears', 'procurement_notices', 'events', 'articles', 'people'] as const;
/** Off in every hub until enabled with an impact assessment, a legal basis and a second person (ADR 012 decision 4). */
export const OFF_BY_DEFAULT_DATASET_SUBJECTS = ['court_cases', 'debts_tax_arrears'] as const;
export const DatasetSubjectSchema = z.enum(DATASET_SUBJECTS);
/** Where mined data may go. Reputation is deliberately absent: it changes only through evidence decisions and method releases. */
export const DatasetOutputSchema = z.enum(['directory_sourced_records', 'verification_evidence', 'matching_eligibility', 'knowledge_base', 'opportunities_board', 'events_calendar', 'news_desk']);
export const PersonalDataCategorySchema = z.enum(['name', 'professional_role', 'licence_number', 'business_contact', 'court_party', 'debt_record']);
export const DatasetSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  subject: DatasetSubjectSchema,
  name: NameSchema,
  sourceIds: z.array(IdSchema).min(1),
  purpose: ShortTextSchema,
  legalBasis: LegalBasisSchema,
  personalData: z.strictObject({ present: z.boolean(), naturalPersons: z.boolean(), categories: z.array(PersonalDataCategorySchema) }),
  impactAssessmentRef: IdSchema.nullable(),
  retention: z.strictObject({ className: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), days: z.int().min(1).max(3650) }),
  outputs: z.array(DatasetOutputSchema).min(1),
  publicDisplay: z.boolean(),
  subjectNotice: z.boolean(),
  refreshScheduleId: IdSchema.nullable(),
  status: z.enum(['proposed', 'in_review', 'active', 'paused', 'retired']),
  activatedBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
  version: z.int().min(1),
})
  .refine((d) => d.subject !== 'people' || (['consent', 'public_professional_data'].includes(d.legalBasis) && !d.publicDisplay), {
    message: 'people data needs consent or public professional data and never creates public profiles',
    path: ['legalBasis'],
  })
  .refine((d) => !['court_cases', 'debts_tax_arrears', 'people'].includes(d.subject) || d.impactAssessmentRef !== null, {
    message: 'court, debt and people datasets need a recorded impact assessment',
    path: ['impactAssessmentRef'],
  })
  .refine((d) => !(['court_cases', 'debts_tax_arrears'].includes(d.subject) && d.personalData.naturalPersons) || (!d.publicDisplay && d.outputs.every((o) => o === 'verification_evidence')), {
    message: 'court and debt records about natural persons are never displayed and serve only as reviewed verification evidence',
    path: ['outputs'],
  })
  .refine((d) => !d.outputs.includes('matching_eligibility') || ['companies', 'licences_permits'].includes(d.subject), {
    message: 'matching eligibility comes only from company status and licences',
    path: ['outputs'],
  })
  .refine((d) => !d.personalData.present || d.personalData.categories.length > 0, { message: 'name the personal data categories', path: ['personalData'] })
  .refine((d) => d.status !== 'active' || (d.activatedBy !== null && (!d.personalData.present || d.approvalId !== null)), {
    message: 'activation by a person; personal-data datasets need a second person',
    path: ['approvalId'],
  })
  .refine((d) => !(OFF_BY_DEFAULT_DATASET_SUBJECTS as readonly string[]).includes(d.subject) || d.status !== 'active' || d.approvalId !== null, {
    message: 'court and debt datasets are off by default; turning one on needs a second person',
    path: ['approvalId'],
  });
export type Dataset = z.infer<typeof DatasetSchema>;

export const EntityRefSchema = z.strictObject({ kind: z.enum(['company', 'person', 'sourced_record', 'peer_replica']), id: IdSchema });
/** Entity resolution proposes links; the effect is always a link, never a merge, and a person decides. */
export const LinkProposalSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  left: EntityRefSchema,
  right: EntityRefSchema,
  evidence: z.array(z.strictObject({
    kind: z.enum(['identifier_match', 'name_address_similarity', 'register_officer_match', 'signed_statement', 'subject_confirmation', 'peer_link']),
    detail: ShortTextSchema,
    /** How strongly this evidence matches, 0..1; a matching measure, never a reputation score. */
    similarity: UnitIntervalSchema.nullable(),
  })).min(1),
  confidence: UnitIntervalSchema,
  proposedBy: ProposerSchema,
  status: z.enum(['proposed', 'accepted', 'rejected', 'withdrawn']),
  decidedBy: IdSchema.nullable(),
  decidedAt: TimestampSchema.nullable(),
  effect: z.literal('link'),
})
  .refine((l) => !(l.left.kind === l.right.kind && l.left.id === l.right.id), { message: 'cannot link a record to itself', path: ['right'] })
  .refine((l) => !['accepted', 'rejected'].includes(l.status) || (l.decidedBy !== null && l.decidedAt !== null), { message: 'a person decides', path: ['decidedBy'] })
  .refine((l) => !(l.left.kind === 'person' || l.right.kind === 'person') || l.status !== 'accepted' || l.evidence.some((e) => e.kind === 'subject_confirmation' || e.kind === 'signed_statement'), {
    message: 'a person is linked only with their own confirmation',
    path: ['evidence'],
  });
export type LinkProposal = z.infer<typeof LinkProposalSchema>;

/* ---------- Schedules, pipelines and runs ---------- */

/** Five-field cron (minute hour day-of-month month day-of-week) with numbers, `*`, ranges, lists and steps. */
export const CronExpressionSchema = z.string().regex(/^(\S+\s+){4}\S+$/).refine((v) => v.trim().split(/\s+/).every((f) => /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/.test(f)), {
  message: 'five-field cron expression',
});
const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const RetryPolicySchema = z.strictObject({
  maxAttempts: z.int().min(1).max(10),
  backoff: z.enum(['fixed', 'exponential']),
  baseSeconds: z.int().min(1).max(3600),
  maxDelaySeconds: z.int().min(1).max(86_400),
  retryOn: z.array(z.enum(['network', 'rate_limited', 'server_error', 'timeout'])).min(1),
});
export const AlertRuleSchema = z.strictObject({
  kind: z.enum(['failure_streak', 'zero_items_streak', 'cost_threshold', 'duration_exceeded', 'source_changed', 'budget_exhausted']),
  threshold: z.int().min(1),
  notify: z.enum(['console', 'staff_email']),
});
export const ScheduleSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  pipelineId: IdSchema,
  cron: CronExpressionSchema,
  timeZone: IanaTimeZoneSchema,
  windows: z.array(z.strictObject({ days: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1), from: ClockSchema, to: ClockSchema })).max(14),
  jitterSeconds: z.int().min(0).max(3600),
  quotas: z.strictObject({
    maxItemsPerRun: z.int().min(1),
    maxRunsPerDay: z.int().min(1).max(1440),
    maxCostPerRun: NonNegativeMoneySchema.nullable(),
    maxRequestsPerMinutePerHost: z.int().min(1).max(600),
  }),
  retry: RetryPolicySchema,
  concurrency: z.int().min(1).max(4),
  alerts: z.array(AlertRuleSchema).max(10),
  paused: z.boolean(),
  pausedBy: IdSchema.nullable(),
  pausedReason: ShortTextSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((s) => s.windows.every((w) => w.from !== w.to), { message: 'a window needs a non-empty span', path: ['windows'] })
  .refine((s) => !s.paused || (s.pausedBy !== null && s.pausedReason !== null), { message: 'a paused schedule records who and why', path: ['pausedReason'] });
export type Schedule = z.infer<typeof ScheduleSchema>;

export const PIPELINE_KINDS = [
  'source_discovery', 'source_ingestion', 'editorial_drafting', 'translation', 'magazine_assembly', 'dataset_refresh', 'entity_resolution',
  'verification_recheck', 'sanctions_rescreen', 'index_build',
] as const;
export const PipelineKindSchema = z.enum(PIPELINE_KINDS);
/** There is no `publish`, `activate` or `merge` step: those are human gates outside any pipeline. */
export const PIPELINE_STEPS = [
  'discover', 'check_legal', 'fetch', 'parse', 'normalise', 'deduplicate', 'classify', 'link_entities', 'summarise', 'rewrite', 'translate',
  'fact_check', 'similarity_check', 'generate_image', 'assemble', 'screen', 'index', 'propose_for_review', 'notify_staff',
] as const;
export const PipelineStepKindSchema = z.enum(PIPELINE_STEPS);
export type PipelineStepKind = z.infer<typeof PipelineStepKindSchema>;
const STEP_JOBS: Partial<Record<PipelineStepKind, readonly ModelJob[]>> = {
  summarise: ['summarisation'],
  rewrite: ['editorial_rewrite'],
  translate: ['translation'],
  fact_check: ['fact_check_assist'],
  classify: ['classification'],
  link_entities: ['entity_resolution_assist', 'embeddings'],
  generate_image: ['image_generation'],
  deduplicate: ['embeddings'],
  parse: ['ocr'],
  assemble: ['summarisation', 'classification'],
};
export const PipelineStepSchema = z.strictObject({
  kind: PipelineStepKindSchema,
  modelRouteId: IdSchema.nullable(),
  modelJob: ModelJobSchema.nullable(),
  settings: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/), z.union([z.string().max(500), z.number(), z.boolean()])),
})
  .refine((s) => (s.modelRouteId === null) === (s.modelJob === null), { message: 'a model step names both route and job', path: ['modelJob'] })
  .refine((s) => s.modelJob === null || (STEP_JOBS[s.kind] ?? []).includes(s.modelJob), { message: 'model job does not fit this step', path: ['modelJob'] });
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
const REVIEWED_KINDS: readonly (typeof PIPELINE_KINDS)[number][] = ['source_discovery', 'source_ingestion', 'editorial_drafting', 'translation', 'magazine_assembly', 'dataset_refresh', 'entity_resolution'];
export const PipelineVersionSchema = z.strictObject({
  id: IdSchema,
  pipelineId: IdSchema,
  hubId: IdSchema,
  kind: PipelineKindSchema,
  version: z.int().min(1),
  name: NameSchema,
  sourceIds: z.array(IdSchema),
  datasetId: IdSchema.nullable(),
  steps: z.array(PipelineStepSchema).min(1).max(30),
  automationLevel: AutomationLevelSchema,
  budgetId: IdSchema.nullable(),
  scheduleId: IdSchema.nullable(),
  status: z.enum(['draft', 'active', 'superseded', 'paused']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
})
  .refine((p) => !REVIEWED_KINDS.includes(p.kind) || p.steps.at(-1)?.kind === 'propose_for_review' || p.steps.at(-1)?.kind === 'notify_staff', {
    message: 'content and data pipelines end in a human review queue',
    path: ['steps'],
  })
  .refine((p) => {
    const kinds = p.steps.map((s) => s.kind);
    const review = kinds.lastIndexOf('propose_for_review');
    return kinds.every((k, i) => !['rewrite', 'summarise', 'translate', 'generate_image'].includes(k) || (review > i));
  }, { message: 'generated content must reach review', path: ['steps'] })
  .refine((p) => {
    const kinds = p.steps.map((s) => s.kind);
    const rewrite = kinds.indexOf('rewrite');
    return rewrite === -1 || kinds.indexOf('similarity_check', rewrite) > rewrite;
  }, { message: 'a rewrite is followed by a similarity check', path: ['steps'] })
  .refine((p) => !['source_ingestion', 'editorial_drafting'].includes(p.kind) || p.sourceIds.length > 0, { message: 'ingestion names its sources', path: ['sourceIds'] })
  .refine((p) => p.kind !== 'dataset_refresh' || p.datasetId !== null, { message: 'dataset refresh names its dataset', path: ['datasetId'] })
  .refine((p) => p.status !== 'active' || (p.activatedBy !== null && p.budgetId !== null), { message: 'active pipelines record the activator and a spending cap', path: ['budgetId'] });
export type PipelineVersion = z.infer<typeof PipelineVersionSchema>;

export const RUN_STATES = ['queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch'] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;
const FINISHED: readonly RunState[] = ['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch'];
const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'cancelled', 'skipped_window', 'skipped_budget', 'stopped_by_kill_switch'],
  running: ['succeeded', 'partially_succeeded', 'failed', 'cancelled', 'stopped_by_kill_switch', 'skipped_budget'],
  succeeded: [], partially_succeeded: [], failed: [], cancelled: [], skipped_window: [], skipped_budget: [], stopped_by_kill_switch: [],
};
export function runTransitionAllowed(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}
export const PipelineRunSchema = z.strictObject({
  id: IdSchema,
  pipelineVersionId: IdSchema,
  hubId: IdSchema,
  trigger: z.enum(['schedule', 'manual', 'dry_run', 'retry', 'backfill', 'event']),
  dryRun: z.boolean(),
  state: RunStateSchema,
  attempt: z.int().min(1).max(10),
  triggeredBy: z.discriminatedUnion('kind', [PersonActorSchema, z.strictObject({ kind: z.literal('schedule'), scheduleId: IdSchema })]),
  queuedAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  counts: z.strictObject({
    fetched: z.int().min(0), new: z.int().min(0), duplicates: z.int().min(0), skippedByLicence: z.int().min(0), skippedByRobots: z.int().min(0),
    proposed: z.int().min(0), failed: z.int().min(0),
  }),
  cost: NonNegativeMoneySchema,
  effectsCommitted: z.boolean(),
  errorCode: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/).nullable(),
})
  .refine((r) => (r.trigger === 'dry_run') === r.dryRun, { message: 'dry_run trigger and flag agree', path: ['dryRun'] })
  .refine((r) => !r.dryRun || !r.effectsCommitted, { message: 'a dry run commits nothing', path: ['effectsCommitted'] })
  .refine((r) => r.state !== 'running' || r.startedAt !== null, { message: 'running records a start', path: ['startedAt'] })
  .refine((r) => !FINISHED.includes(r.state) || r.finishedAt !== null, { message: 'finished runs record an end', path: ['finishedAt'] })
  .refine((r) => r.triggeredBy.kind === 'person' || r.trigger === 'schedule' || r.trigger === 'retry', { message: 'manual, dry and backfill runs are started by a person', path: ['triggeredBy'] });
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

/* ---------- Editorial items ---------- */

export const EDITORIAL_STAGES = ['discovered', 'ingested', 'drafted', 'checked', 'in_review', 'approved', 'scheduled', 'published', 'returned', 'rejected', 'held'] as const;
export const EditorialStageSchema = z.enum(EDITORIAL_STAGES);
export const EditorialTreatmentSchema = z.enum(['headline_link', 'summary', 'rewrite', 'translation', 'original_reporting']);
export const AiImageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('licensed'), licence: ShortTextSchema, credit: ShortTextSchema, sourceId: IdSchema.nullable() }),
  /** Always labelled for readers and in file metadata (IPTC digital source type `trainedAlgorithmicMedia`; C2PA where available). */
  z.strictObject({ kind: z.literal('ai_generated'), readerLabel: z.literal(true), metadataLabel: z.literal('trainedAlgorithmicMedia'), depictsRealPerson: z.literal(false), promptDigest: Sha256HexSchema }),
]);
export const FactCheckSchema = z.strictObject({ claim: ShortTextSchema, status: z.enum(['supported', 'contradicted', 'unverifiable']), evidenceUrls: z.array(z.url()).max(10) });
export const EditorialItemSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  pipelineRunId: IdSchema.nullable(),
  sources: z.array(z.strictObject({ sourceId: IdSchema, url: z.url(), retrievedAt: TimestampSchema, contentDigest: Sha256HexSchema })).min(1),
  originalLanguage: LocaleTagSchema,
  targetLanguages: z.array(LocaleTagSchema),
  stage: EditorialStageSchema,
  treatment: EditorialTreatmentSchema,
  ai: z.strictObject({ summarised: z.boolean(), rewritten: z.boolean(), translated: z.boolean(), routeIds: z.array(IdSchema) }),
  similarity: z.strictObject({ maxSourceOverlap: UnitIntervalSchema, threshold: UnitIntervalSchema, method: z.enum(['ngram_jaccard', 'minhash']) }).nullable(),
  factChecks: z.array(FactCheckSchema),
  image: AiImageSchema,
  attribution: ShortTextSchema,
  assignedEditorId: IdSchema.nullable(),
  review: z.strictObject({ decision: z.enum(['approved', 'returned', 'rejected']), by: IdSchema, at: TimestampSchema, note: z.string().max(2000) }).nullable(),
  publicationId: IdSchema.nullable(),
  scheduledFor: TimestampSchema.nullable(),
  revision: RevisionSchema,
})
  .refine((i) => !['approved', 'scheduled', 'published'].includes(i.stage) || i.review?.decision === 'approved', { message: 'only a person approves publication', path: ['review'] })
  .refine((i) => i.stage !== 'published' || i.publicationId !== null, { message: 'published items point to their publication', path: ['publicationId'] })
  .refine((i) => i.stage !== 'scheduled' || i.scheduledFor !== null, { message: 'scheduled items carry a time', path: ['scheduledFor'] })
  .refine((i) => !['summary', 'rewrite'].includes(i.treatment) || i.stage === 'discovered' || i.stage === 'ingested' || i.similarity !== null, {
    message: 'summaries and rewrites carry a similarity check',
    path: ['similarity'],
  });
export type EditorialItem = z.infer<typeof EditorialItemSchema>;
/** Reasons an editor cannot approve yet; `allowedUses` comes from the item's source(s). Warnings are not blockers. */
export function editorialApprovalBlockers(item: EditorialItem, allowedUses: AllowedUses): string[] {
  const out: string[] = [];
  const cmp = (a: string, b: string) => {
    const x = decimalToScaled(a);
    const y = decimalToScaled(b);
    const scale = Math.max(x.scale, y.scale);
    return x.scaled * 10n ** BigInt(scale - x.scale) - y.scaled * 10n ** BigInt(scale - y.scale);
  };
  if (item.similarity && cmp(item.similarity.maxSourceOverlap, item.similarity.threshold) > 0n) out.push('similarity_above_threshold');
  if (item.factChecks.some((f) => f.status === 'contradicted')) out.push('contradicted_claim');
  if (item.treatment === 'summary' && !allowedUses.displaySummary) out.push('licence_forbids_summary');
  if (item.treatment === 'rewrite' && !allowedUses.rewriteWithAttribution) out.push('licence_forbids_rewrite');
  if ((item.treatment === 'translation' || item.ai.translated) && !allowedUses.translate) out.push('licence_forbids_translation');
  if ((item.ai.summarised || item.ai.rewritten || item.ai.translated) && !allowedUses.sendToModelProviders) out.push('licence_forbids_model_use');
  if (item.image.kind === 'licensed' && item.image.sourceId !== null && !allowedUses.reuseImages) out.push('licence_forbids_image_reuse');
  return out;
}

/* ---------- Participant-agent product: modules, metered prices, plans, external clients ---------- */

export const AgentModuleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const MeteringUnitSchema = z.enum(['run', 'thousand_tokens', 'action', 'deliverable', 'api_call', 'month']);
const COMMITMENT_ACTIONS = ['place_order', 'accept_order'] as const;
/** A capability bundle of the one agent every participant has; never a separate bot. */
export const AgentModuleVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  key: AgentModuleKeySchema,
  version: z.int().min(1),
  actions: z.array(MandateActionSchema).min(1),
  eligibility: z.strictObject({
    principals: z.array(z.enum(['person', 'company_member', 'company_representative', 'external_agent_client'])).min(1),
    requireVerifiedCompany: z.boolean(),
  }),
  modelRoutes: z.array(z.strictObject({ job: ModelJobSchema, routeId: IdSchema })),
  limits: z.strictObject({
    runsPerDay: z.int().min(0),
    actionsPerDay: z.int().min(0),
    maxConcurrentRuns: z.int().min(1).max(20),
    tokensPerMonth: z.int().min(0),
    outreachPerWeek: z.int().min(0).nullable(),
  }),
  metering: z.strictObject({ unit: MeteringUnitSchema, freeUnitsPerMonth: z.int().min(0) }),
  status: z.enum(['draft', 'beta', 'active', 'retired']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
})
  .refine((m) => !m.actions.some((a) => (COMMITMENT_ACTIONS as readonly string[]).includes(a)) || m.eligibility.requireVerifiedCompany, {
    message: 'commitment actions are available only to verified companies',
    path: ['eligibility'],
  })
  .refine((m) => !m.actions.some((a) => (COMMITMENT_ACTIONS as readonly string[]).includes(a)) || m.status === 'draft' || (m.approvalId !== null && m.activatedBy !== m.draftedBy), {
    message: 'enabling commitment actions needs a second person',
    path: ['approvalId'],
  })
  .refine((m) => !m.actions.includes('communicate') || m.limits.outreachPerWeek !== null, { message: 'communicating modules carry an outreach quota', path: ['limits'] })
  .refine((m) => m.status === 'draft' || m.activatedBy !== null, { message: 'activation is recorded', path: ['activatedBy'] });
export type AgentModuleVersion = z.infer<typeof AgentModuleVersionSchema>;

/**
 * Metered price: cost price (what the hub pays, estimated) beside sale price (what the participant pays). Both are
 * exact decimals in minor units per metering unit; invoice totals round half-even to whole minor units. Same activation
 * rules as `PriceVersionSchema`: a different activator, no back-dating, no overlap.
 */
export const MeteredPriceVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  offerId: IdSchema,
  moduleKey: AgentModuleKeySchema.nullable(),
  unit: MeteringUnitSchema,
  version: z.int().min(1),
  currency: CurrencySchema,
  costPricePerUnitMinor: DecimalSchema,
  costBasis: z.enum(['model_list_price', 'measured_average', 'contract']),
  salePricePerUnitMinor: DecimalSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
})
  .refine((p) => !p.costPricePerUnitMinor.startsWith('-') && !p.salePricePerUnitMinor.startsWith('-'), { message: 'prices are non-negative', path: ['salePricePerUnitMinor'] })
  .refine((p) => p.status === 'draft' || p.status === 'cancelled' || (p.activatedBy !== null && p.activatedAt !== null), { message: 'non-draft versions record activation', path: ['activatedBy'] })
  .refine((p) => p.activatedBy === null || p.activatedBy !== p.draftedBy, { message: 'activator must differ from drafter', path: ['activatedBy'] })
  .refine((p) => p.activatedAt === null || Date.parse(p.effectiveFrom) > Date.parse(p.activatedAt), { message: 'effectiveFrom must be after activation (no back-dating)', path: ['effectiveFrom'] })
  .refine((p) => p.effectiveTo === null || Date.parse(p.effectiveTo) > Date.parse(p.effectiveFrom), { message: 'effectiveTo after effectiveFrom', path: ['effectiveTo'] });
export type MeteredPriceVersion = z.infer<typeof MeteredPriceVersionSchema>;
/** Sale minus cost per unit, as a decimal string; negative means the hub subsidises the unit (allowed, shown as a warning). */
export function unitMargin(p: Pick<MeteredPriceVersion, 'costPricePerUnitMinor' | 'salePricePerUnitMinor'>): string {
  const sale = decimalToScaled(p.salePricePerUnitMinor);
  const cost = decimalToScaled(p.costPricePerUnitMinor);
  const scale = Math.max(sale.scale, cost.scale);
  const diff = sale.scaled * 10n ** BigInt(scale - sale.scale) - cost.scaled * 10n ** BigInt(scale - cost.scale);
  const negative = diff < 0n;
  const digits = (negative ? -diff : diff).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== '0' ? `-${text}` : text;
}
export function meteredVersionsOverlap(a: MeteredPriceVersion, b: MeteredPriceVersion): boolean {
  if (a.offerId !== b.offerId || a.unit !== b.unit || a.status !== 'active' || b.status !== 'active') return false;
  const end = (p: MeteredPriceVersion) => (p.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(p.effectiveTo));
  return Date.parse(a.effectiveFrom) < end(b) && Date.parse(b.effectiveFrom) < end(a);
}

/** A plan tier buys capacity (module quotas, trials). It has no field that could touch ranking, matching or reputation. */
export const AgentPlanVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  offerId: IdSchema,
  version: z.int().min(1),
  payer: z.enum(['person', 'company', 'either']),
  includes: z.array(z.strictObject({ moduleKey: AgentModuleKeySchema, unitsPerMonth: z.int().min(0) })).min(1),
  trialDays: z.int().min(0).max(90),
  status: z.enum(['draft', 'active', 'retired']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
})
  .refine((p) => new Set(p.includes.map((i) => i.moduleKey)).size === p.includes.length, { message: 'each module once', path: ['includes'] })
  .refine((p) => p.status === 'draft' || (p.activatedBy !== null && p.activatedBy !== p.draftedBy), { message: 'activated by a different person', path: ['activatedBy'] });
export type AgentPlanVersion = z.infer<typeof AgentPlanVersionSchema>;

/**
 * An external agent (MCP or A2A client, or a plain REST integration) that a participant connects. It acts as that
 * participant's agent: only under their mandates, labelled, rate-limited, its inputs untrusted. It never has staff scopes.
 */
export const ExternalAgentClientSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  actingFor: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  protocol: z.enum(['mcp', 'a2a', 'rest']),
  label: NameSchema,
  scopes: z.array(z.enum(['read_public', 'search_public', 'read_own', 'act_under_mandate', 'receive_envelopes'])).min(1),
  /** Private data classes the person opted in to, one by one, after a residency warning; empty by default (ADR 012 decision 23). */
  privateDataClasses: z.array(DataClassSchema.exclude(['public'])),
  privateOptInAt: TimestampSchema.nullable(),
  credentialRef: SecretRefSchema,
  mandateRequired: z.literal(true),
  rateLimit: z.strictObject({ requestsPerMinute: z.int().min(1).max(600), actionsPerDay: z.int().min(0).max(10_000) }),
  status: z.enum(['active', 'suspended', 'revoked']),
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
})
  .refine((c) => c.status !== 'revoked' || c.revokedAt !== null, { message: 'revocation time recorded', path: ['revokedAt'] })
  .refine((c) => c.privateDataClasses.length === 0 || (c.privateOptInAt !== null && c.scopes.includes('read_own')), {
    message: 'private data reaches an external agent only after an explicit opt-in of the person, per class',
    path: ['privateOptInAt'],
  })
  .refine((c) => new Set(c.privateDataClasses).size === c.privateDataClasses.length, { message: 'each data class once', path: ['privateDataClasses'] });
export type ExternalAgentClient = z.infer<typeof ExternalAgentClientSchema>;

/** Aggregate agent statistics: every participant count is a cohort of at least AGGREGATE_MIN_COHORT or suppressed. */
export const AgentUsageStatSchema = z.strictObject({
  hubId: IdSchema,
  from: TimestampSchema,
  to: TimestampSchema,
  moduleKey: AgentModuleKeySchema,
  activePrincipals: CohortCountSchema,
  runs: CohortCountSchema,
  actionsSucceeded: CohortCountSchema,
  actionsEscalatedToHumans: CohortCountSchema,
  outcomeUnknown: z.int().min(0),
  cost: NonNegativeMoneySchema,
  revenue: NonNegativeMoneySchema,
});
export type AgentUsageStat = z.infer<typeof AgentUsageStatSchema>;

/* ---------- ADR 010 decision 22: jurisdiction settings, hub agent policy, extension references ---------- */

/** What the `jurisdiction` configuration domain covers; the full payload schema belongs to HUB-005 (`jurisdiction.ts`). */
export const JURISDICTION_SETTING_AREAS = ['agent_disclosure', 'liability_allocation', 'consent', 'record_keeping', 'action_limits', 'legal_texts'] as const;
export const JurisdictionSettingAreaSchema = z.enum(JURISDICTION_SETTING_AREAS);
/** A sourced country-pack fact a default comes from (`pack_code` + `pack_version` + fact key, docs/data/model.md 1.11). */
export const PackFactRefSchema = z.strictObject({
  packCode: z.string().regex(/^[A-Z]{2}$/),
  packVersion: z.string().min(1).max(40),
  factKey: z.string().regex(/^[a-z0-9][A-Za-z0-9_./:-]{1,160}$/),
});
export type PackFactRef = z.infer<typeof PackFactRefSchema>;
/**
 * The console's reference to one version of a hub's settings for one jurisdiction: which areas it sets, which pack
 * defaults it starts from, in which languages the disclosure exists. It is a `hub_config_version` of domain
 * `jurisdiction`; activation needs a second person like every sensitive domain.
 */
export const JurisdictionSettingsRefSchema = z.strictObject({
  hubId: IdSchema,
  jurisdiction: JurisdictionCodeSchema,
  configVersionId: IdSchema,
  version: z.int().min(1),
  payloadDigest: DigestSchema,
  areas: z.array(JurisdictionSettingAreaSchema).min(1),
  packDefaults: z.array(z.strictObject({ area: JurisdictionSettingAreaSchema, fact: PackFactRefSchema })),
  /** A hub may be stricter than a mandatory pack rule, never weaker; HUB-005 checks it and records the result here. */
  weakerThanMandatoryPackRule: z.literal(false),
  disclosureLocales: z.array(LocaleTagSchema),
  status: ConfigVersionStatusSchema,
})
  .refine((j) => new Set(j.areas).size === j.areas.length, { message: 'each area once', path: ['areas'] })
  .refine((j) => j.packDefaults.every((d) => j.areas.includes(d.area)), { message: 'pack defaults name areas the version sets', path: ['packDefaults'] })
  .refine((j) => !j.areas.includes('agent_disclosure') || j.disclosureLocales.length > 0, { message: 'disclosure wording exists in at least one language', path: ['disclosureLocales'] });
export type JurisdictionSettingsRef = z.infer<typeof JurisdictionSettingsRefSchema>;
/** Disclosure wording must exist in every hub language before the version can be activated. */
export function disclosureLocalesMissing(ref: Pick<JurisdictionSettingsRef, 'areas' | 'disclosureLocales'>, hub: Pick<Hub, 'locales'>): string[] {
  return ref.areas.includes('agent_disclosure') ? hub.locales.filter((l) => !ref.disclosureLocales.includes(l)) : [];
}

/** What participants configure about their own agent (ADR 010 decision 22, AGT-022); the hub cannot remove an area. */
export const AGENT_SETTING_AREAS = [
  'goals', 'modules', 'behaviour_and_tone', 'action_limits', 'budgets', 'schedules', 'channels', 'approval_rules', 'sharing', 'external_connections',
] as const;
export const AgentSettingAreaSchema = z.enum(AGENT_SETTING_AREAS);
/**
 * Payload of the `agents` configuration domain: hub-wide bounds for every participant's one agent. Participant settings
 * themselves are owner-private (`agent_settings`) and never reach the console; they compile into mandate proposals and
 * never authorize by themselves.
 */
export const HubAgentPolicySchema = z.strictObject({
  hubId: IdSchema,
  version: z.int().min(1),
  participantSettings: z.strictObject({
    areas: z.array(AgentSettingAreaSchema),
    previewShown: z.literal(true),
    explanationShown: z.literal(true),
    settingsAuthorizeByThemselves: z.literal(false),
  }),
  outreachPerPersonPerWeek: z.int().min(0).max(500),
  channels: z.array(z.enum(['platform', 'email', 'sms', 'messenger'])).min(1),
  commitmentsOnlyForVerifiedCompanies: z.literal(true),
  competitorsExchangePrices: z.literal(false),
  externalAgents: z.strictObject({
    defaultPrivateDataClasses: z.array(DataClassSchema).max(0),
    anonymousA2a: z.enum(['off', 'public_read_only']),
  }),
  disclosureFrom: z.literal('jurisdiction_settings'),
})
  .refine((p) => AGENT_SETTING_AREAS.every((a) => p.participantSettings.areas.includes(a)), {
    message: 'participants configure every area of their own agent; a hub cannot remove one',
    path: ['participantSettings'],
  })
  .refine((p) => p.channels.includes('platform'), { message: 'the platform channel is always available', path: ['channels'] });
export type HubAgentPolicy = z.infer<typeof HubAgentPolicySchema>;

export const AgentExtensionStatusSchema = z.enum(['draft', 'tested', 'active', 'suspended', 'retired']);
/** Hostname of an extension endpoint (no scheme, no path), with the country it is served from. */
const EndpointHostSchema = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
/**
 * The console's reference to one version of a governed agent extension (AGT-023 owns the full manifest in
 * `agent-extensions.ts`). Every declared action maps to a mandate kind; the guards are literals because no extension
 * can switch them off; activation needs a passed safety suite on the fake adapter, a second person and a hub
 * configuration version of domain `agent_extensions`.
 */
export const AgentExtensionVersionRefSchema = z.strictObject({
  id: IdSchema,
  extensionId: IdSchema,
  hubId: IdSchema,
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  version: z.int().min(1),
  manifestDigest: DigestSchema,
  declaredActions: z.array(z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/), mandateKind: MandateActionSchema })).min(1).max(50),
  dataClassesRead: z.array(DataClassSchema),
  dataClassesSent: z.array(DataClassSchema),
  endpoints: z.array(z.strictObject({ host: EndpointHostSchema, country: z.string().regex(/^[A-Z]{2}$/) })).max(20),
  adapterId: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  hasFakeAdapter: z.literal(true),
  guards: z.strictObject({
    mandates: z.literal(true), budgets: z.literal(true), approvals: z.literal(true), killSwitches: z.literal(true), egress: z.literal(true),
    privacyRules: z.literal(true), restrictedPlaces: z.literal(true), untrustedTextNeverCommands: z.literal(true),
  }),
  safetySuite: z.strictObject({ runId: IdSchema, onFakeAdapter: z.literal(true), passed: z.boolean(), engineVersion: z.string().min(1).max(40), at: TimestampSchema }).nullable(),
  status: AgentExtensionStatusSchema,
  draftedBy: IdSchema,
  approvedBy: IdSchema.nullable(),
  approvalId: IdSchema.nullable(),
  activatedConfigVersionId: IdSchema.nullable(),
})
  .refine((e) => new Set(e.declaredActions.map((a) => a.key)).size === e.declaredActions.length, { message: 'each declared action once', path: ['declaredActions'] })
  .refine((e) => e.status === 'draft' || e.status === 'retired' || e.status === 'suspended' || e.safetySuite?.passed === true, {
    message: 'tested and active extensions passed their safety suite on the fake adapter',
    path: ['safetySuite'],
  })
  .refine((e) => e.status !== 'active' || (e.approvedBy !== null && e.approvedBy !== e.draftedBy && e.approvalId !== null && e.activatedConfigVersionId !== null), {
    message: 'activation needs a second person and a hub configuration version',
    path: ['approvedBy'],
  })
  .refine((e) => e.dataClassesSent.length === 0 || e.endpoints.length > 0, { message: 'data sent goes to a declared endpoint', path: ['endpoints'] });
export type AgentExtensionVersionRef = z.infer<typeof AgentExtensionVersionRefSchema>;

/* ---------- ADR 010 decisions 20 and 21: no held funds, commissions as hub settings ---------- */

/**
 * Payload of the `payments` configuration domain. Trustwork and the hub operator never hold, pool or move participants'
 * funds: payments, escrow, retainage and payouts go only through licensed payment providers; the engine records
 * instructions, provider references, evidence and reconciliation.
 */
export const HubPaymentSettingsSchema = z.strictObject({
  hubId: IdSchema,
  version: z.int().min(1),
  providers: z.array(z.strictObject({
    connectionId: IdSchema,
    capabilities: z.array(z.enum(['payments', 'payouts'])).min(1),
    licence: z.strictObject({ regulator: ShortTextSchema, licenceRef: z.string().min(1).max(120), country: z.string().regex(/^[A-Z]{2}$/) }).nullable(),
  })).max(10),
  fundsHeldBy: z.literal('licensed_payment_provider'),
  operatorAccountInFundsFlow: z.literal(false),
  escrowAndRetainage: z.enum(['off', 'provider_managed']),
  /** Demo hubs move no money (ADR 012 decision 22); every payment provider of a live hub records its licence. */
  demoNoMoneyMoves: z.boolean(),
})
  .refine((p) => new Set(p.providers.map((x) => x.connectionId)).size === p.providers.length, { message: 'each provider once', path: ['providers'] })
  .refine((p) => p.demoNoMoneyMoves || (p.providers.length > 0 && p.providers.every((x) => x.licence !== null)), {
    message: 'live money moves only through licensed providers whose licence is recorded',
    path: ['providers'],
  })
  .refine((p) => p.escrowAndRetainage === 'off' || p.providers.length > 0, { message: 'escrow and retainage are held by a provider', path: ['escrowAndRetainage'] });
export type HubPaymentSettings = z.infer<typeof HubPaymentSettingsSchema>;

export const MARKETPLACE_FEE_KINDS = ['consultation', 'task', 'ticket', 'course', 'agent_capacity'] as const;
export const MarketplaceFeeKindSchema = z.enum(MARKETPLACE_FEE_KINDS);
/**
 * `marketplace_fee_version`: a commission or fee the hub administrator sets (ADR 010 decision 21). Versioned, activated by
 * a second person under an approval, never back-dated, never overlapping, published on the price page before anyone
 * accepts it. It has no field that could reach ranking, matching, recommendations or reputation.
 */
export const MarketplaceFeeVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: MarketplaceFeeKindSchema,
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).nullable(),
  version: z.int().min(1),
  currency: CurrencySchema,
  basisPoints: z.int().min(0).max(10_000).nullable(),
  fixed: NonNegativeMoneySchema.nullable(),
  payer: z.enum(['buyer', 'seller']),
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  disclosure: z.strictObject({ publicPricePage: z.literal(true), acceptanceTextVersion: z.string().min(1).max(40) }),
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  approvalId: IdSchema.nullable(),
})
  .refine((f) => f.basisPoints !== null || f.fixed !== null, { message: 'a fee is a percentage, a fixed amount or both', path: ['basisPoints'] })
  .refine((f) => f.fixed === null || f.fixed.currency === f.currency, { message: 'fixed fee in the fee currency', path: ['fixed'] })
  .refine((f) => f.categoryKey === null || f.kind === 'consultation' || f.kind === 'task', { message: 'categories exist for consultations and tasks', path: ['categoryKey'] })
  .refine((f) => f.status === 'draft' || f.status === 'cancelled' || (f.activatedBy !== null && f.activatedAt !== null && f.approvalId !== null), {
    message: 'non-draft fee versions record activation under a second-person approval',
    path: ['approvalId'],
  })
  .refine((f) => f.activatedBy === null || f.activatedBy !== f.draftedBy, { message: 'a fee version is activated by someone other than its drafter', path: ['activatedBy'] })
  .refine((f) => f.activatedAt === null || Date.parse(f.effectiveFrom) >= Date.parse(f.activatedAt), { message: 'a fee version is never back-dated', path: ['effectiveFrom'] })
  .refine((f) => f.effectiveTo === null || Date.parse(f.effectiveTo) > Date.parse(f.effectiveFrom), { message: 'a fee version ends after it starts', path: ['effectiveTo'] });
export type MarketplaceFeeVersion = z.infer<typeof MarketplaceFeeVersionSchema>;
export function feeVersionsOverlap(a: MarketplaceFeeVersion, b: MarketplaceFeeVersion): boolean {
  if (a.id === b.id || a.hubId !== b.hubId || a.kind !== b.kind || a.categoryKey !== b.categoryKey || a.payer !== b.payer) return false;
  if (a.status !== 'active' || b.status !== 'active') return false;
  const end = (f: MarketplaceFeeVersion) => (f.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(f.effectiveTo));
  return Date.parse(a.effectiveFrom) < end(b) && Date.parse(b.effectiveFrom) < end(a);
}

/* ---------- Plan to people: planner templates, expert marketplace rules, shared knowledge ---------- */

const KeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);
export const PlanItemKindSchema = z.enum(['task', 'consultation', 'milestone', 'document', 'permit_check']);
/**
 * A project plan template a hub's experts maintain per country and project type. A participant's agent instantiates it
 * into a private project plan; template items become consultation and task requests only after the owner confirms.
 */
export const PlanTemplateVersionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  key: KeySchema,
  version: z.int().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  projectType: KeySchema,
  title: LocalizedNameSchema,
  phases: z.array(z.strictObject({
    key: KeySchema,
    title: LocalizedNameSchema,
    items: z.array(z.strictObject({
      key: KeySchema,
      kind: PlanItemKindSchema,
      title: LocalizedNameSchema,
      categoryKey: KeySchema.nullable(),
      licenceCategory: z.string().min(1).max(80).nullable(),
      typicalDurationDays: z.int().min(0).max(3650).nullable(),
      dependsOn: z.array(KeySchema),
    })).min(1),
  })).min(1),
  references: z.array(z.strictObject({ label: ShortTextSchema, url: z.url() })),
  authors: z.array(IdSchema).min(1),
  reviewedBy: IdSchema.nullable(),
  status: z.enum(['draft', 'in_review', 'published', 'retired']),
})
  .refine((t) => {
    const keys = t.phases.flatMap((p) => p.items.map((i) => i.key));
    return new Set(keys).size === keys.length && t.phases.every((p) => p.items.every((i) => i.dependsOn.every((d) => keys.includes(d) && d !== i.key)));
  }, { message: 'item keys are unique and dependencies point to other items of the template', path: ['phases'] })
  .refine((t) => {
    const deps = new Map(t.phases.flatMap((p) => p.items.map((i) => [i.key, i.dependsOn] as const)));
    const state = new Map<string, 1 | 2>();
    const visit = (k: string): boolean => {
      if (state.get(k) === 2) return true;
      if (state.get(k) === 1) return false;
      state.set(k, 1);
      const ok = (deps.get(k) ?? []).every(visit);
      state.set(k, 2);
      return ok;
    };
    return [...deps.keys()].every(visit);
  }, { message: 'dependencies are acyclic', path: ['phases'] })
  .refine((t) => t.status !== 'published' || (t.reviewedBy !== null && !t.authors.includes(t.reviewedBy)), {
    message: 'a template is published after review by someone who is not its author',
    path: ['reviewedBy'],
  });
export type PlanTemplateVersion = z.infer<typeof PlanTemplateVersionSchema>;

/** Who may offer consultations or tasks in a category, how it is priced and what agents may do there. */
export const MarketplaceCategoryRuleSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  categoryKey: KeySchema,
  kind: z.enum(['consultation', 'task']),
  whoMayOffer: z.enum(['verified_company', 'verified_professional', 'verified_company_or_professional', 'claimed_company_or_professional']),
  verificationRecipeId: IdSchema.nullable(),
  licenceCategory: z.string().min(1).max(80).nullable(),
  /** Commissions are `marketplace_fee_version` rows keyed by this category (BILL-003), not a field of the rule. */
  pricing: z.enum(['fixed', 'hourly', 'quote_based']),
  refunds: z.strictObject({ cancellationWindowHours: z.int().min(0).max(720), disputeWindowDays: z.int().min(1).max(180) }),
  agentAutomation: z.strictObject({ mayDraftRequests: z.boolean(), mayDraftOffers: z.boolean(), mayAcceptWithinMandate: z.boolean(), requestsPerWeek: z.int().min(0).max(500) }),
  version: z.int().min(1),
  status: z.enum(['draft', 'active', 'retired']),
})
  .refine((r) => r.licenceCategory === null || (r.verificationRecipeId !== null && r.whoMayOffer !== 'claimed_company_or_professional'), {
    message: 'licensed categories need verified providers and a verification recipe',
    path: ['verificationRecipeId'],
  })
  .refine((r) => !r.agentAutomation.mayAcceptWithinMandate || r.whoMayOffer !== 'claimed_company_or_professional', {
    message: 'agents may accept only with verified counterparties',
    path: ['agentAutomation'],
  });
export type MarketplaceCategoryRule = z.infer<typeof MarketplaceCategoryRuleSchema>;

/**
 * A completed project turned into shared knowledge (diary, template, Q&A, lesson). Published only with the consent of
 * the owner party and every named participant, after review, with private fields (budgets, prices, private files) removed.
 */
export const KnowledgeShareSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: z.enum(['project_diary', 'plan_template', 'qa', 'lesson']),
  projectId: IdSchema,
  ownerParty: PartySchema,
  namedParties: z.array(PartySchema),
  consents: z.array(z.strictObject({ party: PartySchema, givenBy: IdSchema, at: TimestampSchema, scope: z.enum(['anonymised', 'named']), withdrawnAt: TimestampSchema.nullable() })),
  privateFieldsExcluded: z.literal(true),
  status: z.enum(['proposed', 'consent_pending', 'in_review', 'published', 'withdrawn']),
  reviewedBy: IdSchema.nullable(),
  publicationId: IdSchema.nullable(),
}).refine((k) => {
  if (k.status !== 'published') return true;
  const consented = (p: z.infer<typeof PartySchema>) => k.consents.some((c) => c.withdrawnAt === null && c.party.kind === p.kind && c.party.id === p.id);
  return k.reviewedBy !== null && k.publicationId !== null && consented(k.ownerParty) && k.namedParties.every(consented);
}, { message: 'published only after review and with the consent of the owner and every named party', path: ['consents'] });
export type KnowledgeShare = z.infer<typeof KnowledgeShareSchema>;

/* ---------- Manufacturer knowledge and plan-step recommendations (ADR 010 decision 19) ---------- */

export const SourcedContentTypeSchema = z.enum(['company_profile', 'catalogue_item', 'training', 'guide', 'technical_article', 'event', 'ignore']);
/**
 * How pages of one manufacturer or supplier source map to content types. Matching is by path prefix and, where the
 * site publishes it, schema.org type; anything unmatched is ignored. Mapped items arrive as sourced and labelled.
 */
export const ContentTypeMappingSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  sourceId: IdSchema,
  version: z.int().min(1),
  rules: z.array(z.strictObject({
    pathPrefix: z.string().regex(/^\/[A-Za-z0-9._~%/-]{0,200}$/),
    schemaOrgType: z.string().regex(/^[A-Z][A-Za-z]{1,60}$/).nullable(),
    contentType: SourcedContentTypeSchema,
    categoryKey: KeySchema.nullable(),
  })).min(1).max(50),
  status: z.enum(['draft', 'active', 'superseded']),
});
export type ContentTypeMapping = z.infer<typeof ContentTypeMappingSchema>;

/** Signals a recommendation may use. Payment, sponsorship and plan tier are absent by construction. */
export const RecommendationSignalSchema = z.enum(['category_match', 'plan_step_match', 'region_served', 'licence_valid', 'language_match', 'freshness', 'verified_status', 'reputation_with_samples', 'availability']);
export const RecommendationKindSchema = z.enum(['material', 'article_or_guide', 'training', 'event', 'consultant', 'contractor', 'contact']);
/** For one plan-step category: what to recommend, from which signals, how many, always with an explanation. */
export const RecommendationRuleSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  version: z.int().min(1),
  planCategoryKey: KeySchema,
  planItemKinds: z.array(PlanItemKindSchema).min(1),
  recommends: z.array(z.strictObject({ kind: RecommendationKindSchema, maxItems: z.int().min(1).max(10), includeSourced: z.boolean() })).min(1),
  signals: z.array(RecommendationSignalSchema).min(1),
  explanationShown: z.literal(true),
  status: z.enum(['draft', 'active', 'superseded']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
})
  .refine((r) => new Set(r.recommends.map((x) => x.kind)).size === r.recommends.length, { message: 'each kind once', path: ['recommends'] })
  .refine((r) => !r.recommends.some((x) => ['consultant', 'contractor'].includes(x.kind)) || r.signals.includes('region_served'), {
    message: 'people and firms are recommended only where they serve the region',
    path: ['signals'],
  })
  .refine((r) => r.status === 'draft' || r.activatedBy !== null, { message: 'activation recorded', path: ['activatedBy'] });
export type RecommendationRule = z.infer<typeof RecommendationRuleSchema>;

/** Sponsored content, if a hub allows it at all: labelled, in its own slot, never in ranked results, never a signal. */
export const SponsoredContentPolicySchema = z.strictObject({
  hubId: IdSchema,
  version: z.int().min(1),
  allowed: z.boolean(),
  readerLabel: z.literal(true),
  separateSlotOnly: z.literal(true),
  affectsRankingOrMatching: z.literal(false),
  requireVerifiedSponsor: z.boolean(),
  maxSlotsPerPage: z.int().min(0).max(3),
  neverIn: z.array(z.enum(['search_results', 'matching_results', 'plan_recommendations', 'reputation', 'directory_order', 'magazine_editorial'])),
}).refine((p) => (['search_results', 'matching_results', 'plan_recommendations', 'reputation', 'directory_order'] as const).every((x) => p.neverIn.includes(x)), {
  message: 'sponsored content never enters search, matching, plan recommendations, reputation or directory order',
  path: ['neverIn'],
}).refine((p) => p.allowed || p.maxSlotsPerPage === 0, { message: 'no slots when not allowed', path: ['maxSlotsPerPage'] });
export type SponsoredContentPolicy = z.infer<typeof SponsoredContentPolicySchema>;
/** Sponsored content is off by default in every hub (ADR 012 decision 3); turning it on is `sponsored.enable` (second person). */
export function defaultSponsoredContentPolicy(hubId: string): SponsoredContentPolicy {
  return SponsoredContentPolicySchema.parse({
    hubId, version: 1, allowed: false, readerLabel: true, separateSlotOnly: true, affectsRankingOrMatching: false, requireVerifiedSponsor: true, maxSlotsPerPage: 0,
    neverIn: ['search_results', 'matching_results', 'plan_recommendations', 'reputation', 'directory_order', 'magazine_editorial'],
  });
}

/* ---------- Reputation building: credential types and hub-issued verifiable credentials ---------- */

/**
 * What a hub can verify about a participant and how. A credential states a checked fact (a licence, insurance, an
 * identity, a confirmed completed work, a course taught); it is never a score and never bought.
 */
export const CredentialTypeSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  key: KeySchema,
  version: z.int().min(1),
  subject: z.enum(['person', 'company']),
  claim: z.enum(['identity', 'licence', 'insurance', 'qualification', 'certificate', 'membership', 'completed_work', 'counterparty_confirmation', 'knowledge_contribution']),
  title: LocalizedNameSchema,
  verificationRecipeId: IdSchema.nullable(),
  validityDays: z.int().min(1).max(3650).nullable(),
  recheckOnSourceChange: z.boolean(),
  portable: z.boolean(),
  status: z.enum(['draft', 'active', 'retired']),
}).refine((t) => ['counterparty_confirmation', 'knowledge_contribution'].includes(t.claim) || t.verificationRecipeId !== null, {
  message: 'checked claims name the verification recipe that checks them',
  path: ['verificationRecipeId'],
});
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

/**
 * The hub's record of a verifiable credential it issued (W3C VC data model, signed with a key from the node identity).
 * Only references and digests are stored here; the holder keeps and presents the credential. Revocation is a status
 * entry with a reason category, published in the hub's status list; nothing is deleted.
 */
export const IssuedCredentialSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  credentialTypeId: IdSchema,
  holder: PartySchema,
  evidenceRefs: z.array(IdSchema).min(1),
  decidedBy: IdSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  signingKeyId: z.string().min(1).max(200),
  credentialDigest: DigestSchema,
  statusListIndex: z.int().min(0),
  status: z.enum(['valid', 'expired', 'suspended', 'revoked']),
  revocation: z.strictObject({
    reason: z.enum(['evidence_withdrawn', 'evidence_expired', 'fraud', 'source_changed', 'holder_request', 'legal_order']),
    decidedBy: IdSchema,
    at: TimestampSchema,
  }).nullable(),
})
  .refine((c) => c.expiresAt === null || Date.parse(c.expiresAt) > Date.parse(c.issuedAt), { message: 'expiry after issue', path: ['expiresAt'] })
  .refine((c) => (c.status === 'revoked') === (c.revocation !== null), { message: 'revoked credentials carry a revocation record, and only they do', path: ['revocation'] });
export type IssuedCredential = z.infer<typeof IssuedCredentialSchema>;

/** Abuse controls for confirmation requests ("confirm that I delivered this"): only real counterparties, bounded volume. */
export const ConfirmationPolicySchema = z.strictObject({
  hubId: IdSchema,
  version: z.int().min(1),
  requireTransactionOrProjectLink: z.literal(true),
  maxOpenRequestsPerRequester: z.int().min(1).max(200),
  maxRequestsPerCounterpartyPerMonth: z.int().min(1).max(20),
  declineCooldownDays: z.int().min(0).max(365),
  reciprocalConfirmationsFlagged: z.boolean(),
  agentsMayRequest: z.boolean(),
  agentsMayConfirm: z.literal(false),
});
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;

/* ---------- Setup wizard ---------- */

export const SETUP_STEPS = ['install_check', 'node_identity', 'hub_identity', 'operator', 'first_admin', 'storage_residency', 'providers', 'modes', 'review'] as const;
export const SetupStepSchema = z.enum(SETUP_STEPS);
export const SetupStateSchema = z.strictObject({
  nodeId: IdSchema,
  completed: z.array(SetupStepSchema),
  current: SetupStepSchema,
  /** The one-time setup token is printed by the installer; only its hash and expiry are stored. */
  setupTokenHash: Sha256HexSchema,
  setupTokenExpiresAt: TimestampSchema,
  firstAdmin: z.strictObject({ personId: IdSchema, secondFactor: z.enum(['totp', 'webauthn']), recoveryCodesIssuedAt: TimestampSchema }).nullable(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
})
  .refine((s) => new Set(s.completed).size === s.completed.length, { message: 'duplicate step', path: ['completed'] })
  .refine((s) => s.finishedAt === null || SETUP_STEPS.every((step) => s.completed.includes(step)), { message: 'setup finishes only after every step', path: ['finishedAt'] })
  .refine((s) => !s.completed.includes('first_admin') || s.firstAdmin !== null, { message: 'the first admin has a second factor', path: ['firstAdmin'] });
export type SetupState = z.infer<typeof SetupStateSchema>;
/** Steps must be completed in order; a later step cannot be reached before an earlier one is done. */
export function nextSetupStep(state: Pick<SetupState, 'completed'>): (typeof SETUP_STEPS)[number] | null {
  return SETUP_STEPS.find((step) => !state.completed.includes(step)) ?? null;
}

/* ---------- Support: account servicing without impersonation ---------- */

/**
 * The diagnostic account card support staff see without a case grant. It is an allowlist: no message bodies, no
 * private objects, no budgets, no exact e-mail (masked), no session tokens or IPs, no behaviour timeline.
 */
export const SupportAccountSummarySchema = z.strictObject({
  personId: IdSchema,
  displayName: NameSchema,
  maskedEmail: z.string().regex(/^[^@\s]{1,3}\*+@[^@\s]+$/),
  emailVerified: z.boolean(),
  accountState: z.enum(['active', 'locked', 'pending_verification', 'suspended', 'deletion_requested', 'erased']),
  secondFactor: z.strictObject({ enrolled: z.boolean(), methods: z.int().min(0).max(10) }),
  activeSessions: z.int().min(0),
  recovery: z.enum(['none', 'requested', 'held_for_review', 'cooling_off']),
  employer: z.strictObject({ companyId: IdSchema, companyName: NameSchema, role: z.string().min(1).max(40) }).nullable(),
  entitlements: z.array(z.strictObject({ offerCode: z.string().min(1).max(60), validUntil: TimestampSchema.nullable() })),
  openCases: z.int().min(0),
  consents: z.array(z.strictObject({ kind: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), version: z.string().min(1).max(40), state: z.enum(['given', 'withdrawn']), at: TimestampSchema })),
});
export type SupportAccountSummary = z.infer<typeof SupportAccountSummarySchema>;
export const ACCOUNT_SERVICE_ACTIONS = [
  'resend_verification', 'unlock_after_lockout', 'revoke_all_sessions', 'require_password_reset', 'rebind_recovery_email', 'reset_second_factor',
  'start_data_export', 'open_deletion_request', 'send_guided_task',
] as const;
/** Actions that change how someone signs in wait out a cooling-off period and are announced on every verified channel. */
export const COOLING_OFF_ACTIONS: readonly (typeof ACCOUNT_SERVICE_ACTIONS)[number][] = ['rebind_recovery_email', 'reset_second_factor'];
export const AccountServiceActionSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  supportCaseId: IdSchema,
  subjectPersonId: IdSchema,
  action: z.enum(ACCOUNT_SERVICE_ACTIONS),
  requestedBy: IdSchema,
  approvedBy: IdSchema.nullable(),
  evidenceRefs: z.array(IdSchema),
  requestedAt: TimestampSchema,
  effectiveAt: TimestampSchema,
  subjectNotified: z.literal(true),
  state: z.enum(['pending', 'cooling_off', 'done', 'cancelled']),
})
  .refine((a) => !COOLING_OFF_ACTIONS.includes(a.action) || (a.approvedBy !== null && a.approvedBy !== a.requestedBy && a.evidenceRefs.length > 0), {
    message: 'changing sign-in factors needs evidence and a second person',
    path: ['approvedBy'],
  })
  .refine((a) => !COOLING_OFF_ACTIONS.includes(a.action) || Date.parse(a.effectiveAt) - Date.parse(a.requestedAt) >= 72 * 3_600_000, {
    message: 'sign-in factor changes take effect after at least 72 hours',
    path: ['effectiveAt'],
  })
  .refine((a) => a.subjectPersonId !== a.requestedBy, { message: 'staff never service their own account', path: ['requestedBy'] });
export type AccountServiceAction = z.infer<typeof AccountServiceActionSchema>;

/* ---------- Operations: backups and restore drills ---------- */

export const BackupRecordSchema = z.strictObject({
  id: IdSchema,
  nodeId: IdSchema,
  kind: z.enum(['database_full', 'database_wal', 'object_store', 'tombstone_ledger', 'config_export']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  sizeBytes: z.int().min(0).nullable(),
  encrypted: z.literal(true),
  offHost: z.boolean(),
  manifestDigest: Sha256HexSchema.nullable(),
  state: z.enum(['running', 'completed', 'failed', 'expired']),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;
export const RestoreDrillSchema = z.strictObject({
  id: IdSchema,
  nodeId: IdSchema,
  backupIds: z.array(IdSchema).min(1),
  isolatedEnvironment: z.literal(true),
  externalAdaptersDisabled: z.literal(true),
  checks: z.strictObject({
    schemaChecksums: z.boolean(), digestsVerified: z.boolean(), tombstonesReplayed: z.boolean(), objectsRestored: z.boolean(), permissionsVerified: z.boolean(),
  }),
  measuredRecoveryMinutes: z.int().min(0).nullable(),
  dataLossWindowMinutes: z.int().min(0).nullable(),
  performedBy: IdSchema,
  witnessedBy: IdSchema.nullable(),
  performedAt: TimestampSchema,
  outcome: z.enum(['passed', 'failed']),
}).refine((d) => d.outcome === 'failed' || Object.values(d.checks).every(Boolean), { message: 'a passed drill passed every check', path: ['checks'] });
export type RestoreDrill = z.infer<typeof RestoreDrillSchema>;

/* ---------- Restricted places: one check over everything the console configures ---------- */

/**
 * Codes the console must refuse: hub territories, jurisdiction settings, provider hosting and extension endpoints in a
 * restricted place (ADR 009). Empty means nothing restricted; the predicate is `isRestricted` from country-packs.
 */
export function restrictedPlaceViolations(
  input: {
    territories?: readonly HubTerritory[];
    jurisdictions?: readonly JurisdictionCode[];
    connections?: readonly Pick<ProviderConnection, 'id' | 'hosting'>[];
    extensions?: readonly Pick<AgentExtensionVersionRef, 'id' | 'endpoints'>[];
    paymentLicences?: readonly { connectionId: string; country: string }[];
  },
  isRestricted: RestrictedPredicate,
): string[] {
  const out: string[] = [];
  for (const t of input.territories ?? []) if (territoryRestricted(t, isRestricted)) out.push(`territory:${t.code}`);
  for (const j of input.jurisdictions ?? []) if (jurisdictionRestricted(j, isRestricted)) out.push(`jurisdiction:${j}`);
  for (const c of input.connections ?? []) if (isRestricted(c.hosting.country)) out.push(`connection:${c.id}`);
  for (const e of input.extensions ?? []) for (const ep of e.endpoints) if (isRestricted(ep.country)) out.push(`extension:${e.id}:${ep.host}`);
  for (const l of input.paymentLicences ?? []) if (isRestricted(l.country)) out.push(`payment_provider:${l.connectionId}`);
  return out;
}

/* ---------- Console commands and results (strict, versioned) ---------- */

/** Versioned records the console activates; every one is immutable once active and superseded by a new version. */
export const CONSOLE_VERSIONED_RECORDS = [
  'hub_config_version', 'model_route', 'egress_rule', 'pipeline_version', 'dataset', 'agent_module_version', 'agent_extension_version',
  'metered_price_version', 'agent_plan_version', 'marketplace_fee_version', 'plan_template_version', 'marketplace_category_rule',
  'recommendation_rule', 'sponsored_content_policy', 'content_type_mapping', 'credential_type', 'confirmation_policy',
] as const;
export const ConsoleVersionedRecordSchema = z.enum(CONSOLE_VERSIONED_RECORDS);
/** Activate one drafted version. The server decides whether the record needs a second person; if so `approvalId` is required. */
export const ActivateVersionCommandSchema = consoleCommand({
  target: z.strictObject({ record: ConsoleVersionedRecordSchema, id: IdSchema }),
  expectedRevision: RevisionSchema,
  approvalId: IdSchema.nullable(),
  effectiveFrom: TimestampSchema,
});
export type ActivateVersionCommand = z.infer<typeof ActivateVersionCommandSchema>;
/** Ask a second person: the request carries the exact action digest the approver will see and bind. */
export const RequestSecondPersonApprovalCommandSchema = consoleCommand({
  action: ConsoleSecondPersonActionSchema,
  scope: StaffScopeSchema,
  actionDigest: DigestSchema,
});
/** The approver restates the digest they reviewed; a mismatch is refused (`access.approval_digest_mismatch`). */
export const DecideSecondPersonApprovalCommandSchema = consoleCommand({
  approvalRequestId: IdSchema,
  decision: z.enum(['approve', 'decline']),
  actionDigest: DigestSchema,
});
export const RequestLifecycleTransitionCommandSchema = consoleCommand({ hubId: IdSchema, to: HubLifecycleSchema, expectedRevision: RevisionSchema });
/** Engaging a kill switch is immediate and needs one person. */
export const EngageKillSwitchCommandSchema = consoleCommand({ scope: KillSwitchScopeSchema });
/** Releasing needs a second-person approval and an incident note. */
export const ReleaseKillSwitchCommandSchema = consoleCommand({ killSwitchId: IdSchema, approvalId: IdSchema, incidentNote: ShortTextSchema, expectedRevision: RevisionSchema });
/** A connection test sends only engine-supplied synthetic input; the command has no field for customer data. */
export const RunConnectionTestCommandSchema = consoleCommand({ connectionId: IdSchema, syntheticInputOnly: z.literal(true) });
/** A schedule-independent run; a dry run commits nothing. */
export const StartPipelineRunCommandSchema = consoleCommand({ pipelineVersionId: IdSchema, trigger: z.enum(['manual', 'dry_run', 'backfill']), backfillFrom: TimestampSchema.nullable() })
  .refine((c) => (c.trigger === 'backfill') === (c.backfillFrom !== null), { message: 'a backfill names its start, and only a backfill does', path: ['backfillFrom'] });

/** Every console command answers with this envelope (errors use `ErrorEnvelopeSchema`). Acceptance never claims an external effect. */
export const ConsoleCommandResultSchema = z.strictObject({
  contractVersion: HubConsoleContractVersionSchema,
  outcome: z.enum(['applied', 'pending_second_person', 'queued']),
  objectId: IdSchema,
  revision: RevisionSchema,
  approvalRequestId: IdSchema.nullable(),
  auditEventId: IdSchema,
}).refine((r) => (r.outcome === 'pending_second_person') === (r.approvalRequestId !== null), {
  message: 'a pending result names the approval request, and only it does',
  path: ['approvalRequestId'],
});
export type ConsoleCommandResult = z.infer<typeof ConsoleCommandResultSchema>;

/* ---------- JSON Schema for the console contracts ---------- */

/** Every console read model, payload, command and result, by name. `hubConsoleJsonSchemas()` renders them. */
export const HUB_CONSOLE_SCHEMAS = {
  Hub: HubSchema, HubTerritory: HubTerritorySchema, LaunchGate: LaunchGateSchema, HubModes: HubModesSchema,
  StaffScope: StaffScopeSchema, ScopedStaffRoleDefinition: ScopedStaffRoleDefinitionSchema, ScopedStaffRoleAssignment: ScopedStaffRoleAssignmentSchema,
  ConsoleSecondPersonApproval: ConsoleSecondPersonApprovalSchema, ConsoleAuditEvent: ConsoleAuditEventSchema, HubConfigVersion: HubConfigVersionSchema,
  SecretRef: SecretRefSchema, SecretSubmitCommand: SecretSubmitCommandSchema, SecretSubmitResult: SecretSubmitResultSchema,
  ConnectionTestResult: ConnectionTestResultSchema, ProviderConnection: ProviderConnectionSchema, ModelPricing: ModelPricingSchema, ModelRoute: ModelRouteSchema,
  EgressRule: EgressRuleSchema, ProviderBudget: ProviderBudgetSchema, UsageAggregate: UsageAggregateSchema, KillSwitch: KillSwitchSchema,
  HubSource: HubSourceSchema, Dataset: DatasetSchema, LinkProposal: LinkProposalSchema, Schedule: ScheduleSchema, PipelineVersion: PipelineVersionSchema,
  PipelineRun: PipelineRunSchema, EditorialItem: EditorialItemSchema,
  AgentModuleVersion: AgentModuleVersionSchema, MeteredPriceVersion: MeteredPriceVersionSchema, AgentPlanVersion: AgentPlanVersionSchema,
  ExternalAgentClient: ExternalAgentClientSchema, AgentUsageStat: AgentUsageStatSchema,
  JurisdictionSettingsRef: JurisdictionSettingsRefSchema, HubAgentPolicy: HubAgentPolicySchema, AgentExtensionVersionRef: AgentExtensionVersionRefSchema,
  HubPaymentSettings: HubPaymentSettingsSchema, MarketplaceFeeVersion: MarketplaceFeeVersionSchema,
  PlanTemplateVersion: PlanTemplateVersionSchema, MarketplaceCategoryRule: MarketplaceCategoryRuleSchema, KnowledgeShare: KnowledgeShareSchema,
  ContentTypeMapping: ContentTypeMappingSchema, RecommendationRule: RecommendationRuleSchema, SponsoredContentPolicy: SponsoredContentPolicySchema,
  CredentialType: CredentialTypeSchema, IssuedCredential: IssuedCredentialSchema, ConfirmationPolicy: ConfirmationPolicySchema,
  SetupState: SetupStateSchema, SupportAccountSummary: SupportAccountSummarySchema, AccountServiceAction: AccountServiceActionSchema,
  BackupRecord: BackupRecordSchema, RestoreDrill: RestoreDrillSchema,
  ActivateVersionCommand: ActivateVersionCommandSchema, RequestSecondPersonApprovalCommand: RequestSecondPersonApprovalCommandSchema,
  DecideSecondPersonApprovalCommand: DecideSecondPersonApprovalCommandSchema, RequestLifecycleTransitionCommand: RequestLifecycleTransitionCommandSchema,
  EngageKillSwitchCommand: EngageKillSwitchCommandSchema, ReleaseKillSwitchCommand: ReleaseKillSwitchCommandSchema,
  RunConnectionTestCommand: RunConnectionTestCommandSchema, StartPipelineRunCommand: StartPipelineRunCommandSchema, ConsoleCommandResult: ConsoleCommandResultSchema,
} as const;
export type HubConsoleSchemaName = keyof typeof HUB_CONSOLE_SCHEMAS;
/** JSON Schema (draft 2020-12) generated from the Zod source; refinements stay in Zod and are enforced server-side. */
export function hubConsoleJsonSchemas(): Record<HubConsoleSchemaName, Record<string, unknown>> {
  const out = {} as Record<HubConsoleSchemaName, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(HUB_CONSOLE_SCHEMAS) as [HubConsoleSchemaName, z.ZodType][]) {
    out[name] = {
      ...(z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>),
      $id: `urn:trustwork:hub-console:${HUB_CONSOLE_CONTRACT_VERSION}:${name}`,
    };
  }
  return out;
}
