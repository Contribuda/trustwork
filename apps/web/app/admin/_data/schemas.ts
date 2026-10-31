import { z } from 'zod';
import {
  ConsoleSecondPersonActionSchema,
  ConsoleSecondPersonApprovalSchema,
  DigestSchema,
  HubConfigVersionSchema,
  HubSchema,
  HubModesSchema,
  IdSchema,
  KillSwitchSchema,
  LaunchGateSchema,
  LocaleTagSchema,
  LocalizedNameSchema,
  NameSchema,
  NonNegativeMinorUnitsSchema,
  ProviderBudgetSchema,
  ProviderCapabilitySchema,
  ProviderModeSchema,
  ScopedStaffRoleAssignmentSchema,
  ScopedStaffRoleDefinitionSchema,
  SetupStateSchema,
  ShortTextSchema,
  SodModeSchema,
  StaffScopeSchema,
  TimestampSchema,
  SETUP_STEPS,
} from '@trustwork/contracts/client';

/**
 * Console read models (ADM-002). Every record the console renders is either a frozen contract schema from
 * `packages/contracts/src/hub.ts` (console contract 1.0.0) or one of the view models below, which are composed only
 * of contract schemas and primitives. View models exist where the frozen contract has no read model yet (pending
 * approval requests, overview queue counts, legal documents, residency services, taxonomy trees); the backend
 * packages (ADM-001, HUB-001, HUB-004, HUBC-007) either serve these shapes or propose them as additive contract
 * changes (minor version). Fixtures are parsed with these schemas at module load and in
 * `tests/web/admin/shell/console-fixtures.test.ts`, so a fixture that violates an invariant fails the build.
 */

const Synthetic = { synthetic: z.literal(true) } as const;

/** A synthetic person shown in the console (staff, requesters). Names are invented; e-mail domains are `example.invalid`. */
export const ConsolePersonSchema = z.strictObject({ id: IdSchema, displayName: NameSchema, nameLang: LocaleTagSchema, ...Synthetic });
export type ConsolePerson = z.infer<typeof ConsolePersonSchema>;

/** The node that hosts the hubs (one installation). */
export const ConsoleNodeSchema = z.strictObject({ id: IdSchema, name: NameSchema, domain: z.string().regex(/^[a-z0-9.-]+\.invalid$/), engineVersion: z.string().min(1).max(40), ...Synthetic });
export type ConsoleNode = z.infer<typeof ConsoleNodeSchema>;

export const BudgetUseSchema = z.strictObject({ budget: ProviderBudgetSchema, spentMinorUnits: NonNegativeMinorUnitsSchema });
export type BudgetUse = z.infer<typeof BudgetUseSchema>;

/** Which worked example a fixture hub is (docs/engine/hub-console/README.md). */
export const HubExampleSchema = z.enum(['us_reference', 'samarkand_example']);

/** One hub as the console loads it: the contract `Hub`, its modes, gates, configuration versions, caps and switches. */
export const HubRecordSchema = z.strictObject({
  hub: HubSchema,
  modes: HubModesSchema,
  example: HubExampleSchema,
  domain: z.string().regex(/^[a-z0-9.-]+\.invalid$/),
  sodMode: SodModeSchema,
  gates: z.array(LaunchGateSchema),
  configVersions: z.array(HubConfigVersionSchema),
  budgets: z.array(BudgetUseSchema),
  killSwitches: z.array(KillSwitchSchema),
  updatedAt: TimestampSchema,
  ...Synthetic,
}).refine((r) => r.gates.every((g) => g.hubId === r.hub.id) && r.configVersions.every((c) => c.hubId === r.hub.id) && r.budgets.every((b) => b.budget.hubId === r.hub.id), {
  message: 'gates, versions and budgets belong to the hub',
  path: ['hub'],
});
export type HubRecord = z.infer<typeof HubRecordSchema>;

/** Staff fixtures: people, role definitions over the merged vocabulary, scoped assignments. */
export const StaffFixtureSchema = z.strictObject({
  people: z.array(ConsolePersonSchema),
  definitions: z.array(ScopedStaffRoleDefinitionSchema),
  assignments: z.array(ScopedStaffRoleAssignmentSchema),
  ...Synthetic,
}).refine((s) => new Set(s.definitions.map((d) => d.role)).size === s.definitions.length, { message: 'one definition per role', path: ['definitions'] })
  .refine((s) => s.assignments.every((a) => s.definitions.some((d) => d.role === a.role && d.version === a.definitionVersion && d.scopes.includes(a.scope.kind))), {
    message: 'every assignment points at a released definition that allows its scope',
    path: ['assignments'],
  });
export type StaffFixture = z.infer<typeof StaffFixtureSchema>;

/* ---------- Overview ---------- */

export const QUEUE_IDS = ['claims', 'review_items', 'link_proposals', 'reports', 'support_cases', 'grant_requests', 'privacy_requests', 'unknown_outcomes', 'alerts'] as const;
export const QueueIdSchema = z.enum(QUEUE_IDS);
export type QueueId = z.infer<typeof QueueIdSchema>;
export const HEALTH_CHECKS = ['readiness', 'outbox_age', 'dead_letters', 'unknown_outcomes', 'backup_age'] as const;

export const OverviewSchema = z.strictObject({
  hubId: IdSchema,
  queues: z.array(z.strictObject({ id: QueueIdSchema, count: z.int().min(0), nearestDeadline: TimestampSchema.nullable() })),
  compliance: z.strictObject({
    legalDocumentsDue: z.int().min(0),
    screeningListAgeDays: z.int().min(0).nullable(),
    expiringSourceLicences: z.int().min(0),
    fakeProviders: z.array(ProviderCapabilitySchema),
  }),
  /** Health values: minutes for ages, counts otherwise; null when nothing measured it yet (never a guess). */
  health: z.array(z.strictObject({ id: z.enum(HEALTH_CHECKS), state: z.enum(['ok', 'warning', 'failing', 'unknown']), value: z.int().min(0).nullable() })),
  updatedAt: TimestampSchema,
  ...Synthetic,
}).refine((o) => new Set(o.queues.map((q) => q.id)).size === o.queues.length, { message: 'each queue once', path: ['queues'] });
export type Overview = z.infer<typeof OverviewSchema>;

/* ---------- Approvals ---------- */

/** A changed value: a locale key under `admin.values` (enum-like), staff-entered text with its language, or nothing. */
export const ChangeValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('key'), key: z.string().regex(/^[a-z][a-zA-Z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)*$/) }),
  z.strictObject({ kind: z.literal('text'), value: ShortTextSchema, lang: LocaleTagSchema }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type ChangeValue = z.infer<typeof ChangeValueSchema>;

/**
 * A pending second-person request (the frozen contract has the request command and the decided approval, not the
 * request read model). `currentDigest` is the digest of the action as it stands now: when it differs from
 * `actionDigest` the request is void ("The action changed; a new request is required").
 */
export const ApprovalRequestSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  action: ConsoleSecondPersonActionSchema,
  scope: StaffScopeSchema,
  actionDigest: DigestSchema,
  currentDigest: DigestSchema,
  requestedBy: IdSchema,
  reason: z.strictObject({ value: ShortTextSchema, lang: LocaleTagSchema }),
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  changes: z.array(z.strictObject({ field: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/), before: ChangeValueSchema, after: ChangeValueSchema })).min(1),
  state: z.enum(['pending', 'withdrawn']),
  ...Synthetic,
}).refine((r) => Date.parse(r.expiresAt) > Date.parse(r.requestedAt), { message: 'a request expires after it was made', path: ['expiresAt'] });
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** A decided request: an approval is the frozen contract record; a decline records who and why. */
export const ApprovalDecisionSchema = z.strictObject({
  requestId: IdSchema,
  hubId: IdSchema,
  action: ConsoleSecondPersonActionSchema,
  requestedBy: IdSchema,
  decision: z.enum(['approve', 'decline']),
  decidedBy: IdSchema,
  decidedAt: TimestampSchema,
  approval: ConsoleSecondPersonApprovalSchema.nullable(),
  ...Synthetic,
}).refine((d) => (d.decision === 'approve') === (d.approval !== null), { message: 'only an approval carries the approval record', path: ['approval'] })
  .refine((d) => d.decidedBy !== d.requestedBy, { message: 'nobody decides their own request', path: ['decidedBy'] })
  .refine((d) => d.approval === null || (d.approval.requestedBy === d.requestedBy && d.approval.approvedBy === d.decidedBy && d.approval.action === d.action), {
    message: 'the approval record matches the decision',
    path: ['approval'],
  });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/* ---------- Hub settings ---------- */

/** Brand overlay contrast per hub language (gate `brand_accessibility_checked`). Ratio as text, for example `7.1`. */
export const BrandCheckSchema = z.strictObject({ locale: LocaleTagSchema, ratio: z.string().regex(/^\d{1,2}(\.\d)?$/), passes: z.boolean(), ...Synthetic });

export const OperatorSchema = z.strictObject({
  hubId: IdSchema,
  legalName: NameSchema,
  form: z.enum(['llc', 'corporation', 'nonprofit_association', 'sole_proprietor', 'limited_company']),
  /** Placeholder identifiers only (`00-0000000` style): a fixture never carries a real registration number. */
  identifier: z.strictObject({ kind: z.string().regex(/^[A-Z]{2}-[A-Z0-9]+$/), value: z.string().regex(/^0+[-0]*$/) }),
  address: ShortTextSchema,
  legalContact: z.email().regex(/@[a-z0-9.-]+\.invalid$/),
  abuseContact: z.email().regex(/@[a-z0-9.-]+\.invalid$/),
  screening: z.strictObject({ mode: ProviderModeSchema, result: z.enum(['not_run', 'no_match', 'potential_match']), at: TimestampSchema.nullable() }),
  ...Synthetic,
});
export type Operator = z.infer<typeof OperatorSchema>;

export const LEGAL_DOCUMENT_KINDS = ['terms', 'privacy_notice', 'community_rules', 'imprint', 'cookie_policy'] as const;
export const LegalDocumentSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: z.enum(LEGAL_DOCUMENT_KINDS),
  version: z.int().min(1),
  status: z.enum(['draft', 'counsel_approved', 'active', 'superseded']),
  locales: z.array(LocaleTagSchema).min(1),
  counselApproval: z.strictObject({ by: NameSchema, firm: NameSchema, at: TimestampSchema, scope: ShortTextSchema }).nullable(),
  effectiveFrom: TimestampSchema.nullable(),
  ...Synthetic,
}).refine((d) => d.status === 'draft' || d.counselApproval !== null, { message: 'beyond draft a document records counsel approval', path: ['counselApproval'] })
  .refine((d) => (d.status === 'active' || d.status === 'superseded') === (d.effectiveFrom !== null), { message: 'only activated documents have an effective date', path: ['effectiveFrom'] });
export type LegalDocument = z.infer<typeof LegalDocumentSchema>;

export const ResidencySchema = z.strictObject({
  hubId: IdSchema,
  country: z.string().regex(/^[A-Z]{2}$/),
  regime: z.enum(['us_state_privacy', 'uz_personal_data', 'not_recorded']),
  version: z.int().min(1),
  services: z.array(z.strictObject({ service: z.enum(['database', 'object_storage', 'backups', 'worker', 'email_relay']), region: z.string().min(1).max(60), country: z.string().regex(/^[A-Z]{2}$/) })),
  subProcessors: z.array(z.strictObject({ name: NameSchema, capability: ProviderCapabilitySchema, mode: ProviderModeSchema, country: z.string().regex(/^[A-Z]{2}$/), privateData: z.boolean() })),
  ...Synthetic,
});
export type Residency = z.infer<typeof ResidencySchema>;

export const LocalAdditionSchema = z.strictObject({
  kind: z.enum(['identifier', 'register', 'licence_category', 'holiday', 'tax_fact', 'unit']),
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,60}$/),
  label: LocalizedNameSchema,
  verification: z.enum(['candidate', 'confirmed']),
  source: z.url().nullable(),
  ...Synthetic,
});
export type LocalAddition = z.infer<typeof LocalAdditionSchema>;

export const TAXONOMY_KINDS = ['topics', 'categories', 'plan_steps', 'units'] as const;
export const TaxonomyTreeSchema = z.strictObject({
  hubId: IdSchema,
  kind: z.enum(TAXONOMY_KINDS),
  version: z.int().min(1),
  releasedAt: TimestampSchema.nullable(),
  terms: z.array(z.strictObject({ key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,60}$/), parent: z.string().nullable(), label: LocalizedNameSchema, usage: z.int().min(0), deprecated: z.boolean() })),
  ...Synthetic,
}).refine((t) => t.terms.every((term) => term.parent === null || t.terms.some((p) => p.key === term.parent)), { message: 'every parent exists', path: ['terms'] });
export type TaxonomyTree = z.infer<typeof TaxonomyTreeSchema>;

/* ---------- Setup wizard ---------- */

export const INSTALL_CHECKS = ['address', 'database', 'object_storage', 'worker', 'clock', 'secret_store'] as const;
/** A demo setup run: the contract state plus the install-check results the first step shows. */
export const SetupRunSchema = z.strictObject({
  state: SetupStateSchema,
  checks: z.array(z.strictObject({ id: z.enum(INSTALL_CHECKS), state: z.enum(['pass', 'warn', 'fail']) })),
  ...Synthetic,
}).refine((r) => r.state.current === (SETUP_STEPS.find((s) => !r.state.completed.includes(s)) ?? 'review'), { message: 'the current step is the first incomplete one', path: ['state'] });
export type SetupRun = z.infer<typeof SetupRunSchema>;
