import { COUNTRIES, countryName, enabledPacks, getPack, pick, type CountryPack } from '@trustwork/country-packs';
import { isCountryOffered } from '@trustwork/config';
import { currentDeployment } from '@trustwork/config/server';
import { coverage } from '@/app/_lib/locale-data';
import { localesFor, primeLocale } from '@/app/_lib/locale';
import { defaultLanguageFor } from '@/app/_lib/locale-negotiation';
import { CountryGate } from './CountryGate';
import { LocaleSwitcher, type SwitcherCountry, type SwitcherLanguage } from './LocaleSwitcher';

/**
 * Server side: every country this deployment offers as a switcher row in the active language (its featured
 * packs first: `countries.featured` in the deployment configuration, else every enabled pack), and the
 * offered languages with their translation coverage. Any offered country may be combined with any offered
 * language (owner decision 2026-10-29); restricted places are never offered.
 */
export async function switcherCountries(): Promise<SwitcherCountry[]> {
  const active = await primeLocale();
  const deployment = currentDeployment();
  const featuredPacks = deployment.countries.featured ? deployment.countries.featured.map((code) => getPack(code)).filter((p): p is CountryPack => p !== null) : enabledPacks();
  const featured = featuredPacks
    .filter((pack) => isCountryOffered(deployment, pack.code))
    .map((pack) => ({ code: pack.code, name: pick(pack.name, active.locale), featured: true, defaultLocale: defaultLanguageFor(pack, deployment) }));
  const featuredCodes = new Set(featured.map((c) => c.code));
  const collator = new Intl.Collator(active.locale);
  const others = COUNTRIES.filter((c) => !featuredCodes.has(c.code) && isCountryOffered(deployment, c.code))
    .map((c) => ({ code: c.code, name: countryName(c.code, active.locale), featured: false, defaultLocale: deployment.languages.byCountry[c.code] ?? deployment.languages.default }))
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

/** Shown until a country cookie exists; with no default country configured, nothing is preselected (ADR 012 decision 11). */
export async function FirstVisitGate() {
  const active = await primeLocale();
  if (active.chosen) return null;
  return <CountryGate countries={await switcherCountries()} languages={await switcherLanguages()} suggested={active.country} suggestedLocale={active.locale} />;
}
