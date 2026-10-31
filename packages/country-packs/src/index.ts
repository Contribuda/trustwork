import { z } from 'zod';
import { isRestricted } from './restricted.js';
import type { CountryPack } from './schema.js';
import { validatePack } from './validate.js';
import { findIdentifierKind } from './facts.js';
import uz from '../packs/uz.json' with { type: 'json' };
import ge from '../packs/ge.json' with { type: 'json' };
import am from '../packs/am.json' with { type: 'json' };
import az from '../packs/az.json' with { type: 'json' };
import us from '../packs/us.json' with { type: 'json' };
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
export { facetProblems, levelFromNotes, packProblems, scopeChain, upgradePack, validatePack, type FacetCheckContext, type PackCheck } from './validate.js';
export * from './facts.js';
export * from './calendar.js';

export type CountryCode = CountryPack['code'];

const RAW_PACKS = [uz, ge, am, az, us];

export const PACKS: readonly CountryPack[] = RAW_PACKS.map((raw) => validatePack(raw));
const BY_CODE = new Map(PACKS.map((p) => [p.code, p]));

export function getPack(code: string): CountryPack | null {
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

/** Packs offered in the country selector: enabled and, by construction, never restricted. */
export function enabledPacks(): readonly CountryPack[] {
  return PACKS.filter((p) => p.enabled);
}

export const DEFAULT_COUNTRY = 'UZ';
export const FALLBACK_LOCALE = 'en';
/** Every locale any pack can switch to, plus the engine fallback; `ru` is optional and never a default. */
export const ALL_LOCALES: readonly string[] = [...new Set([FALLBACK_LOCALE, ...PACKS.flatMap((p) => p.locales)])];

export function isLocale(value: string): boolean {
  return ALL_LOCALES.includes(value);
}

/** Picks a localized string: the locale, then the engine fallback, then the first value present. */
export function pick(text: Record<string, string>, locale: string): string {
  return text[locale] ?? text[FALLBACK_LOCALE] ?? Object.values(text)[0] ?? '';
}

export function regionName(pack: CountryPack, code: string, locale: string): string {
  const region = pack.regions.find((r) => r.code === code);
  return region ? pick(region.name, locale) : code;
}

/** Checks a value against the primary identifier pattern, or against another kind declared in the pack. */
export function validateIdentifier(pack: CountryPack, value: string, kind: string = pack.registrationIdentifier.kind): boolean {
  const info = findIdentifierKind(pack, kind);
  return info ? new RegExp(info.pattern).test(value.trim()) : false;
}

/** Money from contract minor units in the pack's currency, formatted for the locale (no hard-coded currency anywhere). */
export function formatMoney(minorUnits: string, currency: string, locale: string, options: { fractionDigits?: number | undefined } = {}): string {
  const pack = PACKS.find((p) => p.currency.code === currency);
  const meta = pack?.currency ?? currencyMeta(currency);
  const digits = meta.minorUnitDigits;
  const major = Number(minorUnits) / 10 ** digits;
  const fraction = options.fractionDigits ?? meta.displayFractionDigits;
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(major);
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

/** Country name in a locale: the pack's own name, then `Intl.DisplayNames`, then the dataset (en, ru). */
export function countryName(code: string, locale: string): string {
  const upper = code.toUpperCase();
  const pack = getPack(upper);
  if (pack) return pick(pack.name, locale);
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
  return country ? pick(country.name, locale) : upper;
}

type CurrencyMeta = CountryPack['currency'];

/** Minor-unit digits and symbol of any ISO 4217 code from `Intl` (packs state theirs explicitly). */
export function currencyMeta(code: string): CurrencyMeta {
  try {
    const format = new Intl.NumberFormat('en', { style: 'currency', currency: code });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    const symbol = format.formatToParts(1).find((part) => part.type === 'currency')?.value ?? code;
    return { code, minorUnitDigits: digits, displayFractionDigits: digits, symbol };
  } catch {
    return { code, minorUnitDigits: 2, displayFractionDigits: 2, symbol: code };
  }
}

const DATASET_SOURCE = { url: 'https://github.com/mledoze/countries', what: 'ISO 3166-1 codes, names, currencies, calling codes and time zones (ODbL 1.0)', accessed: '2026-10-29', verification: 'secondary dataset; a contributed pack replaces it' };

const genericPacks = new Map<string, CountryPack>();

/** A pack-shaped profile for a country without a contributed pack: usable everywhere a pack is, with no regions and a free-form identifier. */
export function genericPack(country: Country): CountryPack {
  const cached = genericPacks.get(country.code);
  if (cached) return cached;
  const currency = currencyMeta(country.currency ?? 'USD');
  const callingCode = country.callingCode && /^\+\d{1,4}$/.test(country.callingCode) ? country.callingCode : '+0';
  const pack: CountryPack = {
    schemaVersion: 2,
    code: country.code,
    name: country.name,
    enabled: true,
    status: 'draft',
    locales: [...ALL_LOCALES],
    defaultLocale: FALLBACK_LOCALE,
    currency,
    secondaryCurrencies: country.currencies.filter((c) => c !== currency.code),
    verificationLevel: 'secondary',
    formats: {
      timeZone: country.timeZones[0] ?? 'UTC',
      phone: { callingCode, nationalLength: 15, example: callingCode },
      postalCode: { pattern: '^.{0,16}$', example: '' },
    },
    timeZones: [country.timeZones[0] ?? 'UTC'],
    registrationIdentifier: {
      kind: `${country.code}-REGNO`,
      label: { en: 'Company registration number', ru: 'Регистрационный номер компании' },
      pattern: '^[A-Za-z0-9 .\\-/]{2,32}$',
      example: '0000000',
      issuer: { name: { en: 'National business registry' }, url: 'https://example.invalid/registry' },
      verification: 'Set by the operator of this country; the engine accepts any value that matches the pattern',
      verificationLevel: 'pending',
      sources: [DATASET_SOURCE],
    },
    legalEntityTypes: [{ code: 'other', name: { en: 'Legal entity', ru: 'Юридическое лицо' } }],
    regions: [],
    address: { lines: ['street', 'city', 'region', 'postalCode'], cityFirst: false },
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
