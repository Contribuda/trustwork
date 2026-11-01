import { z } from 'zod';
import { IanaTimeZoneSchema, IdSchema, NameSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema } from './common/money.js';
import { ENGINE_TEMPLATE_LANGUAGES } from './communications.js';
import { EmailSchema, passwordSchema } from './identity.js';
import {
  AUTOMATION_DOMAINS, DataModeSchema, HubModuleSchema, KNOWN_MODEL_ADAPTERS, LocaleTagSchema, LocalizedNameSchema, ModerationStrictnessSchema,
  modesViolations, placeCodes, SETUP_STEPS, SetupStateSchema, SetupStepSchema, type ConsolePermission, type HubModes, type HubModule, type SetupState,
} from './hub.js';
import { TerritoryInputSchema, type DeploymentDocument, type LegalConfigPayload, type ResidencyConfigPayload } from './hub-core.js';
import { coveringRestrictedPlace, type RestrictedPlaces } from './sanctions.js';
import { AttestedGateModeSchema, DeploymentAttestationStatusSchema, deploymentLocationRefusals } from './sanctions-attestation.js';

/**
 * Setup wizard backend (HUB-004, docs/engine/hub-console/setup-wizard.md): the one-time setup token, the answers of
 * each step, the view the wizard reads, and the pure builders that turn the answers into HUB-001 configuration
 * payloads. Additive to the frozen console contract (`hub.ts`: `SETUP_STEPS`, `SetupStateSchema`, `nextSetupStep`);
 * nothing here changes a schema of it.
 *
 * The database (packages/data/migrations/setup) is the authority: it stores only the token's SHA-256 and expiry,
 * refuses a step ahead of the first incomplete one, refuses restricted places in every answer, binds the run to the
 * founding administrator and refuses to finish without a second factor and an attestation in force. These functions
 * let the API and the wizard explain a refusal before it happens; the tests compare both.
 */

/** The setup token travels in this header, never in an API path or query (the wizard page itself carries it as `?token=`). */
export const SETUP_TOKEN_HEADER = 'X-Trustwork-Setup-Token';
/** 32 random bytes, base64url without padding (43 characters). */
export const SetupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'setup token');
/** Default lifetime of a setup token printed by the installer (installation.md: "within 24 hours"). */
export const SETUP_TOKEN_TTL_HOURS = 24;

/** Engine interface languages a hub may choose (a regional variant such as `es-US` of one of them is allowed). */
export const SETUP_ENGINE_LANGUAGES = ENGINE_TEMPLATE_LANGUAGES;
const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');
const RegionCode = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'ISO 3166-2');
const HubSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/);
/** A host name without scheme, port or path (`build.example.org`, `localhost`). */
const DomainSchema = z.string().max(253).regex(/^(?=.{1,253}$)(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/, 'domain name');

/** The engine language a hub locale belongs to (`es-US` -> `es`, `uz-Latn` -> `uz-Latn`), or null. */
export function engineLanguageOf(tag: string): string | null {
  for (const lang of SETUP_ENGINE_LANGUAGES) if (tag === lang || tag.startsWith(`${lang}-`)) return lang;
  return null;
}

/* ---------- Install check ---------- */

export const INSTALL_CHECK_IDS = ['address', 'database', 'object_storage', 'worker', 'clock', 'secret_store'] as const;
export const InstallCheckIdSchema = z.enum(INSTALL_CHECK_IDS);
export const InstallCheckSchema = z.strictObject({
  id: InstallCheckIdSchema,
  state: z.enum(['pass', 'warn', 'fail']),
  /** An English machine reason the wizard explains from its locale files (`https_required`, `no_heartbeat_source`, ...). */
  reason: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).nullable(),
});
export type InstallCheck = z.infer<typeof InstallCheckSchema>;
/** Step 1: the browser's clock, so the server can compare it with its own (more than 30 seconds apart is a warning). */
export const InstallCheckAnswerSchema = z.strictObject({ clientTime: TimestampSchema });
export const CLOCK_SKEW_WARN_MS = 30_000;

/* ---------- Answers per step ---------- */

export const NodeIdentityAnswerSchema = z.strictObject({ nodeName: NameSchema, domain: DomainSchema, jurisdiction: CountryCode });
export type NodeIdentityAnswer = z.infer<typeof NodeIdentityAnswerSchema>;

/**
 * Step 3. A country is required (ADR 012: no default country): the hub starts from that country's pack or from the
 * generic profile; every territory lies in that country and is checked at country, region and place level.
 */
export const HubIdentityAnswerSchema = z.strictObject({
  country: CountryCode,
  startingPoint: z.enum(['pack', 'generic']),
  territories: z.array(TerritoryInputSchema).min(1).max(50),
  slug: HubSlug.optional(),
  name: LocalizedNameSchema,
  locales: z.array(LocaleTagSchema).min(1).max(12),
  defaultLocale: LocaleTagSchema,
  currency: CurrencySchema,
  timeZone: IanaTimeZoneSchema,
})
  .refine((h) => h.territories.every((t) => t.code.slice(0, 2) === h.country), { message: 'every territory lies in the hub country', path: ['territories'] })
  .refine((h) => new Set(h.territories.map((t) => t.code)).size === h.territories.length, { message: 'each territory once', path: ['territories'] })
  .refine((h) => new Set(h.locales).size === h.locales.length, { message: 'duplicate locale', path: ['locales'] })
  .refine((h) => h.locales.includes(h.defaultLocale), { message: 'default locale must be one of the hub locales', path: ['defaultLocale'] })
  .refine((h) => h.locales.every((l) => engineLanguageOf(l) !== null), { message: 'a hub language is an engine language or a regional variant of one', path: ['locales'] })
  .refine((h) => h.locales.every((l) => typeof h.name[l] === 'string'), { message: 'hub name is required in every hub locale', path: ['name'] });
export type HubIdentityAnswer = z.infer<typeof HubIdentityAnswerSchema>;

export const OPERATOR_FORMS = ['llc', 'corporation', 'nonprofit_association', 'sole_proprietor', 'limited_company'] as const;
/**
 * Step 4: the operator legal entity and the deployment-location statement (SANC-009: entity and hosting country, the
 * region where the restricted list distinguishes regions, and the jurisdiction-gate mode). The statement is attested
 * by the founding administrator when setup finishes, under their elevated session, as SANC-009 requires.
 */
export const OperatorAnswerSchema = z.strictObject({
  legalName: NameSchema,
  form: z.enum(OPERATOR_FORMS),
  identifier: z.string().trim().min(1).max(120),
  address: ShortTextSchema,
  legalContact: ShortTextSchema,
  abuseContact: ShortTextSchema,
  ownershipDeclared: z.literal(true),
  entityCountry: CountryCode,
  entityRegion: RegionCode.nullable(),
  hostingCountry: CountryCode,
  hostingRegion: RegionCode.nullable(),
  gateMode: AttestedGateModeSchema,
})
  .refine((o) => o.entityRegion === null || o.entityRegion.startsWith(`${o.entityCountry}-`), { message: 'the region lies in the entity country', path: ['entityRegion'] })
  .refine((o) => o.hostingRegion === null || o.hostingRegion.startsWith(`${o.hostingCountry}-`), { message: 'the region lies in the hosting country', path: ['hostingRegion'] });
export type OperatorAnswer = z.infer<typeof OperatorAnswerSchema>;

/** The operator's sanctions screening against the engine baseline lists (SANC-003 matcher); `fake` is labelled as such. */
export const OperatorScreeningSchema = z.strictObject({
  outcome: z.enum(['clear', 'possible_match', 'not_screened', 'insufficient_name']),
  basis: z.enum(['engine_baseline', 'fake']),
  matcherVersion: z.string().min(1).max(120),
  listVersionIds: z.array(IdSchema).max(50),
  matches: z.int().min(0),
  screenedAt: TimestampSchema,
});
export type OperatorScreening = z.infer<typeof OperatorScreeningSchema>;

/** Step 5a (before a session exists): the founding administrator's account; the e-mail is verified by the mailbox proof. */
export const FirstAdminAccountSchema = z.strictObject({ name: NameSchema, email: EmailSchema, password: passwordSchema() });
export type FirstAdminAccount = z.infer<typeof FirstAdminAccountSchema>;
/** Step 5b (signed in, second factor enrolled): bind the run to this person; the recovery codes were shown once by BE-004. */
export const FirstAdminAnswerSchema = z.strictObject({ secondFactor: z.enum(['totp', 'webauthn']), recoveryCodesStored: z.literal(true) });
export type FirstAdminAnswer = z.infer<typeof FirstAdminAnswerSchema>;

export const PRIVACY_REGIMES = ['us_state_privacy', 'uz_personal_data', 'not_recorded'] as const;
export const StorageResidencyAnswerSchema = z.strictObject({
  personalDataCountry: CountryCode,
  privacyRegime: z.enum(PRIVACY_REGIMES),
  note: ShortTextSchema.optional(),
});
export type StorageResidencyAnswer = z.infer<typeof StorageResidencyAnswerSchema>;

/** Capabilities the providers step lists; each starts on its fake adapter. */
export const SETUP_PROVIDER_CAPABILITIES = ['llm', 'email', 'sms', 'payments', 'maps_geocoding', 'register_lookup', 'e_signature', 'tax_calculation'] as const;
export const SetupProviderChoiceSchema = z.enum(['fake', 'manual', 'later']);
/** Model adapters a hub may choose to connect later: OpenRouter is one optional router next to the direct providers (ADR 012). */
export const SETUP_DIRECT_MODEL_ADAPTERS = KNOWN_MODEL_ADAPTERS.filter((a) => a !== 'fake' && a !== 'openrouter') as readonly ('openai' | 'anthropic' | 'google' | 'mistral' | 'openai_compatible')[];
export const ProvidersAnswerSchema = z.strictObject({
  capabilities: z.strictObject(Object.fromEntries(SETUP_PROVIDER_CAPABILITIES.map((c) => [c, SetupProviderChoiceSchema])) as Record<(typeof SETUP_PROVIDER_CAPABILITIES)[number], typeof SetupProviderChoiceSchema>),
  models: z.enum(['undecided', 'openrouter', 'direct']),
  directModelAdapter: z.enum(SETUP_DIRECT_MODEL_ADAPTERS as unknown as [string, ...string[]]).nullable(),
})
  .refine((p) => p.capabilities.llm !== 'manual', { message: 'a person cannot be a language model', path: ['capabilities', 'llm'] })
  .refine((p) => (p.models === 'direct') === (p.directModelAdapter !== null), { message: 'name the direct provider exactly when connecting one directly', path: ['directModelAdapter'] });
export type ProvidersAnswer = z.infer<typeof ProvidersAnswerSchema>;

/** Modules on by default (setup-wizard.md, step 8). */
export const DEFAULT_SETUP_MODULES: readonly HubModule[] = ['publications', 'magazine', 'events', 'search', 'communications'];
export const ModesAnswerSchema = z.strictObject({
  dataMode: DataModeSchema,
  modules: z.array(HubModuleSchema).max(40).optional(),
  moderation: ModerationStrictnessSchema.optional(),
});
export type ModesAnswer = z.infer<typeof ModesAnswerSchema>;

export const FinishSetupSchema = z.strictObject({ confirm: z.literal(true) });

/** The answer schema of each step saved through the generic save route (`first_admin` and `review` have their own routes). */
export const SETUP_ANSWER_SCHEMAS = {
  install_check: InstallCheckAnswerSchema,
  node_identity: NodeIdentityAnswerSchema,
  hub_identity: HubIdentityAnswerSchema,
  operator: OperatorAnswerSchema,
  storage_residency: StorageResidencyAnswerSchema,
  providers: ProvidersAnswerSchema,
  modes: ModesAnswerSchema,
} as const;
export type SavedSetupStep = keyof typeof SETUP_ANSWER_SCHEMAS;
export const SAVED_SETUP_STEPS = Object.keys(SETUP_ANSWER_SCHEMAS) as SavedSetupStep[];
export const SavedSetupStepSchema = z.enum(SAVED_SETUP_STEPS as [SavedSetupStep, ...SavedSetupStep[]]);

/* ---------- Restricted places ---------- */

const restrictedCode = (code: string, restricted: RestrictedPlaces): boolean => placeCodes(code).some((c) => coveringRestrictedPlace(c, restricted) !== null);

/**
 * Every restricted place an answer names, as `field:code` items (empty: none). A place inside a restricted region is
 * restricted too; the deployment-location statement also needs the region where the list distinguishes regions.
 */
export function setupPlaceRefusals(step: SavedSetupStep, answer: unknown, restricted: RestrictedPlaces): string[] {
  const out: string[] = [];
  const check = (field: string, code: string | null | undefined) => {
    if (typeof code === 'string' && restrictedCode(code, restricted)) out.push(`${field}:${code}`);
  };
  if (step === 'node_identity') check('jurisdiction', (answer as NodeIdentityAnswer).jurisdiction);
  if (step === 'hub_identity') {
    const h = answer as HubIdentityAnswer;
    check('country', h.country);
    for (const t of h.territories) check('territories', t.code);
  }
  if (step === 'operator') {
    const o = answer as OperatorAnswer;
    for (const r of deploymentLocationRefusals({ operatorEntityCountry: o.entityCountry, operatorEntityRegion: o.entityRegion, hostingCountry: o.hostingCountry, hostingRegion: o.hostingRegion }, restricted)) {
      const field = { operator_entity_country: 'entityCountry', operator_entity_region: 'entityRegion', hosting_country: 'hostingCountry', hosting_region: 'hostingRegion' }[r.field];
      out.push(r.reason === 'restricted' ? `${field}:${r.place}` : `${field}:region_required`);
    }
  }
  if (step === 'storage_residency') check('personalDataCountry', (answer as StorageResidencyAnswer).personalDataCountry);
  return [...new Set(out)];
}

/* ---------- The founding administrator ---------- */

/**
 * The permissions of `node-operator` version 1 as the setup wizard releases it when no definition of that role exists
 * yet (the engine's founding release of the role; the full capability map is the data integrator's). Node scope covers
 * every hub of the node, so the founding administrator can create the hub, draft its configuration, attest the
 * deployment location and invite the second staff member. The database holds the same list
 * (`setup_founding_permissions`, tested); every sensitive action still needs a second person.
 */
export const FOUNDING_NODE_OPERATOR_PERMISSIONS = [
  'admin.audit.read', 'admin.config.edit', 'admin.hub.country.edit', 'admin.hub.identity.edit', 'admin.hub.jurisdiction.edit', 'admin.hub.launch.check',
  'admin.hub.legal.edit', 'admin.hub.lifecycle.request', 'admin.hub.modes.edit', 'admin.hub.read', 'admin.hub.residency.edit', 'admin.node.hubs.manage',
  'admin.observability.read', 'admin.providers.connection.edit', 'admin.providers.read', 'admin.session.elevate', 'admin.staff.assign', 'admin.staff.read',
] as const satisfies readonly ConsolePermission[];
export const FOUNDING_ROLE = 'node-operator' as const;

/* ---------- The view the wizard reads ---------- */

export const SetupViewSchema = z.strictObject({
  state: SetupStateSchema,
  checks: z.array(InstallCheckSchema),
  /** Saved answers by step (the password is never stored; the operator screening result is the server's). */
  answers: z.partialRecord(SetupStepSchema, z.unknown()),
  operatorScreening: OperatorScreeningSchema.nullable(),
  /** The account the founding administrator created in step 5a, masked; null before. */
  adminAccount: z.strictObject({ maskedEmail: z.string().min(3).max(260) }).nullable(),
  /** Whether the caller's session is the founding administrator's (every later change needs it). */
  session: z.strictObject({ signedIn: z.boolean(), isFirstAdmin: z.boolean(), secondFactor: z.boolean() }),
  /** The deployment-location attestation as the launch gate reads it (SANC-009 `currentStatus()`), judged now. */
  attestation: DeploymentAttestationStatusSchema,
  hubId: IdSchema.nullable(),
});
export type SetupView = z.infer<typeof SetupViewSchema>;

export const FinishSetupResultSchema = z.strictObject({
  hubId: IdSchema,
  slug: HubSlug,
  attestationId: IdSchema,
  configVersions: z.array(z.strictObject({ domain: z.string(), versionId: IdSchema, status: z.enum(['active', 'draft']) })),
  /** The five things to do next (setup-wizard.md, step 9), as locale-key suffixes the console explains. */
  next: z.array(z.enum(['inviteStaff', 'legalDocuments', 'firstSource', 'verificationRecipe', 'backupDrill'])),
});
export type FinishSetupResult = z.infer<typeof FinishSetupResultSchema>;

/** Masks an address for the wizard view (`ad*****@example.org`). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}

/* ---------- From answers to HUB-001 configuration ---------- */

/** The hub slug: the answer's, or one derived from the most specific territory (`us-san-diego`). */
export function setupHubSlug(hub: HubIdentityAnswer): string {
  if (hub.slug) return hub.slug;
  const specific = [...hub.territories].sort((a, b) => b.code.length - a.code.length)[0]!.code;
  const slug = specific.toLowerCase().replace(/:/g, '-').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 41);
  return slug.length >= 2 ? slug : `${hub.country.toLowerCase()}-hub`;
}

/** CFG-001's deployment document for configuration version 1 of `identity` and `country` (HUB-001 `splitDeploymentConfig`). */
export function setupDeploymentDocument(node: NodeIdentityAnswer, hub: HubIdentityAnswer): DeploymentDocument {
  return {
    schemaVersion: 1,
    countries: { default: hub.country, offered: 'all' },
    languages: { default: hub.defaultLocale, enabled: [...hub.locales] },
    brand: { overlay: null },
    site: { url: `https://${node.domain}` },
  };
}

export function setupLegalPayload(operator: OperatorAnswer): LegalConfigPayload {
  return {
    operatorEntity: { name: operator.legalName, registrationRef: operator.identifier, legalNoticeContact: operator.legalContact },
    operatorEntityCountry: operator.entityCountry,
    operatorEntityRegion: operator.entityRegion,
  };
}

export function setupResidencyPayload(operator: OperatorAnswer, residency: StorageResidencyAnswer): ResidencyConfigPayload {
  return {
    hostingCountry: operator.hostingCountry,
    hostingRegion: operator.hostingRegion,
    personalDataCountries: [...new Set([operator.hostingCountry, residency.personalDataCountry])],
    ...(residency.note ? { note: residency.note } : {}),
  };
}

/** The `providers` payload: every capability fake (or manual) for now; "later" is recorded as an intention only. */
export function setupProvidersPayload(providers: ProvidersAnswer): Record<string, unknown> {
  return {
    schemaVersion: 1,
    capabilities: Object.fromEntries(SETUP_PROVIDER_CAPABILITIES.map((c) => [c, { mode: providers.capabilities[c] === 'manual' ? 'manual' : 'fake', connectLater: providers.capabilities[c] === 'later' }])),
    models: { route: providers.models, directAdapter: providers.directModelAdapter, optionalRouter: 'openrouter' },
  };
}

/** The hub's starting modes: registration closed, indexing off, every automation domain manual (`modesViolations` empty for a draft). */
export function setupModes(modes: ModesAnswer): HubModes {
  return {
    dataMode: modes.dataMode,
    registration: 'closed',
    modules: [...(modes.modules ?? DEFAULT_SETUP_MODULES)],
    moderation: modes.moderation ?? 'pre_moderate_new_authors',
    automation: Object.fromEntries(AUTOMATION_DOMAINS.map((d) => [d, 'manual'])) as HubModes['automation'],
    searchEngineIndexing: false,
    maintenance: false,
  };
}
export function setupModesProblems(modes: ModesAnswer): string[] {
  return modesViolations('draft', setupModes(modes));
}

/** The steps that must be complete before `step` may be saved (the wizard never skips ahead). */
export function stepsBefore(step: (typeof SETUP_STEPS)[number]): (typeof SETUP_STEPS)[number][] {
  return SETUP_STEPS.slice(0, SETUP_STEPS.indexOf(step));
}
export function canSaveStep(state: Pick<SetupState, 'completed'>, step: (typeof SETUP_STEPS)[number]): boolean {
  return stepsBefore(step).every((s) => state.completed.includes(s));
}
