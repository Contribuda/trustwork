import { NextResponse, type NextRequest } from 'next/server';
import { getCountryPack, isLocale } from '@trustwork/country-packs';

import { COUNTRY_COOKIE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE as MAX_AGE, localeCookiePath } from './app/_lib/locale-names';
import { BASE_PATH } from './app/_lib/base-path';

/**
 * `?country=UZ&lang=uz-Latn` on any address sets the cookies and redirects to the same address without
 * the parameters, so links can carry a country and a language. Any selectable country works (a restricted
 * place is never selectable, so it cannot be set); unknown values are ignored.
 */
export function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const country = url.searchParams.get('country');
  const lang = url.searchParams.get('lang');
  if (!country && !lang) return NextResponse.next();
  const clean = url.clone();
  clean.searchParams.delete('country');
  clean.searchParams.delete('lang');
  const response = NextResponse.redirect(clean);
  const pack = country ? getCountryPack(country) : null;
  if (pack) response.cookies.set(COUNTRY_COOKIE, pack.code, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  if (lang && isLocale(lang)) response.cookies.set(LOCALE_COOKIE, lang, { path: localeCookiePath(BASE_PATH), maxAge: MAX_AGE, sameSite: 'lax' });
  return response;
}

export const config = { matcher: ['/((?!_next/|media/|icons/|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest).*)'] };
