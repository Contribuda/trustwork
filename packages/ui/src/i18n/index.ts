import { getLocaleStore } from '@trustwork/i18n-runtime';
import type { Messages } from '@trustwork/i18n-runtime/types';
import en from '../../locales/en.json' with { type: 'json' };

/**
 * Typed i18n for the design system (ADR-009). English is the reference dictionary, the fallback for every
 * other locale and the only dictionary this module bundles: the other languages reach a page as message
 * layers of the request-scoped store (the application puts the active locale's design-system dictionary
 * there; `./dictionaries` holds them all for servers, tests and tools), so a browser downloads one language.
 * Keys are dot paths into `locales/en.json` (`shell.collapse`, `publicNav.0`). Messages support `{name}`
 * interpolation and the ICU plural subset `{count, plural, one {...} few {...} many {...} other {...}}`
 * with `#` as the number; the plural category comes from `Intl.PluralRules` for the active locale.
 */

type Primitive = string | number;

type PathsOf<T, Prefix extends string = ''> = T extends readonly (infer U)[]
  ? U extends string
    ? `${Prefix}${number}`
    : never
  : T extends string
    ? Prefix extends `${infer P}.`
      ? P
      : Prefix
    : {
        [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : PathsOf<T[K], `${Prefix}${K}.`>;
      }[keyof T & string];

export type LocaleKey = PathsOf<typeof en>;
export type LocaleParams = Record<string, Primitive>;

/** The reference dictionary (English). */
export const locale = en;
export const FALLBACK_LOCALE = 'en';

const dictionaries: Record<string, Messages> = { en };

/** Registers or replaces a design-system dictionary for a locale (`./dictionaries` registers the engine languages). */
export function registerUiLocale(tag: string, messages: Messages): void {
  dictionaries[tag] = messages;
}

export function uiLocales(): string[] {
  return Object.keys(dictionaries);
}

export function uiDictionary(tag: string): Messages | undefined {
  return dictionaries[tag];
}

/** The active locale tag (`en`, `ru`, `uz-Latn`, `ka`, `hy`, `az-Latn`). */
export function localeTag(): string {
  return getLocaleStore().locale || FALLBACK_LOCALE;
}

/** The active country code (ISO 3166-1 alpha-2) that, with the language, selects `Intl` formats. */
export function countryCode(): string {
  return getLocaleStore().country;
}

/**
 * When `Intl` has no data for language + country, the language's own formats apply; English then uses
 * international English (`en-001`, day before month), not the United States default.
 */
const LANGUAGE_FALLBACK: Record<string, string> = { en: 'en-001' };
const intlTagCache = new Map<string, string>();

function supportsExactly(tag: string): boolean {
  try {
    return new Intl.DateTimeFormat(tag).resolvedOptions().locale === tag;
  } catch {
    return false;
  }
}

/**
 * BCP 47 tag for `Intl` (number, date and plural rules) derived from the language and the country:
 * `en` + `US` gives `en-US` (month before day), `en` + `GB` gives `en-GB`, `es` + `US` gives `es-US`,
 * `uz-Latn` + `UZ` gives `uz-Latn-UZ`. A pair `Intl` has no data for (English in Uzbekistan) uses the
 * language's fallback. Each runtime (server, browser) only picks a tag its own `Intl` data covers, so a
 * pair one side lacks degrades to the same language-level formats instead of a different country's.
 */
export function intlTagFor(language: string, country?: string | null): string {
  const key = `${language}|${country ?? ''}`;
  const cached = intlTagCache.get(key);
  if (cached) return cached;
  let tag = LANGUAGE_FALLBACK[language] ?? language;
  if (country && /^[A-Z]{2}$/.test(country)) {
    try {
      const candidate = Intl.getCanonicalLocales(`${language}-${country}`)[0];
      if (candidate && supportsExactly(candidate)) tag = candidate;
    } catch {
      // not a valid tag: keep the language fallback
    }
  }
  try {
    Intl.getCanonicalLocales(tag);
  } catch {
    tag = LANGUAGE_FALLBACK[FALLBACK_LOCALE] ?? FALLBACK_LOCALE;
  }
  intlTagCache.set(key, tag);
  return tag;
}

/** The `Intl` tag of the active language and country (`intlTag('ru')` keeps the active country). */
export function intlTag(tag: string = localeTag(), country: string = countryCode()): string {
  return intlTagFor(tag, country);
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function pluralRules(): Intl.PluralRules {
  const tag = intlTag();
  let rules = pluralRulesCache.get(tag);
  if (!rules) {
    rules = new Intl.PluralRules(tag);
    pluralRulesCache.set(tag, rules);
  }
  return rules;
}

export function formatNumber(value: number): string {
  const tag = intlTag();
  let format = numberFormatCache.get(tag);
  if (!format) {
    format = new Intl.NumberFormat(tag);
    numberFormatCache.set(tag, format);
  }
  return format.format(value);
}

function readPath(root: unknown, key: string): unknown {
  let node: unknown = root;
  for (const part of key.split('.')) {
    if (Array.isArray(node)) node = node[Number(part)];
    else if (node && typeof node === 'object') node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

/** Raw message in the active locale, then English; unknown keys throw so missing copy fails loudly in tests. */
export function message(key: LocaleKey): string {
  const found = messageOrUndefined(key);
  if (found === undefined) throw new Error(`Missing locale key: ${key}`);
  return found;
}

export function messageOrUndefined(key: string): string | undefined {
  // Layers primed by the application come first: a deployment's brand overlay may rename `brand.*` and the
  // copy that embeds the name even for components that live in the design system.
  for (const layer of getLocaleStore().layers) {
    const layered = readPath(layer, key);
    if (typeof layered === 'string') return layered;
  }
  const active = dictionaries[localeTag()];
  const own = active ? readPath(active, key) : undefined;
  if (typeof own === 'string') return own;
  const base = readPath(en, key);
  return typeof base === 'string' ? base : undefined;
}

/** `count` that is not a finite number selects the `other`/`many` form; `#` then renders Intl's NaN so missing data is visible in review. */
function selectPlural(count: number, cases: Record<string, string>): string {
  const category = Number.isFinite(count) ? pluralRules().select(count) : 'other';
  return cases[`=${count}`] ?? cases[category] ?? cases.other ?? cases.many ?? '';
}

function parsePluralCases(body: string): Record<string, string> {
  const cases: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body.charAt(i))) i++;
    const nameStart = i;
    while (i < body.length && body.charAt(i) !== '{' && !/\s/.test(body.charAt(i))) i++;
    const name = body.slice(nameStart, i).trim();
    while (i < body.length && body.charAt(i) !== '{') i++;
    if (i >= body.length) break;
    let depth = 0;
    const valueStart = i + 1;
    for (; i < body.length; i++) {
      const ch = body.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    cases[name] = body.slice(valueStart, i);
    i++;
  }
  return cases;
}

export function formatMessage(template: string, params: LocaleParams = {}): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    let depth = 0;
    let close = open;
    for (; close < template.length; close++) {
      const ch = template.charAt(close);
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const inner = template.slice(open + 1, close);
    const pluralMatch = /^\s*([a-zA-Z0-9_]+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (pluralMatch) {
      const name = pluralMatch[1] ?? '';
      const raw = params[name];
      const count = typeof raw === 'number' ? raw : Number(raw);
      const chosen = selectPlural(count, parsePluralCases(pluralMatch[2] ?? ''));
      out += formatMessage(chosen.replace(/#/g, formatNumber(count)), params);
    } else {
      const name = inner.trim();
      const value = params[name];
      out += value === undefined ? `{${name}}` : String(value);
    }
    i = close + 1;
  }
  return out;
}

/** Translate a locale key with optional parameters. */
export function t(key: LocaleKey, params?: LocaleParams): string {
  return formatMessage(message(key), params);
}

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dates in the active locale: long («27 октября 2026», "27 October 2026", "27-oktabr, 2026") and short
 * numeric. Date-only strings (`2026-10-27`) are calendar dates and are formatted as such regardless of the
 * machine's time zone; instants (Date objects, ISO timestamps) are formatted in the local zone.
 */
export function formatDate(value: Date | string, style: 'long' | 'short' = 'long'): string {
  const isDateOnly = typeof value === 'string' && dateOnly.test(value);
  const date = typeof value === 'string' ? new Date(isDateOnly ? `${value}T00:00:00Z` : value) : value;
  const zone = isDateOnly ? { timeZone: 'UTC' } : {};
  const tag = intlTag();
  if (style === 'short') return new Intl.DateTimeFormat(tag, { day: '2-digit', month: '2-digit', year: 'numeric', ...zone }).format(date);
  if (tag === 'ru' || tag.startsWith('ru-')) {
    const parts = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', ...zone }).formatToParts(date);
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('day')} ${pick('month')} ${pick('year')}`;
  }
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric', ...zone }).format(date);
}
