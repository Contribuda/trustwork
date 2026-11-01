import { JurisdictionSourceSchema } from '../../contracts/src/jurisdiction.js';
import { z } from 'zod';
import { CatalogueUnitCodeSchema, DecimalSchema, MoneySchema, PROVIDER_CAPABILITIES } from '@trustwork/contracts/client';

/**
 * Country pack v2 facets (CTRY-002). A facet is a list of facts; every fact carries a stable `id`, at least one
 * source and an honest verification level, so the same shape works for a country, for one of its subdivisions
 * (a state, district or territory) and for a shared layer such as the EU (CTRY-EU). A fact declared again with the
 * same `id` at a narrower scope replaces the wider one for that scope and must cite its own sources.
 *
 * Facts describe the world; they never configure a hub and never switch anything on. Restricted places stay in
 * `packs/restricted.json` and cannot be named, enabled or overridden by any facet.
 */

/** Localized text keyed by BCP 47 tag. */
export const LocalizedText = z.record(z.string().min(2), z.string().min(1));
/** Localized text of a fact: English (the engine fallback) is required. */
export const FactText = LocalizedText.refine((text) => typeof text.en === 'string', 'fact text needs an en entry (engine fallback)');

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'not a calendar date');

/** v1 source shape, unchanged: `verification` is a free-text note about this source. */
export const SourceSchema = z.strictObject({ url: z.string().url(), what: z.string().min(1), accessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), verification: z.string().optional() });
export type Source = z.infer<typeof SourceSchema>;

/**
 * How far a fact was confirmed:
 * - `official`: checked against the primary source (the law, the register, the authority's own page);
 * - `secondary`: taken from reputable secondary sources, official confirmation still to do;
 * - `candidate`: a lead worth checking (for example a portal named by one source), not yet a fact;
 * - `pending`: recorded but not yet checked by a maintainer.
 */
export const VERIFICATION_LEVELS = ['official', 'secondary', 'candidate', 'pending'] as const;
export const VerificationLevelSchema = z.enum(VERIFICATION_LEVELS);
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;

export const FactIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'fact id: lower-case letters, digits and hyphens');
/** Identifier kinds: `<CC>-<NAME>` nationally, `<CC>-<SUB>-<NAME>` for a subdivision (for example a state licence). */
export const IdentifierKindSchema = z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?-[A-Z][A-Z0-9]{1,11}$/, 'identifier kind');
export const RegionCodeSchema = z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/);
export const AdapterIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/);

/** A reference to an adapter that exists in the engine (see `ENGINE_ADAPTERS`); the validator refuses unknown ones. */
export const AdapterRefSchema = z.strictObject({ capability: z.enum(PROVIDER_CAPABILITIES), id: AdapterIdSchema });
export type AdapterRef = z.infer<typeof AdapterRefSchema>;

const Organization = z.strictObject({ name: FactText, url: z.string().url() });

/** Fields every fact has. */
const FACT_BASE = {
  id: FactIdSchema,
  sources: z.array(SourceSchema).min(1, 'every fact needs at least one source'),
  verification: VerificationLevelSchema,
  verificationNote: z.string().min(1).optional(),
  effectiveFrom: IsoDateSchema.optional(),
  effectiveTo: IsoDateSchema.optional(),
};

/** Adapter fields for facts the engine may act on: a real reference, or named candidates that do not exist yet. */
const ADAPTER_FIELDS = {
  adapter: AdapterRefSchema.optional(),
  /** Names of adapters someone could build; they are leads, never engine references. */
  candidateAdapters: z.array(z.string().min(1)).optional(),
};

const fact = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ ...FACT_BASE, ...shape });

/** A percentage rate as an exact decimal string between 0 and 100 (never a JSON number). */
export const RateSchema = DecimalSchema.refine((value) => !value.startsWith('-') && (Number(value.split('.')[0]) < 100 || /^100(\.0+)?$/.test(value)), 'rate is a percentage between 0 and 100');

/* ---------- Companies, identifiers and registers ---------- */

export const IDENTIFIER_ROLES = ['registration', 'tax', 'vat', 'register', 'licence', 'procurement', 'statistical', 'other'] as const;
export const IdentifierFactSchema = fact({
  kind: IdentifierKindSchema,
  role: z.enum(IDENTIFIER_ROLES),
  label: LocalizedText,
  pattern: z.string().min(1),
  example: z.string().min(1),
  issuer: z.strictObject({ name: LocalizedText, url: z.string().url() }),
  appliesTo: z.array(z.enum(['legal-entity', 'sole-proprietor', 'natural-person'])).min(1).optional(),
  checkDigit: z.strictObject({ algorithm: z.string().min(1), enforced: z.boolean() }).optional(),
  /** Fact id of the register that issues or lists this identifier. */
  register: FactIdSchema.optional(),
  ...ADAPTER_FIELDS,
});

export const RegisterFactSchema = fact({
  name: FactText,
  url: z.string().url(),
  query: z.enum(['manual', 'open_data', 'api']),
  dataLicence: z.string().min(1).optional(),
  /** Identifier kinds this register answers for. */
  covers: z.array(IdentifierKindSchema).default([]),
  ...ADAPTER_FIELDS,
});

/* ---------- Construction licensing and professional qualifications ---------- */

export const LicensingFactSchema = z.discriminatedUnion('type', [
  fact({
    type: z.literal('activity'),
    name: FactText,
    authority: Organization,
    required: z.boolean(),
    register: FactIdSchema.optional(),
    identifierKind: IdentifierKindSchema.optional(),
    categories: z.array(z.strictObject({ code: z.string().min(1), name: FactText })).optional(),
  }),
  fact({ type: z.literal('profession'), name: FactText, body: Organization, register: FactIdSchema.optional() }),
  fact({ type: z.literal('insurance'), name: FactText, mandatory: z.boolean() }),
]);

/* ---------- Building codes and standards ---------- */

export const StandardsFactSchema = fact({
  system: FactText,
  body: Organization,
  publications: z.string().url().optional(),
  textLicence: z.string().min(1).optional(),
  adopts: z.array(z.string().min(1)).optional(),
});

/* ---------- Public procurement ---------- */

export const ProcurementFactSchema = z.discriminatedUnion('type', [
  fact({ type: z.literal('portal'), name: FactText, url: z.string().url(), level: z.enum(['supranational', 'national', 'federal', 'state', 'regional', 'local']), openData: z.boolean(), ...ADAPTER_FIELDS }),
  fact({ type: z.literal('threshold'), summary: FactText, amount: MoneySchema }),
]);

/* ---------- Tax and invoicing ---------- */

export const TAX_KINDS = ['vat', 'gst', 'sales', 'use', 'excise', 'withholding', 'other'] as const;
export const TaxFactSchema = z.discriminatedUnion('type', [
  fact({
    type: z.literal('rate'),
    taxKind: z.enum(TAX_KINDS),
    name: FactText,
    /** Null where the scope levies no such tax (a state without sales tax still states that, with sources). */
    standardRate: RateSchema.nullable(),
    reducedRates: z.array(z.strictObject({ rate: RateSchema, appliesTo: FactText })).default([]),
    /** `additive`: local jurisdictions add their own rates on top; the engine never guesses them. */
    localRates: z.enum(['none', 'additive']).default('none'),
    registrationThreshold: MoneySchema.nullable().default(null),
    /** `adapter`: the amount comes from a tax-calculation adapter; the engine never hard-codes the computation. */
    calculation: z.enum(['rate', 'adapter']),
    ...ADAPTER_FIELDS,
  }),
  fact({
    type: z.literal('e-invoicing'),
    system: FactText,
    mandatory: z.boolean(),
    scope: z.array(z.enum(['B2B', 'B2G', 'B2C'])).min(1),
    signatureRequired: z.boolean(),
    ...ADAPTER_FIELDS,
  }),
]);

/* ---------- Electronic identity and signatures ---------- */

export const ESignatureFactSchema = fact({
  kind: z.enum(['signature', 'identity', 'signature-and-identity']),
  name: FactText,
  /** Legal strength in the scope: simple (any electronic act of assent), advanced, or qualified. */
  strength: z.enum(['simple', 'advanced', 'qualified']),
  legalBasis: FactText,
  ...ADAPTER_FIELDS,
});

/* ---------- Payments ---------- */

export const PAYMENT_RAILS = ['card', 'credit-transfer', 'instant-credit-transfer', 'direct-debit', 'wallet', 'cash', 'other'] as const;
export const PaymentFactSchema = z.discriminatedUnion('type', [
  fact({ type: z.literal('scheme'), name: FactText, rails: z.array(z.enum(PAYMENT_RAILS)).min(1), ...ADAPTER_FIELDS }),
  fact({ type: z.literal('currency-control'), summary: FactText }),
  /**
   * Statutory payment terms for commercial transactions (for example a late-payment law): the longest payment period
   * that applies unless the contract expressly agrees otherwise, between businesses and where a public authority pays.
   */
  fact({
    type: z.literal('payment-terms'),
    summary: FactText,
    businessMaxDays: z.int().min(1).max(365).optional(),
    publicAuthorityMaxDays: z.int().min(1).max(365).optional(),
  }),
]);

/* ---------- Calendar and holidays ---------- */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

const Month = z.int().min(1).max(12);
export const HolidayRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed'), month: Month, day: z.int().min(1).max(31) }),
  /** `nth: -1` is the last such weekday of the month. */
  z.strictObject({ kind: z.literal('nth-weekday'), month: Month, weekday: WeekdaySchema, nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]) }),
  /** Movable holidays (lunar, Easter-based, proclaimed) are published per year with sources. */
  z.strictObject({ kind: z.literal('dates'), dates: z.array(IsoDateSchema).min(1) }),
]);
export type HolidayRule = z.infer<typeof HolidayRuleSchema>;

/**
 * Observed-date rules for a holiday that falls on a weekend (Saturday and Sunday):
 * `nearest-weekday` moves Saturday to Friday and Sunday to Monday; `next-weekday` moves both to Monday;
 * `sunday-to-monday` moves only Sunday. Collisions between two moved holidays are not resolved by the engine.
 */
export const OBSERVED_RULES = ['none', 'nearest-weekday', 'next-weekday', 'sunday-to-monday'] as const;

export const CalendarFactSchema = z.discriminatedUnion('type', [
  fact({ type: z.literal('working-week'), days: z.array(WeekdaySchema).min(1) }),
  fact({ type: z.literal('fiscal-year'), startMonth: Month, startDay: z.int().min(1).max(31) }),
  fact({
    type: z.literal('holiday'),
    name: FactText,
    holiday: z.enum(['public', 'federal', 'state', 'bank', 'observance']),
    /** Whether offices and sites are normally closed (affects delivery dates, deadlines and events). */
    nonWorking: z.boolean(),
    rule: HolidayRuleSchema,
    observed: z.enum(OBSERVED_RULES).default('none'),
  }),
]);

/* ---------- Money, numbers and units ---------- */

export const UnitsFactSchema = z.discriminatedUnion('type', [
  /** The measurement system used in trade and construction, with the catalogue units most commonly quoted. */
  fact({ type: z.literal('system'), system: z.enum(['metric', 'imperial', 'us-customary', 'mixed']), common: z.array(CatalogueUnitCodeSchema).min(1) }),
  /** A local name or symbol for a catalogue unit (for example a running metre or a roofing square). */
  fact({ type: z.literal('local-name'), unit: CatalogueUnitCodeSchema, name: FactText, symbol: LocalizedText.optional() }),
]);

/* ---------- Languages and scripts ---------- */

export const ScriptsFactSchema = fact({
  language: z.string().regex(/^[a-z]{2,3}$/, 'ISO 639 language code'),
  scripts: z.array(z.string().regex(/^[A-Z][a-z]{3}$/, 'ISO 15924 script code')).min(1),
  direction: z.enum(['ltr', 'rtl']),
  transliteration: z.string().min(1).optional(),
});

/* ---------- Privacy and data ---------- */

export const PrivacyFactSchema = z.discriminatedUnion('type', [
  /** Subdivision-level residency rule; the country rule stays in the v1 `dataResidency` field. */
  fact({ type: z.literal('data-residency'), required: z.boolean(), note: FactText }),
  fact({
    type: z.literal('law'),
    name: FactText,
    summary: FactText.optional(),
    /** When the law applies (thresholds, kinds of business), in words. */
    appliesWhen: FactText.optional(),
    authority: Organization.optional(),
    consent: z.enum(['opt-in', 'opt-out', 'mixed']).optional(),
    subjectRequestDays: z.int().min(1).max(365).optional(),
    breachNotificationHours: z.int().min(1).max(8760).optional(),
    minorsAge: z.int().min(1).max(21).optional(),
  }),
  fact({ type: z.literal('retention'), record: FactText, years: z.int().min(0).max(100) }),
]);

/* ---------- Content, media and consumer law ---------- */

export const ContentLawFactSchema = fact({
  topic: z.enum(['media-registration', 'defamation', 'right-of-reply', 'reviews', 'advertising', 'copyright', 'takedown', 'consumer-protection', 'distance-selling', 'other']),
  summary: FactText,
});

/* ---------- Sanctions and export controls ---------- */

/** National lists a hub must apply in addition to the engine-wide restricted places (which no pack can change). */
export const SanctionsFactSchema = fact({
  name: FactText,
  authority: Organization,
  url: z.string().url(),
  updateCadence: z.enum(['daily', 'weekly', 'monthly', 'irregular']).optional(),
  ...ADAPTER_FIELDS,
});

/* ---------- Agent-law defaults ---------- */

/**
 * Sourced defaults for what a hub's agents must disclose and record (ADR 010 decision 21). They stay unverified until
 * counsel review: `verification: official` is accepted only with `counselReview: done`.
 */
export const AgentLawFactSchema = fact({
  executable: JurisdictionSourceSchema.optional(),
  topic: z.enum(['disclosure', 'liability', 'consent', 'record-keeping', 'action-limit', 'other']),
  summary: FactText,
  wording: LocalizedText.optional(),
  recordYears: z.int().min(0).max(100).optional(),
  actionLimit: MoneySchema.optional(),
  counselReview: z.enum(['pending', 'done']).default('pending'),
});

export const FacetsSchema = z.strictObject({
  identifiers: z.array(IdentifierFactSchema).optional(),
  registers: z.array(RegisterFactSchema).optional(),
  licensing: z.array(LicensingFactSchema).optional(),
  standards: z.array(StandardsFactSchema).optional(),
  procurement: z.array(ProcurementFactSchema).optional(),
  tax: z.array(TaxFactSchema).optional(),
  eSignature: z.array(ESignatureFactSchema).optional(),
  payments: z.array(PaymentFactSchema).optional(),
  calendar: z.array(CalendarFactSchema).optional(),
  units: z.array(UnitsFactSchema).optional(),
  scripts: z.array(ScriptsFactSchema).optional(),
  privacy: z.array(PrivacyFactSchema).optional(),
  contentLaw: z.array(ContentLawFactSchema).optional(),
  sanctions: z.array(SanctionsFactSchema).optional(),
  agentLaw: z.array(AgentLawFactSchema).optional(),
});
export type Facets = z.infer<typeof FacetsSchema>;
export type FacetName = keyof Facets;
export const FACET_NAMES = Object.keys(FacetsSchema.shape) as FacetName[];
export type FactOf<F extends FacetName> = NonNullable<Facets[F]>[number];
export type AnyFact = FactOf<FacetName>;
export type IdentifierFact = FactOf<'identifiers'>;
export type CalendarFact = FactOf<'calendar'>;

/** Every fact of a facets object with the facet it belongs to, in declaration order. */
export function listFacts(facets: Facets | undefined): { facet: FacetName; fact: AnyFact }[] {
  if (!facets) return [];
  return FACET_NAMES.flatMap((facet) => ((facets[facet] ?? []) as AnyFact[]).map((fact) => ({ facet, fact })));
}
