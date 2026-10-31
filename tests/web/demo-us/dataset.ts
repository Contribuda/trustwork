import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared helpers for the United States demo dataset checks (DEMO-US): where the files are, which strings are reader
 * text (and so need a copy in every engine language), and the routes the dataset renders.
 */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const US_DIR = resolve(REPO, 'apps/web/fixtures/us');
export const US_FILES = ['people', 'companies', 'projects', 'publications', 'issues', 'workspace', 'events', 'courses'] as const;
export type UsFile = (typeof US_FILES)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function usFile(name: UsFile): Record<string, Json> {
  return JSON.parse(readFileSync(resolve(US_DIR, `${name}.json`), 'utf8')) as Record<string, Json>;
}

/** Override files of the US dataset: `fixtures/us/i18n/<tag>.json`, `{ file: { "json/pointer": "text" } }`. */
export function usOverrides(tag: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(resolve(US_DIR, 'i18n', `${tag}.json`), 'utf8')) as Record<string, Record<string, string>>;
}

export function usOverrideTags(): string[] {
  return readdirSync(resolve(US_DIR, 'i18n'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort();
}

/** Keys whose values are identifiers, dates, addresses of resources or machine values, never reader text. */
const TECHNICAL = new Set([
  'id', 'slug', 'href', 'url', 'uri', 'website', 'email', 'phone', 'telegram', 'cover', 'portrait', 'photo', 'timezone', 'timeZone',
  'startsAt', 'endsAt', 'date', 'due', 'at', 'createdAt', 'publishedAt', 'updatedAt', 'observedAt', 'sourceTime', 'eventTime',
  'validUntil', 'verifiedAt', 'requestedAt', 'postedAt', 'claimedAt', 'dateFrom', 'dateTo', 'releasedAt', 'lastSeen', 'deadline',
  'baselineDue', 'changedDue', 'actual', 'projectionDate', 'invitedAt', 'validFrom', 'endedAt', 'salesUntil', 'issuedAt', 'until',
  'topics', 'topicIds', 'kinds', 'region', 'currency', 'algorithm', 'hash', 'license', 'number', 'minorUnits', 'quantity', 'time',
  'personSlug', 'companySlug', 'authorSlug', 'relatedPublicationSlugs', 'internalNotes', 'privateNotes', 'articleFormat', 'field',
  'category', 'evidence', 'audience', 'employment', 'state', 'approval', 'grant', 'relation', 'section', 'status', 'format', 'type', 'partyRole',
  'profileVisibility', 'onboarding', 'permissions', 'invitedBy', 'endedBy', 'correctedBy', 'correctedAt',
]);
/** Keys that hold a machine token in some records and reader text in others: a lower camel-case token is machine. */
const ENUMISH = new Set(['kind', 'role', 'action', 'source']);
const CATALOGUE_UNITS = new Set(['t', 'm2', 'm3', 'pcs', 'set']);

/** Proper names stay as written in every language: people, companies, the demo guild and the cities of the hub. */
export function properNames(): Set<string> {
  const names = new Set(['Sample Bay Builders Guild', 'San Diego', 'Chula Vista', 'Escondido', 'Oceanside', 'National City', 'El Cajon', 'Trustwork']);
  for (const row of usFile('people').people as Array<{ person: { displayName: string } }>) names.add(row.person.displayName);
  for (const row of usFile('companies').companies as Array<{ company: { name: string } }>) names.add(row.company.name);
  return names;
}

/** Every reader-facing string of a US fixture file as `[json pointer, text]` (the pointer format of the override files). */
export function translatableStrings(file: UsFile, json: Json = usFile(file), names: Set<string> = properNames()): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (node: Json, path: string[], key: string) => {
    if (typeof node === 'string') {
      if (TECHNICAL.has(key) || /Ids?$/.test(key) || path.includes('contentDigest') || path.includes('renderArtifacts') || path.includes('legalIdentifiers')) return;
      if (ENUMISH.has(key) && /^[a-z][A-Za-z0-9]*$/.test(node)) return;
      if (key === 'unit' && CATALOGUE_UNITS.has(node)) return;
      if (names.has(node) || (node.match(/\p{L}/gu) ?? []).length < 2) return;
      out.push([path.join('/'), node]);
    } else if (Array.isArray(node)) node.forEach((child, index) => walk(child, [...path, String(index)], key));
    else if (node && typeof node === 'object') for (const [k, child] of Object.entries(node)) walk(child, [...path, k], k);
  };
  walk(json, [], '');
  return out.filter(([pointer]) => !['synthetic', 'description'].includes(pointer));
}

/** Public routes rendered from the US dataset (detail pages of every public record). */
export function usRoutes(): string[] {
  const routes = new Set<string>(['/', '/news', '/articles', '/events', '/companies', '/people', '/projects', '/magazine', '/magazine/archive']);
  for (const p of usFile('publications').publications as Array<{ slug: string; publication: { format: string; status: string } }>) {
    if (!['published', 'corrected'].includes(p.publication.status)) continue;
    routes.add(p.publication.format === 'news' ? `/news/${p.slug}` : `/articles/${p.slug}`);
  }
  for (const i of usFile('issues').issues as Array<{ issue: { number: number } }>) routes.add(`/magazine/${i.issue.number}`);
  for (const c of usFile('companies').companies as Array<{ slug: string }>) routes.add(`/companies/${c.slug}`);
  for (const p of usFile('people').people as Array<{ slug: string; person: { profileVisibility: string } }>) if (p.person.profileVisibility === 'public') routes.add(`/people/${p.slug}`);
  for (const p of usFile('projects').projects as Array<{ slug: string; project: { publicity: { enabled: boolean } } }>) if (p.project.publicity.enabled) routes.add(`/projects/${p.slug}`);
  for (const e of usFile('events').events as Array<{ slug: string }>) routes.add(`/events/${e.slug}`);
  return [...routes];
}
