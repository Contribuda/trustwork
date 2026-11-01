import { resolve, sep } from 'node:path';
import { getCountryPack, packs, type ClientPack, type CountryPack } from '@trustwork/country-packs';
import { isCountryOffered, resolveDeployment, type Deployment, type Env } from '@trustwork/config';
import { currentDeployment, dataPath, languageDirectories, type LoadedDeployment } from '@trustwork/config/server';

/**
 * Which countries and languages this deployment offers, and which a visitor starts with (CFG-001). Everything comes
 * from the deployment configuration (`@trustwork/config`) and the dictionaries found on disk; nothing here names a
 * country, and the only language named is the engine's English fallback through the configuration's default.
 */

const fromApp = process.cwd().endsWith(`${sep}apps${sep}web`);
const BUILT_IN_LOCALES_DIR = resolve(process.cwd(), fromApp ? 'locales' : 'apps/web/locales');
const dictionaries = new WeakMap<object, Set<string>>();

/**
 * Languages with an application dictionary: a directory in `apps/web/locales` or in the deployment's
 * `<dataDir>/locales` (the same discovery as `locale-data.ts`, without loading any dictionary).
 */
export function dictionaryLanguages(deployment: Deployment = currentDeployment()): Set<string> {
  let found = dictionaries.get(deployment);
  if (!found) {
    const dataDir = (deployment as Partial<LoadedDeployment>).dataDir ?? null;
    found = new Set([...languageDirectories(BUILT_IN_LOCALES_DIR), ...languageDirectories(dataDir ? dataPath({ dataDir }, 'locales') : null)]);
    dictionaries.set(deployment, found);
  }
  return found;
}

/**
 * Languages this deployment offers, in a stable order: the configured default, then the languages the active packs
 * suggest (pack order), then every other language with a dictionary. With `languages.enabled: "all"` (the default)
 * a language is offered as soon as its dictionary directory exists, so adding one is a data-only change.
 */
export function offeredLanguages(deployment: Deployment = currentDeployment()): string[] {
  const available = dictionaryLanguages(deployment);
  const enabled = deployment.languages.enabled;
  const candidates = enabled === 'all' ? [deployment.languages.default, ...packs().flatMap((p) => p.locales), ...[...available].sort()] : [deployment.languages.default, ...enabled];
  return [...new Set(candidates)].filter((tag) => available.has(tag));
}

export function isOfferedLanguage(tag: string, deployment: Deployment = currentDeployment()): boolean {
  return offeredLanguages(deployment).includes(tag);
}

/** The language a country starts in: the configured one for that country, else the pack's own when offered, else the deployment default. */
export function defaultLanguageFor(pack: Pick<ClientPack, 'code' | 'defaultLocale'>, deployment: Deployment = currentDeployment()): string {
  const offered = offeredLanguages(deployment);
  const configured = deployment.languages.byCountry[pack.code];
  if (configured && offered.includes(configured)) return configured;
  return offered.includes(pack.defaultLocale) ? pack.defaultLocale : deployment.languages.default;
}

/** Languages a visitor may pick for any country: the country's default first, then the deployment default, then every other offered language (owner decision 2026-10-29: any country × any language). */
export function localesFor(pack: Pick<ClientPack, 'code' | 'defaultLocale'>, deployment: Deployment = currentDeployment()): string[] {
  return [...new Set([defaultLanguageFor(pack, deployment), deployment.languages.default, ...offeredLanguages(deployment)])];
}

/**
 * Picks the language from the browser's Accept-Language list. When nothing matches, a visitor who chose a
 * country gets that country's default language; a visitor who has not chosen one gets the deployment's default
 * language (English unless configured, ADR 012 decision 27), never the language of whichever country is the default.
 */
export function negotiate(acceptLanguage: string | null, pack: Pick<ClientPack, 'code' | 'defaultLocale'>, countryChosen: boolean, deployment: Deployment = currentDeployment()): string {
  const wanted = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  const offered = localesFor(pack, deployment);
  for (const tag of wanted) {
    const exact = offered.find((o) => o.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    const byBase = offered.find((o) => (o.split('-')[0] ?? '').toLowerCase() === base);
    if (byBase) return byBase;
  }
  return countryChosen ? defaultLanguageFor(pack, deployment) : deployment.languages.default;
}

/**
 * The deployment's default country for visitors who have not chosen one, or null: the engine has none of its own
 * (ADR 012 decision 11). Set by `countries.default` in the configuration file or `TRUSTWORK_DEFAULT_COUNTRY`
 * (read when the server starts); the reference hub sets US (decisions 26 and 31). Pass `env` to resolve a
 * configuration without a file; an invalid or restricted value is a configuration error, never silently replaced.
 */
export function defaultCountryCode(env?: Env): string | null {
  if (!env) return currentDeployment().countries.default;
  const { deployment, problems } = resolveDeployment({ env });
  if (!deployment) throw new Error(problems.join('; '));
  return deployment.countries.default;
}

/** The pack of a country a visitor may choose here (a contributed pack or the generic profile), or null. */
export function offeredCountryPack(code: string | null | undefined, deployment: Deployment = currentDeployment()): CountryPack | null {
  if (!code || !isCountryOffered(deployment, code)) return null;
  return getCountryPack(code);
}
