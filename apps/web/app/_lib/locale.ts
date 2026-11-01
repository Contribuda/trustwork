import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getLocaleStore, runWithLocaleScope, setLocaleStore } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { uiLayers } from '@trustwork/ui/i18n/dictionaries';
import { BUILT_IN_PACKS, getCountryPack, toClientPack, type ClientPack } from '@trustwork/country-packs';
import { appLayers, brandLayers, brandWordmark } from './locale-data';
import { currentDeployment } from '@trustwork/config/server';
import { defaultCountryCode, localesFor, negotiate, offeredCountryPack, offeredLanguages } from './locale-negotiation';
import { neutralPack, setCountryPackResolver, setDefaultCountryReader } from './country';
import CLIENT_NAMESPACES from '@/locales/client-namespaces.json';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localeCookiePath } from './locale-names';
import { BASE_PATH } from './base-path';
import { setDefaultLanguage } from './localize';

export { COUNTRY_COOKIE, LOCALE_COOKIE };

setDefaultCountryReader(() => defaultCountryCode());
setCountryPackResolver(getCountryPack);
setDefaultLanguage(() => currentDeployment().languages.default);
export { localesFor };

/** `country` is empty when the visitor has not chosen one and the deployment configures none (ADR 012 decision 11). */
export type ActiveLocale = { country: string; locale: string; chosen: boolean; pack: ClientPack };

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

/**
 * One message in a given language without touching the request's locale store: for the few server components that
 * render inside every page's tree in a language of their own (the last-resort 404), where priming would switch the
 * language of the page rendering next to them.
 */
export function messageIn(tag: string, key: string): string {
  for (const layer of [...localeLayers(tag), ...localeLayers('en')]) {
    let node: unknown = layer;
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    if (typeof node === 'string') return node;
  }
  return key;
}

/** Route groups with their own client namespaces (`apps/web/locales/client-namespaces.json`). */
export type RouteGroup = Exclude<keyof typeof CLIENT_NAMESPACES, '$comment'>;

/** The namespaces whose messages a route group hands to client components (the root list reaches every page). */
export function clientNamespaces(group: RouteGroup): string[] {
  return [...CLIENT_NAMESPACES[group]];
}

/**
 * What the browser receives for one route group (INTL-004): the application layers of exactly the
 * namespaces that group's client components use. The document (`components/RootDocument.tsx`) adds the brand overlay and the design
 * system's dictionary once (`rootClientLocale`); a page therefore carries one language and only the
 * namespaces its route needs.
 */
export function clientLayers(tag: string, group: RouteGroup): { namespaces: string[]; layers: Messages[] } {
  const namespaces = clientNamespaces(group);
  return { namespaces, layers: appLayers(tag, namespaces) };
}

/**
 * The active country's pack when the browser bundle does not carry it: a pack from the deployment's data directory
 * (CFG-001) or the generic profile of a country without a contributed pack. The bundle carries the client subset of the
 * built-in packs (`@trustwork/country-packs/client`); this one reaches the browser as the same subset, only for visitors
 * in that country, and never with its facets, sources or verification notes.
 */
function packForBrowser(): ClientPack | null {
  const country = getLocaleStore().country;
  const pack = country ? getCountryPack(country) : null;
  return pack && !BUILT_IN_PACKS.includes(pack) ? toClientPack(pack) : null;
}

/** The document's client locale (`components/RootDocument.tsx`): brand overlay (messages and this language's wordmark), the visitor's pack when the bundle lacks it, the root namespaces and the design system's dictionary. */
export function rootClientLocale(tag: string): { brand: Messages[]; wordmark: ReturnType<typeof brandWordmark>; pack: ClientPack | null; namespaces: string[]; layers: Messages[]; ui: Messages[] } {
  return { brand: brandLayers(tag), wordmark: brandWordmark(tag), pack: packForBrowser(), ...clientLayers(tag, 'root'), ui: uiLayers(tag) };
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

/** Languages that appear as a URL prefix: every offered language except the deployment's default (decision 27). */
export function prefixedLanguages(): string[] {
  const fallback = currentDeployment().languages.default;
  return offeredLanguages().filter((tag) => tag !== fallback);
}

/** Whether `/<lang>/...` is a public address of this deployment (the default language is never prefixed). */
export function isPrefixedLanguage(lang: string): boolean {
  return prefixedLanguages().includes(lang);
}

/**
 * The locale of a public page (WEB-005): the language comes from the URL (`app/(public)/[lang]`, the proxy maps an
 * unprefixed address to the default language), never from the cookie, so a shared `/es/...` link always opens in
 * Spanish (decision 27). The country is the visitor's chosen one (the `trustwork.country` cookie, which also selects the
 * demo dataset, DEMO-US), else the deployment's default; a public page reads nothing else of the visitor, never the
 * session. Every public layout, page, metadata function and route handler awaits this first (they render in parallel);
 * React `cache` makes it one resolution per request and language.
 */
export const primePublicLocale = cache(async (lang: string): Promise<ActiveLocale> => {
  const jar = await cookies();
  const wanted = offeredCountryPack(jar.get(COUNTRY_COOKIE)?.value);
  const fallback = defaultCountryCode();
  const pack = wanted ?? (fallback ? getCountryPack(fallback) : null) ?? neutralPack();
  const locale = lang === currentDeployment().languages.default || isPrefixedLanguage(lang) ? lang : currentDeployment().languages.default;
  const active: ActiveLocale = { country: pack === neutralPack() ? '' : pack.code, locale, chosen: wanted !== null, pack };
  setLocaleStore({ locale: active.locale, country: active.country, layers: localeLayers(active.locale) });
  return active;
});

/** Route params of every public page carry the language segment. */
export type LangParams = Promise<{ lang: string }>;

/** `primePublicLocale` from a page's or layout's params. */
export async function primeFromParams(params: Promise<{ lang: string }>): Promise<ActiveLocale> {
  return primePublicLocale((await params).lang);
}

/** Route handlers under a language segment: runs the handler in its own locale scope for that language. */
export function withPublicLocale<P extends { lang: string }, R>(
  handler: (request: Request, context: { params: Promise<P> }) => R | Promise<R>,
): (request: Request, context: { params: Promise<P> }) => Promise<R> {
  return (request, context) =>
    runWithLocaleScope(async () => {
      await primePublicLocale((await context.params).lang);
      return handler(request, context);
    });
}

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
