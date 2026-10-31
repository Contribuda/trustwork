import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Messages } from '@trustwork/i18n-runtime/types';

/** Repository root (node:test runs from it, Playwright from apps/web). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Dictionaries read from disk, so tests build a locale's layers the way `localeLayers()` does on the server. */
export const ENGINE_LOCALES = ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn'] as const;

const read = (path: string): Messages => JSON.parse(readFileSync(resolve(REPO, path), 'utf8')) as Messages;

export function appDictionary(tag: string): Messages {
  return read(`apps/web/app/_lib/locales/${tag}.json`);
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

/**
 * Distinctive strings of each language's dictionaries (long, unique to that language, JSON-safe): if
 * several of them appear in one file, that file carries the language's dictionary.
 */
export function dictionarySignatures(count = 40): Record<string, string[]> {
  const sets = Object.fromEntries(ENGINE_LOCALES.map((tag) => [tag, new Set([...leaves(appDictionary(tag)), ...leaves(uiDictionary(tag))].map(([, value]) => value))]));
  return Object.fromEntries(
    ENGINE_LOCALES.map((tag) => {
      const others = ENGINE_LOCALES.filter((other) => other !== tag);
      const unique = [...sets[tag]!].filter((value) => value.length > 30 && !/["\\\n{<]/.test(value) && others.every((other) => !sets[other]!.has(value)));
      return [tag, unique.slice(0, count)];
    }),
  );
}

/** Languages whose dictionary signature appears in `text` (at least `threshold` distinct strings). */
export function languagesIn(text: string, signatures: Record<string, string[]>, threshold = 5): string[] {
  return Object.entries(signatures)
    .filter(([, strings]) => strings.filter((value) => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))).length >= threshold)
    .map(([tag]) => tag);
}
