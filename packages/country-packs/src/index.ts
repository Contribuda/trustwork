import { z } from 'zod';
import { isRestricted } from './restricted.js';
import type { CountryPack } from './schema.js';
import { findIdentifierKind } from './facts.js';
import { BUILT_IN_PACKS, getPack } from './registry.js';
import { genericClientPack, pick } from './client.js';
import countriesJson from '../countries/countries.json' with { type: 'json' };

/**
 * Country packs (ADR-009, CTRY-002): the engine is country-agnostic; a pack is data, not code. Every fact a pack
 * states about a country or one of its subdivisions carries its sources and a verification level. Pack files may be
 * v1 or v2; once validated every pack is served in v2 form (v1 files are upgraded losslessly). A restricted place can
 * never be a pack, a subdivision of a pack or a fact's scope.
 */

export * from './facets.js';
export * from './schema.js';
export * from './restricted.js';
export * from './adapters.js';
export { facetProblems, levelFromNotes, packProblems, scopeChain, upgradePack, validatePack, type FacetCheckContext, type LayerResolution, type PackCheck, type PackCheckOptions } from './validate.js';
export * from './facts.js';
export { OUTREACH_LAW_TOPICS, outreachPackRules, type OutreachLawFactView } from './outreach-law.js';
export * from './calendar.js';
export { BUILT_IN_PACKS, checkPackFile, enabledPacks, getPack, installPacks, packs, resetPacks, type PackFileCheck } from './registry.js';

export type CountryCode = CountryPack['code'];

/**
 * The packs that ship with the engine (`packages/country-packs/packs`). A deployment's own packs join them at start
 * (`packs()`, `getPack()` and `enabledPacks()` in `registry.ts`). There is no default country here or anywhere in
 * the engine (ADR 012 decision 11): the deployment configuration names one, or visitors choose.
 */
export const PACKS: readonly CountryPack[] = BUILT_IN_PACKS;

/**
 * Shared with the browser entry (`./client.ts`, `@trustwork/country-packs/client`), which carries only the v1 subset of
 * the built-in packs; on the server its registry mirrors this one, so these helpers see the same packs here and there.
 */
export { ALL_LOCALES, FALLBACK_LOCALE, currencyMeta, formatMoney, genericClientPack, isLocale, pick, regionName, toClientPack, type ClientPack, type ClientRegion, type GenericCountry } from './client.js';

/** Checks a value against the primary identifier pattern, or against another kind declared in the pack. */
export function validateIdentifier(pack: CountryPack, value: string, kind: string = pack.registrationIdentifier.kind): boolean {
  const info = findIdentifierKind(pack, kind);
  return info ? new RegExp(info.pattern).test(value.trim()) : false;
}

/*
 * Every country (owner decision 2026-10-29): a visitor may pick any country that is not a restricted place
 * and any engine language, independently. Countries with a pack carry regions, identifier formats and
 * legal facts; every other country gets a generic profile (currency and names from the ISO dataset,
 * no regions, a free-form registration number) until someone contributes its pack.
 */
export const CountrySchema = z.strictObject({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: z.record(z.string().min(2), z.string().min(1)),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
  region: z.string().nullable(),
  subregion: z.string().nullable(),
  independent: z.boolean(),
  unMember: z.boolean(),
  callingCode: z.string().nullable(),
  timeZones: z.array(z.string()),
  pack: z.boolean(),
});
export type Country = z.infer<typeof CountrySchema>;

/** Every selectable country, alphabetically by code; restricted places are filtered out again here even though the dataset build drops them. */
export const COUNTRIES: readonly Country[] = z
  .array(CountrySchema)
  .parse((countriesJson as { countries: unknown }).countries)
  .filter((c) => !isRestricted(c.code));
const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function getCountry(code: string): Country | null {
  return COUNTRY_BY_CODE.get(code.toUpperCase()) ?? null;
}

const displayNames = new Map<string, Intl.DisplayNames | null>();

/**
 * Country name in a locale: the pack's own name in that locale, then `Intl.DisplayNames`, then the pack's or the
 * dataset's fallback (English first). A pack without the locale (UZ has no Georgian name) no longer shows English
 * where the runtime knows the name.
 */
export function countryName(code: string, locale: string): string {
  const upper = code.toUpperCase();
  const pack = getPack(upper);
  if (pack?.name[locale]) return pack.name[locale];
  const country = getCountry(upper);
  let names = displayNames.get(locale);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    displayNames.set(locale, names);
  }
  try {
    const fromIntl = names?.of(upper);
    if (fromIntl && fromIntl !== upper) return fromIntl;
  } catch {
    /* unknown region for Intl: fall through to the dataset */
  }
  if (pack) return pick(pack.name, locale);
  return country ? pick(country.name, locale) : upper;
}

const DATASET_SOURCE = { url: 'https://github.com/mledoze/countries', what: 'ISO 3166-1 codes, names, currencies, calling codes and time zones (ODbL 1.0)', accessed: '2026-10-29', verification: 'secondary dataset; a contributed pack replaces it' };

const genericPacks = new Map<string, CountryPack>();

/** A pack-shaped profile for a country without a contributed pack: usable everywhere a pack is, with no regions and a free-form identifier. */
export function genericPack(country: Country): CountryPack {
  const cached = genericPacks.get(country.code);
  if (cached) return cached;
  const base = genericClientPack(country);
  const pack: CountryPack = {
    ...base,
    schemaVersion: 2,
    status: 'draft',
    verificationLevel: 'secondary',
    timeZones: [base.formats.timeZone],
    registrationIdentifier: {
      ...base.registrationIdentifier,
      issuer: { name: { en: 'National business registry' }, url: 'https://example.invalid/registry' },
      verification: 'Set by the operator of this country; the engine accepts any value that matches the pattern',
      verificationLevel: 'pending',
      sources: [DATASET_SOURCE],
    },
    legalTemplates: { terms: 'terms', privacy: 'privacy', sanctions: 'sanctions-and-export-controls' },
    dataResidency: { required: false, note: { en: 'Not assessed for this country; the operator confirms before launch.' }, verificationLevel: 'pending', sources: [DATASET_SOURCE] },
    facets: {},
    notes: ['generic profile: no contributed pack'],
    sources: [DATASET_SOURCE],
  };
  genericPacks.set(country.code, pack);
  return pack;
}

/** The pack for any selectable country: the contributed one, else the generic profile; null for unknown or restricted codes. */
export function getCountryPack(code: string): CountryPack | null {
  const pack = getPack(code);
  if (pack) return pack;
  const country = getCountry(code);
  return country ? genericPack(country) : null;
}
