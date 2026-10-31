import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COUNTRY, getCountryPack } from '@trustwork/country-packs';
import { negotiate } from '../../apps/web/app/_lib/locale-negotiation.js';

const fallbackPack = getCountryPack(DEFAULT_COUNTRY)!;
const georgia = getCountryPack('GE')!;

/** ADR 012, decision 27: English is the default language; a browser in an unsupported language must not land in the fallback pack's language. */
test('a visitor who chose no country and whose browser language is not offered gets English', () => {
  for (const header of [null, '', 'es-MX,es;q=0.9', 'de-DE', 'fr-FR,fr;q=0.8,pt;q=0.5']) assert.equal(negotiate(header, fallbackPack, false), 'en', String(header));
});

test('a supported browser language still wins, exactly or by base language', () => {
  assert.equal(negotiate('ru-RU,ru;q=0.9', fallbackPack, false), 'ru');
  assert.equal(negotiate('ka', fallbackPack, false), 'ka');
  assert.equal(negotiate('uz', fallbackPack, false), 'uz-Latn');
  assert.equal(negotiate('en-US,en;q=0.9', georgia, true), 'en');
});

test('a visitor who chose a country falls back to that country\'s default language', () => {
  assert.equal(negotiate('de-DE', georgia, true), georgia.defaultLocale);
  assert.equal(negotiate(null, georgia, true), georgia.defaultLocale);
});
