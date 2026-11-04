import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { DATE_SHAPES, formatDateShape, formatNumber, intlTagFor, writeDate, writeNumber, type DateShape } from '@trustwork/ui/i18n';
import { localeFormats } from '@trustwork/ui/i18n/formats';
import { formatMoney, longDate, shortDate, t } from '../../../apps/web/app/_lib/i18n.js';
import { layersFor, REPO } from './helpers.js';

/** INTL-003: CLDR plural categories from `Intl.PluralRules` in every language, and formats chosen by language plus country. */
function use(locale: string, country: string): void {
  setLocaleStore({ locale, country, layers: layersFor(locale) });
}

const COUNT_KEYS = ['companies.foundNoun', 'events.foundNoun', 'people.foundNoun', 'projects.foundNoun', 'search.resultNoun'] as const;

test('English uses one and other: 1 company, 2, 21 and 101 companies', () => {
  use('en', 'US');
  assert.deepEqual([1, 2, 21, 101].map((count) => t('companies.foundNoun', { count })), ['company', 'companies', 'companies', 'companies']);
  assert.deepEqual([1, 2, 21, 101].map((count) => t('search.resultNoun', { count })), ['result', 'results', 'results', 'results']);
  assert.deepEqual([1, 2, 21, 101].map((count) => t('articles.materialsCount', { count })), ['1 material', '2 materials', '21 materials', '101 materials']);
  assert.equal(t('articles.materialsCount', { count: 1250 }), '1,250 materials');
});

test('Russian uses one, few and many: 1 and 21 and 101 компания, 2 компании, 5 and 11 компаний', () => {
  use('ru', 'UZ');
  assert.deepEqual([1, 2, 5, 11, 21, 22, 101, 111].map((count) => t('companies.foundNoun', { count })), ['компания', 'компании', 'компаний', 'компаний', 'компания', 'компании', 'компания', 'компаний']);
  assert.deepEqual([1, 3, 12, 21].map((count) => t('articles.materialsCount', { count })), ['1 материал', '3 материала', '12 материалов', '21 материал']);
});

test('every count key resolves in every engine language for 0, 1, 2, 21 and 101', () => {
  for (const [locale, country] of [['en', 'US'], ['ru', 'UZ'], ['uz-Latn', 'UZ'], ['ka', 'GE'], ['hy', 'AM'], ['az-Latn', 'AZ']] as const) {
    use(locale, country);
    for (const key of COUNT_KEYS)
      for (const count of [0, 1, 2, 21, 101]) {
        const text = t(key, { count });
        assert.ok(text.length > 0 && !/[{}#]/.test(text), `${locale} ${key} ${count}: ${text}`);
      }
  }
});

test('the Intl tag comes from language plus country', () => {
  assert.equal(intlTagFor('en', 'US'), 'en-US');
  assert.equal(intlTagFor('es', 'US'), 'es-US');
  assert.equal(intlTagFor('en', 'GB'), 'en-GB');
  assert.equal(intlTagFor('uz-Latn', 'UZ'), 'uz-Latn-UZ');
  assert.equal(intlTagFor('ka', 'GE'), 'ka-GE');
  assert.equal(intlTagFor('hy', 'AM'), 'hy-AM');
  assert.equal(intlTagFor('az-Latn', 'AZ'), 'az-Latn-AZ');
  // No Intl data for the pair: the language's own formats (international English for English).
  assert.equal(intlTagFor('en', 'UZ'), 'en-001');
  assert.equal(intlTagFor('ru', 'UZ'), 'ru');
  assert.equal(intlTagFor('en', null), 'en-001');
  assert.equal(intlTagFor('en', 'not a country'), 'en-001');
});

test('a US visitor sees month-day dates and dollar amounts in US style; other countries day-month', () => {
  use('en', 'US');
  assert.equal(longDate('2026-10-27'), 'October 27, 2026');
  assert.equal(shortDate('2026-10-27'), '10/27/2026');
  assert.equal(formatMoney('123450', 'USD'), '$1,234.50');
  use('en', 'GB');
  assert.equal(longDate('2026-10-27'), '27 October 2026');
  assert.equal(shortDate('2026-10-27'), '27/10/2026');
  use('en', 'UZ');
  assert.equal(longDate('2026-10-27'), '27 October 2026');
  setLocaleStore({ locale: 'es', country: 'US', layers: layersFor('en') }); // es-US formats before a Spanish dictionary exists (LANG-ES)
  assert.match(longDate('2026-10-27'), /27 de octubre de 2026/);
  use('ru', 'KZ');
  assert.equal(longDate('2026-10-27'), '27 октября 2026', 'Russian long dates drop « г.» in every country');
  use('en', 'US');
});

/**
 * A browser has no data for Georgian or Armenian and a stub for Azerbaijani and Uzbek; `Intl` then answers in the
 * browser's own language without an error. So the page carries what the server's `Intl` writes, and what is written from
 * it has to be exactly what `Intl` writes, in every language, shape and date.
 */
const SERVED_TAGS = ['en', 'en-US', 'en-001', 'es', 'es-US', 'ka', 'ka-GE', 'hy', 'hy-AM', 'az-Latn', 'az-Latn-AZ', 'uz-Latn', 'uz-Latn-UZ', 'ru'];
const INSTANTS = [
  ...Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2026, month, 1 + month * 2, month * 2, month * 5))),
  new Date('2026-11-04T00:00:00Z'), new Date('2026-12-31T23:59:59Z'), new Date('2024-02-29T12:00:00Z'), new Date('2026-01-01T12:05:00Z'),
];

test('what the server sends writes every shape exactly as Intl does, in every language', () => {
  for (const tag of SERVED_TAGS) {
    const formats = localeFormats(tag);
    for (const shape of Object.keys(DATE_SHAPES) as DateShape[]) {
      for (const timeZone of ['UTC', 'Asia/Tbilisi', 'America/Los_Angeles']) {
        const native = new Intl.DateTimeFormat(tag, { ...DATE_SHAPES[shape], timeZone });
        for (const at of INSTANTS) assert.equal(writeDate(formats.dates[shape]!, at, timeZone), native.format(at), `${tag} ${shape} ${timeZone} ${at.toISOString()}`);
      }
    }
  }
});

test('what the server sends writes numbers exactly as Intl does, in every language', () => {
  for (const tag of SERVED_TAGS) {
    const native = new Intl.NumberFormat(tag);
    for (const value of [0, 7, 999, 1000, 1234, 9999, 10000, 12345, 1234567, 1234.5, -1234, -12345.25]) assert.equal(writeNumber(localeFormats(tag), value), native.format(value), `${tag} ${value}`);
  }
});

test('a runtime that writes the sample otherwise uses what the page brought; one that agrees keeps its own Intl', () => {
  const instant = new Date('2026-11-03T10:00:00Z');
  const formats = localeFormats('ka');
  const marked = { ...formats.dates.long!, months: formats.dates.long!.months!.map((month) => `page-${month}`) };
  setLocaleStore({ locale: 'ka', country: 'GE', layers: layersFor('ka'), formats: { ...formats, dates: { ...formats.dates, long: marked } } });
  assert.doesNotMatch(longDate(instant), /page-/, 'this runtime has Georgian, so nothing changes');
  setLocaleStore({ locale: 'ka', country: 'GE', layers: layersFor('ka'), formats: { ...formats, sample: 'a browser without Georgian', dates: { ...formats.dates, long: marked }, group: '|' } });
  assert.match(longDate(instant), /^3 page-ნოემბერი, 2026$/);
  assert.match(longDate('2026-11-03'), /^3 page-ნოემბერი, 2026$/, 'a calendar date stays that date in any time zone');
  assert.equal(formatDateShape(new Date('2026-11-03T22:30:00Z'), 'day', 'Asia/Tbilisi'), '4', 'an instant is written in the zone asked for');
  assert.equal(formatNumber(1234567), '1|234|567');
  setLocaleStore({ locale: 'en', country: 'US', layers: layersFor('en') });
});

test('no client component formats a date or a language name with Intl directly', () => {
  const sources = ['packages/ui/src/components/DateTile/DateTile.tsx', 'packages/ui/src/components/AuditTrail/AuditTrail.tsx', 'packages/ui/src/components/CalendarAgenda/CalendarAgenda.tsx', 'apps/web/components/workspace/ProjectRow.tsx', 'apps/web/components/workspace/ProvenanceEditor.tsx', 'apps/web/app/app/settings/_components/SecondFactorPanel.tsx'];
  for (const path of sources) assert.doesNotMatch(readFileSync(resolve(REPO, path), 'utf8'), /new Intl\.(?:DateTimeFormat\(intlTag|DisplayNames\()/, path);
});
