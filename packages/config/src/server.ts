import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { checkPackFile, getPack, installPacks, type CountryPack } from '@trustwork/country-packs';
import { CONFIG_FILE_NAME, isCanonicalLanguageTag, type Deployment } from './schema.js';
import { ENV, knownCountry, resolveDeployment, type Env } from './index.js';

/**
 * Loading the deployment configuration at start (CFG-001), server only. Reads the configuration file and the data
 * directory, validates everything with the same schemas the repository's own data uses, and reports every problem at
 * once. A deployment with any problem does not start: the caller gets a `DeploymentConfigError` and the server exits.
 *
 * Data directory layout (every part optional):
 *
 *   <dataDir>/trustwork.config.json            the configuration file, when TRUSTWORK_CONFIG names none
 *   <dataDir>/country-packs/<code>.json        country packs: new countries, or a replacement for a built-in pack
 *   <dataDir>/locales/<tag>/<namespace>.json   application dictionaries: a new language, or files replacing built-in ones
 *   <dataDir>/ui-locales/<tag>.json            design-system dictionaries
 *   <dataDir>/fixtures/i18n/<tag>.json         demo-content overrides for a language
 *   <dataDir>/brands/<id>.json                 brand overlays
 */
export const DATA_DIR_LAYOUT = {
  config: CONFIG_FILE_NAME,
  countryPacks: 'country-packs',
  locales: 'locales',
  uiLocales: 'ui-locales',
  fixtures: join('fixtures', 'i18n'),
  brands: 'brands',
} as const;

export class DeploymentConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The deployment configuration is invalid; the server does not start:\n- ${problems.join('\n- ')}`);
    this.name = 'DeploymentConfigError';
    this.problems = problems;
  }
}

/** A loaded deployment: the resolved configuration with an absolute data directory and the packs found there. */
export type LoadedDeployment = Deployment & { readonly dataDir: string | null; readonly packs: readonly CountryPack[] };

function readJson(path: string, problems: string[], label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    problems.push(`${label}: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** Every `*.json` pack file of a directory, validated; restricted, malformed or misnamed packs become problems. */
export function readPackDirectory(dir: string): { packs: CountryPack[]; problems: string[] } {
  const packs: CountryPack[] = [];
  const problems: string[] = [];
  if (!isDirectory(dir)) return { packs, problems };
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const label = join(DATA_DIR_LAYOUT.countryPacks, name);
    const raw = readJson(join(dir, name), problems, label);
    if (raw === undefined) continue;
    const check = checkPackFile(name, raw);
    if (check.pack) packs.push(check.pack);
    else problems.push(...check.problems.map((p) => `${DATA_DIR_LAYOUT.countryPacks}/${p}`));
  }
  return { packs, problems };
}

/** Language directories (`<tag>/`) of a dictionary directory: canonical BCP 47 names only. */
export function languageDirectories(dir: string | null): string[] {
  if (!dir || !isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isCanonicalLanguageTag(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Language files (`<tag>.json`) of a directory: canonical BCP 47 names only, mapped to their paths. */
export function languageFiles(dir: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!dir || !isDirectory(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const tag = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (tag && isCanonicalLanguageTag(tag)) out.set(tag, join(dir, name));
  }
  return out;
}

/** A path inside the data directory, or null without one. */
export function dataPath(deployment: Pick<LoadedDeployment, 'dataDir'>, part: keyof typeof DATA_DIR_LAYOUT, ...rest: string[]): string | null {
  return deployment.dataDir ? join(deployment.dataDir, DATA_DIR_LAYOUT[part], ...rest) : null;
}

/**
 * Loads the configuration from the environment, the configuration file and the data directory without changing any
 * global state. Throws `DeploymentConfigError` with every problem found.
 *
 * - `TRUSTWORK_CONFIG` names the file (relative to the working directory); otherwise `<dataDir>/trustwork.config.json`
 *   is used when it exists; otherwise there is no file and everything takes its default.
 * - `TRUSTWORK_DATA_DIR` names the data directory; otherwise the file's `dataDir`, relative to the file.
 */
export function loadDeployment({ env = process.env as Env, cwd = process.cwd() }: { env?: Env; cwd?: string } = {}): LoadedDeployment {
  const problems: string[] = [];
  const envDataDir = env[ENV.dataDir]?.trim() ? resolve(cwd, env[ENV.dataDir]!.trim()) : null;
  let filePath: string | null = null;
  const named = env[ENV.config]?.trim();
  if (named) {
    filePath = resolve(cwd, named);
    if (!existsSync(filePath)) problems.push(`${ENV.config}: ${named} does not exist`);
  } else if (envDataDir && existsSync(join(envDataDir, CONFIG_FILE_NAME))) {
    filePath = join(envDataDir, CONFIG_FILE_NAME);
  }
  const file = filePath && !problems.length ? readJson(filePath, problems, filePath) : undefined;
  if (problems.length) throw new DeploymentConfigError(problems);

  // First pass: everything except whether each country exists, which may depend on the data directory's packs.
  const first = resolveDeployment({ file, fileName: filePath, env, known: () => true });
  if (!first.deployment) throw new DeploymentConfigError(first.problems);
  const deployment = first.deployment;

  let dataDir: string | null = null;
  if (envDataDir) dataDir = envDataDir;
  else if (deployment.dataDir) dataDir = isAbsolute(deployment.dataDir) ? deployment.dataDir : resolve(filePath ? dirname(filePath) : cwd, deployment.dataDir);
  if (dataDir && !isDirectory(dataDir)) problems.push(`data directory ${dataDir} does not exist`);

  const { packs, problems: packProblems } = dataDir && !problems.length ? readPackDirectory(join(dataDir, DATA_DIR_LAYOUT.countryPacks)) : { packs: [], problems: [] };
  problems.push(...packProblems);

  // Second pass: every country named must exist (ISO dataset, built-in pack or data-directory pack); featured
  // countries need a pack, every other one may use the generic profile.
  const packCodes = new Set(packs.map((p) => p.code));
  if (!problems.length) {
    const second = resolveDeployment({ file, fileName: filePath, env, known: (code) => packCodes.has(code) || knownCountry(code) });
    problems.push(...second.problems);
  }
  for (const code of deployment.countries.featured ?? []) if (!packCodes.has(code) && !getPack(code)) problems.push(`countries.featured ${code} has no country pack`);

  if (problems.length) throw new DeploymentConfigError(problems);
  return { ...deployment, dataDir, packs };
}

/** Makes a loaded deployment's packs active in the pack registry (once per server process and bundle). */
export function activateDeployment(loaded: LoadedDeployment): void {
  installPacks(loaded.packs);
}

let current: LoadedDeployment | null = null;
let failure: Error | null = null;

/**
 * The deployment of this server process: loaded and activated the first time anything asks, then kept for the life of
 * the process. Next runs the proxy, server components and the start-up check in separate bundles, and each loads it
 * itself; the inputs are the same files and variables, so they agree. A change needs a restart, never a rebuild. An
 * invalid configuration throws `DeploymentConfigError` on every call (the start-up check stops the server first).
 */
export function currentDeployment(): LoadedDeployment {
  if (current) return current;
  if (failure) throw failure;
  try {
    const next = loadDeployment();
    activateDeployment(next);
    current = next;
    return next;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw failure;
  }
}

/** Uses the given deployment for this process (tests and tools); `null` forgets it so the next call loads again. */
export function setCurrentDeployment(next: LoadedDeployment | null): void {
  current = next;
  failure = null;
  if (next) activateDeployment(next);
  else installPacks([]);
}
