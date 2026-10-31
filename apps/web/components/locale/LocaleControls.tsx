import { COUNTRIES, countryName, enabledPacks, pick } from '@trustwork/country-packs';
import { coverage } from '@/app/_lib/locale-data';
import { localesFor, primeLocale } from '@/app/_lib/locale';
import { CountryGate } from './CountryGate';
import { LocaleSwitcher, type SwitcherCountry, type SwitcherLanguage } from './LocaleSwitcher';

/**
 * Server side: every selectable country as a switcher row in the active language (the platform's own
 * packs first, flagged `featured`), and the engine languages with their translation coverage. Any
 * country may be combined with any language (owner decision 2026-10-29).
 */
export async function switcherCountries(): Promise<SwitcherCountry[]> {
  const active = await primeLocale();
  const featured = enabledPacks().map((pack) => ({ code: pack.code, name: pick(pack.name, active.locale), featured: true, defaultLocale: pack.defaultLocale }));
  const featuredCodes = new Set(featured.map((c) => c.code));
  const collator = new Intl.Collator(active.locale);
  const others = COUNTRIES.filter((c) => !featuredCodes.has(c.code))
    .map((c) => ({ code: c.code, name: countryName(c.code, active.locale), featured: false, defaultLocale: 'en' }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return [...featured, ...others];
}

export async function switcherLanguages(): Promise<SwitcherLanguage[]> {
  const active = await primeLocale();
  return localesFor(active.pack).map((tag) => {
    const c = coverage(tag);
    return { tag, partial: c.translated < c.total };
  });
}

export async function HeaderLocaleSwitcher({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const active = await primeLocale();
  return <LocaleSwitcher countries={await switcherCountries()} languages={await switcherLanguages()} country={active.country} locale={active.locale} tone={tone} />;
}

/** Shown until a country cookie exists. */
export async function FirstVisitGate() {
  const active = await primeLocale();
  if (active.chosen) return null;
  return <CountryGate countries={await switcherCountries()} languages={await switcherLanguages()} suggested={active.country} suggestedLocale={active.locale} />;
}
