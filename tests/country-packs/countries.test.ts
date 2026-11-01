import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_LOCALES, COUNTRIES, RESTRICTED, countryName, currencyMeta, enabledPacks, formatMoney, genericPack, getCountry, getCountryPack } from '../../packages/country-packs/src/index.js';

test('every selectable country is listed once and no restricted place is among them', () => {
  assert.ok(COUNTRIES.length >= 240, `${COUNTRIES.length} countries`);
  const codes = COUNTRIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const place of RESTRICTED.places) assert.equal(codes.includes(place.code.slice(0, 2)) && place.code.length === 2, false, `${place.code} must not be selectable`);
  for (const pack of enabledPacks()) assert.ok(getCountry(pack.code)?.pack, `${pack.code} is flagged as a pack`);
});

test('a country without a pack gets a generic profile with its currency, every engine language and no regions', () => {
  const de = getCountryPack('DE');
  assert.ok(de);
  assert.equal(de.currency.code, 'EUR');
  assert.equal(de.currency.minorUnitDigits, 2);
  assert.deepEqual([...de.locales], [...ALL_LOCALES]);
  assert.equal(de.defaultLocale, 'en');
  assert.deepEqual(de.regions, []);
  assert.equal(de.registrationIdentifier.kind, 'DE-REGNO');
  assert.equal(de.status, 'draft');
  const jp = genericPack(getCountry('JP')!);
  assert.equal(jp.currency.minorUnitDigits, 0, 'yen has no minor units');
  assert.equal(getCountryPack('UZ')?.status, 'complete', 'a contributed pack wins over the generic profile');
  assert.equal(getCountryPack('RU'), null);
  assert.equal(getCountryPack('XX'), null);
});

test('country names come from the pack, Intl or the dataset, in the requested language', () => {
  assert.equal(countryName('UZ', 'uz-Latn'), 'Oʻzbekiston');
  assert.match(countryName('DE', 'ru'), /Германия/);
  assert.match(countryName('DE', 'ka'), /გერმანია/);
  assert.equal(countryName('DE', 'en'), 'Germany');
});

test('money formats for any ISO currency with the right minor units', () => {
  assert.equal(currencyMeta('JPY').minorUnitDigits, 0);
  assert.match(formatMoney('123456', 'JPY', 'en'), /123,456/);
  assert.match(formatMoney('123456', 'EUR', 'en'), /1,234\.56/);
});

test('a pack without a name in the locale uses Intl before the English fallback', () => {
  assert.equal(countryName('UZ', 'uz-Latn'), 'Oʻzbekiston', 'the pack name in its own locale');
  assert.equal(countryName('UZ', 'ka'), new Intl.DisplayNames(['ka'], { type: 'region' }).of('UZ'), 'Georgian from Intl, not "Uzbekistan"');
  assert.notEqual(countryName('UZ', 'ka'), 'Uzbekistan');
  assert.equal(countryName('UZ', 'en'), 'Uzbekistan');
});
