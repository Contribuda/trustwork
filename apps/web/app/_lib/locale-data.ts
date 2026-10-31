import type { Messages } from '@trustwork/i18n-runtime/types';
import { registerBrandOverlay } from '@trustwork/ui/brand';
import { brandOverlay } from '@/brand';
import en from './locales/en.json';
import ru from './locales/ru.json';
import uzLatn from './locales/uz-Latn.json';
import ka from './locales/ka.json';
import hy from './locales/hy.json';
import azLatn from './locales/az-Latn.json';

/**
 * Every application dictionary, imported statically on the server only (the client receives the active
 * locale's layers through the provider). A locale that has no file yet resolves entirely to English.
 */
const DICTIONARIES: Record<string, Messages> = { en: en as unknown as Messages, ru: ru as unknown as Messages, 'uz-Latn': uzLatn as unknown as Messages, ka: ka as unknown as Messages, hy: hy as unknown as Messages, 'az-Latn': azLatn as unknown as Messages };

/** Registers a dictionary (country packs add theirs; tests can inject). */
export function registerAppLocale(tag: string, messages: Messages): void {
  DICTIONARIES[tag] = messages;
}

export function appDictionary(tag: string): Messages | undefined {
  return DICTIONARIES[tag];
}

export function appLocales(): string[] {
  return Object.keys(DICTIONARIES);
}

type Leaf = string | readonly string[];
function isLeaf(value: unknown): value is Leaf {
  return typeof value === 'string' || Array.isArray(value);
}

/** The English leaves that `messages` does not define: the smallest fallback layer the client needs. */
export function missingFrom(messages: Messages | undefined, reference: Messages = DICTIONARIES.en as Messages): Messages {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reference)) {
    if (key === '$comment') continue;
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

/** Message layers for a locale: the deployment's brand overlay first, then its own dictionary, then only the English keys it lacks. */
export function appLayers(tag: string): Messages[] {
  const own = DICTIONARIES[tag];
  const brand = brandOverlay?.messages[tag];
  const base = tag === 'en' || !own ? [DICTIONARIES.en as Messages] : [own, missingFrom(own)];
  return brand ? [brand, ...base] : base;
}

/** Key count report used by the completeness test and the switcher's "translation in progress" note. */
export function coverage(tag: string): { total: number; translated: number } {
  const count = (node: unknown): number =>
    isLeaf(node)
      ? 1
      : node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>)
            .filter(([k]) => k !== '$comment')
            .reduce((n, [, v]) => n + count(v), 0)
        : 0;
  const total = count(DICTIONARIES.en);
  const missing = count(missingFrom(DICTIONARIES[tag]));
  return { total, translated: total - missing };
}
