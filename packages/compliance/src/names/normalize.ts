import { TRANSLITERATION_TABLES, type TransliterationTable } from './tables/index.js';

/**
 * Deterministic name keys (ADR 014 decision 11; SANC-002). The same name written in Latin with or without marks, in
 * another order, or in Cyrillic or Georgian, gives the same key:
 *
 * 1. NFC composition (so a decomposed Cyrillic letter is one character), then lower case;
 * 2. apostrophes inside a name are dropped (O'Brien and OBrien are one token);
 * 3. transliteration into Latin by the sourced tables (`tables/`): ICAO Doc 9303 Cyrillic, Georgian national 2002 and
 *    the Latin letters decomposition cannot reduce;
 * 4. NFKD compatibility decomposition with every combining mark removed, lower case again;
 * 5. every other character that is not a letter or a digit separates tokens (hyphens, commas, periods, brackets);
 * 6. distinct tokens, sorted by code unit, joined by one space.
 *
 * Letters of scripts without a table (for example Arabic or Han) stay as they are, lower-cased and without marks, so
 * two spellings in the same script still meet. `NAME_KEY_VERSION` changes whenever the output of a name can change.
 */
export const NAME_KEY_VERSION = 'name-key-1';

const APOSTROPHES = /['‘’ʼʹ`´′]/gu;
const MARKS = /\p{M}+/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

function combine(tables: readonly TransliterationTable[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const table of tables) {
    for (const [from, to] of Object.entries(table.map)) {
      if ([...from].length !== 1 || from !== from.toLowerCase()) throw new Error(`${table.id}: key ${from} must be one lower-case character`);
      if (!/^[a-z]*$/.test(to)) throw new Error(`${table.id}: value for ${from} must be lower-case ASCII`);
      if (map.has(from)) throw new Error(`${table.id}: ${from} is already mapped by another table`);
      map.set(from, to);
    }
  }
  return map;
}

const DEFAULT_MAP = combine(TRANSLITERATION_TABLES);

function transliterate(text: string, map: ReadonlyMap<string, string>): string {
  let out = '';
  for (const char of text) out += map.get(char) ?? char;
  return out;
}

/** The distinct tokens of a name, sorted. Empty when the name has no letters or digits. */
export function nameTokens(name: string, tables: readonly TransliterationTable[] = TRANSLITERATION_TABLES): string[] {
  const map = tables === TRANSLITERATION_TABLES ? DEFAULT_MAP : combine(tables);
  const folded = transliterate(name.normalize('NFC').toLowerCase().replace(APOSTROPHES, ''), map)
    .normalize('NFKD')
    .replace(MARKS, '')
    // A compatibility decomposition can produce a capital (U+03D2 becomes U+03A5): lower-case once more.
    .toLowerCase()
    // A decomposition may produce a character a table maps (rare compatibility forms); apply the tables once more.
    .split('')
    .map((char) => map.get(char) ?? char)
    .join('')
    .replace(SEPARATORS, ' ')
    .trim();
  if (folded === '') return [];
  return [...new Set(folded.split(' '))].sort();
}

/** The name key: distinct sorted tokens joined by one space, or '' for a name without letters or digits. */
export function nameKey(name: string, tables?: readonly TransliterationTable[]): string {
  return nameTokens(name, tables).join(' ');
}

/** Distinct, non-empty keys of several names (a primary name and its aliases), sorted. */
export function nameKeys(names: readonly string[], tables?: readonly TransliterationTable[]): string[] {
  return [...new Set(names.map((name) => nameKey(name, tables)).filter((key) => key !== ''))].sort();
}
