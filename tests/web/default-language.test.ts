import test from 'node:test';
import assert from 'node:assert/strict';
import { getCountryPack } from '@trustwork/country-packs';
import { resolveDeployment, unconfiguredDeployment } from '@trustwork/config';
import { defaultCountryCode, negotiate } from '../../apps/web/app/_lib/locale-negotiation.js';

const unconfigured = unconfiguredDeployment();
const unitedStates = getCountryPack('US')!;
const georgia = getCountryPack('GE')!;

/** ADR 012, decision 27: English is the default language; a browser in an unsupported language must not land in a country's language. */
test('a visitor who chose no country and whose browser language is not offered gets English', () => {
  for (const pack of [unitedStates, georgia]) {
    for (const header of [null, '', 'pt-BR,pt;q=0.9', 'de-DE', 'fr-FR,fr;q=0.8,pt;q=0.5']) assert.equal(negotiate(header, pack, false, unconfigured), 'en', `${pack.code} ${String(header)}`);
  }
});

test('a supported browser language still wins, exactly or by base language', () => {
  assert.equal(negotiate('ru-RU,ru;q=0.9', unitedStates, false, unconfigured), 'ru');
  assert.equal(negotiate('ka', unitedStates, false, unconfigured), 'ka');
  assert.equal(negotiate('uz', unitedStates, false, unconfigured), 'uz-Latn');
  assert.equal(negotiate('es-MX,es;q=0.9', unitedStates, false, unconfigured), 'es', 'Spanish is offered since LANG-ES');
  assert.equal(negotiate('en-US,en;q=0.9', georgia, true, unconfigured), 'en');
});

test('a visitor who chose a country falls back to that country\'s default language', () => {
  assert.equal(negotiate('de-DE', georgia, true, unconfigured), georgia.defaultLocale);
  assert.equal(negotiate(null, georgia, true, unconfigured), georgia.defaultLocale);
});

test('the engine has no default country; the deployment chooses one by configuration (ADR 012 decisions 11 and 31)', () => {
  assert.equal(unconfigured.countries.default, null);
  assert.equal(defaultCountryCode({}), null);
  assert.equal(defaultCountryCode({ TRUSTWORK_DEFAULT_COUNTRY: 'US' }), 'US');
  assert.equal(defaultCountryCode({ TRUSTWORK_DEFAULT_COUNTRY: ' us ' }), 'US');
  assert.equal(defaultCountryCode({ TRUSTWORK_DEFAULT_COUNTRY: 'none' }), null);
});

test('an invalid or restricted default country is a configuration error, never silently replaced', () => {
  for (const bad of ['RU', 'IR', 'KP', 'CU', 'XX', 'USA', 'U1']) {
    assert.throws(() => defaultCountryCode({ TRUSTWORK_DEFAULT_COUNTRY: bad }), /TRUSTWORK_DEFAULT_COUNTRY/, bad);
    assert.equal(resolveDeployment({ env: { TRUSTWORK_DEFAULT_COUNTRY: bad } }).deployment, null, bad);
  }
});
