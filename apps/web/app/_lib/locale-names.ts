/** Cookie names shared by the server resolver, the proxy and the browser-side writers (no server imports here). */
export const COUNTRY_COOKIE = 'trustwork.country';
export const LOCALE_COOKIE = 'trustwork.locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Path the locale cookies live on: the base path without a trailing slash, so both `/trustwork` and every
 * `/trustwork/...` page receive them (a cookie on `/trustwork/` never reaches the bare `/trustwork` home);
 * `/` when the app is served at the root.
 */
export function localeCookiePath(basePath: string): string {
  return basePath.replace(/\/+$/, '') || '/';
}

/**
 * Paths earlier builds wrote the same cookies on. A stale copy there would shadow a new choice: the browser
 * sends the shortest path last and Next keeps the last duplicate. Every choice clears them.
 */
export function legacyLocaleCookiePaths(basePath: string): string[] {
  const base = basePath.replace(/\/+$/, '');
  return base ? ['/', `${base}/`] : [];
}
