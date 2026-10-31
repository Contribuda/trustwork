import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getLocaleStore, runWithLocaleScope, setLocaleStore } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { uiLayers } from '@trustwork/ui/i18n/dictionaries';
import { BUILT_IN_PACKS, getCountryPack, getPack, type CountryPack } from '@trustwork/country-packs';
import { appLayers, brandLayers, brandWordmark } from './locale-data';
import { defaultCountryCode, localesFor, negotiate, offeredCountryPack } from './locale-negotiation';
import { neutralPack, setDefaultCountryReader } from './country';
import CLIENT_NAMESPACES from '@/locales/client-namespaces.json';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localeCookiePath } from './locale-names';
import { BASE_PATH } from './base-path';

export { COUNTRY_COOKIE, LOCALE_COOKIE };

setDefaultCountryReader(() => defaultCountryCode());
export { localesFor };

/** `country` is empty when the visitor has not chosen one and the deployment configures none (ADR 012 decision 11). */
export type ActiveLocale = { country: string; locale: string; chosen: boolean; pack: CountryPack };

/**
 * The visitor's country and language: the cookies when they name a country and a language this deployment offers;
 * otherwise the deployment's default country, or none at all (a neutral profile until the visitor chooses).
 */
export function resolveActive(countryCookie: string | undefined, localeCookie: string | undefined, acceptLanguage: string | null): ActiveLocale {
  const wanted = offeredCountryPack(countryCookie);
  const fallback = defaultCountryCode();
  const pack = wanted ?? (fallback ? getCountryPack(fallback) : null) ?? neutralPack();
  const chosen = wanted !== null;
  const locale = localeCookie && localesFor(pack).includes(localeCookie) ? localeCookie : negotiate(acceptLanguage, pack, chosen);
  return { country: pack === neutralPack() ? '' : pack.code, locale, chosen, pack };
}

/**
 * Every message layer one locale needs on the server, in lookup order: the deployment's brand overlay,
 * the application's layers for every namespace (own messages, then the English keys they lack), then the
 * design system's dictionary. Server components resolve against all of them.
 */
export function localeLayers(tag: string): Messages[] {
  return [...brandLayers(tag), ...appLayers(tag), ...uiLayers(tag)];
}

/** Route groups with their own client namespaces (`apps/web/locales/client-namespaces.json`). */
export type RouteGroup = Exclude<keyof typeof CLIENT_NAMESPACES, '$comment'>;

/** The namespaces whose messages a route group hands to client components (the root list reaches every page). */
export function clientNamespaces(group: RouteGroup): string[] {
  return [...CLIENT_NAMESPACES[group]];
}

/**
 * What the browser receives for one route group (INTL-004): the application layers of exactly the
 * namespaces that group's client components use. The root layout adds the brand overlay and the design
 * system's dictionary once (`rootClientLocale`); a page therefore carries one language and only the
 * namespaces its route needs.
 */
export function clientLayers(tag: string, group: RouteGroup): { namespaces: string[]; layers: Messages[] } {
  const namespaces = clientNamespaces(group);
  return { namespaces, layers: appLayers(tag, namespaces) };
}

/**
 * The active country's pack when it came from the deployment's data directory (CFG-001): built-in packs ship in the
 * browser bundle, a data-directory pack reaches the browser this way, and only for visitors in that country.
 */
function deploymentPackForBrowser(): CountryPack | null {
  const country = getLocaleStore().country;
  const pack = country ? getPack(country) : null;
  return pack && !BUILT_IN_PACKS.includes(pack) ? pack : null;
}

/** The root layout's client locale: brand overlay (messages and this language's wordmark), a data-directory pack, the root namespaces and the design system's dictionary. */
export function rootClientLocale(tag: string): { brand: Messages[]; wordmark: ReturnType<typeof brandWordmark>; pack: CountryPack | null; namespaces: string[]; layers: Messages[]; ui: Messages[] } {
  return { brand: brandLayers(tag), wordmark: brandWordmark(tag), pack: deploymentPackForBrowser(), ...clientLayers(tag, 'root'), ui: uiLayers(tag) };
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
