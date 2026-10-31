import { getCountry, getPack, isRestricted } from '@trustwork/country-packs';
import { CountryCodeSchema, DEPLOYMENT_CONFIG_SCHEMA_VERSION, DeploymentConfigSchema, BrandIdSchema, type Deployment, type DeploymentConfigFile } from './schema.js';

/**
 * Deployment configuration (CFG-001): pure resolution of the configuration file and the environment into the values
 * the engine reads. No file system here (see `./server` for loading); nothing in this package names a country, a
 * language other than the English fallback, or a brand as a default.
 */
export * from './schema.js';

export type Env = Readonly<Record<string, string | undefined>>;

/** The engine's fallback language (ADR 009; English is the default language, ADR 012 decision 27). */
export const ENGINE_LANGUAGE = 'en';

/**
 * Environment variables that override the file, one per value an operator most often sets per container. Values are
 * read when the server starts, so one image serves deployments with different settings.
 */
export const ENV = {
  config: 'TRUSTWORK_CONFIG',
  dataDir: 'TRUSTWORK_DATA_DIR',
  defaultCountry: 'TRUSTWORK_DEFAULT_COUNTRY',
  brand: 'TRUSTWORK_BRAND',
  siteUrl: 'TRUSTWORK_SITE_URL',
} as const;

export type Resolution = { deployment: Deployment | null; problems: string[] };

const set = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** A country the engine knows: one of the ISO dataset, or one an active pack describes. */
export type KnownCountry = (code: string) => boolean;
export const knownCountry: KnownCountry = (code) => Boolean(getCountry(code) ?? getPack(code));

/** Every problem with country codes in the configuration: restricted places first (they are never negotiable). */
function countryProblems(where: string, codes: readonly string[], known: KnownCountry): string[] {
  const problems: string[] = [];
  for (const code of codes) {
    if (isRestricted(code)) problems.push(`${where}: ${code} is a restricted place and can never be offered or used as a default`);
    else if (!known(code)) problems.push(`${where}: ${code} is not a country the engine knows (ISO 3166-1 alpha-2, or a country pack in the data directory)`);
  }
  return problems;
}

/**
 * Resolves a parsed configuration file (or none) and the environment into a deployment. Returns every problem at once;
 * a deployment is returned only when there are none.
 */
export function resolveDeployment({ file, fileName = null, env = {}, known = knownCountry }: { file?: unknown; fileName?: string | null; env?: Env; known?: KnownCountry }): Resolution {
  const problems: string[] = [];
  const label = fileName ?? 'configuration';
  let config: DeploymentConfigFile = { schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION };
  if (file !== undefined && file !== null) {
    const parsed = DeploymentConfigSchema.safeParse(file);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${label}: ${issue.path.join('.') || '(file)'}: ${issue.message}`);
      return { deployment: null, problems };
    }
    config = parsed.data;
  }

  // Environment overrides.
  let defaultCountry = config.countries?.default ?? null;
  const envCountry = set(env[ENV.defaultCountry])?.toUpperCase();
  if (envCountry !== undefined) {
    if (envCountry === 'NONE') defaultCountry = null;
    else if (CountryCodeSchema.safeParse(envCountry).success) defaultCountry = envCountry;
    else problems.push(`${ENV.defaultCountry}: "${env[ENV.defaultCountry]}" is not an ISO 3166-1 alpha-2 code (or "none")`);
  }
  let brand: Deployment['brand'] = config.brand ? { overlay: config.brand.overlay } : undefined;
  const envBrand = set(env[ENV.brand]);
  if (envBrand !== undefined) {
    if (envBrand.toLowerCase() === 'none') brand = { overlay: null };
    else if (BrandIdSchema.safeParse(envBrand).success) brand = { overlay: envBrand };
    else problems.push(`${ENV.brand}: "${envBrand}" is not a brand overlay id (or "none")`);
  }
  let siteUrl = config.site?.url ?? null;
  const envSite = set(env[ENV.siteUrl]);
  if (envSite !== undefined) {
    try {
      const url = new URL(envSite);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
      siteUrl = envSite;
    } catch {
      problems.push(`${ENV.siteUrl}: "${envSite}" is not an http or https URL`);
    }
  }
  const dataDir = set(env[ENV.dataDir]) ?? config.dataDir ?? null;

  const offered = config.countries?.offered ?? 'all';
  const featured = config.countries?.featured ?? null;
  const languagesDefault = config.languages?.default ?? ENGINE_LANGUAGE;
  const enabled = config.languages?.enabled ?? 'all';
  const byCountry = config.languages?.byCountry ?? {};

  // Countries: never a restricted place, always a known country, the default and the featured ones among those offered.
  if (defaultCountry) problems.push(...countryProblems(envCountry !== undefined ? ENV.defaultCountry : `${label}: countries.default`, [defaultCountry], known));
  if (offered !== 'all') {
    problems.push(...countryProblems(`${label}: countries.offered`, offered, known));
    if (new Set(offered).size !== offered.length) problems.push(`${label}: countries.offered lists a country twice`);
  }
  if (featured) {
    problems.push(...countryProblems(`${label}: countries.featured`, featured, known));
    if (new Set(featured).size !== featured.length) problems.push(`${label}: countries.featured lists a country twice`);
  }
  problems.push(...countryProblems(`${label}: languages.byCountry`, Object.keys(byCountry), known));
  if (offered !== 'all') {
    if (defaultCountry && !offered.includes(defaultCountry)) problems.push(`${label}: countries.default ${defaultCountry} is not in countries.offered`);
    for (const code of featured ?? []) if (!offered.includes(code)) problems.push(`${label}: countries.featured ${code} is not in countries.offered`);
  }

  // Languages: the default and every per-country default among the enabled ones.
  if (enabled !== 'all') {
    if (new Set(enabled).size !== enabled.length) problems.push(`${label}: languages.enabled lists a language twice`);
    if (!enabled.includes(languagesDefault)) problems.push(`${label}: languages.default ${languagesDefault} is not in languages.enabled`);
    for (const [code, tag] of Object.entries(byCountry)) if (!enabled.includes(tag)) problems.push(`${label}: languages.byCountry.${code} ${tag} is not in languages.enabled`);
  }

  if (problems.length) return { deployment: null, problems };
  return {
    deployment: {
      schemaVersion: DEPLOYMENT_CONFIG_SCHEMA_VERSION,
      revision: config.revision?.number ?? null,
      countries: { default: defaultCountry, offered, featured },
      languages: { default: languagesDefault, enabled, byCountry },
      brand,
      site: { url: siteUrl },
      dataDir,
      source: { file: fileName },
    },
    problems,
  };
}

/** Whether a visitor may choose this country in this deployment (restricted places never). */
export function isCountryOffered(deployment: Deployment, code: string): boolean {
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper) || isRestricted(upper) || !knownCountry(upper)) return false;
  return deployment.countries.offered === 'all' || deployment.countries.offered.includes(upper);
}

/** The deployment with nothing configured: no default country, every country and every language with a dictionary offered, English as the fallback. */
export function unconfiguredDeployment(): Deployment {
  const { deployment } = resolveDeployment({});
  return deployment!;
}
