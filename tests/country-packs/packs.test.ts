import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { ALL_LOCALES, CountryPackSchema, PACKS, RESTRICTED, enabledPacks, formatMoney, getPack, isRestricted, packProblems, upgradePack, validateIdentifier, validatePack } from '@trustwork/country-packs';

test('every pack file on disk validates and is loaded', () => {
  const files = readdirSync('packages/country-packs/packs').filter((f) => f.endsWith('.json') && f !== 'restricted.json');
  assert.equal(files.length, PACKS.length);
  for (const file of files) validatePack(JSON.parse(readFileSync(`packages/country-packs/packs/${file}`, 'utf8')));
});

test('launch markets are present and Uzbekistan is complete and first', () => {
  assert.deepEqual(
    PACKS.map((p) => p.code),
    ['UZ', 'GE', 'AM', 'AZ', 'US'],
  );
  assert.equal(getPack('uz')?.status, 'complete');
  assert.equal(getPack('UZ')?.defaultLocale, 'uz-Latn');
  assert.equal(getPack('UZ')?.currency.code, 'UZS');
  assert.equal(getPack('UZ')?.regions.length, 14);
  assert.equal(getPack('GE')?.regions.length, 12);
  assert.equal(getPack('AM')?.regions.length, 11);
  assert.equal(getPack('AZ')?.regions.length, 78);
});

test('restricted places never become packs or appear in the selector', () => {
  for (const code of ['RU', 'ru', 'CU', 'IR', 'KP', 'UA-43', 'UA-40', 'UA-14', 'UA-09']) assert.equal(isRestricted(code), true, code);
  assert.equal(isRestricted('UA'), false);
  assert.equal(isRestricted('UZ'), false);
  assert.ok(RESTRICTED.places.length >= 8);
  assert.ok(enabledPacks().every((p) => !isRestricted(p.code)));
  const russia = {
    ...getPack('UZ')!,
    code: 'RU',
    name: { en: 'Russia' },
    regions: [{ code: 'RU-MOW', name: { en: 'Moscow', 'uz-Latn': 'Moskva' }, kind: 'city' as const }],
    registrationIdentifier: { ...getPack('UZ')!.registrationIdentifier, kind: 'RU-INN' },
  };
  assert.throws(() => validatePack(russia), /restricted/);
});

test('identifiers validate by the pack pattern and examples match', () => {
  for (const pack of PACKS) {
    assert.ok(validateIdentifier(pack, pack.registrationIdentifier.example), pack.code);
    assert.equal(validateIdentifier(pack, 'not-a-number'), false);
    assert.ok(pack.registrationIdentifier.sources.length > 0);
    assert.ok(pack.registrationIdentifier.verification.length > 0);
  }
  assert.equal(validateIdentifier(getPack('UZ')!, '301234567'), true);
  assert.equal(validateIdentifier(getPack('UZ')!, '0000000001'), false, '10-digit Russian-style value is not a STIR');
});

test('every locale has a fallback to en and ru is never a default', () => {
  assert.equal(ALL_LOCALES[0], 'en');
  for (const pack of PACKS) {
    assert.ok(pack.locales.includes('en'));
    assert.notEqual(pack.defaultLocale, 'ru');
    // English may be a pack default where it is the country's language (the United States, ADR 012 decisions 27 and 31).
  }
  assert.deepEqual([...ALL_LOCALES].sort(), ['az-Latn', 'en', 'hy', 'ka', 'ru', 'uz-Latn']);
});

test('money formats in the pack currency without a hard-coded one', () => {
  assert.match(formatMoney('150000000', 'UZS', 'uz-Latn'), /1\s?500\s?000/);
  assert.match(formatMoney('150000000', 'UZS', 'en'), /UZS|soʻm|so'm/);
  assert.match(formatMoney('123456', 'GEL', 'ka'), /1[\s,.]?234[.,]56/);
  assert.match(formatMoney('123456', 'AMD', 'hy'), /1[\s,.]?235/);
  assert.match(formatMoney('123456', 'AZN', 'az-Latn'), /1[\s,.]?234[.,]56/);
  assert.doesNotMatch(JSON.stringify(PACKS), /RUB|₽/);
});

test('schema rejects unknown fields so packs stay data', () => {
  assert.throws(() => CountryPackSchema.parse({ ...getPack('UZ')!, forkedCode: true }));
});

test('the four existing pack files still validate unchanged (v1) and upgrade to v2 without losing a fact or a source', () => {
  for (const file of ['uz', 'ge', 'am', 'az']) {
    const raw = JSON.parse(readFileSync(`packages/country-packs/packs/${file}.json`, 'utf8')) as Record<string, unknown> & { registrationIdentifier: Record<string, unknown>; dataResidency: Record<string, unknown> };
    assert.equal(raw.schemaVersion, undefined, `${file}.json is still a v1 file`);
    assert.deepEqual(packProblems(raw).problems, [], file);
    const pack = upgradePack(CountryPackSchema.parse(raw));
    assert.equal(pack.schemaVersion, 2);
    assert.deepEqual(pack.timeZones, [pack.formats.timeZone]);
    assert.deepEqual(pack.facets, {});
    for (const level of [pack.verificationLevel, pack.registrationIdentifier.verificationLevel, pack.dataResidency.verificationLevel]) {
      assert.ok(level === 'secondary' || level === 'pending', `${file}: a v1 fact is never upgraded to ${level}`);
    }
    const v1View = structuredClone(pack) as unknown as Record<string, unknown> & { registrationIdentifier: Record<string, unknown>; dataResidency: Record<string, unknown> };
    for (const key of ['schemaVersion', 'verificationLevel', 'timeZones', 'facets'] as const) delete v1View[key];
    delete v1View.registrationIdentifier.verificationLevel;
    delete v1View.dataResidency.verificationLevel;
    assert.deepEqual(v1View, raw, `${file}: every v1 field and source is kept verbatim`);
    assert.deepEqual(getPack(file), pack, `${file}: the served pack is the upgraded file`);
  }
  assert.equal(getPack('UZ')?.registrationIdentifier.verificationLevel, 'secondary', 'UZ-STIR rests on secondary sources');
  assert.equal(getPack('UZ')?.dataResidency.verificationLevel, 'pending', 'UZ residency article numbering is pending');
});
