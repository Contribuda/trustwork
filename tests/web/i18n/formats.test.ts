import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLocaleStore } from '@trustwork/i18n-runtime';
import { intlTagFor } from '@trustwork/ui/i18n';
import { formatMoney, longDate, shortDate, t } from '../../../apps/web/app/_lib/i18n.js';
import { layersFor } from './helpers.js';

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
