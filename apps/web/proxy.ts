import { NextResponse, type NextRequest } from 'next/server';
import { getCountryPack, isLocale } from '@trustwork/country-packs';

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

/** Headers on every document and redirect the proxy answers. HSTS is ignored by browsers on plain-http responses. */
export function documentSecurityHeaders(development: boolean): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(development ? {} : { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
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
 * its own scripts) and, for `?country=UZ&lang=uz-Latn` on any address, sets the cookies and redirects to the same
 * address without the parameters, so links can carry a country and a language. Any selectable country works (a
 * restricted place is never selectable, so it cannot be set); unknown values are ignored.
 */
export function proxy(request: NextRequest) {
  const development = process.env.NODE_ENV === 'development';
  const url = request.nextUrl;
  if (url.pathname.startsWith('/media/')) {
    return withHeaders(NextResponse.next(), { 'Content-Security-Policy': MEDIA_CSP, 'X-Content-Type-Options': 'nosniff' });
  }
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, { development, https: isHttps(request) });
  const headers = { ...documentSecurityHeaders(development), 'Content-Security-Policy': csp };
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
  const pack = country ? getCountryPack(country) : null;
  if (pack) response.cookies.set(COUNTRY_COOKIE, pack.code, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  if (lang && isLocale(lang)) response.cookies.set(LOCALE_COOKIE, lang, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  return response;
}

export const config = { matcher: ['/((?!_next/|icons/|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest).*)'] };
