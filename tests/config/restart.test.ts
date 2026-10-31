import test from 'node:test';
import assert from 'node:assert/strict';
import { dataDirectory, probe, startupCheck, syntheticPack } from './helpers.js';

/**
 * CFG-001 acceptance: a country pack and a language dropped into the data directory appear after a restart with no
 * code change; one build serves deployments with different default countries and brands; restricted places are
 * refused at load. Every observation is a fresh process started the way the server starts (see probe.mjs).
 */

test('a new pack and a new language dropped into the data directory appear after a restart, with no code change', () => {
  const data = dataDirectory();
  try {
    const before = probe({ TRUSTWORK_DATA_DIR: data.dir });
    assert.equal(before.languageOffered, false, 'pt is not offered before its dictionary exists');
    assert.ok(!before.packs.includes('XF'), 'XF has no pack yet');
    assert.equal(before.countryOffered, null, 'XF cannot be chosen yet');

    // The operator drops data files into the directory; nothing else changes.
    data.write('country-packs/xf.json', syntheticPack('pt'));
    data.write('locales/pt/core.json', { locale: { gateTitle: 'Escolha o seu país' } });
    data.write('ui-locales/pt.json', { brand: { name: 'Trustwork' } });
    data.write('fixtures/i18n/pt.json', { people: { 'people/0/experience': 'Oito anos em fachadas ventiladas (texto sintético de teste).' } });

    const after = probe({ TRUSTWORK_DATA_DIR: data.dir });
    assert.ok(after.packs.includes('XF'), 'the pack is active');
    assert.equal(after.countryOffered, 'XF', 'and the country can be chosen');
    assert.equal(after.countryName, 'Federation of Exampleland (synthetic)');
    assert.equal(after.languageOffered, true, 'the language is offered');
    assert.ok(after.offeredLanguages.includes('pt'));
    assert.equal(after.countryLanguage, 'pt', "the pack's language is the country's default");
    assert.deepEqual(after.chooser, { country: 'XF', locale: 'pt', chosen: true }, 'a visitor who chooses XF gets Portuguese');
    assert.equal(after.gateTitle, 'Escolha o seu país', 'the application dictionary is served');
    assert.equal(after.uiDictionary, true, 'the design-system dictionary is registered');
    assert.ok(after.fixtureLanguages.includes('pt'));
    assert.equal(after.fixtureText, 'Oito anos em fachadas ventiladas (texto sintético de teste).', 'demo content is localized by its override file');
    // The built-in data is unchanged.
    for (const code of ['UZ', 'GE', 'AM', 'AZ', 'US']) assert.ok(after.packs.includes(code), code);
    for (const tag of ['en', 'ru', 'uz-Latn', 'ka', 'hy', 'az-Latn']) assert.ok(after.offeredLanguages.includes(tag), tag);
  } finally {
    data.remove();
  }
});

test('one build serves deployments with different default countries and brands (runtime configuration)', () => {
  const a = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'US', TRUSTWORK_BRAND: 'none' });
  const b = probe({ TRUSTWORK_DEFAULT_COUNTRY: 'GE' });
  assert.deepEqual(a.visitor, { country: 'US', locale: 'en', chosen: false });
  assert.deepEqual(b.visitor, { country: 'GE', locale: 'en', chosen: false }, 'the default language stays English (decision 27)');
  assert.equal(a.brandName.ru, null, 'TRUSTWORK_BRAND=none: Trustwork in Russian too');
  assert.equal(a.russianWordmark, false);
  assert.equal(b.brandName.ru, 'Строй Репутация', 'the default overlay letters the Russian interface only');
  assert.equal(b.brandName.en, null, 'and never another language');
  assert.equal(b.russianWordmark, true);

  // A brand supplied as data, chosen by configuration file.
  const data = dataDirectory();
  try {
    data.write('brands/example-build.json', { messages: { en: { brand: { name: 'Example Build (test)' } } } });
    data.write('trustwork.config.json', { schemaVersion: 1, countries: { default: 'AM' }, brand: { overlay: 'example-build' } });
    const c = probe({ TRUSTWORK_DATA_DIR: data.dir });
    assert.equal(c.defaultCountry, 'AM');
    assert.deepEqual(c.visitor, { country: 'AM', locale: 'en', chosen: false });
    assert.equal(c.brandName.en, 'Example Build (test)');
    assert.equal(c.brandName.ru, null);
  } finally {
    data.remove();
  }
});

test('with nothing configured there is no default country: visitors start neutral and choose (ADR 012 decision 11)', () => {
  const none = probe({});
  assert.equal(none.defaultCountry, null);
  assert.deepEqual(none.visitor, { country: '', locale: 'en', chosen: false });
  // A visitor's choice still works for any country that is not a restricted place.
  const chooser = probe({ PROBE_COUNTRY: 'BR' });
  assert.deepEqual(chooser.chooser, { country: 'BR', locale: 'en', chosen: true });
  const refused = probe({ PROBE_COUNTRY: 'RU' });
  assert.deepEqual(refused.chooser, { country: '', locale: 'en', chosen: false }, 'a restricted place is never set, even by cookie');
});

test('the server refuses to start on a restricted or invalid pack, an unknown brand or a language without a dictionary', () => {
  const cases: { name: string; files: Record<string, unknown>; env?: Record<string, string>; expect: RegExp }[] = [
    { name: 'restricted country as a pack', files: { 'country-packs/ir.json': { ...syntheticPack('en'), code: 'IR', locales: ['en'], defaultLocale: 'en' } }, expect: /IR is a restricted place/ },
    {
      name: 'restricted region inside a pack',
      files: { 'country-packs/xf.json': { ...syntheticPack('en'), locales: ['en'], defaultLocale: 'en', regions: [...(syntheticPack('en').regions as object[]), { code: 'UA-43', name: { en: 'Restricted' }, kind: 'region' }] } },
      expect: /UA-43 is a restricted place/,
    },
    { name: 'malformed pack', files: { 'country-packs/xf.json': { code: 'XF' } }, expect: /xf\.json: .*expected/ },
    { name: 'misnamed pack file', files: { 'country-packs/other.json': syntheticPack('en') }, expect: /must be named xf\.json/ },
    { name: 'pack file that is not JSON', files: { 'country-packs/xf.json': '{ not json' }, expect: /cannot be read as JSON/ },
    { name: 'restricted default country', files: {}, env: { TRUSTWORK_DEFAULT_COUNTRY: 'KP' }, expect: /KP is a restricted place/ },
    { name: 'restricted offered country in the file', files: { 'trustwork.config.json': { schemaVersion: 1, countries: { offered: ['US', 'CU'] } } }, expect: /CU is a restricted place/ },
    { name: 'unknown brand overlay', files: {}, env: { TRUSTWORK_BRAND: 'nobody' }, expect: /brand overlay .{1,2}nobody.{1,2} is neither built in/ },
    { name: 'language without a dictionary', files: { 'trustwork.config.json': { schemaVersion: 1, languages: { enabled: ['en', 'pt'] } } }, expect: /language pt is configured but has no dictionary/ },
    { name: 'unknown key in the configuration file', files: { 'trustwork.config.json': { schemaVersion: 1, defaultCountry: 'US' } }, expect: /Unrecognized key/ },
  ];
  for (const c of cases) {
    const data = dataDirectory();
    try {
      for (const [path, content] of Object.entries(c.files)) data.write(path, content);
      const result = startupCheck({ TRUSTWORK_DATA_DIR: data.dir, ...c.env });
      assert.equal(result.status, 1, `${c.name}: the server must not start\n${result.log}`);
      assert.match(result.log, /"level":"fatal"/, c.name);
      assert.match(result.log, c.expect, c.name);
    } finally {
      data.remove();
    }
  }
  const ok = startupCheck({ TRUSTWORK_DEFAULT_COUNTRY: 'US' });
  assert.equal(ok.status, 0, ok.log);
  assert.match(ok.log, /"defaultCountry":"US"/);
});
