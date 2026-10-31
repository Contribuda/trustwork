/**
 * Russian typographic polish (applied only when the active locale is Russian; other locales pass through) for headlines, decks and other short copy rendered from data:
 * «» instead of straight quotes, an em dash instead of a hyphen between spaces, a non-breaking
 * space after one- and two-letter words (prepositions, conjunctions, particles) and before a dash,
 * so lines never end with «в», «и» or «на». Numbers keep a non-breaking space before «№» and units.
 * Pure string → string; safe to run twice. Longer bodies (Prose) are left alone on purpose.
 */

const NBSP = ' ';
const SHORT_WORDS = /(?<=^|[\s(«„])([А-Яа-яЁёA-Za-z]{1,2}) +(?=\S)/g;
const DASH_BETWEEN_SPACES = /(\S)\s[-–—]\s(?=\S)/g;
const OPENING_QUOTE = /(^|[\s(\[{>])"(?=\S)/g;
const CLOSING_QUOTE = /(\S)"(?=[\s.,;:!?)\]}<]|$)/g;
const NUMBER_SIGN = /№\s+(?=\d)/g;
const NUMBER_UNIT = /(\d)\s+(?=(?:мин|ч|м|м²|м³|т|шт|кг|км|%|г\.|года)\b)/g;

import { localeTag } from '@trustwork/ui/i18n';

export function typo(input: string): string {
  if (localeTag() !== 'ru') return input;
  let text = input;
  text = text.replace(OPENING_QUOTE, '$1«').replace(CLOSING_QUOTE, '$1»');
  text = text.replace(DASH_BETWEEN_SPACES, `$1${NBSP}— `);
  text = text.replace(NUMBER_SIGN, `№${NBSP}`);
  text = text.replace(NUMBER_UNIT, `$1${NBSP}`);
  // Lookbehind keeps the preceding boundary unconsumed, so «а не в конце» binds every short word in one pass.
  text = text.replace(SHORT_WORDS, `$1${NBSP}`);
  return text;
}

/** Applies `typo()` only to strings (nullable values pass through). */
export function typoOr<T extends string | null | undefined>(value: T): T {
  return (typeof value === 'string' ? typo(value) : value) as T;
}
