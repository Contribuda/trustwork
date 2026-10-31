import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { currentDeployment } from '@trustwork/config/server';
import { defaultLanguageFor, isOfferedLanguage, offeredCountryPack, offeredLanguages } from './app/_lib/locale-negotiation';
import { PUBLIC_ROUTE_HEADER, isEntryNavigation, isPublicPath, localizePath, splitLanguage } from './app/_lib/public-paths';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE as MAX_AGE, localeCookiePath } from './app/_lib/locale-names';
import { BASE_PATH } from './app/_lib/base-path';
import { clientAddressOf, decideWebRequest, JURISDICTION_REFUSAL_PATH, relaySighting } from './app/_lib/jurisdiction';

/** Third-party origins the pages load on purpose: the Leaflet stylesheet (script trust flows from the nonce) and map tiles. */
const MAP_STYLE_ORIGIN = 'https://unpkg.com';
const MAP_TILE_ORIGIN = 'https://*.tile.openstreetmap.org';

export interface CspOptions { development: boolean; https: boolean }

/**
 * Nonce-based Content Security Policy for HTML documents. Scripts run only with this request's nonce; `strict-dynamic`
 * extends trust to scripts those scripts load (Next chunks, the Leaflet loader). Styles allow `unsafe-inline` because
 * React writes `style` attributes; there is no inline script anywhere in the app. Development adds `unsafe-eval` and
 * websocket connections for the bundler's hot reload.
 */
export function contentSecurityPolicy(nonce: string, { development, https }: CspOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${MAP_STYLE_ORIGIN}${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline' ${MAP_STYLE_ORIGIN}`,
    `img-src 'self' data: blob: ${MAP_TILE_ORIGIN}`,
    "font-src 'self' data:",
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/**
 * `Strict-Transport-Security` exactly as configured in `TRUSTWORK_HSTS` (read at request time), or null: no HSTS by
 * default. HSTS pins the whole host, and with `includeSubDomains` every subdomain, to HTTPS for its max-age; that is
 * the domain operator's decision, so set it only when the app owns the whole host (never for an app served under a
 * path of another site, such as the hosted preview). A malformed value is ignored rather than sent.
 */
export function configuredHsts(raw: string | undefined = process.env.TRUSTWORK_HSTS): string | null {
  const value = raw?.trim();
  return value && /^max-age=\d{1,10}(\s*;\s*(includeSubDomains|preload))*\s*;?$/i.test(value) ? value : null;
}

/** Headers on every document and redirect the proxy answers. */
export function documentSecurityHeaders(hsts: string | null = configuredHsts()): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(hsts ? { 'Strict-Transport-Security': hsts } : {}),
  };
}

/** Repository media (including SVG) is never a document that may run script, even when opened directly. */
export const MEDIA_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function isHttps(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwarded ? forwarded === 'https' : request.nextUrl.protocol === 'https:';
}

function withHeaders(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** Relays a refused visitor's session to the API (SANC-001) after the response, so the API's gate can hold the person. */
function relay(request: NextRequest, event?: NextFetchEvent): void {
  const pending = relaySighting({ cookieHeader: request.headers.get('cookie'), address: clientAddressOf((name) => request.headers.get(name)) });
  if (event) event.waitUntil(pending);
  else void pending;
}

/**
 * Language routing of public pages (ADR 012 decision 27): the default language is unprefixed, every other offered
 * language is `/<lang>/...`. An unprefixed public address is rewritten to the default language's segment of
 * `app/(public)/[lang]`; `/<default>/...` redirects permanently to the unprefixed address; an entry navigation to an
 * unprefixed page by a visitor who prefers another offered language (the language cookie, or the language of the
 * country they chose when there is no language cookie) redirects to that language (never a prefixed address, never a
 * private page).
 */
type PublicRoute = { kind: 'serve'; lang: string; path: string } | { kind: 'redirect'; location: string; permanent: boolean; personal: boolean };

export function routePublic(pathname: string, cookieLang: string | undefined, entry: boolean, languages: { default: string; offered: readonly string[] }): PublicRoute {
  const prefixed = languages.offered.filter((tag) => tag !== languages.default);
  const { lang, path } = splitLanguage(pathname, [...prefixed, languages.default]);
  if (lang === languages.default) return { kind: 'redirect', location: path, permanent: true, personal: false };
  if (lang) return { kind: 'serve', lang, path };
  if (entry && cookieLang && cookieLang !== languages.default && prefixed.includes(cookieLang)) {
    return { kind: 'redirect', location: localizePath(pathname, cookieLang, languages.default), permanent: false, personal: true };
  }
  return { kind: 'serve', lang: languages.default, path: pathname };
}

/** The internal page of a public address: `/<lang><path>` in `app/(public)/[lang]`. */
export function internalPublicPath(lang: string, path: string): string {
  return `/${lang}${path === '/' ? '' : path}`;
}

/**
 * Security headers for every page and language routing for public ones. Every document, public pages included, gets the
 * nonce-based CSP (Next reads the nonce from the request's CSP header and stamps its own scripts), so every page is
 * rendered per request (WEB-005: full-page caching of public pages is deferred until a no-inline-script or build-time
 * hash approach is proven). `?country=<code>&lang=<tag>` on any address sets the cookies and redirects to the same
 * address without the parameters, in that language when it is a public page, so links can carry a country and a
 * language. Any country and language the deployment offers works (CFG-001; a restricted place is never offered, so it
 * cannot be set); other values are ignored. Before all of this the jurisdiction gate (SANC-001,
 * `app/_lib/jurisdiction.ts`) refuses requests from restricted places: pages render `/restricted`, everything else is
 * answered 451.
 */
export function proxy(request: NextRequest, event?: NextFetchEvent) {
  const development = process.env.NODE_ENV === 'development';
  const url = request.nextUrl;
  // SANC-001: the jurisdiction gate runs before anything else, media included.
  const decision = decideWebRequest({ method: request.method, pathname: url.pathname, header: (name) => request.headers.get(name) });
  if (decision.kind === 'unavailable' || decision.kind === 'refuse_call') {
    if (decision.kind === 'refuse_call') relay(request, event);
    return withHeaders(NextResponse.json(decision.body, { status: decision.status }), { 'Cache-Control': 'no-store', ...documentSecurityHeaders() });
  }
  if (url.pathname.startsWith('/media/')) {
    return withHeaders(NextResponse.next(), { 'Content-Security-Policy': MEDIA_CSP, 'X-Content-Type-Options': 'nosniff' });
  }
  if (decision.kind === 'refuse_page') {
    const nonce = newNonce();
    const csp = contentSecurityPolicy(nonce, { development, https: isHttps(request) });
    const headers = { ...documentSecurityHeaders(), 'Content-Security-Policy': csp };
    relay(request, event);
    const target = url.clone();
    target.pathname = JURISDICTION_REFUSAL_PATH;
    target.search = '';
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    requestHeaders.set('x-trustwork-refusal', 'jurisdiction');
    // 451 where the runtime keeps a rewrite's status (RFC 7725); the page is noindex either way.
    return withHeaders(NextResponse.rewrite(target, { status: 451, request: { headers: requestHeaders } }), { ...headers, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  }
  const https = isHttps(request);
  const deployment = currentDeployment();
  const languages = { default: deployment.languages.default, offered: offeredLanguages(deployment) };
  const country = url.searchParams.get('country');
  const lang = url.searchParams.get('lang');
  const isPublic = isPublicPath(url.pathname);

  if (country || lang) {
    const clean = url.clone();
    clean.searchParams.delete('country');
    clean.searchParams.delete('lang');
    const language = lang && isOfferedLanguage(lang) ? lang : null;
    if (isPublic && language) {
      const { path } = splitLanguage(url.pathname, languages.offered);
      clean.pathname = localizePath(path, language, languages.default); // NextURL adds the base path itself
    }
    const response = withHeaders(NextResponse.redirect(clean), { ...documentSecurityHeaders(), 'Content-Security-Policy': contentSecurityPolicy(newNonce(), { development, https }), 'Cache-Control': 'private, no-store' });
    const pack = offeredCountryPack(country);
    if (pack) response.cookies.set(COUNTRY_COOKIE, pack.code, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
    if (language) response.cookies.set(LOCALE_COOKIE, language, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
    return response;
  }

  if (isPublic) {
    // The visitor's language preference: the language cookie, else the language of the country they chose.
    const chosenCountry = offeredCountryPack(request.cookies.get(COUNTRY_COOKIE)?.value);
    const preferred = request.cookies.get(LOCALE_COOKIE)?.value ?? (chosenCountry ? defaultLanguageFor(chosenCountry, deployment) : undefined);
    const route = routePublic(url.pathname, preferred, isEntryNavigation(request.headers), languages);
    if (route.kind === 'redirect') {
      const target = url.clone();
      target.pathname = route.location; // NextURL adds the base path itself
      const response = NextResponse.redirect(target, route.permanent ? 308 : 307);
      return withHeaders(response, { ...documentSecurityHeaders(), ...(route.personal ? { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } : {}) });
    }
    // The internal page goes to the router as a request header that one `beforeFiles` rewrite in next.config.ts applies
    // (PUBLIC_ROUTE_HEADER). A middleware rewrite would do the same, but Next resolves it against `localhost` while a
    // server bound to 127.0.0.1 compares with `127.0.0.1`, so it would loop through this proxy again.
    const nonce = newNonce();
    const csp = contentSecurityPolicy(nonce, { development, https });
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete(PUBLIC_ROUTE_HEADER);
    const internal = internalPublicPath(route.lang, route.path);
    if (internal !== url.pathname) requestHeaders.set(PUBLIC_ROUTE_HEADER, internal.slice(1));
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), { ...documentSecurityHeaders(), 'Content-Security-Policy': csp });
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { development, https });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(PUBLIC_ROUTE_HEADER);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), { ...documentSecurityHeaders(), 'Content-Security-Policy': csp });
}

/**
 * `'/'` is listed on its own because, with a base path, Next compiles the second pattern to `^<base>/(...)` with a
 * mandatory slash, so the home page at `<base>` (Next redirects `<base>/` to it) would get no CSP, no frame and
 * referrer headers and no `?country=&lang=` handling. Without a base path `'/'` is already covered; listing it is
 * harmless. Checked by infra/images/web-smoke.mjs against the image with the preview's base path.
 */
export const config = { matcher: ['/', '/((?!_next/|icons/|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest).*)'] };
