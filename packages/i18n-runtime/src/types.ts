/** One dictionary: nested objects whose leaves are ICU-subset message strings. */
export type Messages = { readonly [key: string]: string | Messages | readonly string[] };

/**
 * The active locale for one render plus the message layers that resolve a key, in order: the deployment's
 * brand overlay, the app's dictionary for the locale, the app's English keys that dictionary lacks, then
 * the design system's dictionary for the locale (the design system's English reference is built in).
 * `country` is the active country code (empty when there is none); together with `locale` it selects the `Intl` formats.
 */
export type LocaleStore = { locale: string; country: string; layers: Messages[]; formats?: LocaleFormats | null };

/** A part of a date the formatter fills in; everything else in a pattern is literal text. */
export type DateField = 'day' | 'month' | 'year' | 'weekday' | 'hour' | 'minute' | 'dayPeriod';

/** One shape of date in one language, as the server's `Intl` writes it: the order, the words and the padding. */
export type DateShapeFormat = {
  parts: Array<string | [DateField]>;
  /** January first, as this shape writes each month (Armenian and Georgian decline it, so each shape has its own). */
  months?: string[];
  /** Sunday first. */
  weekdays?: string[];
  /** Morning and afternoon, present on a twelve-hour clock. */
  dayPeriods?: [string, string];
  padDay?: boolean;
  padHour?: boolean;
};

/**
 * What the server's `Intl` knows about the page's language, for a browser that does not. A browser without data for a
 * language gives no error: it silently uses its own language (`Intl.DateTimeFormat('ka')` on a Russian Chromium writes
 * Russian months), so this travels with the page. `sample` is how the server writes a fixed date: a browser that writes
 * it the same way has the data and keeps using its own `Intl`.
 */
export type LocaleFormats = {
  tag: string;
  sample: string;
  dates: Record<string, DateShapeFormat>;
  group: string;
  decimal: string;
  /** Whether four-digit numbers are grouped (`1 234`); Spanish waits for five. */
  groupsFourDigits: boolean;
  /** What stands before and after the number of each unit (`['', ' მეგაბაიტი']`). */
  units: Record<string, [string, string]>;
};

/** Outside any request: English and no country (the engine has no default country, ADR 012 decision 11). */
export const EMPTY_STORE: LocaleStore = { locale: 'en', country: '', layers: [] };
