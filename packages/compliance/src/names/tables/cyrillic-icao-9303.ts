import type { TransliterationTable } from './types.js';

/**
 * Cyrillic into Latin as machine-readable travel documents print names (ICAO Doc 9303, Part 3, section 6,
 * transliteration of Cyrillic characters). This is what a passport shows, which is what most published list entries
 * and most legal names entered by people were derived from.
 */
export const CYRILLIC_ICAO_9303: TransliterationTable = {
  id: 'cyrillic-icao-9303',
  script: 'Cyrl',
  source: {
    title: 'ICAO Doc 9303, Machine Readable Travel Documents, Part 3: Specifications Common to all MRTDs, section 6 (transliteration)',
    url: 'https://www.icao.int/publications/pages/publication.aspx?docnum=9303',
    accessed: '2026-10-31',
  },
  verification: 'secondary',
  note: 'Russian letters as printed in current Russian, Kazakh and Kyrgyz passports (for example Yuliya is printed IULIIA). The Belarusian, Macedonian, Serbian and Ukrainian letters follow the same table and must be checked against the cited edition before a hub relies on them.',
  map: {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'ґ': 'g', 'д': 'd', 'ђ': 'd', 'ѓ': 'g', 'е': 'e', 'ё': 'e', 'є': 'ie', 'ж': 'zh', 'з': 'z', 'ѕ': 'dz',
    'и': 'i', 'і': 'i', 'ї': 'i', 'й': 'i', 'ј': 'j', 'к': 'k', 'ќ': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p',
    'р': 'r', 'с': 's', 'т': 't', 'ћ': 'c', 'у': 'u', 'ў': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'џ': 'dz', 'ш': 'sh', 'щ': 'shch',
    'ъ': 'ie', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'iu', 'я': 'ia',
  },
};
