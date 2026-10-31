import { formatDate, formatMessage, formatNumber, intlTag, localeTag, messageOrUndefined, type LocaleParams } from '@trustwork/ui/i18n';
import { formatMoney as packMoney } from '@trustwork/country-packs';

/**
 * Application i18n (ADR-009): keys are dot paths into `locales/en.json` (the reference) layered over the
 * design-system dictionary. The active locale and its message layers live in the request-scoped store
 * primed by `primeLocale()` (server) and the `LocaleProvider` (client); a locale falls back to English per
 * key. No product copy is written in TSX: every string comes through `t()`.
 *
 * This module is shared by server and client components, so it imports no dictionary: the layers arrive
 * with the store (only the active locale's), and the dictionaries stay on the server (`locale-data.ts`).
 */

type Primitive = string | number;

type PathsOf<T, Prefix extends string = ''> = T extends readonly (infer U)[]
  ? U extends string
    ? `${Prefix}${number}`
    : never
  : T extends string
    ? Prefix extends `${infer P}.`
      ? P
      : Prefix
    : {
        [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : PathsOf<T[K], `${Prefix}${K}.`>;
      }[keyof T & string];

type Additions = typeof import('./locales/en.json');
type AdditionKeys = Exclude<PathsOf<Additions>, '$comment'>;
type UiKeys = PathsOf<typeof import('@trustwork/ui/locales/en.json')>;
export type LocaleKey = UiKeys | AdditionKeys;

/** The store's layers in order (brand overlay, app locale, app English fallback, design-system locale), then the design system's English reference. */
function lookup(key: string): string | undefined {
  return messageOrUndefined(key);
}

/** Raw message by key: app layers (locale, then English) win over the design-system dictionary; unknown keys throw so missing copy fails loudly. */
export function message(key: LocaleKey): string {
  const found = lookup(key);
  if (found === undefined) throw new Error(`Missing locale key: ${key}`);
  return found;
}

export function t(key: LocaleKey, params?: Record<string, Primitive>): string {
  return formatMessage(message(key), params as LocaleParams | undefined);
}

/** Looks a dynamic key up without a compile-time union (enum labels built from data); falls back to the raw value. */
export function tDynamic(key: string, fallback: string, params?: Record<string, Primitive>): string {
  const raw = lookup(key);
  return raw === undefined ? fallback : formatMessage(raw, params as LocaleParams | undefined);
}

/** Maps a contract error code (`auth.invalid_credentials`) to the message under `error.*`. */
export function errorMessage(code: string, params?: Record<string, Primitive>): string {
  return tDynamic(`error.${code}`, t('error.generic'), params);
}

export { formatDate, formatNumber };

/** Short date for timestamps (instants) or `YYYY-MM-DD` calendar dates. */
export function shortDate(value: string | Date): string {
  return formatDate(value, 'short');
}

export function longDate(value: string | Date): string {
  return formatDate(value, 'long');
}

/** Money from contract minor units in the given currency and the active language and country (no hard-coded currency). */
export function formatMoney(minorUnits: string, currency: string): string {
  return packMoney(minorUnits, currency, intlTag());
}

/** The active locale tag for the current render. */
export function currentLocale(): string {
  return localeTag();
}

/** Navigation labels for the active locale (eight public sections, eight workspace sections, three onboarding options). */
export function publicNav(): string[] {
  return Array.from({ length: 8 }, (_, i) => t(`publicNav.${i}` as LocaleKey));
}

export function workspaceNav(): string[] {
  return Array.from({ length: 8 }, (_, i) => t(`workspaceNav.${i}` as LocaleKey));
}

export function onboardingOptions(): string[] {
  return Array.from({ length: 3 }, (_, i) => t(`onboarding.${i}` as LocaleKey));
}
