import { z } from 'zod';
import { FacetsSchema, LocalizedText, RegionCodeSchema, SourceSchema, VerificationLevelSchema, type Facets, type VerificationLevel } from './facets.js';

/**
 * Country pack schema (ADR-009, CTRY-002). Version 1 files stay valid unchanged; version 2 (`schemaVersion: 2`) keeps
 * every v1 field and adds verification levels on the v1 facts, several IANA time zones, subdivision kinds for federal
 * countries (state, district, territory, province), subdivision hierarchy and facets at country and subdivision level.
 */

export const REGION_KINDS = ['city', 'region', 'republic', 'autonomous-republic', 'rayon', 'municipality', 'state', 'district', 'territory', 'province'] as const;

export const RegionSchema = z.strictObject({
  code: RegionCodeSchema,
  name: LocalizedText,
  kind: z.enum(REGION_KINDS),
  /** v2: the enclosing subdivision (for example a county inside a state); facts inherit along this chain. */
  parent: RegionCodeSchema.optional(),
  /** v2: the IANA time zones used in this subdivision, a subset of the pack's `timeZones`. */
  timeZones: z.array(z.string().min(1)).min(1).optional(),
  /** v2: facts that hold only in this subdivision (state licensing, sales tax, privacy law, holidays). */
  facets: FacetsSchema.optional(),
});

export const CountryPackSchema = z.strictObject({
  /** Absent in v1 files; `2` enables the v2 fields below and makes verification levels mandatory. */
  schemaVersion: z.literal(2).optional(),
  code: z.string().regex(/^[A-Z]{2}$/),
  name: LocalizedText,
  enabled: z.boolean(),
  status: z.enum(['complete', 'partial', 'draft']),
  locales: z.array(z.string().min(2)).min(1),
  defaultLocale: z.string().min(2),
  currency: z.strictObject({ code: z.string().regex(/^[A-Z]{3}$/), minorUnitDigits: z.number().int().min(0).max(4), displayFractionDigits: z.number().int().min(0).max(4), symbol: z.string().min(1) }),
  secondaryCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
  formats: z.strictObject({
    /** The representative time zone (v1); v2 lists every zone in `timeZones`, which must include this one. */
    timeZone: z.string().min(1),
    phone: z.strictObject({ callingCode: z.string().regex(/^\+\d{1,4}$/), nationalLength: z.number().int().min(4).max(15), example: z.string().min(1) }),
    postalCode: z.strictObject({ pattern: z.string().min(1), example: z.string().min(1) }),
  }),
  /** v2: every IANA time zone in use in the country. */
  timeZones: z.array(z.string().min(1)).min(1).optional(),
  /** The primary company identifier (v1). Further kinds (tax, procurement, state licences) are `identifiers` facts. */
  registrationIdentifier: z.strictObject({
    kind: z.string().regex(/^[A-Z]{2}-[A-Z]{2,8}$/),
    label: LocalizedText,
    pattern: z.string().min(1),
    example: z.string().min(1),
    issuer: z.strictObject({ name: LocalizedText, url: z.string().url() }),
    /** Free-text verification note (v1). */
    verification: z.string().min(1),
    /** v2: the verification level of this fact. */
    verificationLevel: VerificationLevelSchema.optional(),
    sources: z.array(SourceSchema).min(1),
  }),
  legalEntityTypes: z.array(z.strictObject({ code: z.string().min(1), name: LocalizedText })).min(1),
  regions: z.array(RegionSchema).min(1),
  /** `street2` (v2) is a second street line such as a unit or suite. */
  address: z.strictObject({ lines: z.array(z.enum(['street', 'street2', 'city', 'region', 'postalCode'])).min(1), cityFirst: z.boolean() }),
  legalTemplates: z.strictObject({ terms: z.string().min(1), privacy: z.string().min(1), sanctions: z.string().min(1) }),
  dataResidency: z.strictObject({ required: z.boolean(), note: LocalizedText, verificationLevel: VerificationLevelSchema.optional(), sources: z.array(SourceSchema).min(1) }),
  /** v2: the verification level of the pack-wide facts (formats, currency, entity types, regions) cited in `sources`. */
  verificationLevel: VerificationLevelSchema.optional(),
  /** v2: country-level facts. */
  facets: FacetsSchema.optional(),
  notes: z.array(z.string()).optional(),
  sources: z.array(SourceSchema).min(1),
});

/** A pack file as written: v1 or v2. */
export type CountryPackInput = z.infer<typeof CountryPackSchema>;
export type Region = z.infer<typeof RegionSchema>;

/** A validated pack, always in v2 form: v1 files are upgraded losslessly when loaded. */
export type CountryPack = CountryPackInput & {
  schemaVersion: 2;
  verificationLevel: VerificationLevel;
  timeZones: string[];
  facets: Facets;
  registrationIdentifier: CountryPackInput['registrationIdentifier'] & { verificationLevel: VerificationLevel };
  dataResidency: CountryPackInput['dataResidency'] & { verificationLevel: VerificationLevel };
};
