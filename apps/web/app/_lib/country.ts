import { DEFAULT_COUNTRY, formatMoney as packMoney, getCountryPack, pick, regionName, type CountryPack } from '@trustwork/country-packs';
import { localeTag } from '@trustwork/ui/i18n';
import { getLocaleStore } from '@trustwork/i18n-runtime';

/**
 * Active country pack and locale for the app (ADR-009): both come from the request-scoped store primed by
 * `primeLocale()`; every region label, currency and registration-identifier label comes from the pack,
 * never from a hard-coded list.
 */
export function activePack(): CountryPack {
  const pack = getCountryPack(getLocaleStore().country) ?? getCountryPack(DEFAULT_COUNTRY);
  if (!pack) throw new Error(`Default country pack ${DEFAULT_COUNTRY} is missing`);
  return pack;
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

export function regionLabel(code: string | null | undefined): string {
  return code ? regionName(activePack(), code, activeLocale()) : '';
}

/** Label of a legal identifier kind: the pack's registration identifier, or the generic «other». */
export function identifierLabel(kind: string): string {
  const pack = activePack();
  return kind === pack.registrationIdentifier.kind ? pick(pack.registrationIdentifier.label, activeLocale()) : kind;
}

export function formatMoney(minorUnits: string | number, currency: string = currencyCode()): string {
  return packMoney(String(minorUnits), currency, activeLocale());
}
