import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Messages } from '@trustwork/i18n-runtime/types';
import { registerBrandOverlay } from '@trustwork/ui/brand';
import { registerUiLocale, uiDictionary } from '@trustwork/ui/i18n';
import { brandOverlay } from '../../brand/index.js';

/**
 * Application dictionaries, server only (INTL-004, ADR 012 decision 16). They live as data in
 * `apps/web/locales/<tag>/<namespace>.json`: one directory per language, one file per feature namespace.
 * Languages and namespaces are discovered by listing the directories, so adding a language is a data-only
 * change and a feature adds its own namespace file without editing anyone else's. English (`en`) is the
 * reference: its files define the namespaces and every key.
 *
 * Files next to the language directories (`<tag>.meta.json` review status, `client-namespaces.json`) are
 * metadata, never dictionaries. Files are read once per process and cached; a new language or namespace
 * needs a server restart. Client components never import this module: the browser receives only the
 * layers of the namespaces its route uses (`clientLayers` in `locale.ts`).
 */
const fromApp = process.cwd().endsWith(`${sep}apps${sep}web`);
export const LOCALES_DIR = resolve(process.cwd(), fromApp ? 'locales' : 'apps/web/locales');
const UI_LOCALES_DIR = resolve(process.cwd(), fromApp ? '../../packages/ui/locales' : 'packages/ui/locales');

export const REFERENCE_LOCALE = 'en';
const NAMESPACE = /^[a-z][a-z0-9-]*$/;

function isLanguageTag(name: string): boolean {
  try {
    return Intl.getCanonicalLocales(name)[0]?.toLowerCase() === name.toLowerCase();
  } catch {
    return false;
  }
}

const readJson = (path: string): Messages => JSON.parse(readFileSync(path, 'utf8')) as Messages;

let localeList: string[] | null = null;
const namespaceLists = new Map<string, string[]>();
const namespaceFiles = new Map<string, Messages | null>();

/** Every language with a dictionary directory, the reference first. */
export function appLocales(): string[] {
  localeList ??= readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isLanguageTag(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a === REFERENCE_LOCALE ? -1 : b === REFERENCE_LOCALE ? 1 : a.localeCompare(b)));
  return localeList;
}

/** The namespace files of one language (for the reference: every namespace of the application). */
export function localeNamespaces(tag: string): string[] {
  if (!appLocales().includes(tag)) return [];
  let list = namespaceLists.get(tag);
  if (!list) {
    list = readdirSync(resolve(LOCALES_DIR, tag))
      .filter((name) => name.endsWith('.json') && NAMESPACE.test(name.slice(0, -5)))
      .map((name) => name.slice(0, -5))
      .sort();
    namespaceLists.set(tag, list);
  }
  return list;
}

/** Every namespace of the application: the reference language's files. */
export function appNamespaces(): string[] {
  return localeNamespaces(REFERENCE_LOCALE);
}

/** One namespace of one language, or undefined when that language has no file for it (it falls back to English). */
export function appNamespace(tag: string, namespace: string): Messages | undefined {
  if (!localeNamespaces(tag).includes(namespace)) return undefined;
  const id = `${tag}/${namespace}`;
  if (!namespaceFiles.has(id)) namespaceFiles.set(id, readJson(resolve(LOCALES_DIR, tag, `${namespace}.json`)));
  return namespaceFiles.get(id) ?? undefined;
}

/** A language's messages for the given namespaces (all by default), merged; undefined for an unknown language. */
export function appDictionary(tag: string, namespaces: readonly string[] = appNamespaces()): Messages | undefined {
  if (!appLocales().includes(tag)) return undefined;
  return Object.assign({}, ...namespaces.map((namespace) => appNamespace(tag, namespace) ?? {})) as Messages;
}

type Leaf = string | readonly string[];
function isLeaf(value: unknown): value is Leaf {
  return typeof value === 'string' || Array.isArray(value);
}

/** The reference leaves that `messages` does not define: the smallest fallback layer a language needs. */
export function missingFrom(messages: Messages | undefined, reference: Messages = appDictionary(REFERENCE_LOCALE) ?? {}): Messages {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reference)) {
    if (key.startsWith('$')) continue;
    const own = messages ? (messages as Record<string, unknown>)[key] : undefined;
    if (isLeaf(value)) {
      if (own === undefined) out[key] = value;
    } else if (value && typeof value === 'object') {
      const nested = missingFrom(own && typeof own === 'object' && !Array.isArray(own) ? (own as Messages) : undefined, value as Messages);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out as Messages;
}

registerBrandOverlay(brandOverlay);

/**
 * Design-system dictionaries are data too: `packages/ui/locales/<tag>.json` for a language the design
 * system does not register itself is registered here, so a new language needs no TypeScript change.
 */
function registerUiDictionaries(): void {
  if (!existsSync(UI_LOCALES_DIR)) return;
  for (const name of readdirSync(UI_LOCALES_DIR)) {
    const tag = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (tag && isLanguageTag(tag) && !uiDictionary(tag)) registerUiLocale(tag, readJson(resolve(UI_LOCALES_DIR, name)));
  }
}
registerUiDictionaries();

/** The deployment's brand overlay for a language (Trustwork everywhere; the Russian interface may carry another name). */
export function brandLayers(tag: string): Messages[] {
  const brand = brandOverlay?.messages[tag];
  return brand ? [brand] : [];
}

const layerCache = new Map<string, Messages[]>();

/**
 * Application layers for a language and a set of namespaces (all by default), in lookup order: the
 * language's own messages, then only the English keys it lacks. English and unknown languages get the
 * English messages alone. The brand overlay is separate (`brandLayers`).
 */
export function appLayers(tag: string, namespaces: readonly string[] = appNamespaces()): Messages[] {
  const known = namespaces.filter((namespace) => appNamespaces().includes(namespace));
  const id = `${tag}|${known.join(',')}`;
  let layers = layerCache.get(id);
  if (!layers) {
    const english = appDictionary(REFERENCE_LOCALE, known) ?? {};
    const own = tag === REFERENCE_LOCALE ? undefined : appDictionary(tag, known);
    layers = own ? [own, missingFrom(own, english)] : [english];
    layerCache.set(id, layers);
  }
  return layers;
}

/** Key count report used by the completeness test and the switcher's "translation in progress" note. */
export function coverage(tag: string): { total: number; translated: number } {
  const count = (node: unknown): number =>
    isLeaf(node)
      ? 1
      : node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>)
            .filter(([k]) => !k.startsWith('$'))
            .reduce((n, [, v]) => n + count(v), 0)
        : 0;
  const total = count(appDictionary(REFERENCE_LOCALE));
  const missing = count(missingFrom(appDictionary(tag)));
  return { total, translated: total - missing };
}
