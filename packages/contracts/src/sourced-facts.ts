import { z } from 'zod';
import { AllowedUsesSchema } from './hub.js';

/**
 * Public-register and licence-board facts as sourced records (REG-001; docs/engine/discovery-and-outreach.md section 3,
 * ADR 026). A fact says what an official register showed about an identifier at a moment: licence status, entity
 * status, SAM.gov registration or exclusion, a safety inspection, an LEI record or an official grade. It is never the
 * hub's own judgement:
 *
 * - it is linked to a company only through an identifier the company holds (kind and value), never by name; facts
 *   whose register has no identifier (OSHA inspections) stay unlinked until a person links them with a reason;
 * - it is shown only when the licence snapshot taken at observation allows display and the holder is an organisation;
 *   past `validUntil` it is labelled stale;
 * - its value carries no natural person's name or contact data (strict value shapes; adapters drop such columns);
 * - it never feeds a reputation snapshot, ranking or matching;
 * - wording never claims that the hub certified, licensed, verified or approved anyone.
 *
 * The database twin lives in packages/data/migrations/registers; vocabularies are tested against it.
 */

export const SOURCED_FACT_KINDS = ['licence_status', 'entity_status', 'sam_registration', 'sam_exclusion', 'safety_inspection', 'lei_record', 'official_rating'] as const;
export const SourcedFactKindSchema = z.enum(SOURCED_FACT_KINDS);
export type SourcedFactKind = z.infer<typeof SourcedFactKindSchema>;

export const SOURCED_FACT_METHODS = ['register_api', 'structured_feed', 'manual'] as const;
export const HOLDER_KINDS = ['organisation', 'natural_person', 'unknown'] as const;

/**
 * Identifier kinds follow the country-pack pattern (`US-UEI`, `US-CA-CSLB`). `XX-LEI` is the Legal Entity Identifier of
 * the Global LEI System (ISO 17442), which belongs to no country: XX is an ISO 3166-1 user-assigned code.
 */
export const SourcedIdentifierKindSchema = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?-[A-Z][A-Z0-9]{1,11}$/, 'identifier kind');
export const LEI_IDENTIFIER_KIND = 'XX-LEI';
export const IdentifierValueSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,63}$/, 'identifier value');

/** Identifier values compare case-insensitively without spaces, dots, slashes or dashes. */
export function normaliseIdentifier(value: string): string {
  return value.toUpperCase().replace(/[\s./-]/g, '');
}

const DateSchema = z.iso.date();
const CodeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/);
/** A licence classification code (`B`, `C-10`): no spaces, so it cannot hold a sentence. */
const ClassificationSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/);

/** Value shapes per kind. Strict: a value never has room for a person's name, address, phone or e-mail. */
export const SourcedFactValueSchemas = {
  licence_status: z.strictObject({
    status: z.enum(['active', 'inactive', 'suspended', 'revoked', 'expired']),
    classifications: z.array(ClassificationSchema).max(30),
    issuedOn: DateSchema.nullable(),
  }),
  entity_status: z.strictObject({
    status: z.enum(['active', 'inactive', 'dissolved', 'suspended']),
    entityType: z.enum(['corporation', 'llc', 'partnership', 'sole_proprietor', 'nonprofit', 'other']),
  }),
  sam_registration: z.strictObject({
    status: z.enum(['active', 'inactive', 'expired']),
    purpose: z.enum(['all_awards', 'financial_assistance_only']),
  }),
  sam_exclusion: z.strictObject({
    status: z.enum(['excluded', 'not_excluded']),
    exclusionType: z.enum(['ineligible_proceedings_pending', 'ineligible_proceedings_completed', 'prohibition_restriction', 'voluntary_exclusion']).nullable(),
  }),
  safety_inspection: z.strictObject({
    inspectionRef: CodeSchema,
    openedOn: DateSchema,
    inspectionType: z.enum(['planned', 'complaint', 'accident', 'referral', 'follow_up', 'other']),
    status: z.enum(['open', 'closed']),
    citations: z.number().int().min(0).max(999),
  }),
  lei_record: z.strictObject({
    registrationStatus: z.enum(['issued', 'lapsed', 'retired', 'annulled', 'pending_transfer', 'pending_archival', 'merged', 'duplicate']),
    entityStatus: z.enum(['active', 'inactive']),
  }),
  official_rating: z.strictObject({
    scheme: CodeSchema,
    grade: CodeSchema,
  }),
} as const satisfies Record<SourcedFactKind, z.ZodType>;

/** The identifier the register keyed the record by; both null for registers without one (a reviewed link is needed). */
export const SourcedFactSubjectSchema = z.strictObject({
  identifierKind: SourcedIdentifierKindSchema.nullable(),
  identifierValue: IdentifierValueSchema.nullable(),
  holderKind: z.enum(HOLDER_KINDS),
}).refine((s) => (s.identifierKind === null) === (s.identifierValue === null), 'identifier kind and value come together');

const observation = <K extends SourcedFactKind>(kind: K) => z.strictObject({
  kind: z.literal(kind),
  subject: SourcedFactSubjectSchema,
  value: SourcedFactValueSchemas[kind],
  /** The register's own key for the record (licence number, inspection number, LEI). */
  recordRef: CodeSchema,
  link: z.url({ protocol: /^https$/ }).max(2000),
  observedAt: z.iso.datetime({ offset: true }),
  validUntil: DateSchema.nullable(),
});

/** One observation an adapter hands over: everything but what the hub adds (ids, licence snapshot, link to a company). */
export const SourcedObservationSchema = z.discriminatedUnion('kind', [
  observation('licence_status'), observation('entity_status'), observation('sam_registration'), observation('sam_exclusion'),
  observation('safety_inspection'), observation('lei_record'), observation('official_rating'),
]);
export type SourcedObservation = z.infer<typeof SourcedObservationSchema>;

export const SourcedFactSchema = z.strictObject({
  id: z.uuid(),
  hubId: z.uuid(),
  adapter: z.string(),
  sourceId: z.uuid(),
  method: z.enum(SOURCED_FACT_METHODS),
  kind: SourcedFactKindSchema,
  subject: SourcedFactSubjectSchema,
  value: z.record(z.string(), z.unknown()),
  recordRef: CodeSchema,
  link: z.url(),
  licenceSnapshot: AllowedUsesSchema,
  observedAt: z.iso.datetime({ offset: true }),
  validUntil: DateSchema.nullable(),
});
export type SourcedFact = z.infer<typeof SourcedFactSchema>;

/* ---------- Register adapters catalogue ---------- */

export type RegisterAdapter = {
  readonly id: string;
  readonly kinds: readonly SourcedFactKind[];
  /** The identifier the register answers for; null when it has none (facts need a reviewed link). */
  readonly identifierKind: string | null;
  /** Fact id of the register in the country pack, when the pack lists it. */
  readonly packRegister: string | null;
  readonly access: 'file' | 'api';
  readonly method: (typeof SOURCED_FACT_METHODS)[number];
  /** What the operator must confirm before live use (the pack records the licence where it is known). */
  readonly dataLicence: string;
  /** Default refresh cadence in days (a hub setting may only shorten it). */
  readonly refreshDays: number;
  /** Adapters never call out without an operator's key and a second person; this is what runs without them. */
  readonly withoutCredentials: 'fake' | 'not_run';
};

/**
 * Register adapters that exist in engine code. Each runs as a deterministic fake until a hub activates live mode with
 * a credential reference and a second person's approval. Licences are stated as what an operator must confirm, not as
 * a conclusion. Where a register applies comes from the country pack that lists it (`packRegister`), never from here.
 */
export const REGISTER_ADAPTERS: readonly RegisterAdapter[] = [
  { id: 'us_ca_cslb_licence_file', kinds: ['licence_status'], identifierKind: 'US-CA-CSLB', packRegister: 'ca-cslb-public-data',
    access: 'file', method: 'structured_feed', dataLicence: 'state public record; confirm the CSLB data portal terms', refreshDays: 7, withoutCredentials: 'fake' },
  { id: 'us_sam_entity', kinds: ['sam_registration', 'sam_exclusion'], identifierKind: 'US-UEI', packRegister: 'sam-entity-registrations',
    access: 'api', method: 'register_api', dataLicence: 'US federal public data; SAM.gov API terms and key', refreshDays: 30, withoutCredentials: 'fake' },
  { id: 'us_osha_inspections', kinds: ['safety_inspection'], identifierKind: null, packRegister: null,
    access: 'file', method: 'structured_feed', dataLicence: 'US federal public data; DOL enforcement data terms', refreshDays: 30, withoutCredentials: 'fake' },
  { id: 'gleif_lei', kinds: ['lei_record'], identifierKind: LEI_IDENTIFIER_KIND, packRegister: null,
    access: 'api', method: 'register_api', dataLicence: 'GLEIF data under CC0 1.0; confirm current GLEIF terms', refreshDays: 30, withoutCredentials: 'fake' },
];

export function findRegisterAdapter(id: string): RegisterAdapter | null {
  return REGISTER_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/* ---------- Display ---------- */

export type FactDisplay = { shown: false; reason: 'licence' | 'natural_person' } | { shown: true; stale: boolean };

/**
 * Whether a public page may show a fact. Facts about natural persons stay off public pages (ADR 026 decision 2 keeps
 * professional pages off until counsel approves per jurisdiction); a licence snapshot without display hides the fact;
 * a fact past `validUntil` is shown as stale.
 */
export function factDisplay(fact: Pick<SourcedFact, 'licenceSnapshot' | 'subject' | 'validUntil'>, now: Date): FactDisplay {
  if (fact.subject.holderKind !== 'organisation') return { shown: false, reason: 'natural_person' };
  if (!fact.licenceSnapshot.displayHeadlineAndLink) return { shown: false, reason: 'licence' };
  return { shown: true, stale: isStale(fact.validUntil, now) };
}

/** A fact is stale from the day after `validUntil` (a register's expiry date is the last valid day). */
export function isStale(validUntil: string | null, now: Date): boolean {
  if (validUntil === null) return false;
  return now.toISOString().slice(0, 10) > validUntil;
}

/** The public projection: the register's words with source, time and link; no holder kind, no record internals. */
export const PublicSourcedFactSchema = z.strictObject({
  kind: SourcedFactKindSchema,
  identifierKind: SourcedIdentifierKindSchema.nullable(),
  value: z.record(z.string(), z.unknown()),
  sourceId: z.uuid(),
  link: z.url(),
  observedAt: z.iso.datetime({ offset: true }),
  validUntil: DateSchema.nullable(),
  stale: z.boolean(),
});
export type PublicSourcedFact = z.infer<typeof PublicSourcedFactSchema>;

export function toPublicSourcedFact(fact: SourcedFact, now: Date): PublicSourcedFact | null {
  const display = factDisplay(fact, now);
  if (!display.shown) return null;
  return PublicSourcedFactSchema.parse({
    kind: fact.kind, identifierKind: fact.subject.identifierKind, value: fact.value, sourceId: fact.sourceId, link: fact.link,
    observedAt: fact.observedAt, validUntil: fact.validUntil, stale: display.stale,
  });
}

/* ---------- Wording ---------- */

/**
 * Words a sourced-fact label or explanation must not use: the hub reports what a register shows; it never certifies,
 * licenses, verifies, approves, endorses or guarantees. Checked over every locale string of the registers namespace.
 */
export const FORBIDDEN_FACT_WORDING: readonly RegExp[] = [
  /\bcertif/i, /\blicensed by\b/i, /\blicenced by\b/i, /\bverified by\b/i, /\bapproved by\b/i, /\bendorse/i, /\bguarantee/i, /\baccredited by\b/i,
];

export function wordingProblems(text: string): string[] {
  return FORBIDDEN_FACT_WORDING.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/* ---------- Expiry watch ---------- */

/** Days before `validUntil` at which a claimed subject is reminded (largest first; each is sent once). */
export const EXPIRY_REMINDER_DAYS = [60, 30, 7] as const;

/** The reminder step due for a fact at `now`, or null. Steps already sent are skipped by the caller. */
export function expiryReminderDue(validUntil: string | null, now: Date): (typeof EXPIRY_REMINDER_DAYS)[number] | null {
  if (validUntil === null || isStale(validUntil, now)) return null;
  const days = Math.round((Date.parse(`${validUntil}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  let due: (typeof EXPIRY_REMINDER_DAYS)[number] | null = null;
  for (const step of EXPIRY_REMINDER_DAYS) if (days <= step) due = step;
  return due;
}
