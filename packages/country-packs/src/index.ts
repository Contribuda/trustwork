import { z } from 'zod';
import uz from '../packs/uz.json' with { type: 'json' };
import ge from '../packs/ge.json' with { type: 'json' };
import am from '../packs/am.json' with { type: 'json' };
import az from '../packs/az.json' with { type: 'json' };
import countriesJson from '../countries/countries.json' with { type: 'json' };
import restricted from '../packs/restricted.json' with { type: 'json' };

/**
 * Country packs (ADR-009): the engine is country-agnostic; a pack is data, not code. Every fact a pack
 * states about a country (identifier format, regions, residency law) carries its sources; `verification`
 * says how far it was confirmed. A restricted place can never be a pack.
 */

const LocalizedText = z.record(z.string().min(2), z.string().min(1));
const Source = z.strictObject({ url: z.string().url(), what: z.string().min(1), accessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), verification: z.string().optional() });

export const RegionSchema = z.strictObject({
  code: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,3}$/),
  name: LocalizedText,
  kind: z.enum(['city', 'region', 'republic', 'autonomous-republic', 'rayon', 'municipality']),
});

export const CountryPackSchema = z.strictObject({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: LocalizedText,
  enabled: z.boolean(),
  status: z.enum(['complete', 'partial', 'draft']),
  locales: z.array(z.string().min(2)).min(1),
  defaultLocale: z.string().min(2),
  currency: z.strictObject({ code: z.string().regex(/^[A-Z]{3}$/), minorUnitDigits: z.number().int().min(0).max(4), displayFractionDigits: z.number().int().min(0).max(4), symbol: z.string().min(1) }),
  secondaryCurrencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
  formats: z.strictObject({
    timeZone: z.string().min(1),
    phone: z.strictObject({ callingCode: z.string().regex(/^\+\d{1,4}$/), nationalLength: z.number().int().min(4).max(15), example: z.string().min(1) }),
    postalCode: z.strictObject({ pattern: z.string().min(1), example: z.string().min(1) }),
  }),
  registrationIdentifier: z.strictObject({
    kind: z.string().regex(/^[A-Z]{2}-[A-Z]{2,8}$/),
    label: LocalizedText,
    pattern: z.string().min(1),
    example: z.string().min(1),
    issuer: z.strictObject({ name: LocalizedText, url: z.string().url() }),
    verification: z.string().min(1),
    sources: z.array(Source).min(1),
  }),
  legalEntityTypes: z.array(z.strictObject({ code: z.string().min(1), name: LocalizedText })).min(1),
  regions: z.array(RegionSchema).min(1),
  address: z.strictObject({ lines: z.array(z.enum(['street', 'city', 'region', 'postalCode'])).min(1), cityFirst: z.boolean() }),
  legalTemplates: z.strictObject({ terms: z.string().min(1), privacy: z.string().min(1), sanctions: z.string().min(1) }),
  dataResidency: z.strictObject({ required: z.boolean(), note: LocalizedText, sources: z.array(Source).min(1) }),
  notes: z.array(z.string()).optional(),
  sources: z.array(Source).min(1),
});

export const RestrictedPlacesSchema = z.strictObject({
  $comment: z.string(),
  places: z.array(z.strictObject({ code: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/), name: LocalizedText, basis: z.string().min(1) })).min(1),
  sources: z.array(Source).min(1),
});

export type CountryPack = z.infer<typeof CountryPackSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type CountryCode = CountryPack['code'];

const RAW_PACKS = [uz, ge, am, az];

/** Restricted places (ISO 3166-1 alpha-2 or ISO 3166-2). The engine never serves them and never lists them. */
export const RESTRICTED = RestrictedPlacesSchema.parse(restricted);
const RESTRICTED_CODES = new Set(RESTRICTED.places.map((p) => p.code));

export function isRestricted(code: string): boolean {
  const upper = code.toUpperCase();
  return RESTRICTED_CODES.has(upper) || RESTRICTED_CODES.has(upper.split('-')[0] ?? '');
}

/** Parses and cross-checks every pack once; a restricted or malformed pack throws at load so it can never ship. */
export function validatePack(raw: unknown): CountryPack {
  const pack = CountryPackSchema.parse(raw);
  if (isRestricted(pack.code)) throw new Error(`Country pack ${pack.code} is a restricted place and cannot exist`);
  if (!pack.locales.includes(pack.defaultLocale)) throw new Error(`${pack.code}: defaultLocale ${pack.defaultLocale} is not in locales`);
  if (!pack.locales.includes('en')) throw new Error(`${pack.code}: en (engine fallback) must be listed in locales`);
  const codes = new Set<string>();
  for (const region of pack.regions) {
    if (!region.code.startsWith(`${pack.code}-`)) throw new Error(`${pack.code}: region ${region.code} belongs to another country`);
    if (codes.has(region.code)) throw new Error(`${pack.code}: duplicate region ${region.code}`);
    codes.add(region.code);
    if (!region.name.en || !region.name[pack.defaultLocale]) throw new Error(`${pack.code}: region ${region.code} needs en and ${pack.defaultLocale} names`);
  }
  if (!pack.registrationIdentifier.kind.startsWith(`${pack.code}-`)) throw new Error(`${pack.code}: identifier kind must be prefixed with the country code`);
  if (!new RegExp(pack.registrationIdentifier.pattern).test(pack.registrationIdentifier.example)) throw new Error(`${pack.code}: identifier example does not match its pattern`);
  if (!new RegExp(pack.formats.postalCode.pattern).test(pack.formats.postalCode.example)) throw new Error(`${pack.code}: postal code example does not match its pattern`);
  return pack;
}

export const PACKS: readonly CountryPack[] = RAW_PACKS.map(validatePack);
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

export function validateIdentifier(pack: CountryPack, value: string): boolean {
  return new RegExp(pack.registrationIdentifier.pattern).test(value.trim());
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
    code: country.code,
    name: country.name,
    enabled: true,
    status: 'draft',
    locales: [...ALL_LOCALES],
    defaultLocale: FALLBACK_LOCALE,
    currency,
    secondaryCurrencies: country.currencies.filter((c) => c !== currency.code),
    formats: {
      timeZone: country.timeZones[0] ?? 'UTC',
      phone: { callingCode, nationalLength: 15, example: callingCode },
      postalCode: { pattern: '^.{0,16}$', example: '' },
    },
    registrationIdentifier: {
      kind: `${country.code}-REGNO`,
      label: { en: 'Company registration number', ru: 'Регистрационный номер компании' },
      pattern: '^[A-Za-z0-9 .\\-/]{2,32}$',
      example: '0000000',
      issuer: { name: { en: 'National business registry' }, url: 'https://example.invalid/registry' },
      verification: 'Set by the operator of this country; the engine accepts any value that matches the pattern',
      sources: [DATASET_SOURCE],
    },
    legalEntityTypes: [{ code: 'other', name: { en: 'Legal entity', ru: 'Юридическое лицо' } }],
    regions: [],
    address: { lines: ['street', 'city', 'region', 'postalCode'], cityFirst: false },
    legalTemplates: { terms: 'terms', privacy: 'privacy', sanctions: 'sanctions-and-export-controls' },
    dataResidency: { required: false, note: { en: 'Not assessed for this country; the operator confirms before launch.' }, sources: [DATASET_SOURCE] },
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
