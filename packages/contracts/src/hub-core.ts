import { z } from 'zod';
import { HubAgentPolicySchema } from './agent-catalog.js';
import { IdSchema, IanaTimeZoneSchema, NameSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { CurrencySchema } from './common/money.js';
import {
  consoleCommand, FORBIDDEN_CONTROL_WORDS, HubLifecycleSchema, HubModesSchema, HubPaymentSettingsSchema, JurisdictionCodeSchema, LaunchGateIdSchema,
  LocaleTagSchema, LocalizedNameSchema, looksLikeSecretValue, ProviderModeSchema, SecretStoreSchema,
  type ConsolePermission, type ConsoleSecondPersonAction, type HubConfigDomain, type HubLifecycle, type LaunchGateId,
} from './hub.js';

/**
 * Hubs core (HUB-001): the rules and commands that make the hub of the frozen console contract (`hub.ts`, HUBC-000) a
 * first-class object: which permission drafts each configuration domain, which second-person action activates each
 * sensitive domain, the digests a second person approves, the payload shapes HUB-001 checks, the CFG-001 deployment
 * document as configuration version 1, and the staff commands of `/v1/admin/hubs`. Additive only: nothing here changes
 * a schema of `hub.ts`.
 *
 * The database (packages/data/migrations/hubs) is the authority for every rule; these functions let the API and the
 * console explain a refusal before it happens, and the tests compare both.
 */

/* ---------- Who drafts and who activates ---------- */

/** The permission that drafts a version of each domain (and activates a non-sensitive one); `admin.config.edit` works for every domain. */
export const CONFIG_DOMAIN_PERMISSIONS: Readonly<Record<HubConfigDomain, ConsolePermission>> = {
  identity: 'admin.hub.identity.edit', modes: 'admin.hub.modes.edit', legal: 'admin.hub.legal.edit', residency: 'admin.hub.residency.edit', country: 'admin.hub.country.edit',
  sources: 'admin.sources.manage', verification: 'admin.claims.policy.edit', screening: 'admin.hub.jurisdiction.edit', editorial: 'admin.editorial.calendar.edit',
  events: 'admin.events.policy.edit', learning: 'admin.learning.review', matching: 'admin.matching.policy.edit', commerce: 'admin.commerce.offer.edit', tax: 'admin.currency.edit',
  payments: 'admin.hub.payments.edit', agents: 'admin.agents.policy.edit', agent_extensions: 'admin.agents.extensions.edit', jurisdiction: 'admin.hub.jurisdiction.edit',
  communications: 'admin.notifications.template.edit', privacy: 'admin.privacy.retention.edit', federation: 'admin.federation.peer.edit',
  providers: 'admin.providers.connection.edit', routing: 'admin.models.route.edit', egress: 'admin.providers.egress.edit', budgets: 'admin.providers.budget.edit',
};
export function configDraftPermissions(domain: HubConfigDomain): ConsolePermission[] {
  return [CONFIG_DOMAIN_PERMISSIONS[domain], 'admin.config.edit'];
}

/**
 * The console action whose second-person approval activates each sensitive domain (exactly `SENSITIVE_CONFIG_DOMAINS`).
 * The vocabulary has no dedicated retention action: activating privacy settings changes when the sweeper erases data,
 * so it is bound to the erasure action and its permission (a dedicated action is a contract follow-up).
 */
export const CONFIG_DOMAIN_SECOND_PERSON_ACTIONS: Readonly<Partial<Record<HubConfigDomain, ConsoleSecondPersonAction>>> = {
  legal: 'legal.activate_document_version', residency: 'hub.change_residency', providers: 'providers.enable_non_fake', egress: 'egress.allow_private_class',
  federation: 'federation.raise_peering_level', agents: 'agents.enable_commitment_module', agent_extensions: 'agents.activate_extension',
  jurisdiction: 'jurisdiction.activate_settings', payments: 'payments.change_settings', privacy: 'privacy.execute_erasure',
};
export function configActivationAction(domain: HubConfigDomain): ConsoleSecondPersonAction | null {
  return CONFIG_DOMAIN_SECOND_PERSON_ACTIONS[domain] ?? null;
}

/** Transitions that need a second person. */
export const LIFECYCLE_SECOND_PERSON_ACTIONS: Readonly<Partial<Record<HubLifecycle, ConsoleSecondPersonAction>>> = {
  soft_launch: 'hub.transition_soft_launch',
  public: 'hub.transition_public',
};
export function transitionAction(to: HubLifecycle): ConsoleSecondPersonAction | null {
  return LIFECYCLE_SECOND_PERSON_ACTIONS[to] ?? null;
}

/** The passed gates a newly activated version of a domain re-opens (`invalidated` until a person checks them again). */
export const CONFIG_DOMAIN_GATES: Readonly<Partial<Record<HubConfigDomain, readonly LaunchGateId[]>>> = {
  legal: ['operator_recorded_and_screened'], residency: ['data_residency_configured'], screening: ['sanctions_screening_configured'],
  sources: ['information_source_registered'], verification: ['verification_recipe_enabled'], editorial: ['editorial_team_and_policy'], egress: ['ai_egress_policy_reviewed'],
};

/* ---------- The digests a second person approves (the database computes the same bytes) ---------- */

export function configActivationDigestInput(v: { id: string; hubId: string; domain: HubConfigDomain; version: number; payloadDigest: string }) {
  return { action: configActivationAction(v.domain), object: 'hub_config_version', hubId: v.hubId, domain: v.domain, versionId: v.id, version: v.version, payloadDigest: v.payloadDigest };
}
export function lifecycleTransitionDigestInput(t: { hubId: string; from: HubLifecycle; to: 'soft_launch' | 'public'; revision: number }) {
  return { action: transitionAction(t.to), object: 'hub', hubId: t.hubId, from: t.from, to: t.to, revision: t.revision };
}
export function legalActivationDigestInput(d: { id: string; hubId: string; kind: LegalDocumentKind; locale: string; version: number; bodyDigest: string; counselApprovalId: string }) {
  return {
    action: 'legal.activate_document_version', object: 'legal_document_version', hubId: d.hubId, documentVersionId: d.id, kind: d.kind, locale: d.locale, version: d.version,
    bodyDigest: d.bodyDigest, counselApprovalId: d.counselApprovalId,
  };
}
export function credentialActivationDigestInput(c: { id: string; hubId: string; provider: string; adapter: string; mode: 'manual' | 'live'; secretStore: string; secretRef: string }) {
  return {
    action: 'providers.enable_non_fake', object: 'provider_credential_ref', hubId: c.hubId, credentialId: c.id, provider: c.provider, adapter: c.adapter, mode: c.mode,
    secretStore: c.secretStore, secretRef: c.secretRef,
  };
}

/* ---------- Payloads ---------- */

/**
 * Keys no configuration payload may contain, at any depth: no hub setting widens data access (reads private data,
 * grants a role or a permission, bypasses a policy) or sets a ranking (score, rank, position, badge, weight, boost).
 */
export const ACCESS_WIDENING_KEY = /(bypass|impersonat|permission|grant|role|visib|audience|case_?access|share_?with|expose|unrestrict|superuser|row_?level|(^|_)rls|private_?(read|access|data_?access)|read_?private|staff_?(read|access)|access_?(widen|level|override))/i;
/** Every key (at any depth) of a payload that would widen data access or set a ranking. */
export function forbiddenConfigKeys(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (ACCESS_WIDENING_KEY.test(key) || FORBIDDEN_CONTROL_WORDS.test(key)) out.add(key);
        walk(inner);
      }
    }
  };
  walk(payload);
  return [...out].sort();
}

const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');
const RegionCode = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/, 'ISO 3166-2');
/** A canonical BCP 47 tag, the grammar of CFG-001's `LanguageTagSchema` (packages/config/src/schema.ts). */
const LanguageTag = z.string().min(2).max(35).refine((tag) => {
  try {
    return Intl.getCanonicalLocales(tag)[0] === tag;
  } catch {
    return false;
  }
}, 'canonical BCP 47 language tag');
const BrandId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);
const DEPLOYMENT_SCHEMA_VERSION = 1;

/**
 * `identity` domain: the deployment's languages, brand overlay and site (CFG-001 `languages`, `brand`, `site`). Same
 * grammar and the same `schemaVersion` as `trustwork.config.json`, so the active version can be handed to the CFG-001
 * loader (`joinDeploymentConfig`).
 */
export const IdentityConfigPayloadSchema = z.strictObject({
  schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
  languages: z.strictObject({
    default: LanguageTag.optional(),
    enabled: z.union([z.literal('all'), z.array(LanguageTag).min(1)]).optional(),
    byCountry: z.record(CountryCode, LanguageTag).optional(),
  }).optional(),
  brand: z.strictObject({ overlay: BrandId.nullable() }).optional(),
  site: z.strictObject({ url: z.url({ protocol: /^https?$/ }).optional() }).optional(),
});
export type IdentityConfigPayload = z.infer<typeof IdentityConfigPayloadSchema>;
/** `country` domain: the countries a visitor may choose and the default one (CFG-001 `countries`). */
export const CountryConfigPayloadSchema = z.strictObject({
  schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
  countries: z.strictObject({
    default: CountryCode.nullable().optional(),
    offered: z.union([z.literal('all'), z.array(CountryCode).min(1)]).optional(),
    featured: z.array(CountryCode).optional(),
  }).optional(),
});
export type CountryConfigPayload = z.infer<typeof CountryConfigPayloadSchema>;
/** `residency` domain: where personal data is stored and processed; checked against the deployment-location attestation. */
export const ResidencyConfigPayloadSchema = z.strictObject({
  hostingCountry: CountryCode,
  hostingRegion: RegionCode.nullable(),
  personalDataCountries: z.array(CountryCode).min(1).max(20),
  note: ShortTextSchema.optional(),
}).refine((r) => r.hostingRegion === null || r.hostingRegion.startsWith(`${r.hostingCountry}-`), { message: 'the region lies in the hosting country', path: ['hostingRegion'] })
  .refine((r) => r.personalDataCountries.includes(r.hostingCountry), { message: 'personal data is stored where the hosting is', path: ['personalDataCountries'] });
export type ResidencyConfigPayload = z.infer<typeof ResidencyConfigPayloadSchema>;
/** `legal` domain: the operator legal entity (the launch gate `operator_recorded_and_screened` rests on it). */
export const LegalConfigPayloadSchema = z.strictObject({
  operatorEntity: z.strictObject({ name: NameSchema, registrationRef: z.string().min(1).max(120).nullable(), legalNoticeContact: ShortTextSchema }),
  operatorEntityCountry: CountryCode,
  operatorEntityRegion: RegionCode.nullable(),
}).refine((l) => l.operatorEntityRegion === null || l.operatorEntityRegion.startsWith(`${l.operatorEntityCountry}-`), { message: 'the region lies in the country', path: ['operatorEntityRegion'] });
export type LegalConfigPayload = z.infer<typeof LegalConfigPayloadSchema>;
/** A place a hub's own law closes (ADR 014 decision 2): add only, with a cited legal basis, activated by a second person. */
export const AddedRestrictedPlaceSchema = z.strictObject({
  code: JurisdictionCodeSchema,
  legalBasis: z.strictObject({ citation: z.string().min(3).max(500), url: z.url().nullable() }),
});
/**
 * `jurisdiction` domain. HUB-001 owns `addedRestrictedPlaces`; the per-jurisdiction settings (agent disclosure,
 * liability, consent, record-keeping, action limits) are HUB-005's and pass through unchanged here.
 */
export const JurisdictionConfigPayloadSchema = z.looseObject({
  addedRestrictedPlaces: z.array(AddedRestrictedPlaceSchema).max(200).optional(),
}).refine((j) => new Set((j.addedRestrictedPlaces ?? []).map((p) => p.code)).size === (j.addedRestrictedPlaces ?? []).length, {
  message: 'each place once', path: ['addedRestrictedPlaces'],
});
export type JurisdictionConfigPayload = z.infer<typeof JurisdictionConfigPayloadSchema>;
/** Retention classes of docs/data/retention-and-privacy.md section 2. */
export const RETENTION_CLASSES = [
  'ephemeral', 'session', 'operational', 'account', 'published', 'commercial', 'accounting', 'evidence', 'verification', 'consent_proof', 'case', 'audit_long',
  'audit_standard', 'conversation', 'derived', 'tombstone', 'config',
] as const;
export const RetentionClassSchema = z.enum(RETENTION_CLASSES);
/** ISO 8601 date durations (`P7Y`, `P90D`, `P1Y6M`). */
export const IsoDurationSchema = z.string().regex(/^P(?=\d)(\d{1,4}Y)?(\d{1,4}M)?(\d{1,5}D)?$/, 'ISO 8601 duration such as P7Y or P90D');
const durationDays = (d: string): number => {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/.exec(d);
  return m ? Number(m[1] ?? 0) * 360 + Number(m[2] ?? 0) * 30 + Number(m[3] ?? 0) : Number.NaN;
};
/** `privacy` domain: retention per class inside the pack's bounds; activation derives the `retention_policy` rows. */
export const PrivacyConfigPayloadSchema = z.strictObject({
  retention: z.array(z.strictObject({
    class: RetentionClassSchema,
    minPeriod: IsoDurationSchema.nullable(),
    maxPeriod: IsoDurationSchema.nullable(),
    packFactRef: z.strictObject({ packCode: CountryCode, packVersion: z.string().min(1).max(40), factKey: z.string().regex(/^[a-z0-9][A-Za-z0-9_./:-]{1,160}$/) }).nullable(),
    disclosureTextKey: z.string().regex(/^[a-z][A-Za-z0-9_.-]{1,120}$/).nullable(),
  }).refine((r) => r.minPeriod === null || r.maxPeriod === null || durationDays(r.minPeriod) <= durationDays(r.maxPeriod), { message: 'minPeriod <= maxPeriod', path: ['maxPeriod'] }))
    .max(RETENTION_CLASSES.length),
  breachContact: ShortTextSchema.optional(),
}).refine((p) => new Set(p.retention.map((r) => r.class)).size === p.retention.length, { message: 'each class once', path: ['retention'] });
export type PrivacyConfigPayload = z.infer<typeof PrivacyConfigPayloadSchema>;

/** Domains whose payload HUB-001 (or the contract it reuses) knows; others are objects checked by the generic rules. */
export const CONFIG_PAYLOAD_SCHEMAS: Readonly<Partial<Record<HubConfigDomain, z.ZodType>>> = {
  identity: IdentityConfigPayloadSchema, country: CountryConfigPayloadSchema, residency: ResidencyConfigPayloadSchema, legal: LegalConfigPayloadSchema,
  jurisdiction: JurisdictionConfigPayloadSchema, privacy: PrivacyConfigPayloadSchema, modes: HubModesSchema, payments: HubPaymentSettingsSchema, agents: HubAgentPolicySchema,
};
const GenericPayloadSchema = z.record(z.string().min(1).max(100), z.unknown());
const MAX_PAYLOAD_BYTES = 65_536;

/** Every problem with a payload for a domain, as `path: message` lines (empty: acceptable to the API). */
export function configPayloadProblems(domain: HubConfigDomain, payload: unknown): string[] {
  const problems: string[] = [];
  const parsed = (CONFIG_PAYLOAD_SCHEMAS[domain] ?? GenericPayloadSchema).safeParse(payload);
  if (!parsed.success) for (const issue of parsed.error.issues) problems.push(`${issue.path.join('.') || '(payload)'}: ${issue.message}`);
  if (payload !== null && typeof payload === 'object' && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) problems.push(`(payload): larger than ${MAX_PAYLOAD_BYTES} bytes`);
  const forbidden = forbiddenConfigKeys(payload);
  if (forbidden.length) problems.push(`(payload): keys that would widen data access or set a ranking: ${forbidden.join(', ')}`);
  return problems;
}

/* ---------- CFG-001 deployment settings as configuration version 1 ---------- */

/** A deployment document as the API accepts it for import (the CFG-001 grammar; `dataDir` and `$schema` are ignored). */
export const DeploymentDocumentSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
  revision: z.strictObject({ number: z.int().positive(), note: z.string().max(500).optional() }).optional(),
  countries: CountryConfigPayloadSchema.shape.countries,
  languages: IdentityConfigPayloadSchema.shape.languages,
  brand: IdentityConfigPayloadSchema.shape.brand,
  site: IdentityConfigPayloadSchema.shape.site,
  dataDir: z.string().min(1).optional(),
});
/** The parts of `trustwork.config.json` a hub versions: everything except `dataDir` (a path of the installation). */
export type DeploymentDocument = z.infer<typeof DeploymentDocumentSchema>;
const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
/** Splits a deployment document into the `identity` and `country` payloads of configuration version 1. */
export function splitDeploymentConfig(doc: DeploymentDocument): { identity: IdentityConfigPayload; country: CountryConfigPayload } {
  return {
    identity: strip({ schemaVersion: 1 as const, languages: doc.languages, brand: doc.brand, site: doc.site }),
    country: strip({ schemaVersion: 1 as const, countries: doc.countries }),
  };
}
/** Joins the active `identity` and `country` payloads back into a document the CFG-001 loader reads. */
export function joinDeploymentConfig(identity: IdentityConfigPayload | null, country: CountryConfigPayload | null): DeploymentDocument {
  return strip({ schemaVersion: 1 as const, languages: identity?.languages, brand: identity?.brand, site: identity?.site, countries: country?.countries });
}
/* ---------- Legal documents ---------- */

export const LEGAL_DOCUMENT_KINDS = ['terms', 'privacy_notice', 'sanctions_section', 'cookie_notice', 'community_rules', 'organizer_terms', 'author_terms', 'notice_at_collection', 'do_not_sell_notice'] as const;
export const LegalDocumentKindSchema = z.enum(LEGAL_DOCUMENT_KINDS);
export type LegalDocumentKind = z.infer<typeof LegalDocumentKindSchema>;
/** Documents the `legal_documents_counsel_approved` gate requires in every hub language. */
export const COUNSEL_GATE_DOCUMENT_KINDS: readonly LegalDocumentKind[] = ['terms', 'privacy_notice', 'sanctions_section'];
export const LegalAcceptanceContextSchema = z.enum(['signup', 'checkout', 'hosting', 'authoring', 'peering']);
/** An active legal text of the hub as everyone may read it, signed in or not (`GET /v1/legal`, QA-002 D4). */
export const PublicLegalDocumentSchema = z.strictObject({
  id: IdSchema,
  hubId: IdSchema,
  kind: LegalDocumentKindSchema,
  locale: LocaleTagSchema,
  version: z.int().min(1),
  body: z.string().min(1).max(200_000),
  bodyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  activatedAt: TimestampSchema.nullable(),
});
export type PublicLegalDocument = z.infer<typeof PublicLegalDocumentSchema>;
/**
 * The active legal texts of the hub this API serves (`TRUSTWORK_HUB_ID`). `hubConfigured` is false when the API serves
 * no hub; an empty list means nothing is active yet (before soft launch, or no version activated): pages then show a
 * labelled draft notice instead of any text, and sign-up records that no terms version was active.
 */
export const PublicLegalDocumentsSchema = z.strictObject({ hubConfigured: z.boolean(), documents: z.array(PublicLegalDocumentSchema) });
export type PublicLegalDocuments = z.infer<typeof PublicLegalDocumentsSchema>;
/** The acceptedTermsVersion a sign-up records while the hub has no active terms: never a version string that looks final. */
export const NO_ACTIVE_TERMS_VERSION = 'no-active-terms';
/** The acceptedTermsVersion of an active terms text: its document id, which names the exact text (body and digest). */
export function termsAcceptanceVersion(document: Pick<PublicLegalDocument, 'id'>): string {
  return document.id;
}

/* ---------- Commands (strict console commands of contract 1.0.0) ---------- */

const PlaceTerritorySchema = z.discriminatedUnion('level', [
  z.strictObject({ level: z.literal('country'), code: CountryCode }),
  z.strictObject({ level: z.literal('region'), code: RegionCode }),
  z.strictObject({ level: z.literal('place'), code: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?:[a-z0-9][a-z0-9-]{0,62}$/) }),
]);
export const TerritoryInputSchema = PlaceTerritorySchema;
export type TerritoryInput = z.infer<typeof TerritoryInputSchema>;
const HubProfileShape = {
  name: LocalizedNameSchema,
  defaultLocale: LocaleTagSchema,
  locales: z.array(LocaleTagSchema).min(1).max(12),
  timeZone: IanaTimeZoneSchema,
  currency: CurrencySchema,
};
const profileRefinements = <T extends z.ZodType<{ defaultLocale: string; locales: string[]; name: Record<string, string> }>>(schema: T) => schema
  .refine((h) => h.locales.includes(h.defaultLocale), { message: 'default locale must be one of the hub locales', path: ['defaultLocale'] })
  .refine((h) => new Set(h.locales).size === h.locales.length, { message: 'duplicate locale', path: ['locales'] })
  .refine((h) => h.locales.every((l) => typeof h.name[l] === 'string'), { message: 'hub name is required in every hub locale', path: ['name'] });

/** Create a hub on this node (node staff with `admin.node.hubs.manage`); it starts as a `draft` with every launch gate open. */
export const CreateHubCommandSchema = profileRefinements(consoleCommand({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  ...HubProfileShape,
  countryPack: z.strictObject({ code: CountryCode, version: z.string().min(1).max(40) }).nullable(),
  territories: z.array(TerritoryInputSchema).min(1).max(200),
}));
export type CreateHubCommand = z.infer<typeof CreateHubCommandSchema>;
export const UpdateHubProfileCommandSchema = profileRefinements(consoleCommand({ ...HubProfileShape, brandOverlay: BrandId.nullable(), expectedRevision: RevisionSchema }));
export type UpdateHubProfileCommand = z.infer<typeof UpdateHubProfileCommandSchema>;
export const AddTerritoryCommandSchema = consoleCommand({ territory: TerritoryInputSchema });
export const PlainHubCommandSchema = consoleCommand({});
export const DraftConfigVersionCommandSchema = consoleCommand({ domain: z.enum(Object.keys(CONFIG_DOMAIN_PERMISSIONS) as [HubConfigDomain, ...HubConfigDomain[]]), payload: z.record(z.string(), z.unknown()) });
export type DraftConfigVersionCommand = z.infer<typeof DraftConfigVersionCommandSchema>;
/** Activation of a configuration version (the frozen `ActivateVersionCommand` restricted to `hub_config_version`). */
export const ActivateConfigVersionCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, approvalId: IdSchema.nullable(), effectiveFrom: TimestampSchema.optional() });
export type ActivateConfigVersionCommand = z.infer<typeof ActivateConfigVersionCommandSchema>;
/** Import the deployment settings (CFG-001) as configuration version 1 of `identity` and `country`. */
export const ImportDeploymentCommandSchema = consoleCommand({ deployment: DeploymentDocumentSchema });
export type ImportDeploymentCommand = z.infer<typeof ImportDeploymentCommandSchema>;
export const TransitionHubCommandSchema = consoleCommand({ to: HubLifecycleSchema, expectedRevision: RevisionSchema, approvalId: IdSchema.nullable() });
export type TransitionHubCommand = z.infer<typeof TransitionHubCommandSchema>;
export const CheckLaunchGateCommandSchema = consoleCommand({ gate: LaunchGateIdSchema, evidenceRef: IdSchema });
export const InvalidateLaunchGateCommandSchema = consoleCommand({ gate: LaunchGateIdSchema });
export const DraftLegalDocumentCommandSchema = consoleCommand({ kind: LegalDocumentKindSchema, locale: LocaleTagSchema, body: z.string().min(1).max(200_000) });
export const RecordCounselApprovalCommandSchema = consoleCommand({
  documentVersionIds: z.array(IdSchema).min(1).max(100),
  counselName: NameSchema,
  firm: NameSchema,
  approvedOn: z.iso.date(),
  scopeNote: z.string().min(1).max(1000),
}).refine((c) => new Set(c.documentVersionIds).size === c.documentVersionIds.length, { message: 'each document once', path: ['documentVersionIds'] });
export const ActivateLegalDocumentCommandSchema = consoleCommand({ expectedRevision: RevisionSchema, approvalId: IdSchema.nullable() });
export const AcceptLegalDocumentCommandSchema = z.strictObject({ context: LegalAcceptanceContextSchema });
export const RegisterCredentialCommandSchema = consoleCommand({
  provider: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  adapter: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  mode: ProviderModeSchema,
  secret: z.strictObject({ store: SecretStoreSchema, ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/) }),
}).refine((c) => !looksLikeSecretValue(c.secret.ref), { message: 'ref must name a secret, not contain one', path: ['secret', 'ref'] });
export const ActivateCredentialCommandSchema = consoleCommand({ approvalId: IdSchema.nullable() });

/* ---------- Read models ---------- */

export const LaunchChecklistSchema = z.strictObject({
  hubId: IdSchema,
  lifecycle: HubLifecycleSchema,
  gates: z.array(z.strictObject({
    gate: LaunchGateIdSchema, state: z.enum(['open', 'passed', 'invalidated']), requiredFor: z.enum(['soft_launch', 'public']), engineConfirms: z.boolean(),
    evidenceRef: IdSchema.nullable(), checkedBy: IdSchema.nullable(), checkedAt: TimestampSchema.nullable(), invalidationReason: ShortTextSchema.nullable(),
  })),
  blockers: z.strictObject({ soft_launch: z.array(z.string()), public: z.array(z.string()) }),
});
export type LaunchChecklist = z.infer<typeof LaunchChecklistSchema>;
