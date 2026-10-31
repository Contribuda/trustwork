import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Messages } from '@trustwork/i18n-runtime/types';

/** Repository root (node:test runs from it, Playwright from apps/web). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Application dictionaries: `apps/web/locales/<tag>/<namespace>.json` (INTL-004). */
export const APP_LOCALES_DIR = resolve(REPO, 'apps/web/locales');

/** Every language with a dictionary directory, English (the reference) first: new languages are picked up by listing. */
export function appLocaleTags(): string[] {
  return readdirSync(APP_LOCALES_DIR)
    .filter((name) => statSync(resolve(APP_LOCALES_DIR, name)).isDirectory())
    .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
}

/** The namespace files of one language, by listing its directory. */
export function namespacesOf(tag: string): string[] {
  return readdirSync(resolve(APP_LOCALES_DIR, tag))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .sort();
}

/** The engine languages the browser suites render (the dictionary directories). */
export const ENGINE_LOCALES: readonly string[] = appLocaleTags();

const read = (path: string): Messages => JSON.parse(readFileSync(resolve(REPO, path), 'utf8')) as Messages;

export function appNamespace(tag: string, namespace: string): Messages {
  return read(`apps/web/locales/${tag}/${namespace}.json`);
}

/** A language's application messages, every namespace merged (the server's view). */
export function appDictionary(tag: string): Messages {
  return Object.assign({}, ...namespacesOf(tag).map((namespace) => appNamespace(tag, namespace))) as Messages;
}

export function uiDictionary(tag: string): Messages {
  return read(`packages/ui/locales/${tag}.json`);
}

/** App locale, app English (fallback), then the design system's locale: the order of `localeLayers()`. */
export function layersFor(tag: string): Messages[] {
  return tag === 'en' ? [appDictionary('en')] : [appDictionary(tag), appDictionary('en'), uiDictionary(tag)];
}

export function leaves(node: unknown, path = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[path, node]];
  if (Array.isArray(node)) return node.flatMap((value, index) => leaves(value, `${path}.${index}`));
  if (node && typeof node === 'object') return Object.entries(node).flatMap(([key, value]) => (key === '$comment' ? [] : leaves(value, path ? `${path}.${key}` : key)));
  return [];
}

/** Route groups and the namespaces each hands to the browser (`apps/web/locales/client-namespaces.json`). */
export function clientNamespaceTable(): Record<string, string[]> {
  const table = JSON.parse(readFileSync(resolve(APP_LOCALES_DIR, 'client-namespaces.json'), 'utf8')) as Record<string, string[]>;
  return Object.fromEntries(Object.entries(table).filter(([key]) => !key.startsWith('$')));
}

/** The country a browser suite pairs with a language (the pack whose default it is; the United States otherwise). */
export function localeCountry(tag: string): string {
  return ({ ru: 'UZ', 'uz-Latn': 'UZ', ka: 'GE', hy: 'AM', 'az-Latn': 'AZ' } as Record<string, string>)[tag] ?? 'US';
}

/**
 * Distinctive strings of each language's dictionaries (long, unique to that language, JSON-safe): if
 * several of them appear in one file, that file carries the language's dictionary. They are taken from
 * the namespaces every page receives (the root list) and the design system's dictionary, spread evenly.
 */
export function dictionarySignatures(count = 40): Record<string, string[]> {
  const root = clientNamespaceTable().root ?? [];
  const everyPage = (tag: string): Messages[] => [...root.map((namespace) => appNamespace(tag, namespace)), uiDictionary(tag)];
  const sets = Object.fromEntries(ENGINE_LOCALES.map((tag) => [tag, new Set(everyPage(tag).flatMap((messages) => leaves(messages)).map(([, value]) => value))]));
  return Object.fromEntries(
    ENGINE_LOCALES.map((tag) => {
      const others = ENGINE_LOCALES.filter((other) => other !== tag);
      const unique = [...sets[tag]!].filter((value) => value.length > 30 && !/["\\\n{<]/.test(value) && others.every((other) => !sets[other]!.has(value)));
      const step = Math.max(1, Math.floor(unique.length / count));
      return [tag, unique.filter((_, index) => index % step === 0).slice(0, count)];
    }),
  );
}

/**
 * Distinctive strings of each namespace in one language (JSON-safe, no placeholders, unique to that
 * namespace): a page whose payload contains nearly all of them received that namespace.
 */
export function namespaceSignatures(tag: string, count = 30): Record<string, string[]> {
  const values = Object.fromEntries(namespacesOf('en').map((namespace) => [namespace, leaves(appNamespace(tag, namespace)).map(([, value]) => value)]));
  const owners = new Map<string, number>();
  for (const list of Object.values(values)) for (const value of new Set(list)) owners.set(value, (owners.get(value) ?? 0) + 1);
  for (const value of leaves(uiDictionary(tag)).map(([, v]) => v)) owners.set(value, (owners.get(value) ?? 0) + 2);
  return Object.fromEntries(
    Object.entries(values).map(([namespace, list]) => {
      const unique = [...new Set(list)].filter((value) => value.length >= 16 && !/["'\\\n{}<>&]/.test(value) && owners.get(value) === 1);
      const step = Math.max(1, Math.floor(unique.length / count));
      return [namespace, unique.filter((_, index) => index % step === 0).slice(0, count)];
    }),
  );
}

/** Namespaces a page's document received: at least `share` of their signature strings occur in it. */
export function namespacesIn(text: string, signatures: Record<string, string[]>, share = 0.9): string[] {
  return Object.entries(signatures)
    .filter(([, strings]) => strings.length > 0 && strings.filter((value) => text.includes(value)).length >= share * strings.length)
    .map(([namespace]) => namespace)
    .sort();
}

/** Languages whose dictionary signature appears in `text` (at least `threshold` distinct strings). */
export function languagesIn(text: string, signatures: Record<string, string[]>, threshold = 5): string[] {
  return Object.entries(signatures)
    .filter(([, strings]) => strings.filter((value) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))).length >= threshold)
    .map(([tag]) => tag);
}
