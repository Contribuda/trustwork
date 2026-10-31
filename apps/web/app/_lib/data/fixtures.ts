import { CompaniesFileSchema, IssuesFileSchema, PeopleFileSchema, ProjectsFileSchema, PublicationsFileSchema, WorkspaceFileSchema, EventsFileSchema, CoursesFileSchema } from '@/fixtures/schemas';
import { localeTag } from '@trustwork/ui/i18n';
import peopleJson from '@/fixtures/people.json';
import companiesJson from '@/fixtures/companies.json';
import projectsJson from '@/fixtures/projects.json';
import publicationsJson from '@/fixtures/publications.json';
import issuesJson from '@/fixtures/issues.json';
import workspaceJson from '@/fixtures/workspace.json';
import eventsJson from '@/fixtures/events.json';
import coursesJson from '@/fixtures/courses.json';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { currentDeployment, dataPath, languageFiles } from '@trustwork/config/server';

/**
 * Fixture store: every file is parsed with its Zod envelope at module load, so an invalid fixture
 * fails `next build` (and `tests/web/fixtures.test.ts`) instead of rendering wrong data.
 * Server-only: fixtures never ship to the browser as a whole; pages pass projected view models.
 *
 * Demo content is written once (the base files, Russian) and localized by overrides in
 * `fixtures/i18n/<locale>.json`: `{ file: { "json/pointer/path": "text" } }`. Resolution is per string:
 * the locale's own override, then the English override, then the base text. English must cover every
 * base string (tests/web/fixtures.test.ts), so a reader outside the Russian locale never sees Russian
 * demo content (owner decision 2026-10-29, ADR-009 owner decision 10).
 *
 * Override files are data, discovered by name (CFG-001): every `fixtures/i18n/<tag>.json`, plus the deployment's
 * `<dataDir>/fixtures/i18n/<tag>.json` (which replaces a built-in file of the same language). A language with demo
 * content therefore needs no code change; the files are read once per process.
 */
type Overrides = Record<string, Record<string, string>>;
const fromApp = process.cwd().endsWith(`${sep}apps${sep}web`);
const FIXTURE_I18N_DIR = resolve(process.cwd(), fromApp ? 'fixtures/i18n' : 'apps/web/fixtures/i18n');
const OVERRIDES: Record<string, Overrides> = Object.fromEntries(
  [...languageFiles(FIXTURE_I18N_DIR), ...languageFiles(dataPath(currentDeployment(), 'fixtures'))].map(([tag, path]) => [tag, JSON.parse(readFileSync(path, 'utf8')) as Overrides]),
);

const BASE_FILES = {
  people: peopleJson,
  companies: companiesJson,
  projects: projectsJson,
  publications: publicationsJson,
  issues: issuesJson,
  workspace: workspaceJson,
  events: eventsJson,
  courses: coursesJson,
} as const;

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
function overridesFor(locale: string, file: string): Record<string, string> | undefined {
  const own = OVERRIDES[locale]?.[file];
  if (locale === 'en' || locale === 'ru') return own;
  const english = OVERRIDES.en?.[file];
  if (!english && !own) return undefined;
  return { ...(english ?? {}), ...(own ?? {}) };
}

function parseAll(locale: string) {
  const pick = <T>(file: keyof typeof BASE_FILES, parse: (raw: unknown) => T): T => parse(applyOverrides(file, BASE_FILES[file], overridesFor(locale, file)));
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
 * The fixtures for a locale (base content plus the English layer plus that locale's overrides), parsed once
 * per locale. A locale without its own override file reads the English content, never the Russian base.
 */
export function fixturesFor(locale: string): Parsed {
  const key = locale in OVERRIDES ? locale : locale === 'ru' ? 'ru' : 'en';
  let parsed = cache.get(key);
  if (!parsed) {
    parsed = parseAll(key);
    cache.set(key, parsed);
  }
  return parsed;
}

/** The fixtures for the active locale; property access resolves the locale at call time (request-scoped on the server). */
export const fixtures: Parsed = new Proxy({} as Parsed, {
  get(_target, property) {
    return fixturesFor(localeTag())[property as keyof Parsed];
  },
});

/** Locales that carry fixture overrides (the base content is Russian). */
export const FIXTURE_LOCALES = ['ru', ...Object.keys(OVERRIDES)] as const;

export const DATA_SOURCE = 'fixtures' as const;
