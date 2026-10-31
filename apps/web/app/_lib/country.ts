import { formatMoney as packMoney, genericPack, getCountryPack, getPack, pick, regionName, type CountryPack } from '@trustwork/country-packs';
import { localeTag } from '@trustwork/ui/i18n';
import { getLocaleStore } from '@trustwork/i18n-runtime';

/**
 * Active country pack and locale for the app (ADR-009): both come from the request-scoped store primed by
 * `primeLocale()`; every region label, currency and registration-identifier label comes from the pack,
 * never from a hard-coded list.
 */

let neutral: CountryPack | null = null;

/**
 * The profile of a visitor without a country (CFG-001, ADR 012 decision 11): nothing chosen and nothing configured.
 * It names no real country: no regions, no currency (ISO 4217 `XXX`), UTC and a free-form identifier, until the
 * visitor chooses in the first-visit window or the header switcher. `ZZ` is the ISO 3166 user-assigned code CLDR uses
 * for an unknown region; it is never offered, stored or sent anywhere.
 */
export function neutralPack(): CountryPack {
  neutral ??= genericPack({ code: 'ZZ', name: { en: '—' }, currency: 'XXX', currencies: [], region: null, subregion: null, independent: false, unMember: false, callingCode: null, timeZones: ['UTC'], pack: false });
  return neutral;
}

/** The pack of the active country; with none chosen, the deployment's default country; with neither, the neutral profile. */
export function activePack(): CountryPack {
  const country = getLocaleStore().country;
  const pack = country ? getCountryPack(country) : null;
  if (pack) return pack;
  return defaultPack() ?? neutralPack();
}

let defaultCountryReader: (() => string | null) | null = null;

/**
 * Client components import this module too (region labels), so it never loads the server configuration itself: the
 * server registers how to read the deployment's default country (`locale.ts`). In the browser the store always
 * carries the country the server resolved.
 */
export function setDefaultCountryReader(reader: () => string | null): void {
  defaultCountryReader = reader;
}

function defaultPack(): CountryPack | null {
  const code = defaultCountryReader?.() ?? null;
  return code ? getCountryPack(code) : null;
}

export function activeLocale(): string {
  return localeTag();
}

export function currencyCode(): string {
  return activePack().currency.code;
}

/** Region codes of the active pack in pack order (cities first where the pack lists them so). */
export function regionCodes(): string[] {
  return activePack().regions.map((r) => r.code);
}

/**
 * Region filter options from the records on a page (CFG-001): the distinct regions present, the active pack's
 * regions first in pack order, then the rest by label. Records keep their own regions whatever country the visitor
 * chose, so the options always match the data and no country is assumed.
 */
export function regionOptions(present: readonly (string | null | undefined)[]): string[] {
  const codes = [...new Set(present.filter((code): code is string => Boolean(code)))];
  const order = new Map(activePack().regions.map((r, i) => [r.code, i]));
  const collator = new Intl.Collator(activeLocale());
  return codes.sort((a, b) => {
    const ia = order.get(a);
    const ib = order.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return collator.compare(regionLabel(a), regionLabel(b));
  });
}

/** A region's name: from the active pack, else from the pack of the country the ISO 3166-2 code belongs to, else the code. */
export function regionLabel(code: string | null | undefined): string {
  if (!code) return '';
  const pack = activePack();
  if (pack.regions.some((r) => r.code === code)) return regionName(pack, code, activeLocale());
  const owner = getPack(code.split('-')[0] ?? '');
  return owner ? regionName(owner, code, activeLocale()) : code;
}

/** Label of a legal identifier kind: the pack's registration identifier, or the generic «other». */
export function identifierLabel(kind: string): string {
  const pack = activePack();
  return kind === pack.registrationIdentifier.kind ? pick(pack.registrationIdentifier.label, activeLocale()) : kind;
}

export function formatMoney(minorUnits: string | number, currency: string = currencyCode()): string {
  return packMoney(String(minorUnits), currency, activeLocale());
}
