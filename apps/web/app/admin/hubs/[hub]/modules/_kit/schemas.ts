import { z } from 'zod';
import {
  AGGREGATE_MIN_COHORT,
  AgentExtensionVersionRefSchema,
  AgentUsageStatSchema,
  CapabilityKindSchema,
  CurrencySchema,
  DataClassSchema,
  DecimalSchema,
  DigestSchema,
  IdSchema,
  JurisdictionCodeSchema,
  JurisdictionSettingAreaSchema,
  JurisdictionSettingsRefSchema,
  KnowledgeShareSchema,
  LocaleTagSchema,
  MandateActionV2Schema,
  MarketplaceCategoryRuleSchema,
  MarketplaceFeeVersionSchema,
  McpHubPolicySchema,
  MeterCostEstimateSchema,
  MeterRateVersionSchema,
  ModelJobSchema,
  ModuleFamilySchema,
  MoneySchema,
  NonNegativeMoneySchema,
  OfferSchema,
  PackFactRefSchema,
  PlanTemplateVersionSchema,
  PriceVersionSchema,
  ProtectionLimitsSchema,
  ShortTextSchema,
  StatusLabelSchema,
  SubscriptionPlanVersionSchema,
  TimestampSchema,
  unitMargin,
} from '@trustwork/contracts/client';
import { ChangeValueSchema } from '../../../../_data/schemas.js';

/**
 * Console read models of the agent product, the product modules, billing and communications (HUBC-005). Every record
 * is either a frozen contract schema (agent-catalog.ts, hub.ts, billing.ts, mcp.ts) or a view model composed of
 * contract schemas and primitives, for the screens whose backend read model does not exist yet (AGT-003, AGT-004,
 * AGT-023, BILL-003, BILL-004, COMMS-001). HUBC-009 serves these shapes from the API or proposes them as additive
 * contract changes. Fixtures parse with these schemas at module load.
 *
 * Two rules are built into the shapes, not left to the screens:
 * - participant counts are cohorts: an integer of at least `AGGREGATE_MIN_COHORT` or `null` ("fewer than 10");
 * - no record names a participant or points to one participant's agent, mandate, settings, goals, job subscriptions
 *   or connections: there is no person, mandate or agent identifier anywhere in this file.
 */

const Synthetic = { synthetic: z.literal(true) } as const;
export const KeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/);
const CapabilityIdSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);

/** A participant count: at least ten, or suppressed. */
export const CohortSchema = z.int().min(AGGREGATE_MIN_COHORT).nullable();
export type Cohort = z.infer<typeof CohortSchema>;

/** Who a capability or a setting applies to (the participant types of docs/engine/hub-console/user-agents-admin.md). */
export const AUDIENCES = ['person', 'company_member', 'company_representative', 'external_client'] as const;
export const AudienceSchema = z.enum(AUDIENCES);
export type Audience = z.infer<typeof AudienceSchema>;

export const METERING_UNITS = ['run', 'thousand_tokens', 'action', 'deliverable', 'api_call', 'month'] as const;
export const MeteringUnitSchema = z.enum(METERING_UNITS);
export const JOB_TRIGGERS = ['schedule', 'event', 'deadline', 'goal', 'request'] as const;
export const JobTriggerKindSchema = z.enum(JOB_TRIGGERS);

/** One changed field of a draft version, old value beside new (the approvals card uses the same values). */
export const ChangeSchema = z.strictObject({ field: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/), before: ChangeValueSchema, after: ChangeValueSchema });
export type Change = z.infer<typeof ChangeSchema>;

/**
 * The preview stored with a draft version (user-agents-admin.md, "Preview before activation"): computed on current data
 * when the version was drafted, bound to the version by its digest, shown to the drafter and to the second person.
 * Counts only; it never lists named participants.
 */
export const ActivationPreviewSchema = z.strictObject({
  id: IdSchema,
  digest: DigestSchema,
  computedAt: TimestampSchema,
  changes: z.array(ChangeSchema).min(1),
  affected: z.strictObject({ mandates: CohortSchema, jobSubscriptions: CohortSchema, externalConnections: CohortSchema, openRuns: CohortSchema, payers: CohortSchema }),
  audiences: z.array(AudienceSchema),
  plans: z.array(KeySchema),
  /** Days of advance notice existing payers get before a price rises (BILL-004); null when no notice is needed. */
  advanceNoticeDays: z.int().min(1).max(90).nullable(),
  /** Estimated monthly cost change for the hub from model pricing and recent usage, labelled as an estimate. */
  estimatedMonthlyCostChange: MoneySchema.nullable(),
  ...Synthetic,
});
export type ActivationPreview = z.infer<typeof ActivationPreviewSchema>;

/** A draft version waiting for activation: who drafted it (staff), from which version, and its stored preview. */
export const DraftSchema = z.strictObject({ version: z.int().min(1), baseVersion: z.int().min(0), draftedBy: IdSchema, draftedAt: TimestampSchema, preview: ActivationPreviewSchema });
export type Draft = z.infer<typeof DraftSchema>;

/* ---------- Agent product ---------- */

/** A cost and a sale price per unit in exact minor-unit decimals (cents may have fractions for token-based units). */
export const UnitPriceSchema = z.strictObject({
  priceVersionId: IdSchema,
  version: z.int().min(1),
  currency: CurrencySchema,
  unit: MeteringUnitSchema,
  costPerUnitMinor: DecimalSchema,
  salePerUnitMinor: DecimalSchema,
  costBasis: z.enum(['model_list_price', 'measured_average', 'contract']),
}).refine((p) => !p.costPerUnitMinor.startsWith('-') && !p.salePerUnitMinor.startsWith('-'), { message: 'prices are non-negative', path: ['salePerUnitMinor'] });
export type UnitPrice = z.infer<typeof UnitPriceSchema>;
export const negativeMargin = (p: Pick<UnitPrice, 'costPerUnitMinor' | 'salePerUnitMinor'>) => unitMargin({ costPricePerUnitMinor: p.costPerUnitMinor, salePricePerUnitMinor: p.salePerUnitMinor }).startsWith('-');

/** One capability of a module with where it is turned off: for the whole hub, for participant types, for plans. */
export const CapabilityToggleSchema = z.strictObject({
  id: CapabilityIdSchema,
  kind: CapabilityKindSchema,
  hubOn: z.boolean(),
  offFor: z.array(AudienceSchema),
  offForPlans: z.array(KeySchema),
});
export type CapabilityToggle = z.infer<typeof CapabilityToggleSchema>;

/** A default the participant's agent starts with and the hub's maximum; participants may tighten, never widen. */
export const DefaultSettingSchema = z.strictObject({ key: KeySchema, value: z.int().min(0), maximum: z.int().min(0), unit: z.enum(['per_day', 'per_week', 'per_month', 'count', 'hours']) })
  .refine((d) => d.value <= d.maximum, { message: 'a default never exceeds the hub maximum', path: ['value'] });

/** A job template a module offers; a participant turns it on only through a mandate proposal they confirm. */
export const JobOfferSchema = z.strictObject({ key: KeySchema, offered: z.boolean(), triggers: z.array(JobTriggerKindSchema).min(1), minIntervalHours: z.int().min(1).max(8760) });

export const AgentModuleConfigSchema = z.strictObject({
  key: KeySchema,
  family: ModuleFamilySchema,
  engineStatus: StatusLabelSchema,
  version: z.int().min(1),
  lifecycle: z.enum(['draft', 'beta', 'active', 'retired']),
  actions: z.array(MandateActionV2Schema).min(1),
  eligibility: z.array(AudienceSchema).min(1),
  verifiedCompanyRequired: z.boolean(),
  capabilities: z.array(CapabilityToggleSchema).min(1),
  defaults: z.array(DefaultSettingSchema),
  jobs: z.array(JobOfferSchema),
  routes: z.array(z.strictObject({ job: ModelJobSchema, routeKey: KeySchema, dataClasses: z.array(DataClassSchema).min(1) })),
  limits: z.strictObject({ runsPerDay: z.int().min(0), actionsPerDay: z.int().min(0), concurrentRuns: z.int().min(1), tokensPerMonth: z.int().min(0), outreachPerWeek: z.int().min(0).nullable() }),
  metering: z.strictObject({ unit: MeteringUnitSchema, freeUnitsPerMonth: z.int().min(0) }),
  price: UnitPriceSchema.nullable(),
  draft: DraftSchema.nullable(),
})
  .refine((m) => !m.actions.includes('communicate') || m.limits.outreachPerWeek !== null, { message: 'modules that communicate carry an outreach limit', path: ['limits'] })
  .refine((m) => m.capabilities.every((c) => c.id.startsWith(`${m.key}.`)), { message: 'capabilities are prefixed with the module key', path: ['capabilities'] });
export type AgentModuleConfig = z.infer<typeof AgentModuleConfigSchema>;

/** One jurisdiction's agent settings with the country-pack default beside the hub value (HUB-005 owns the payload). */
export const JurisdictionRowSchema = z.strictObject({
  area: JurisdictionSettingAreaSchema,
  packDefault: z.strictObject({ text: ShortTextSchema, lang: LocaleTagSchema, fact: PackFactRefSchema, mandatory: z.boolean() }),
  hubValue: z.strictObject({ text: ShortTextSchema, lang: LocaleTagSchema }),
  comparison: z.enum(['same', 'stricter']),
});
export const JurisdictionSettingsViewSchema = z.strictObject({ ref: JurisdictionSettingsRefSchema, rows: z.array(JurisdictionRowSchema).min(1) });
export type JurisdictionSettingsView = z.infer<typeof JurisdictionSettingsViewSchema>;

export const AgentPolicyViewSchema = z.strictObject({
  version: z.int().min(1),
  forbiddenPreAuthorization: z.array(MandateActionV2Schema),
  commitmentsOnlyForVerifiedCompanies: z.literal(true),
  outreachPerPersonPerWeek: z.int().min(0).max(500),
  outreachOnlyToParticipants: z.boolean(),
  channels: z.array(z.enum(['in_app', 'email', 'sms', 'messenger'])),
  disclosure: z.array(z.strictObject({ lang: LocaleTagSchema, text: ShortTextSchema })),
  planToPeople: z.strictObject({ mayDraftRequests: z.boolean(), mayDraftOffers: z.boolean(), mayAcceptWithinMandate: z.boolean(), requestsPerWeek: z.int().min(0).max(500) }),
  protectionLimits: ProtectionLimitsSchema,
  jurisdictions: z.array(JurisdictionSettingsViewSchema),
  draft: DraftSchema.nullable(),
});
export type AgentPolicyView = z.infer<typeof AgentPolicyViewSchema>;

/** The extension registry entry: the contract reference plus what the screen shows beside it. */
export const ExtensionViewSchema = z.strictObject({
  ref: AgentExtensionVersionRefSchema,
  title: z.strictObject({ text: ShortTextSchema, lang: LocaleTagSchema }),
  actions: z.array(z.strictObject({ capabilityId: CapabilityIdSchema, mandateKind: MandateActionV2Schema.nullable(), sideEffect: z.enum(['none', 'draft_state', 'state_change', 'outbound_message', 'external_call']) })).min(1),
  inputs: z.array(KeySchema),
  costModel: z.strictObject({ unit: MeteringUnitSchema, costPerUnitMinor: DecimalSchema, currency: CurrencySchema }),
  routeKey: KeySchema.nullable(),
  history: z.array(z.strictObject({ at: TimestampSchema, event: z.enum(['drafted', 'safety_passed', 'safety_failed', 'activation_requested', 'activated', 'suspended', 'retired']), by: IdSchema })),
  preview: ActivationPreviewSchema.nullable(),
});
export type ExtensionView = z.infer<typeof ExtensionViewSchema>;

export const ExternalAgentsViewSchema = z.strictObject({
  protocols: z.strictObject({ mcp: z.boolean(), a2a: z.boolean() }),
  rateLimits: z.strictObject({ defaultPerMinute: z.int().min(1), maximumPerMinute: z.int().min(1), defaultActionsPerDay: z.int().min(0), maximumActionsPerDay: z.int().min(0) }),
  modulesForExternalClients: z.array(KeySchema),
  representativesMayUseExternalClients: z.boolean(),
  registeredClients: z.strictObject({ mcp: CohortSchema, a2a: CohortSchema }),
  mcp: McpHubPolicySchema,
})
  .refine((e) => e.rateLimits.defaultPerMinute <= e.rateLimits.maximumPerMinute && e.rateLimits.defaultActionsPerDay <= e.rateLimits.maximumActionsPerDay, { message: 'defaults within maximums', path: ['rateLimits'] });

/** Per participant type or plan: aggregate usage, cost and revenue (never per person). */
export const CohortUsageSchema = z.strictObject({ segment: z.enum(['audience', 'plan']), key: KeySchema, activePrincipals: CohortSchema, runs: CohortSchema, cost: NonNegativeMoneySchema, revenue: NonNegativeMoneySchema });

export const ABUSE_SIGNALS = ['rate_above_limit', 'outreach_declines', 'injection_attempts', 'confirmation_spam', 'unknown_outcomes'] as const;
export const AbuseSignalSchema = z.strictObject({ kind: z.enum(ABUSE_SIGNALS), last7Days: z.int().min(0), threshold: z.int().min(1), response: z.enum(['throttle', 'quota_reduction', 'security_event', 'confirmation_limit', 'module_pause']), casesOpened: z.int().min(0) });

export const AgentProductSchema = z.strictObject({
  modules: z.array(AgentModuleConfigSchema),
  plans: z.array(KeySchema),
  policy: AgentPolicyViewSchema,
  extensions: z.array(ExtensionViewSchema),
  external: ExternalAgentsViewSchema,
  usage: z.array(AgentUsageStatSchema),
  cohorts: z.array(CohortUsageSchema),
  abuse: z.strictObject({ signals: z.array(AbuseSignalSchema), throttlesActive: z.int().min(0), draft: DraftSchema.nullable() }),
});
export type AgentProduct = z.infer<typeof AgentProductSchema>;

/* ---------- Product modules ---------- */

const PublicTitleSchema = z.strictObject({ text: ShortTextSchema, lang: LocaleTagSchema });
/** The engine's allowlist of fields a published project may show; budgets, private files and contacts are never on it. */
export const PROJECT_PUBLIC_FIELDS = ['title', 'category', 'region', 'status', 'timeline', 'photos', 'participants_public'] as const;

export const ProductModulesSchema = z.strictObject({
  projects: z.strictObject({
    publishingAllowed: z.boolean(),
    publicFields: z.array(z.enum(PROJECT_PUBLIC_FIELDS)),
    counts: z.strictObject({ created: CohortSchema, published: CohortSchema, completed: CohortSchema }),
    reports: z.array(z.strictObject({ id: IdSchema, title: PublicTitleSchema, reason: z.enum(['spam', 'misleading', 'private_data', 'rights']), at: TimestampSchema })),
    transferDisputes: z.int().min(0),
    version: z.int().min(1),
  }),
  planner: z.strictObject({
    templates: z.array(z.strictObject({ template: PlanTemplateVersionSchema, plansCreated: CohortSchema, itemsTurnedIntoRequestsPercent: z.int().min(0).max(100).nullable() })),
    /** A draft that does not pass the contract yet (a cycle or a missing item): named so the editor can fix it. */
    blocked: z.array(z.strictObject({ templateKey: KeySchema, version: z.int().min(1), problem: z.enum(['cycle', 'missing_item']), itemKey: KeySchema })),
    feedback: z.int().min(0),
    adaptation: z.strictObject({ addItems: z.boolean(), removeItems: z.boolean(), reorder: z.boolean() }),
  }),
  marketplace: z.strictObject({
    rules: z.array(MarketplaceCategoryRuleSchema),
    fees: z.array(z.strictObject({ fee: MarketplaceFeeVersionSchema, preview: ActivationPreviewSchema.nullable() })),
    counts: z.array(z.strictObject({ categoryKey: KeySchema, openRequests: CohortSchema, engagements: CohortSchema })),
    disputes: z.int().min(0),
    refundsOutsidePolicy: z.int().min(0),
    pausedForExpiredLicence: CohortSchema,
  }),
  knowledge: z.strictObject({
    shares: z.array(z.strictObject({
      share: KnowledgeShareSchema,
      projectTitle: PublicTitleSchema,
      parties: z.array(z.strictObject({ kind: z.enum(['owner', 'named']), partyKind: z.enum(['person', 'company']), label: PublicTitleSchema, consent: z.enum(['given', 'missing', 'withdrawn']) })),
    })),
    kindsAccepted: z.array(z.enum(['project_diary', 'plan_template', 'qa', 'lesson'])),
    anonymisedAllowed: z.boolean(),
    mentoring: z.boolean(),
  }),
  events: z.strictObject({
    hostingPolicy: z.enum(['editorial_only', 'verified_and_editorial', 'anyone_reviewed', 'anyone_unreviewed']),
    ticketing: z.boolean(),
    feeVersionLabel: z.string().min(1).max(80).nullable(),
    partnerMeetings: z.boolean(),
    inReview: z.array(z.strictObject({ id: IdSchema, title: PublicTitleSchema, startsAt: TimestampSchema, organizerKind: z.enum(['editorial', 'company', 'person']) })),
    counts: z.strictObject({ published: CohortSchema, registrations: CohortSchema, checkIns: CohortSchema }),
    refunds: z.int().min(0),
    organizerScreening: z.int().min(0),
    payoutBatchesWaiting: z.int().min(0),
  }),
  learning: z.strictObject({
    inReview: z.array(z.strictObject({ id: IdSchema, title: PublicTitleSchema, submittedAt: TimestampSchema })),
    certificates: z.strictObject({ issued: CohortSchema, revoked: CohortSchema, expired: CohortSchema }),
    revocationRequests: z.int().min(0),
    accreditations: z.array(z.strictObject({ id: IdSchema, body: PublicTitleSchema, source: z.url(), validUntil: TimestampSchema.nullable() })),
    paidCourses: z.boolean(),
  }),
  matching: z.strictObject({
    counts: z.strictObject({ needsPublished: CohortSchema, needsFilled: CohortSchema, introductionsRequested: CohortSchema, introductionsAccepted: CohortSchema }),
    introductionsPerPersonPerWeek: z.int().min(0).max(100),
    needsBoard: z.boolean(),
    crossBorderInterest: z.boolean(),
    methods: z.array(z.strictObject({ version: z.int().min(1), status: z.enum(['draft', 'released', 'superseded']), explanation: PublicTitleSchema, releasedAt: TimestampSchema.nullable() })),
    reports: z.int().min(0),
  }),
  commerce: z.strictObject({
    rules: z.array(z.strictObject({ categoryKey: KeySchema, licenceCheck: z.boolean(), pricesIncludeTax: z.boolean(), version: z.int().min(1) })),
    flows: z.strictObject({ rfqs: CohortSchema, quotes: CohortSchema, agreements: CohortSchema, orders: CohortSchema, medianHoursToFirstQuote: z.int().min(0).nullable(), medianDaysAcceptanceToOrder: z.int().min(0).nullable() }),
    unknownOutcomes: z.array(z.strictObject({ id: IdSchema, kind: z.enum(['payment', 'e_invoice', 'e_signature', 'order_confirmation']), state: z.enum(['outcome_unknown', 'reconciling']), since: TimestampSchema })),
  }),
});
export type ProductModules = z.infer<typeof ProductModulesSchema>;

/* ---------- Billing ---------- */

export const PriceBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('flat') }),
  /** Percentage over the cost price at drafting time; the sale price is computed once and stored as a fixed number. */
  z.strictObject({ kind: z.literal('markup'), percent: z.int().min(0).max(1000), costAtDraftMinor: DecimalSchema }),
]);
export const PriceSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('module'), key: KeySchema }),
  z.strictObject({ kind: z.literal('capability'), key: CapabilityIdSchema }),
  z.strictObject({ kind: z.literal('model'), key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,80}$/), direction: z.enum(['input', 'output']) }),
]);
export const PriceRowSchema = z.strictObject({
  subject: PriceSubjectSchema,
  price: UnitPriceSchema,
  basis: PriceBasisSchema,
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  acceptanceTextVersion: z.string().min(1).max(40),
  acceptances: CohortSchema,
  notice: z.enum(['not_needed', 'scheduled', 'sent']),
  draftedBy: IdSchema,
  activatedBy: IdSchema.nullable(),
  preview: ActivationPreviewSchema.nullable(),
  /** A newer cost record makes this active price's margin negative: the console offers a draft, never a silent change. */
  costChanged: z.strictObject({ newCostPerUnitMinor: DecimalSchema, observedAt: TimestampSchema }).nullable(),
})
  .refine((r) => r.activatedBy === null || r.activatedBy !== r.draftedBy, { message: 'activated by someone other than the drafter', path: ['activatedBy'] })
  .refine((r) => r.status !== 'draft' || r.preview !== null, { message: 'a draft carries its stored preview', path: ['preview'] });
export type PriceRow = z.infer<typeof PriceRowSchema>;

export const CreditPackSchema = z.strictObject({
  id: IdSchema,
  version: z.int().min(1),
  credits: z.int().min(1),
  price: NonNegativeMoneySchema,
  validityDays: z.int().min(30).max(3650).nullable(),
  /** ADR 012 decision 33: credits never expire silently; holders are reminded before any expiry. */
  reminderDaysBeforeExpiry: z.int().min(7).max(90).nullable(),
  refundPolicyVersion: z.int().min(1),
  status: z.enum(['draft', 'active', 'superseded', 'cancelled']),
  draftedBy: IdSchema,
  preview: ActivationPreviewSchema.nullable(),
}).refine((p) => p.validityDays === null || p.reminderDaysBeforeExpiry !== null, { message: 'expiring credits carry a reminder', path: ['reminderDaysBeforeExpiry'] });

export const BillingViewSchema = z.strictObject({
  currency: CurrencySchema,
  freeMinimum: z.array(z.strictObject({ moduleKey: KeySchema, unitsPerMonth: z.int().min(0), unit: MeteringUnitSchema })),
  offers: z.array(OfferSchema),
  plans: z.array(z.strictObject({ plan: SubscriptionPlanVersionSchema, key: KeySchema, trialDays: z.int().min(0).max(90), price: PriceVersionSchema, draftedBy: IdSchema, preview: ActivationPreviewSchema.nullable() })),
  prices: z.array(PriceRowSchema),
  meterRates: z.array(z.strictObject({ rate: MeterRateVersionSchema, cost: MeterCostEstimateSchema })),
  invoiceRuns: z.array(z.strictObject({ id: IdSchema, period: z.string().regex(/^\d{4}-\d{2}$/), state: z.enum(['scheduled', 'issued', 'partially_failed', 'failed']), invoices: CohortSchema, failed: z.int().min(0), total: NonNegativeMoneySchema, byOffer: z.array(z.strictObject({ offerCode: z.string().min(1).max(60), total: NonNegativeMoneySchema })), eInvoicing: z.enum(['not_required', 'sent', 'pending', 'failed']) })),
  payoutBatches: z.array(z.strictObject({ id: IdSchema, recipients: z.enum(['organizers', 'authors', 'experts']), payees: CohortSchema, total: NonNegativeMoneySchema, state: z.enum(['draft', 'awaiting_release', 'released', 'outcome_unknown', 'paid']), createdAt: TimestampSchema })),
  credits: z.strictObject({
    issuedThisMonth: z.int().min(0),
    issuedAmount: NonNegativeMoneySchema,
    roleCap: NonNegativeMoneySchema,
    packs: z.array(CreditPackSchema),
    refundPolicy: z.strictObject({ version: z.int().min(1), summary: PublicTitleSchema, effectiveFrom: TimestampSchema }),
  }),
  tax: z.strictObject({
    version: z.int().min(1),
    feesTaxable: z.array(z.strictObject({ region: JurisdictionCodeSchema, treatment: z.enum(['taxable', 'exempt', 'needs_advice']), source: z.url(), checkedAt: TimestampSchema })),
    eInvoicing: z.enum(['not_required', 'optional', 'required']),
    pricesShownWithTax: z.boolean(),
  }),
});
export type BillingView = z.infer<typeof BillingViewSchema>;

/* ---------- Communications ---------- */

const DnsStateSchema = z.enum(['pass', 'fail', 'pending']);
export const COMMUNICATION_CHANNELS = ['email', 'sms', 'in_app'] as const;
export const CommunicationsViewSchema = z.strictObject({
  domains: z.array(z.strictObject({ domain: z.string().regex(/^[a-z0-9.-]+\.(invalid|example)$/), spf: DnsStateSchema, dkim: DnsStateSchema, dmarc: DnsStateSchema, replyTo: z.string().regex(/^[^@\s]+@[a-z0-9.-]+\.(invalid|example)$/), checkedAt: TimestampSchema })),
  sms: z.strictObject({ registration: z.enum(['not_needed', 'not_started', 'brand_pending', 'campaign_pending', 'approved']), mode: z.enum(['fake', 'manual', 'live']) }),
  templates: z.array(z.strictObject({ key: KeySchema, category: z.enum(['transactional', 'legal', 'digest', 'announcement']), channel: z.enum(COMMUNICATION_CHANNELS), version: z.int().min(1), status: z.enum(['draft', 'active', 'paused']), locales: z.array(LocaleTagSchema).min(1), preview: PublicTitleSchema })),
  deliverability: z.array(z.strictObject({ templateKey: KeySchema, channel: z.enum(COMMUNICATION_CHANNELS), sent: CohortSchema, deliveredPercent: DecimalSchema.nullable(), bouncePercent: DecimalSchema.nullable(), complaintPercent: DecimalSchema.nullable() })),
  bounceThresholdPercent: DecimalSchema,
  announcements: z.array(z.strictObject({ id: IdSchema, kind: z.enum(['announcement', 'legal_notice']), title: PublicTitleSchema, audience: z.enum(['opted_in', 'all_participants']), audienceSize: CohortSchema, lawfulBasis: z.enum(['consent', 'legal_obligation', 'contract']), state: z.enum(['draft', 'scheduled', 'sent']), at: TimestampSchema }))
    .refine((list) => list.every((a) => a.kind === 'legal_notice' || (a.audience === 'opted_in' && a.lawfulBasis === 'consent')), { message: 'announcements go only to people who opted in', path: [0] }),
  quietHours: z.strictObject({ from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }),
});
export type CommunicationsView = z.infer<typeof CommunicationsViewSchema>;

/** Everything the four groups of HUBC-005 show for one hub, loaded through the console port (`product`). */
export const HubProductSchema = z.strictObject({
  hubId: IdSchema,
  agents: AgentProductSchema,
  modules: ProductModulesSchema,
  billing: BillingViewSchema,
  communications: CommunicationsViewSchema,
  ...Synthetic,
});
export type HubProduct = z.infer<typeof HubProductSchema>;
