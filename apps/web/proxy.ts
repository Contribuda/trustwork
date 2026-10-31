import { NextResponse, type NextRequest } from 'next/server';
import { isOfferedLanguage, offeredCountryPack } from './app/_lib/locale-negotiation';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE as MAX_AGE, localeCookiePath } from './app/_lib/locale-names';
import { BASE_PATH } from './app/_lib/base-path';

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

/**
 * Security headers for every page (nonce-based CSP; Next reads the nonce from the request's CSP header and stamps
 * its own scripts) and, for `?country=<code>&lang=<tag>` on any address, sets the cookies and redirects to the same
 * address without the parameters, so links can carry a country and a language. Any country and language the
 * deployment offers works (its configuration, CFG-001; a restricted place is never offered, so it cannot be set);
 * other values are ignored.
 */
export function proxy(request: NextRequest) {
  const development = process.env.NODE_ENV === 'development';
  const url = request.nextUrl;
  if (url.pathname.startsWith('/media/')) {
    return withHeaders(NextResponse.next(), { 'Content-Security-Policy': MEDIA_CSP, 'X-Content-Type-Options': 'nosniff' });
  }
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { development, https: isHttps(request) });
  const headers = { ...documentSecurityHeaders(), 'Content-Security-Policy': csp };
  const country = url.searchParams.get('country');
  const lang = url.searchParams.get('lang');
  if (!country && !lang) {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', csp);
    return withHeaders(NextResponse.next({ request: { headers: requestHeaders } }), headers);
  }
  const clean = url.clone();
  clean.searchParams.delete('country');
  clean.searchParams.delete('lang');
  const response = withHeaders(NextResponse.redirect(clean), headers);
  const pack = offeredCountryPack(country);
  if (pack) response.cookies.set(COUNTRY_COOKIE, pack.code, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  if (lang && isOfferedLanguage(lang)) response.cookies.set(LOCALE_COOKIE, lang, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  return response;
}

/**
 * `'/'` is listed on its own because, with a base path, Next compiles the second pattern to `^<base>/(...)` with a
 * mandatory slash, so the home page at `<base>` (Next redirects `<base>/` to it) would get no CSP, no frame and
 * referrer headers and no `?country=&lang=` handling. Without a base path `'/'` is already covered; listing it is
 * harmless. Checked by infra/images/web-smoke.mjs against the image with the preview's base path.
 */
export const config = { matcher: ['/', '/((?!_next/|icons/|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest).*)'] };
