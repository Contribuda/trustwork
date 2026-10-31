/**
 * Language in public URLs (ADR 012 decision 27, WEB-005). Shared by the proxy, server components and the browser, so
 * it imports nothing that only runs on the server.
 *
 * - Public pages in the deployment's default language (English unless configured) have no prefix: `/news/<slug>`.
 * - Every other language is a path prefix: `/es/news/<slug>`, `/ru/news/<slug>`. The country is never part of a URL
 *   (a hub defines its territory).
 * - Private and transactional areas (workspace, sign-in, onboarding, media, the API) are not localized by URL: they
 *   follow the visitor's language cookie.
 *
 * Internally every public page lives under `app/(public)/[lang]/`; the proxy rewrites an unprefixed address to the
 * default language's segment, so `/news` and `/es/news` are two documents that do not depend on the visitor.
 */

/** First path segments that are not public pages and therefore never carry a language prefix. */
export const UNLOCALIZED_SEGMENTS: ReadonlySet<string> = new Set([
  'app',
  'login',
  'signup',
  'recover',
  'logout',
  'verify-email',
  'onboarding',
  // The hub console (ADM-002): private, per request, in the visitor's cookie language.
  'admin',
  // The jurisdiction gate's refusal page (SANC-001): per request, in the visitor's cookie language.
  'restricted',
  'media',
  'v1',
  '_next',
  'icons',
  'favicon.ico',
  'icon.svg',
  'apple-icon.png',
  'manifest.webmanifest',
]);

/** A language prefix segment: `es`, `ru`, `uz-Latn`, `az-Latn` (BCP 47 language with an optional script or region). */
const LANGUAGE_SEGMENT = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function split(href: string): { path: string; rest: string } {
  const cut = href.search(/[?#]/);
  return cut === -1 ? { path: href, rest: '' } : { path: href.slice(0, cut), rest: href.slice(cut) };
}

function firstSegment(path: string): string {
  return path.split('/')[1] ?? '';
}

/** Whether an app-absolute path (without the base path) is a public page that takes a language prefix. */
export function isPublicPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  const segment = firstSegment(split(path).path);
  // `_next`, `__nextjs_*` (framework internals) and `.well-known` are never pages.
  return !UNLOCALIZED_SEGMENTS.has(segment) && !segment.startsWith('_') && !segment.startsWith('.');
}

/**
 * The language a public path names and the path without it. `offered` lists the languages that may appear as a
 * prefix (the deployment's offered languages other than the default); anything else is an unprefixed path.
 */
export function splitLanguage(path: string, offered: ReadonlySet<string> | readonly string[]): { lang: string | null; path: string } {
  const set = offered instanceof Set ? offered : new Set(offered);
  const { path: bare, rest } = split(path);
  const segment = firstSegment(bare);
  if (!segment || !LANGUAGE_SEGMENT.test(segment) || !set.has(segment)) return { lang: null, path };
  const remainder = bare.slice(segment.length + 1) || '/';
  return { lang: segment, path: `${remainder}${rest}` };
}

/**
 * The address of a public page in a language: unprefixed for the default language, `/<lang>/...` otherwise. Paths
 * outside the public area, external URLs, fragments and already prefixed paths pass through unchanged, so applying it
 * twice is harmless.
 */
export function localizePath(href: string, lang: string, defaultLanguage: string): string {
  if (!isPublicPath(href) || !lang || lang === defaultLanguage) return href;
  const { path, rest } = split(href);
  if (firstSegment(path) === lang) return href;
  return `/${lang}${path === '/' ? '' : path}${rest}`;
}

/**
 * Whether a request enters the site on an unprefixed public page (an "entry page" of decision 27) rather than moving
 * inside it: the language preference redirects only such requests. Entering means a top-level navigation that the
 * browser reports as typed, bookmarked or coming from another site (`Sec-Fetch-Site: none` or `cross-site`), or a
 * client that sends no `Sec-Fetch-Site` at all (not a browser). Links inside the site already carry the right prefix,
 * and a visitor who deliberately opens the unprefixed page from inside the site (an explicit language choice) is never
 * redirected.
 */
export function isEntryNavigation(headers: { get(name: string): string | null }): boolean {
  if (headers.get('rsc') || headers.get('next-router-prefetch') || headers.get('next-action')) return false;
  const site = headers.get('sec-fetch-site');
  // Browsers send Sec-Fetch-Site on every request; without it the client is not a browser (a crawler, curl, a server
  // fetch that only adds Sec-Fetch-Mode) and its request is an entry.
  if (site === null) return true;
  return headers.get('sec-fetch-mode') === 'navigate' && (site === 'none' || site === 'cross-site');
}

/** Query parameters that never change a public page: the demo persona and scenario (decided in the browser) and Next's own. */
const NEUTRAL_PARAMS = new Set(['persona', 'scenario', '_rsc']);

/** Whether a query asks for a filtered view of a list (`?topic=`, `?q=`, `?page=` and every other filter): such addresses are canonical to the list and not indexed. */
export function isFilteredQuery(params: URLSearchParams): boolean {
  for (const key of params.keys()) if (!NEUTRAL_PARAMS.has(key)) return true;
  return false;
}

/**
 * Request header that carries a public page's internal path (without the leading slash, for example `en/news`) from
 * the proxy to the one `beforeFiles` rewrite in next.config.ts that applies it. The proxy removes any copy a client
 * sends before it sets its own.
 */
export const PUBLIC_ROUTE_HEADER = 'x-trustwork-public-route';
