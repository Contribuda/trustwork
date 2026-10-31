import type { TransliterationTable } from './types.js';

/**
 * Latin letters that compatibility decomposition does not reduce to a base letter plus marks (for example ß, ø, ł).
 * The values follow the Unicode CLDR Latin-ASCII transform for these letters.
 */
export const LATIN_LETTERS_CLDR: TransliterationTable = {
  id: 'latin-letters-cldr',
  script: 'Latn',
  source: {
    title: 'Unicode CLDR transform Latin-ASCII (common/transforms/Latin-ASCII.xml)',
    url: 'https://github.com/unicode-org/cldr/blob/main/common/transforms/Latin-ASCII.xml',
    accessed: '2026-10-31',
  },
  verification: 'secondary',
  note: 'Only letters without a canonical or compatibility decomposition; letters with marks lose them through NFKD instead.',
  map: {
    'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't', 'ŋ': 'n', 'ĸ': 'q', 'ƒ': 'f',
  },
};
