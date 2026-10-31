/**
 * A transliteration table into Latin, kept as sourced data (ADR 014 decision 11). Keys are single lower-case
 * characters (after NFC composition); values are lower-case ASCII, possibly empty (the letter is dropped).
 */
export interface TransliterationTable {
  readonly id: string;
  readonly script: string;
  readonly source: { readonly title: string; readonly url: string; readonly accessed: string };
  /** `official` only when the table was checked line by line against the cited edition. */
  readonly verification: 'official' | 'secondary';
  readonly note: string;
  readonly map: Readonly<Record<string, string>>;
}
