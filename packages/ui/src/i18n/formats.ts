import type { DateField, DateShapeFormat, LocaleFormats } from '@trustwork/i18n-runtime/types';
import { DATE_SHAPES, FORMAT_SAMPLE, formatSample, UNIT_SHAPES } from './index.js';

/**
 * Server side of the page's formats: `Intl` as the server has it, written down for a browser that lacks the language
 * (`LocaleFormats`). Node carries the full ICU data and browsers do not, so the page brings what the browser cannot
 * know. A separate entry point, so that none of this reaches the browser bundle.
 */
const FIELDS: ReadonlySet<string> = new Set<DateField>(['day', 'month', 'year', 'weekday', 'hour', 'minute', 'dayPeriod']);

function shapeFormat(tag: string, options: Intl.DateTimeFormatOptions): DateShapeFormat {
  const format = new Intl.DateTimeFormat(tag, { ...options, timeZone: 'UTC' });
  const pick = (at: number, type: string) => format.formatToParts(at).find((part) => part.type === type)?.value ?? '';
  const parts = format.formatToParts(FORMAT_SAMPLE);
  const has = (type: string) => parts.some((part) => part.type === type);
  return {
    // `format()` writes a plain space where `formatToParts()` gives the narrow no-break space of newer CLDR.
    parts: parts.map((part) => (FIELDS.has(part.type) ? [part.type as DateField] : part.value.replaceAll('\u202f', ' '))),
    ...(has('month') ? { months: Array.from({ length: 12 }, (_, month) => pick(Date.UTC(2001, month, 3), 'month')) } : {}),
    // 7 January 2001 was a Sunday.
    ...(has('weekday') ? { weekdays: Array.from({ length: 7 }, (_, day) => pick(Date.UTC(2001, 0, 7 + day), 'weekday')) } : {}),
    ...(has('dayPeriod') ? { dayPeriods: [pick(Date.UTC(2001, 1, 3, 4), 'dayPeriod'), pick(Date.UTC(2001, 1, 3, 16), 'dayPeriod')] as [string, string] } : {}),
    ...(pick(FORMAT_SAMPLE, 'day').length > 1 ? { padDay: true } : {}),
    ...(pick(FORMAT_SAMPLE, 'hour').length > 1 ? { padHour: true } : {}),
  };
}

/** What stands around the number of a unit in this language. */
function unitFormat(tag: string, options: Intl.NumberFormatOptions): [string, string] {
  const parts = new Intl.NumberFormat(tag, options).formatToParts(5);
  const at = parts.findIndex((part) => part.type === 'integer');
  const text = (from: number, to?: number) => parts.slice(from, to).map((part) => part.value).join('');
  return [text(0, at), text(at + 1)];
}

const cached = new Map<string, LocaleFormats>();

/** The formats of an `Intl` tag; computed once per tag, as they do not depend on the request. */
export function localeFormats(tag: string): LocaleFormats {
  const known = cached.get(tag);
  if (known) return known;
  const number = new Intl.NumberFormat(tag).formatToParts(1234567.5);
  const formats: LocaleFormats = {
    tag,
    sample: formatSample(tag),
    dates: Object.fromEntries(Object.entries<Intl.DateTimeFormatOptions>(DATE_SHAPES).map(([shape, options]) => [shape, shapeFormat(tag, options)])),
    group: number.find((part) => part.type === 'group')?.value ?? '',
    decimal: number.find((part) => part.type === 'decimal')?.value ?? '.',
    groupsFourDigits: new Intl.NumberFormat(tag).formatToParts(1234).some((part) => part.type === 'group'),
    units: Object.fromEntries(Object.entries<Intl.NumberFormatOptions>(UNIT_SHAPES).map(([unit, options]) => [unit, unitFormat(tag, options)])),
  };
  cached.set(tag, formats);
  return formats;
}
