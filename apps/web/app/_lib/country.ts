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

/**
 * Region codes of the active pack in pack order (cities first where the pack lists them so). The list is a live
 * view: every read resolves the active pack of the request reading it, so a list kept in a module-level constant
 * (evaluated once, outside any request) still follows each visitor's country instead of freezing whichever country
 * was active, or configured, when the module loaded (CFG-001).
 */
export function regionCodes(): string[] {
  const current = (): string[] => activePack().regions.map((r) => r.code);
  return new Proxy<string[]>([], {
    get(_target, property) {
      const list = current();
      const value: unknown = Reflect.get(list, property, list);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(list) : value;
    },
    has(_target, property) {
      return Reflect.has(current(), property);
    },
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
