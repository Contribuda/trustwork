import { CompaniesFileSchema, IssuesFileSchema, PeopleFileSchema, ProjectsFileSchema, PublicationsFileSchema, WorkspaceFileSchema, EventsFileSchema, CoursesFileSchema } from '@/fixtures/schemas';
import { localeTag } from '@trustwork/ui/i18n';
import { getLocaleStore } from '@trustwork/i18n-runtime';
import peopleJson from '@/fixtures/people.json';
import companiesJson from '@/fixtures/companies.json';
import projectsJson from '@/fixtures/projects.json';
import publicationsJson from '@/fixtures/publications.json';
import issuesJson from '@/fixtures/issues.json';
import workspaceJson from '@/fixtures/workspace.json';
import eventsJson from '@/fixtures/events.json';
import coursesJson from '@/fixtures/courses.json';
import usPeopleJson from '@/fixtures/us/people.json';
import usCompaniesJson from '@/fixtures/us/companies.json';
import usProjectsJson from '@/fixtures/us/projects.json';
import usPublicationsJson from '@/fixtures/us/publications.json';
import usIssuesJson from '@/fixtures/us/issues.json';
import usWorkspaceJson from '@/fixtures/us/workspace.json';
import usEventsJson from '@/fixtures/us/events.json';
import usCoursesJson from '@/fixtures/us/courses.json';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { currentDeployment, dataPath, languageFiles } from '@trustwork/config/server';
import { DATASETS, selectDataset, type DatasetId } from '@/fixtures/datasets';

export { DATASETS, DATASET_IDS, datasetForCountry, selectDataset, type DatasetId } from '@/fixtures/datasets';

/**
 * Fixture store: every file is parsed with its Zod envelope at first use, so an invalid fixture fails
 * `next build` (and `tests/web/fixtures.test.ts`, `tests/web/demo-us`) instead of rendering wrong data.
 * Server-only: fixtures never ship to the browser as a whole; pages pass projected view models.
 *
 * Demo datasets (DEMO-US, `@/fixtures/datasets`): the United States reference hub (`us`, English base files in
 * `fixtures/us`) and the original example hub (`example`, Russian base files in `fixtures`), both synthetic. Each request
 * reads the dataset `selectDataset` picks from the visitor's country and the deployment's default country (CFG-001).
 *
 * Localization is per string: the locale's own override, then the English override, then the base text. The English
 * layer covers every base string of the Russian-written dataset (tests/web/fixtures.test.ts), so a reader outside the
 * Russian locale never sees Russian demo content (owner decision 2026-10-29, ADR-009 owner decision 10); the US
 * dataset is English already and every other engine language carries its own copy (tests/web/demo-us).
 *
 * Override files are data, discovered by name (CFG-001): every built-in `<dataset>/i18n/<tag>.json`, plus the
 * deployment's `<dataDir>/fixtures/i18n/<tag>.json` for the example dataset and `<dataDir>/fixtures/us/i18n/<tag>.json`
 * for the US dataset (each replaces a built-in file of the same language). A language with demo content therefore
 * needs no code change; the files are read once per process.
 */
type Overrides = Record<string, Record<string, string>>;

type FixtureFile = 'people' | 'companies' | 'projects' | 'publications' | 'issues' | 'workspace' | 'events' | 'courses';

/** The base files of each dataset (static imports, so `next build` bundles and validates them). */
const FILES: Record<DatasetId, Readonly<Record<FixtureFile, unknown>>> = {
  example: { people: peopleJson, companies: companiesJson, projects: projectsJson, publications: publicationsJson, issues: issuesJson, workspace: workspaceJson, events: eventsJson, courses: coursesJson },
  us: { people: usPeopleJson, companies: usCompaniesJson, projects: usProjectsJson, publications: usPublicationsJson, issues: usIssuesJson, workspace: usWorkspaceJson, events: usEventsJson, courses: usCoursesJson },
};

const fromApp = process.cwd().endsWith(`${sep}apps${sep}web`);
const FIXTURES_DIR = resolve(process.cwd(), fromApp ? 'fixtures' : 'apps/web/fixtures');

function readOverrides(dataset: DatasetId): Record<string, Overrides> {
  const { dir } = DATASETS[dataset];
  const builtIn = join(FIXTURES_DIR, dir, 'i18n');
  const deploymentDir = dataPath(currentDeployment(), 'fixtures');
  const fromDeployment = deploymentDir && dir ? join(dirname(deploymentDir), dir, 'i18n') : deploymentDir;
  return Object.fromEntries([...languageFiles(builtIn), ...languageFiles(fromDeployment)].map(([tag, path]) => [tag, JSON.parse(readFileSync(path, 'utf8')) as Overrides]));
}

const OVERRIDES: Record<DatasetId, Record<string, Overrides>> = { example: readOverrides('example'), us: readOverrides('us') };

function applyOverrides(file: string, base: unknown, overrides: Record<string, string> | undefined): unknown {
  if (!overrides) return base;
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [path, text] of Object.entries(overrides)) {
    const parts = path.split('/');
    let node: unknown = copy;
    for (const part of parts.slice(0, -1)) node = Array.isArray(node) ? node[Number(part)] : (node as Record<string, unknown>)[part];
    const last = parts[parts.length - 1]!;
    const exists = Array.isArray(node) ? Number(last) < node.length : Boolean(node && typeof node === 'object' && last in node);
    if (!exists) throw new Error(`fixtures/i18n: ${file}:${path} does not exist in the base fixture`);
    if (Array.isArray(node)) node[Number(last)] = text;
    else (node as Record<string, unknown>)[last] = text;
  }
  return copy;
}

/** The override map for one file in one locale: the English layer first, the locale's own strings on top. */
function overridesFor(dataset: DatasetId, locale: string, file: string): Record<string, string> | undefined {
  const all = OVERRIDES[dataset];
  const own = all[locale]?.[file];
  if (locale === 'en' || locale === DATASETS[dataset].baseLanguage) return own;
  const english = all.en?.[file];
  if (!english && !own) return undefined;
  return { ...(english ?? {}), ...(own ?? {}) };
}

function parseAll(dataset: DatasetId, locale: string) {
  const files = FILES[dataset];
  const pick = <T>(file: FixtureFile, parse: (raw: unknown) => T): T => parse(applyOverrides(file, files[file], overridesFor(dataset, locale, file)));
  return {
    people: pick('people', (raw) => PeopleFileSchema.parse(raw).people),
    companies: pick('companies', (raw) => CompaniesFileSchema.parse(raw).companies),
    projects: pick('projects', (raw) => ProjectsFileSchema.parse(raw).projects),
    publications: pick('publications', (raw) => PublicationsFileSchema.parse(raw).publications),
    issues: pick('issues', (raw) => IssuesFileSchema.parse(raw).issues),
    workspace: pick('workspace', (raw) => WorkspaceFileSchema.parse(raw)),
    events: pick('events', (raw) => EventsFileSchema.parse(raw).events),
    courses: pick('courses', (raw) => CoursesFileSchema.parse(raw).courses),
  } as const;
}

type Parsed = ReturnType<typeof parseAll>;
const cache = new Map<string, Parsed>();

/**
 * The fixtures of a dataset for a locale (base content plus the English layer plus that locale's overrides), parsed
 * once per dataset and locale. A locale without its own override file reads the English content, never the Russian
 * base. Without a dataset: the example dataset (tools and the configuration probe).
 */
export function fixturesFor(locale: string, dataset: DatasetId = 'example'): Parsed {
  const base: string = DATASETS[dataset].baseLanguage;
  const tag = locale in OVERRIDES[dataset] ? locale : locale === base ? base : 'en';
  const key = `${dataset}:${tag}`;
  let parsed = cache.get(key);
  if (!parsed) {
    parsed = parseAll(dataset, tag);
    cache.set(key, parsed);
  }
  return parsed;
}

/** The dataset of the active request (request-scoped on the server): see `selectDataset`. */
export function activeDataset(): DatasetId {
  return selectDataset(getLocaleStore().country, currentDeployment().countries.default);
}

/** The fixtures for the active locale and dataset; property access resolves both at call time (request-scoped on the server). */
export const fixtures: Parsed = new Proxy({} as Parsed, {
  get(_target, property) {
    return fixturesFor(localeTag(), activeDataset())[property as keyof Parsed];
  },
});

/** Locales that carry demo content for a dataset: its base language plus every override file. */
export function fixtureLocales(dataset: DatasetId): string[] {
  return [...new Set<string>([DATASETS[dataset].baseLanguage, ...Object.keys(OVERRIDES[dataset])])];
}

/** Locales that carry demo content in the example dataset (the base content is Russian). */
export const FIXTURE_LOCALES = fixtureLocales('example');

export const DATA_SOURCE = 'fixtures' as const;
