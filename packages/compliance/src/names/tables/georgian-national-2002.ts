import type { TransliterationTable } from './types.js';

/**
 * Georgian (Mkhedruli) into Latin by the national romanization system of 2002, which Georgian passports use. The
 * ejective apostrophes of the system are punctuation and drop out of a name key anyway, so they are left out here.
 * Mtavruli capitals fold to Mkhedruli through Unicode lower-casing before this table applies.
 */
export const GEORGIAN_NATIONAL_2002: TransliterationTable = {
  id: 'georgian-national-2002',
  script: 'Geor',
  source: {
    title: 'National system of romanization of Georgian (2002), State Department of Language of Georgia',
    url: 'https://en.wikipedia.org/wiki/Romanization_of_Georgian#National_system',
    accessed: '2026-10-31',
  },
  verification: 'secondary',
  note: 'Secondary source for the table; letters no longer in use (ჱ, ჲ, ჳ, ჴ, ჵ, ჶ) are not mapped and stay as they are.',
  map: {
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o',
    'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts',
    'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
  },
};
