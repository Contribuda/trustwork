import { ALL_LOCALES, FALLBACK_LOCALE, type CountryPack } from '@trustwork/country-packs';

/** Languages a visitor may pick for any country: the pack's default first, then the engine fallback, then every other engine language (owner decision 2026-10-29: any country × any language). */
export function localesFor(pack: CountryPack): string[] {
  return [...new Set([pack.defaultLocale, FALLBACK_LOCALE, ...ALL_LOCALES])];
}

/**
 * Picks the language from the browser's Accept-Language list. When nothing matches, a visitor who chose a
 * country gets that country's default language; a visitor who has not chosen one gets English, the engine's
 * default language (ADR 012, decision 27), never the language of whichever pack happens to be the fallback.
 */
export function negotiate(acceptLanguage: string | null, pack: CountryPack, countryChosen: boolean): string {
  const wanted = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  const offered = localesFor(pack);
  for (const tag of wanted) {
    const exact = offered.find((o) => o.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    const byBase = offered.find((o) => (o.split('-')[0] ?? '').toLowerCase() === base);
    if (byBase) return byBase;
  }
  return countryChosen ? pack.defaultLocale : FALLBACK_LOCALE;
}
