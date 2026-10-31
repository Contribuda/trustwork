import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { runWithLocaleScope, setLocaleStore } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { uiLayers } from '@trustwork/ui/i18n/dictionaries';
import { ALL_LOCALES, DEFAULT_COUNTRY, FALLBACK_LOCALE, getCountryPack, type CountryPack } from '@trustwork/country-packs';
import { appLayers } from './locale-data';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localeCookiePath } from './locale-names';
import { BASE_PATH } from './base-path';

export { COUNTRY_COOKIE, LOCALE_COOKIE };

export type ActiveLocale = { country: string; locale: string; chosen: boolean; pack: CountryPack };

/** Languages a visitor may pick for any country: the pack's default first, then the engine fallback, then every other engine language (owner decision 2026-10-29: any country × any language). */
export function localesFor(pack: CountryPack): string[] {
  return [...new Set([pack.defaultLocale, FALLBACK_LOCALE, ...ALL_LOCALES])];
}

function negotiate(acceptLanguage: string | null, pack: CountryPack): string {
  const wanted = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  const offered = localesFor(pack);
  for (const tag of wanted) {
    const exact = offered.find((o) => o.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    const byBase = offered.find((o) => o.split('-')[0].toLowerCase() === base);
    if (byBase) return byBase;
  }
  return pack.defaultLocale;
}

export function resolveActive(countryCookie: string | undefined, localeCookie: string | undefined, acceptLanguage: string | null): ActiveLocale {
  const wanted = countryCookie ? getCountryPack(countryCookie) : null;
  const pack = wanted ?? getCountryPack(DEFAULT_COUNTRY)!;
  const chosen = wanted !== null;
  const locale = localeCookie && localesFor(pack).includes(localeCookie) ? localeCookie : negotiate(acceptLanguage, pack);
  return { country: pack.code, locale, chosen, pack };
}

/**
 * Every message layer one locale needs, in lookup order: the application's (brand overlay, own
 * dictionary, the English keys it lacks), then the design system's dictionary. The root layout hands
 * exactly these to the client, so a page carries one language and never the other dictionaries.
 */
export function localeLayers(tag: string): Messages[] {
  return [...appLayers(tag), ...uiLayers(tag)];
}

/**
 * Resolves the active country and locale for this request from the cookies (set by the selector, the
 * header switcher or `?country=`/`?lang=` through proxy.ts) and primes the request-scoped message store.
 * Layouts and pages render in parallel, so every page awaits this first; React `cache` makes it one read.
 * Route handlers have no React request scope: wrap them in `withRequestLocale`.
 */
export const primeLocale = cache(async (): Promise<ActiveLocale> => {
  const [jar, head] = await Promise.all([cookies(), headers()]);
  const active = resolveActive(jar.get(COUNTRY_COOKIE)?.value, jar.get(LOCALE_COOKIE)?.value, head.get('accept-language'));
  setLocaleStore({ locale: active.locale, country: active.country, layers: localeLayers(active.locale) });
  return active;
});

/**
 * Route handlers (feeds, calendar files, the manifest): runs the handler in its own locale scope primed
 * from this request's cookies, so its `t()` calls use the visitor's language and nobody else's.
 */
export function withRequestLocale<Args extends unknown[], R>(handler: (...args: Args) => R | Promise<R>): (...args: Args) => Promise<R> {
  return (...args: Args) =>
    runWithLocaleScope(async () => {
      await primeLocale();
      return handler(...args);
    });
}

export const cookieOptions = { path: localeCookiePath(BASE_PATH), maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: 'lax' as const };
