import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, legacyLocaleCookiePaths, localeCookiePath } from '@/app/_lib/locale-names';
import { BASE_PATH } from '@/app/_lib/base-path';

/** Browser-side cookie writes shared by the selector and the switcher; the page then refreshes. */
export function writeLocaleCookies(country: string, locale: string): void {
  for (const path of legacyLocaleCookiePaths(BASE_PATH)) {
    for (const name of [COUNTRY_COOKIE, LOCALE_COOKIE]) document.cookie = `${name}=; path=${path}; max-age=0; samesite=lax`;
  }
  const attrs = `; path=${localeCookiePath(BASE_PATH)}; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  document.cookie = `${COUNTRY_COOKIE}=${encodeURIComponent(country)}${attrs}`;
  document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}${attrs}`;
}
