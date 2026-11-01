import { z } from 'zod';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema, NonNegativeMinorUnitsSchema, NonNegativeMoneySchema } from './common/money.js';
import { DecimalSchema, decimalToScaled } from './common/quantity.js';
import { DataClassSchema, type DataClass } from './retrieval.js';
import {
  AgentModuleKeySchema, consoleCommand, ConnectionTestOutcomeSchema, ConnectionTestResultSchema, looksLikeSecretValue, ModelJobSchema, ModelRefSchema,
  ProviderAdapterIdSchema, ProviderBudgetSchema, ProviderCapabilitySchema, ProviderHostingSchema, ProviderModeSchema, RouteStatusSchema, SecretRefSchema,
  type ModelJob, type ModelRef, type ProviderBudget, type ProviderCapability, type ProviderHosting,
} from './hub.js';

/**
 * Provider connections, write-only secrets, model routes, egress, spending caps, kill switches and cost records
 * (KEYS-001; docs/engine/hub-console/providers-and-models.md, ADR 010 decision 25).
 *
 * Additive to the frozen console contract `hub.ts` (HUBC-000, 1.0.0): commands use its `consoleCommand` envelope and its
 * vocabularies (`ProviderHostingSchema`, `ModelRefSchema`, `ProviderBudgetSchema`, `SecretRefSchema`, ...). What this file
 * adds is what the frozen contract left to KEYS-001:
 *
 * - routes **scoped** by job, optionally narrowed to one agent module or one extension, resolved most specific first
 *   (extension, then module, then job) with a refusal when no active route exists (`resolveRoute`);
 * - active routes name a **pinned** provider revision, never a moving alias (`isMovingAlias`);
 * - the egress decision every model or provider call passes, over a residency list, kill switches, brokers and
 *   restricted places (`providerEgressDecision`);
 * - the hard stop of operator spending caps (`capAllows`) and an upper-bound cost estimate (`estimateCallCostMinor`);
 * - versioned cost records that never change a participant's sale price (cost is information, not a price);
 * - the synthetic probes a connection test may send (`SYNTHETIC_PROBES`), and nothing else;
 * - the change log with before and after values, which never carries a secret value.
 *
 * Secret values exist in exactly one schema here (`ProviderSecretSubmitCommandSchema`); every read model carries a
 * reference with a keyed fingerprint only.
 */

const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country');
/** A provider's own region label (`us-east-1`, `eu-west`), descriptive only; the country is what the rules read. */
const RegionLabelSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'provider region label');

/* ---------- Hosting, residency and endpoints ---------- */

/**
 * Where a connection processes and stores data. `hosting.country` (from the frozen contract) is the processing country;
 * `storageCountry` is where inputs or outputs are retained (null when the provider retains nothing).
 */
export const ConnectionHostingInputSchema = z.strictObject({
  hosting: ProviderHostingSchema,
  storageCountry: CountryCodeSchema.nullable(),
  region: RegionLabelSchema.nullable(),
});
export type ConnectionHostingInput = z.infer<typeof ConnectionHostingInputSchema>;

/** Every place code a connection names: the processing country and, when it retains data, the storage country. */
export function connectionPlaces(input: { hosting: ProviderHosting; storageCountry: string | null }): string[] {
  return [...new Set([input.hosting.country, ...(input.storageCountry ? [input.storageCountry] : [])])];
}
/** True when the connection processes or stores data in a restricted place (refused at save time). */
export function connectionRestricted(input: { hosting: ProviderHosting; storageCountry: string | null }, isRestricted: (code: string) => boolean): boolean {
  return connectionPlaces(input).some(isRestricted);
}
/** In the hub's residency: processing and (where retained) storage both in the hub's personal-data countries. */
export function connectionInResidency(input: { hosting: ProviderHosting; storageCountry: string | null }, residencyCountries: readonly string[]): boolean {
  return connectionPlaces(input).every((c) => residencyCountries.includes(c));
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i;
export type EndpointProblem = 'plain_http_vendor' | 'private_address_vendor' | 'credentials_in_url' | 'secret_in_url';
/**
 * Outbound endpoints (SEC-F11): a vendor endpoint is HTTPS on a public host; plain HTTP and private addresses are for
 * self-hosted servers only; no endpoint carries credentials or a key-shaped value in its user info, path or query.
 */
export function endpointProblem(endpoint: string | null, hostingKind: ProviderHosting['kind']): EndpointProblem | null {
  if (endpoint === null) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'secret_in_url';
  }
  if (url.username || url.password) return 'credentials_in_url';
  const parts = [...url.pathname.split('/'), ...[...url.searchParams.entries()].flatMap(([k, v]) => [k, v])].filter(Boolean);
  if (parts.some((p) => looksLikeSecretValue(decodeURIComponent(p)))) return 'secret_in_url';
  if (hostingKind === 'vendor' && url.protocol !== 'https:') return 'plain_http_vendor';
  if (hostingKind === 'vendor' && PRIVATE_HOST.test(url.hostname)) return 'private_address_vendor';
  return null;
}

/* ---------- Connections ---------- */

export const SecretSourceSchema = z.enum(['none', 'envelope', 'credential_ref']);
export type SecretSource = z.infer<typeof SecretSourceSchema>;
const CapabilitiesSchema = z.array(ProviderCapabilitySchema).min(1).max(22).refine((c) => new Set(c).size === c.length, { message: 'each capability once' });
const ConnectionShape = {
  label: NameSchema,
  capabilities: CapabilitiesSchema,
  endpoint: z.url({ protocol: /^https?$/ }).max(2000).nullable(),
  hosting: ProviderHostingSchema,
  storageCountry: CountryCodeSchema.nullable(),
  region: RegionLabelSchema.nullable(),
  /** A HUB-001 credential reference (`provider_credential_ref`) whose secret lives outside the database (env, file, KMS, Vault). */
  credentialRefId: IdSchema.nullable(),
};
const connectionRefinements = <T extends z.ZodType<{ label: string; endpoint: string | null; hosting: ProviderHosting; credentialRefId: string | null; mode?: string }>>(schema: T) => schema
  .refine((c) => !looksLikeSecretValue(c.label), { message: 'a label names a connection, it never contains a key', path: ['label'] })
  .refine((c) => endpointProblem(c.endpoint, c.hosting.kind) === null, { message: 'the endpoint is not allowed for this hosting', path: ['endpoint'] })
  .refine((c) => c.mode !== 'fake' || c.credentialRefId === null, { message: 'fake adapters never hold secrets', path: ['credentialRefId'] });

/** Creates a `draft` connection. Nothing reaches a provider until it is tested, enabled and allowed by an egress cell. */
export const CreateConnectionCommandSchema = connectionRefinements(consoleCommand({ adapterId: ProviderAdapterIdSchema, mode: ProviderModeSchema, ...ConnectionShape }));
export type CreateConnectionCommand = z.infer<typeof CreateConnectionCommandSchema>;
/** Changes a connection. Changing anything but the label returns an enabled connection to `draft` (test and enable again). */
export const UpdateConnectionCommandSchema = connectionRefinements(consoleCommand({ expectedRevision: RevisionSchema, ...ConnectionShape }));
export type UpdateConnectionCommand = z.infer<typeof UpdateConnectionCommandSchema>;
/** Enabling a non-fake connection needs a passing synthetic test and a second person (`providers.enable_non_fake`). */
export const EnableConnectionCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, approvalId: IdSchema.nullable() });
export const PlainProvidersCommandSchema = consoleCommand({});
export const RevisionedProvidersCommandSchema = consoleCommand({ expectedRevision: RevisionSchema });

/** Default grace period of a rotated secret (docs: 24 hours), and its bound. */
export const SECRET_GRACE_DEFAULT_HOURS = 24;
export const SECRET_GRACE_MAX_HOURS = 168;
/**
 * The write-only secret command, and the only schema of this module that carries a secret value: the value is
 * accepted by the secret endpoint alone and never echoed, logged, audited, exported, stored in an idempotency record
 * or put in the outbox. A rotation keeps the previous version usable for `graceHours`, then destroys it.
 */
export const ProviderSecretSubmitCommandSchema = consoleCommand({
  connectionId: IdSchema,
  value: z.string().min(8).max(16_384).refine((v) => v.trim() === v && !/[\r\n\0]/.test(v), { message: 'a secret is one line without surrounding spaces' }),
  expectedRevision: RevisionSchema,
  graceHours: z.int().min(0).max(SECRET_GRACE_MAX_HOURS),
});
export type ProviderSecretSubmitCommand = z.infer<typeof ProviderSecretSubmitCommandSchema>;

export const SecretVersionStatusSchema = z.enum(['active', 'grace', 'destroyed']);
/** A secret version as staff see it: the reference with its keyed fingerprint, never the value or the ciphertext. */
export const ProviderSecretVersionSchema = z.strictObject({
  ref: SecretRefSchema,
  status: SecretVersionStatusSchema,
  graceUntil: TimestampSchema.nullable(),
  destroyedAt: TimestampSchema.nullable(),
}).refine((s) => (s.status === 'destroyed') === (s.destroyedAt !== null), { message: 'destroyed versions record when', path: ['destroyedAt'] })
  .refine((s) => s.status !== 'grace' || s.graceUntil !== null, { message: 'a version in grace says until when', path: ['graceUntil'] });
export type ProviderSecretVersion = z.infer<typeof ProviderSecretVersionSchema>;

/** The connection read model (`killed` while an engaged kill switch covers it). */
export const ConnectionViewStatusSchema = z.enum(['draft', 'enabled', 'disabled', 'killed']);
export const ConnectionViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  adapterId: ProviderAdapterIdSchema,
  label: NameSchema,
  capabilities: CapabilitiesSchema,
  mode: ProviderModeSchema,
  endpoint: z.string().nullable(),
  hosting: ProviderHostingSchema,
  storageCountry: CountryCodeSchema.nullable(),
  region: RegionLabelSchema.nullable(),
  inHubResidency: z.boolean(),
  status: ConnectionViewStatusSchema,
  secret: z.strictObject({ source: SecretSourceSchema, versions: z.array(ProviderSecretVersionSchema), credentialRefId: IdSchema.nullable() }),
  lastTest: ConnectionTestResultSchema.nullable(),
  enabledBy: IdSchema.nullable(),
  enabledAt: TimestampSchema.nullable(),
  approvalId: IdSchema.nullable(),
  killSwitchId: IdSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
}).refine((c) => c.mode !== 'fake' || c.secret.source === 'none', { message: 'fake adapters never hold secrets', path: ['secret'] })
  .refine((c) => c.status !== 'enabled' || c.lastTest?.outcome === 'ok', { message: 'enable only after a successful connection test', path: ['lastTest'] })
  .refine((c) => c.status !== 'enabled' || c.mode === 'fake' || (c.enabledBy !== null && c.approvalId !== null), { message: 'non-fake connections are enabled under a second-person approval', path: ['approvalId'] })
  .refine((c) => (c.status === 'killed') === (c.killSwitchId !== null), { message: 'killed exactly while a kill switch is engaged', path: ['killSwitchId'] });
export type ConnectionView = z.infer<typeof ConnectionViewSchema>;

/* ---------- Connection tests: synthetic input only ---------- */

/**
 * The only inputs a connection test may send: an authentication check, a model list where the API has one, and a
 * fixed canned request per capability. There is no field for customer data anywhere in this shape.
 */
export const SyntheticProbeSchema = z.strictObject({
  capability: ProviderCapabilitySchema,
  kind: z.enum(['auth_check', 'list_models', 'canned_request']),
  text: z.string().max(200).nullable(),
});
export type SyntheticProbe = z.infer<typeof SyntheticProbeSchema>;
const CANNED: Partial<Record<ProviderCapability, string>> = {
  llm: 'Trustwork connection test. Reply with the single word OK.',
  embeddings: 'Trustwork connection test sentence.',
  rerank: 'Trustwork connection test sentence.',
  translation: 'Trustwork connection test sentence.',
  image_generation: 'A plain blue square. Trustwork connection test.',
  text_to_speech: 'Trustwork connection test.',
  web_search: 'Trustwork',
};
/** The probes for a connection's capabilities, in a fixed order: one authentication check, then per capability. */
export function syntheticProbesFor(capabilities: readonly ProviderCapability[]): SyntheticProbe[] {
  const out: SyntheticProbe[] = [{ capability: capabilities[0] as ProviderCapability, kind: 'auth_check', text: null }];
  for (const capability of [...capabilities].sort()) {
    if (['llm', 'embeddings', 'rerank', 'image_generation'].includes(capability)) out.push({ capability, kind: 'list_models', text: null });
    const text = CANNED[capability];
    if (text) out.push({ capability, kind: 'canned_request', text });
  }
  return out;
}
/** A result as an adapter reports it; the server adds who, when and the synthetic marker. */
export const AdapterTestReportSchema = z.strictObject({
  outcome: ConnectionTestOutcomeSchema,
  latencyMs: z.int().min(0).nullable(),
  modelsListed: z.int().min(0).nullable(),
  costMinorUnits: NonNegativeMinorUnitsSchema.nullable(),
});
export type AdapterTestReport = z.infer<typeof AdapterTestReportSchema>;

/* ---------- Model routes scoped by job, module or extension ---------- */

/** A route serves one job, optionally narrowed to one agent module or one extension (ADR 010 decision 25). */
export const RouteScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('job') }),
  z.strictObject({ kind: z.literal('module'), moduleKey: AgentModuleKeySchema }),
  z.strictObject({ kind: z.literal('extension'), extensionId: IdSchema }),
]);
export type RouteScope = z.infer<typeof RouteScopeSchema>;
/** Resolution order: the most specific active route wins. */
export const ROUTE_SCOPE_SPECIFICITY = ['extension', 'module', 'job'] as const satisfies readonly RouteScope['kind'][];

const MOVING_ALIASES = /^(latest|stable|current|default|newest|preview|beta|auto)$|[-_.:@](latest|stable|current|default|newest|auto)$/i;
/** True when a revision is a moving alias ("latest", "gpt-x-latest") rather than an exact provider revision. */
export function isMovingAlias(revision: string): boolean {
  return MOVING_ALIASES.test(revision.trim());
}
/** Pinned: an exact provider revision, never null and never a moving alias. */
export function isPinned(ref: ModelRef): boolean {
  return ref.modelRevision !== null && !isMovingAlias(ref.modelRevision);
}

export const RouteLimitsSchema = z.strictObject({
  maxInputTokens: z.int().min(1).max(10_000_000),
  maxOutputTokens: z.int().min(1).max(1_000_000),
  maxFileBytes: z.int().min(1).max(1_073_741_824).nullable(),
  timeoutMs: z.int().min(100).max(600_000),
});
export type RouteLimits = z.infer<typeof RouteLimitsSchema>;

const DataClassesSchema = z.array(DataClassSchema).min(1).max(5).refine((c) => new Set(c).size === c.length, { message: 'each data class once' });
const RouteShape = {
  job: ModelJobSchema,
  scope: RouteScopeSchema,
  primary: ModelRefSchema,
  fallbacks: z.array(ModelRefSchema).max(3),
  allowedDataClasses: DataClassesSchema,
  limits: RouteLimitsSchema,
  budgetId: IdSchema.nullable(),
};
type RouteLike = { job: ModelJob; primary: ModelRef; fallbacks: ModelRef[]; allowedDataClasses: DataClass[] };
const routeRefinements = <T extends z.ZodType<RouteLike>>(schema: T) => schema
  .refine((r) => !r.fallbacks.some((f) => f.connectionId === r.primary.connectionId && f.modelId === r.primary.modelId), { message: 'fallback repeats the primary', path: ['fallbacks'] })
  .refine((r) => new Set(r.fallbacks.map((f) => `${f.connectionId}/${f.modelId}`)).size === r.fallbacks.length, { message: 'duplicate fallback', path: ['fallbacks'] })
  .refine((r) => !['embeddings', 'rerank'].includes(r.job) || r.fallbacks.length === 0, { message: 'vectors and scores never mix models: no fallbacks', path: ['fallbacks'] })
  .refine((r) => r.job !== 'image_generation' || (r.allowedDataClasses.length === 1 && r.allowedDataClasses[0] === 'public'), { message: 'image prompts may contain public data only', path: ['allowedDataClasses'] })
  .refine((r) => [r.primary, ...r.fallbacks].every((m) => m.modelRevision === null || !isMovingAlias(m.modelRevision)), { message: 'a revision is exact, never a moving alias', path: ['primary'] });

/** Drafts a new version of the route for its job and scope; revisions may still be open in a draft, never at activation. */
export const DraftRouteCommandSchema = routeRefinements(consoleCommand(RouteShape));
export type DraftRouteCommand = z.infer<typeof DraftRouteCommandSchema>;
/** Activation supersedes the active version of the same job and scope; non-public routes need a second person. */
export const ActivateRouteCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, approvalId: IdSchema.nullable() });

/** True when a route may carry anything but public data (activation then needs `models.activate_private_route`). */
export function routeNeedsSecondPerson(route: { allowedDataClasses: readonly DataClass[] }): boolean {
  return route.allowedDataClasses.some((c) => c !== 'public');
}

export const ScopedModelRouteSchema = routeRefinements(z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  version: z.int().min(1),
  ...RouteShape,
  status: RouteStatusSchema,
  reason: ShortTextSchema,
  draftedBy: IdSchema,
  draftedAt: TimestampSchema,
  activatedBy: IdSchema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  approvalId: IdSchema.nullable(),
  killSwitchId: IdSchema.nullable(),
  revision: RevisionSchema,
}))
  .refine((r) => r.status !== 'active' || r.activatedBy !== null, { message: 'active routes record the activator', path: ['activatedBy'] })
  .refine((r) => r.status !== 'active' || [r.primary, ...r.fallbacks].every(isPinned), { message: 'active routes name pinned provider revisions', path: ['primary'] })
  .refine((r) => r.status !== 'active' || !routeNeedsSecondPerson(r) || (r.approvalId !== null && r.activatedBy !== r.draftedBy), {
    message: 'routes that may carry non-public data are activated by another person under a second-person approval',
    path: ['approvalId'],
  });
export type ScopedModelRoute = z.infer<typeof ScopedModelRouteSchema>;

export interface RouteCall { hubId: string; job: ModelJob; moduleKey: string | null; extensionId: string | null }
type Resolvable = { hubId: string; job: ModelJob; scope: RouteScope; status: string };
/** The most specific active route for a call (extension, then module, then job), or a refusal. */
export function resolveRoute<R extends Resolvable>(routes: readonly R[], call: RouteCall): { route: R; reason: null } | { route: null; reason: 'no_active_route' } {
  const active = routes.filter((r) => r.status === 'active' && r.hubId === call.hubId && r.job === call.job);
  const matches = (r: R): boolean => (r.scope.kind === 'extension' ? r.scope.extensionId === call.extensionId : r.scope.kind === 'module' ? r.scope.moduleKey === call.moduleKey : true);
  for (const kind of ROUTE_SCOPE_SPECIFICITY) {
    const route = active.find((r) => r.scope.kind === kind && matches(r));
    if (route) return { route, reason: null };
  }
  return { route: null, reason: 'no_active_route' };
}

/* ---------- Egress ---------- */

/** One cell of the matrix: allow or deny one data class to one connection (a missing cell is deny). */
export const SetEgressRuleCommandSchema = consoleCommand({
  connectionId: IdSchema,
  dataClass: DataClassSchema,
  decision: z.enum(['allow', 'deny']),
  requireInResidency: z.boolean(),
  requireZeroRetention: z.boolean(),
  approvalId: IdSchema.nullable(),
}).refine((r) => r.decision === 'deny' || r.dataClass === 'public' || (r.requireInResidency && r.requireZeroRetention), {
  message: 'allowing non-public data needs in-residency processing and zero retention',
  path: ['requireInResidency'],
});
export type SetEgressRuleCommand = z.infer<typeof SetEgressRuleCommandSchema>;
/** True when setting the cell needs `egress.allow_private_class`. */
export function egressRuleNeedsSecondPerson(rule: { decision: 'allow' | 'deny'; dataClass: DataClass }): boolean {
  return rule.decision === 'allow' && rule.dataClass !== 'public';
}
export const EgressRuleRecordSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  connectionId: IdSchema,
  dataClass: DataClassSchema,
  decision: z.enum(['allow', 'deny']),
  requireInResidency: z.boolean(),
  requireZeroRetention: z.boolean(),
  version: z.int().min(1),
  approvalId: IdSchema.nullable(),
  reason: ShortTextSchema,
  createdBy: IdSchema,
  createdAt: TimestampSchema,
}).refine((r) => r.decision === 'deny' || r.dataClass === 'public' || (r.approvalId !== null && r.requireInResidency && r.requireZeroRetention), {
  message: 'allowing non-public data needs a second person, in-residency processing and zero retention',
  path: ['approvalId'],
});
export type EgressRuleRecord = z.infer<typeof EgressRuleRecordSchema>;

export const PROVIDER_EGRESS_REASONS = [
  'allowed', 'no_rule', 'denied', 'connection_not_enabled', 'killed', 'restricted_place', 'training', 'broker', 'residency', 'retention',
] as const;
export type ProviderEgressReason = (typeof PROVIDER_EGRESS_REASONS)[number];
export interface EgressConnection {
  id: string;
  status: 'draft' | 'enabled' | 'disabled';
  hosting: ProviderHosting;
  storageCountry: string | null;
  killed: boolean;
  restricted: boolean;
}
type RuleLike = { connectionId: string; dataClass: DataClass; decision: 'allow' | 'deny'; requireInResidency: boolean; requireZeroRetention: boolean; version: number };
/**
 * The decision every model or provider call passes before data leaves the node. Default deny; a killed, disabled or
 * restricted connection receives nothing; a vendor that trains on inputs, or a broker, never receives non-public data
 * whatever a cell says; residency covers processing and storage against the hub's personal-data countries.
 */
export function providerEgressDecision(rules: readonly RuleLike[], input: { connection: EgressConnection; dataClass: DataClass; residencyCountries: readonly string[] }): { allowed: boolean; reason: ProviderEgressReason } {
  const { connection, dataClass } = input;
  if (connection.killed) return { allowed: false, reason: 'killed' };
  if (connection.status !== 'enabled') return { allowed: false, reason: 'connection_not_enabled' };
  if (connection.restricted) return { allowed: false, reason: 'restricted_place' };
  const rule = rules.filter((r) => r.connectionId === connection.id && r.dataClass === dataClass).sort((a, b) => b.version - a.version)[0];
  if (!rule) return { allowed: false, reason: 'no_rule' };
  if (rule.decision === 'deny') return { allowed: false, reason: 'denied' };
  const vendor = connection.hosting.kind === 'vendor' ? connection.hosting : null;
  if (dataClass !== 'public' && vendor?.trainsOnInputs) return { allowed: false, reason: 'training' };
  if (dataClass !== 'public' && vendor?.broker) return { allowed: false, reason: 'broker' };
  if ((rule.requireInResidency || dataClass !== 'public') && !connectionInResidency(connection, input.residencyCountries)) return { allowed: false, reason: 'residency' };
  if ((rule.requireZeroRetention || dataClass !== 'public') && vendor && !vendor.zeroRetention) return { allowed: false, reason: 'retention' };
  return { allowed: true, reason: 'allowed' };
}

/* ---------- Spending caps ---------- */

const CapScopeSchema = ProviderBudgetSchema.shape.scope;
export const CreateCapCommandSchema = consoleCommand({
  scope: CapScopeSchema,
  period: z.enum(['day', 'month']),
  limit: NonNegativeMoneySchema,
  alertAtPercent: z.array(z.int().min(1).max(100)).max(5),
  onExhausted: z.enum(['pause', 'deny_new']),
}).refine((c) => new Set(c.alertAtPercent).size === c.alertAtPercent.length, { message: 'each alert threshold once', path: ['alertAtPercent'] });
export const UpdateCapCommandSchema = consoleCommand({
  expectedRevision: RevisionSchema,
  limit: NonNegativeMoneySchema,
  alertAtPercent: z.array(z.int().min(1).max(100)).max(5),
  onExhausted: z.enum(['pause', 'deny_new']),
}).refine((c) => new Set(c.alertAtPercent).size === c.alertAtPercent.length, { message: 'each alert threshold once', path: ['alertAtPercent'] });
export const CapStateSchema = z.enum(['ok', 'alert', 'exhausted']);
export const CapViewSchema = z.strictObject({
  budget: ProviderBudgetSchema,
  status: z.enum(['active', 'retired']),
  periodStart: TimestampSchema,
  spent: NonNegativeMoneySchema,
  reserved: NonNegativeMoneySchema,
  state: CapStateSchema,
});
export type CapView = z.infer<typeof CapViewSchema>;
/**
 * The hard stop: a paid call is allowed only while the cap is not exhausted and the call's upper-bound estimate fits
 * what is left. There is no overspend state.
 */
export function capAllows(budget: Pick<ProviderBudget, 'limit'>, usage: { spentMinorUnits: string; reservedMinorUnits: string; estimateMinorUnits: string }): boolean {
  const limit = BigInt(budget.limit.minorUnits);
  const used = BigInt(NonNegativeMinorUnitsSchema.parse(usage.spentMinorUnits)) + BigInt(NonNegativeMinorUnitsSchema.parse(usage.reservedMinorUnits));
  return used < limit && used + BigInt(NonNegativeMinorUnitsSchema.parse(usage.estimateMinorUnits)) <= limit;
}

/* ---------- Cost records (cost price, never a sale price) ---------- */

const NonNegativeDecimalSchema = DecimalSchema.refine((v) => !v.startsWith('-'), { message: 'a cost is not negative' });
/**
 * Records what the operator pays for a model (`ModelPricingSchema` fields, versioned per connection and model). A cost
 * record feeds margins and dashboards; it never changes a participant's price (sale prices are billing versions).
 */
export const RecordModelPricingCommandSchema = consoleCommand({
  connectionId: IdSchema,
  modelId: z.string().min(1).max(200),
  currency: CurrencySchema,
  inputPerMillionTokens: NonNegativeDecimalSchema.nullable(),
  outputPerMillionTokens: NonNegativeDecimalSchema.nullable(),
  perImage: NonNegativeDecimalSchema.nullable(),
  perAudioMinute: NonNegativeDecimalSchema.nullable(),
  basis: z.enum(['provider_list', 'contract', 'measured']),
  observedAt: TimestampSchema,
  sourceNote: ShortTextSchema.nullable(),
}).refine((p) => [p.inputPerMillionTokens, p.outputPerMillionTokens, p.perImage, p.perAudioMinute].some((v) => v !== null), { message: 'name at least one price', path: ['inputPerMillionTokens'] });
export type RecordModelPricingCommand = z.infer<typeof RecordModelPricingCommandSchema>;
export const ModelPricingRecordSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  version: z.int().min(1),
  connectionId: IdSchema,
  modelId: z.string().min(1).max(200),
  currency: CurrencySchema,
  inputPerMillionTokens: DecimalSchema.nullable(),
  outputPerMillionTokens: DecimalSchema.nullable(),
  perImage: DecimalSchema.nullable(),
  perAudioMinute: DecimalSchema.nullable(),
  basis: z.enum(['provider_list', 'contract', 'measured']),
  observedAt: TimestampSchema,
  sourceNote: ShortTextSchema.nullable(),
  recordedBy: IdSchema,
  recordedAt: TimestampSchema,
});
export type ModelPricingRecord = z.infer<typeof ModelPricingRecordSchema>;

/**
 * Upper-bound cost of one call in minor units (rounded up), from a cost record and the route's limits: what a paid call
 * reserves against the caps before it is sent. `minorExponent` is the currency's minor-unit exponent (2 for USD).
 */
export function estimateCallCostMinor(
  pricing: Pick<ModelPricingRecord, 'inputPerMillionTokens' | 'outputPerMillionTokens' | 'perImage' | 'perAudioMinute'>,
  units: { inputTokens: number; outputTokens: number; images: number; audioMinutes: number },
  minorExponent: number,
): string {
  if (!Number.isInteger(minorExponent) || minorExponent < 0 || minorExponent > 4) throw new RangeError('minor-unit exponent between 0 and 4');
  // minor = sum(price * count * 10^e / per); exact over the common denominator 10^6 (decimal scale) * 10^6 (per million).
  const D = 10n ** 12n;
  const terms: [string | null, number, bigint][] = [
    [pricing.inputPerMillionTokens, units.inputTokens, 1_000_000n],
    [pricing.outputPerMillionTokens, units.outputTokens, 1_000_000n],
    [pricing.perImage, units.images, 1n],
    [pricing.perAudioMinute, units.audioMinutes, 1n],
  ];
  let numerator = 0n;
  for (const [price, count, per] of terms) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('unit counts are non-negative integers');
    if (price === null || count === 0) continue;
    const { scaled, scale } = decimalToScaled(price);
    numerator += scaled * BigInt(count) * 10n ** BigInt(minorExponent) * (D / (10n ** BigInt(scale) * per));
  }
  return ((numerator + D - 1n) / D).toString();
}

/* ---------- Kill switches ---------- */

/** What a providers kill switch stops: one connection (every route that uses it falls back or stops) or one route. */
export const ProviderKillTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connection'), connectionId: IdSchema }),
  z.strictObject({ kind: z.literal('route'), job: ModelJobSchema, scope: RouteScopeSchema }),
]);
export type ProviderKillTarget = z.infer<typeof ProviderKillTargetSchema>;
/** Engaging is immediate and needs one person (`admin.providers.kill`). */
export const EngageProviderKillCommandSchema = consoleCommand({ target: ProviderKillTargetSchema });
/** Releasing needs a second person (`kill_switch.release`) and an incident note. */
export const ReleaseProviderKillCommandSchema = consoleCommand({ approvalId: IdSchema.nullable(), incidentNote: ShortTextSchema });
export const ProviderKillSwitchViewSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  target: ProviderKillTargetSchema,
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
export type ProviderKillSwitchView = z.infer<typeof ProviderKillSwitchViewSchema>;

/* ---------- The call gate ---------- */

/** What a model or provider call asks for before anything leaves the node (LLM-001 and every adapter call it). */
export const ProviderCallRequestSchema = z.strictObject({
  hubId: IdSchema,
  job: ModelJobSchema,
  moduleKey: AgentModuleKeySchema.nullable(),
  extensionId: IdSchema.nullable(),
  pipelineId: IdSchema.nullable(),
  dataClasses: DataClassesSchema,
  /** Upper bound of what the call may cost (`estimateCallCostMinor`), in the hub's currency; fake connections cost nothing. */
  estimatedCost: NonNegativeMoneySchema,
  /** The caller's own reference (a run, a request), for reconciliation; never personal data. */
  requestRef: IdSchema,
});
export type ProviderCallRequest = z.infer<typeof ProviderCallRequestSchema>;
export const CALL_REFUSAL_REASONS = [
  'no_active_route', 'data_class_not_in_route', 'node_killed', 'route_killed', 'job_killed', 'module_killed', 'extension_killed', 'pipeline_killed',
  'egress_denied', 'no_available_connection', 'cap_exhausted', 'currency_mismatch',
] as const;
export type CallRefusalReason = (typeof CALL_REFUSAL_REASONS)[number];
export const CallCandidateSchema = z.strictObject({ connectionId: IdSchema, modelId: z.string().min(1).max(200), modelRevision: z.string().min(1).max(200), mode: ProviderModeSchema });
export const ProviderCallDecisionSchema = z.discriminatedUnion('allowed', [
  z.strictObject({
    allowed: z.literal(true),
    decisionId: IdSchema,
    routeId: IdSchema,
    routeVersion: z.int().min(1),
    /** The primary first, then the fallbacks the egress decision also allows, in order; try the next only on unavailability. */
    candidates: z.array(CallCandidateSchema).min(1).max(4),
    limits: RouteLimitsSchema,
    reserved: NonNegativeMoneySchema,
  }),
  z.strictObject({
    allowed: z.literal(false),
    reason: z.enum(CALL_REFUSAL_REASONS),
    /** The egress reason, the data class or the cap that refused, for the explanation (`providers.reasons.*`). */
    detail: z.string().max(200).nullable(),
  }),
]);
export type ProviderCallDecision = z.infer<typeof ProviderCallDecisionSchema>;
/** A staff preview of a call decision: the same gate, nothing reserved. */
export const ExplainCallCommandSchema = consoleCommand({
  job: ModelJobSchema,
  moduleKey: AgentModuleKeySchema.nullable(),
  extensionId: IdSchema.nullable(),
  pipelineId: IdSchema.nullable(),
  dataClasses: DataClassesSchema,
  estimatedCost: NonNegativeMoneySchema,
});

/* ---------- Change log: before and after values, never a secret ---------- */

export const PROVIDER_CHANGE_OBJECTS = ['provider_connection', 'secret_ref', 'connection_test', 'model_route', 'egress_rule', 'provider_budget', 'model_pricing', 'kill_switch'] as const;
export const ProviderConfigChangeSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  objectType: z.enum(PROVIDER_CHANGE_OBJECTS),
  objectId: IdSchema,
  action: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/),
  /** Null only for the engine's own sweeps (a rotated secret's grace period ending). */
  actorPersonId: IdSchema.nullable(),
  reason: ShortTextSchema,
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  approvalId: IdSchema.nullable(),
  occurredAt: TimestampSchema,
});
export type ProviderConfigChange = z.infer<typeof ProviderConfigChangeSchema>;

/* ---------- Reason codes the console explains (locale keys `providers.reasons.<code>`) ---------- */

/** Refusals of the providers commands (database hints without their `providers.` prefix). */
export const PROVIDER_COMMAND_REASONS = [
  'restricted_place', 'endpoint_not_allowed', 'adapter_mode_fake_only', 'fake_holds_no_secret', 'secret_store_unconfigured', 'secret_required', 'secret_not_found',
  'credential_not_active', 'test_required', 'test_failed', 'connection_not_enabled', 'connection_killed', 'revision_conflict', 'invalid_transition', 'route_unpinned',
  'route_connection_unusable', 'route_outside_residency', 'route_fallbacks_forbidden', 'route_public_only', 'route_budget_unknown', 'drafter_cannot_activate',
  'egress_training', 'egress_broker', 'egress_not_in_residency', 'egress_retention', 'cap_currency', 'cap_scope_unknown', 'kill_engaged', 'kill_not_engaged',
  'pricing_currency', 'adapter_unavailable', 'decision_unknown',
] as const;
/** Every reason code a console page or a call refusal can show. */
export const PROVIDER_REASON_CODES = [...new Set([...PROVIDER_COMMAND_REASONS, ...CALL_REFUSAL_REASONS, ...PROVIDER_EGRESS_REASONS])] as const;
export type ProviderReasonCode = (typeof PROVIDER_REASON_CODES)[number];

/* ---------- Digests a second person approves ---------- */

/** `providers.enable_non_fake` for a connection: binds the adapter, mode, endpoint, hosting, secret and the passing test. */
export function connectionEnableDigestInput(c: {
  id: string; hubId: string; adapterId: string; mode: string; endpoint: string | null; hosting: ProviderHosting; storageCountry: string | null;
  secretFingerprint: string | null; credentialRefId: string | null; testId: string; revision: number;
}) {
  return {
    action: 'providers.enable_non_fake', object: 'provider_connection', hubId: c.hubId, connectionId: c.id, adapterId: c.adapterId, mode: c.mode, endpoint: c.endpoint,
    hosting: c.hosting, storageCountry: c.storageCountry, secretFingerprint: c.secretFingerprint, credentialRefId: c.credentialRefId, testId: c.testId, revision: c.revision,
  };
}
/** `models.activate_private_route`: binds the route version exactly as drafted. */
export function routeActivationDigestInput(r: {
  id: string; hubId: string; job: string; scope: RouteScope; version: number; primary: ModelRef; fallbacks: ModelRef[]; allowedDataClasses: string[]; limits: RouteLimits; budgetId: string | null;
}) {
  return {
    action: 'models.activate_private_route', object: 'model_route', hubId: r.hubId, routeId: r.id, job: r.job, scope: r.scope, version: r.version, primary: r.primary,
    fallbacks: r.fallbacks, allowedDataClasses: [...r.allowedDataClasses].sort(), limits: r.limits, budgetId: r.budgetId,
  };
}
/** `egress.allow_private_class`: binds the cell exactly. */
export function egressAllowDigestInput(r: { hubId: string; connectionId: string; dataClass: string; requireInResidency: boolean; requireZeroRetention: boolean; version: number }) {
  return {
    action: 'egress.allow_private_class', object: 'egress_rule', hubId: r.hubId, connectionId: r.connectionId, dataClass: r.dataClass, decision: 'allow',
    requireInResidency: r.requireInResidency, requireZeroRetention: r.requireZeroRetention, version: r.version,
  };
}
/** `kill_switch.release` of a providers switch: binds the switch and the incident note. */
export function providerKillReleaseDigestInput(k: { killSwitchId: string; incidentNote: string }) {
  return { action: 'kill_switch.release', killSwitchId: k.killSwitchId, incidentNote: k.incidentNote };
}
