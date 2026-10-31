import { CYRILLIC_ICAO_9303 } from './cyrillic-icao-9303.js';
import { GEORGIAN_NATIONAL_2002 } from './georgian-national-2002.js';
import { LATIN_LETTERS_CLDR } from './latin-letters.js';
import type { TransliterationTable } from './types.js';

export type { TransliterationTable } from './types.js';
export { CYRILLIC_ICAO_9303, GEORGIAN_NATIONAL_2002, LATIN_LETTERS_CLDR };

/**
 * The tables every name key applies, in this order. Adding a script is adding a sourced table here (Armenian and
 * Arabic are open follow-ups); a table never maps a character another table already maps.
 */
export const TRANSLITERATION_TABLES: readonly TransliterationTable[] = [CYRILLIC_ICAO_9303, GEORGIAN_NATIONAL_2002, LATIN_LETTERS_CLDR];
