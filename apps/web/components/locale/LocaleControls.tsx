import { cache } from 'react';
import { COUNTRIES, countryName, enabledPacks, getPack, pick, type CountryPack } from '@trustwork/country-packs';
import { isCountryOffered } from '@trustwork/config';
import { currentDeployment } from '@trustwork/config/server';
import { coverage } from '@/app/_lib/locale-data';
import { localesFor, type ActiveLocale } from '@/app/_lib/locale';
import { defaultLanguageFor } from '@/app/_lib/locale-negotiation';
import { CountryGate } from './CountryGate';
import { LocaleSwitcher, type SwitcherCountry, type SwitcherLanguage } from './LocaleSwitcher';

/**
 * Server side: every country this deployment offers as a switcher row in the active language (its featured
 * packs first: `countries.featured` in the deployment configuration, else every enabled pack), and the
 * offered languages with their translation coverage. Any offered country may be combined with any offered
 * language (owner decision 2026-10-29); restricted places are never offered.
 */
export const switcherCountries = cache(function switcherCountries(active: ActiveLocale): SwitcherCountry[] {
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
});

/**
 * Both lists are computed once per request and locale (React `cache`): the header switcher and the first-visit window
 * then hand the same arrays to the browser, and the page payload carries them once instead of twice.
 */
export const switcherLanguages = cache(function switcherLanguages(active: ActiveLocale): SwitcherLanguage[] {
  return localesFor(active.pack).map((tag) => {
    const c = coverage(tag);
    return { tag, partial: c.translated < c.total };
  });
});

/** `active` is the locale the page renders in (public pages: the URL language and the visitor's country). */
export function HeaderLocaleSwitcher({ active, tone = 'light' }: { active: ActiveLocale; tone?: 'light' | 'dark' }) {
  return <LocaleSwitcher countries={switcherCountries(active)} languages={switcherLanguages(active)} country={active.country} locale={active.locale} tone={tone} />;
}

/** Shown until a country cookie exists; with no default country configured, nothing is preselected (ADR 012 decision 11). */
export function FirstVisitGate({ active }: { active: ActiveLocale }) {
  if (active.chosen) return null;
  return <CountryGate countries={switcherCountries(active)} languages={switcherLanguages(active)} suggested={active.country} suggestedLocale={active.locale} />;
}
