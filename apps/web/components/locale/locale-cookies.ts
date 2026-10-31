import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, legacyLocaleCookiePaths, localeCookiePath } from '@/app/_lib/locale-names';
import { BASE_PATH } from '@/app/_lib/base-path';
import { unprefixedLanguage } from '@/app/_lib/localize';
import { isPublicPath, localizePath, splitLanguage } from '@/app/_lib/public-paths';

/** Browser-side cookie writes shared by the selector and the switcher; the page then refreshes. */
export function writeLocaleCookies(country: string, locale: string): void {
  for (const path of legacyLocaleCookiePaths(BASE_PATH)) {
    for (const name of [COUNTRY_COOKIE, LOCALE_COOKIE]) document.cookie = `${name}=; path=${path}; max-age=0; samesite=lax`;
  }
  const attrs = `; path=${localeCookiePath(BASE_PATH)}; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  document.cookie = `${COUNTRY_COOKIE}=${encodeURIComponent(country)}${attrs}`;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}${attrs}`;
}

/**
 * Where a language choice leads (ADR 012 decision 27): on a public page, the same page in the chosen language (the
 * prefix changes, the query and fragment stay); elsewhere null, and the page re-renders from the cookie.
 */
export function publicPathIn(tag: string, location: { pathname: string; search: string; hash: string }, languages: readonly string[]): string | null {
  const bare = BASE_PATH && location.pathname.startsWith(BASE_PATH) ? location.pathname.slice(BASE_PATH.length) || '/' : location.pathname;
  if (!isPublicPath(bare)) return null;
  const { path } = splitLanguage(bare, languages);
  return `${localizePath(path, tag, unprefixedLanguage())}${location.search}${location.hash}`;
}
