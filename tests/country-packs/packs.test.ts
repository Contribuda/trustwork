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
    ['UZ', 'GE', 'AM', 'AZ', 'US', 'GB', 'CA', 'MX'],
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

test('the four example packs are v2 files (CTRY-003) whose v1 view still validates and upgrades without losing a fact or a source', () => {
  for (const file of ['uz', 'ge', 'am', 'az']) {
    const raw = JSON.parse(readFileSync(`packages/country-packs/packs/${file}.json`, 'utf8')) as Record<string, unknown> & { registrationIdentifier: Record<string, unknown>; dataResidency: Record<string, unknown> };
    assert.equal(raw.schemaVersion, 2, `${file}.json is a v2 file`);
    assert.deepEqual(packProblems(raw).problems, [], file);
    // The v1 view of the file (v2 fields removed) is still a valid v1 pack, and upgrading it keeps every v1 field and source.
    const v1 = structuredClone(raw);
    for (const key of ['schemaVersion', 'verificationLevel', 'timeZones', 'facets'] as const) delete v1[key];
    delete v1.registrationIdentifier.verificationLevel;
    delete v1.dataResidency.verificationLevel;
    assert.deepEqual(packProblems(v1).problems, [], `${file}: v1 view`);
    const upgraded = upgradePack(CountryPackSchema.parse(v1));
    assert.equal(upgraded.schemaVersion, 2);
    assert.deepEqual(upgraded.facets, {});
    for (const level of [upgraded.verificationLevel, upgraded.registrationIdentifier.verificationLevel, upgraded.dataResidency.verificationLevel]) {
      assert.ok(level === 'secondary' || level === 'pending', `${file}: a v1 fact is never upgraded to ${level}`);
    }
    // The v1 facts still rest on the v1 sources (ISO lists, secondary identifier guides, laws pending counsel): never official.
    const pack = getPack(file)!;
    for (const level of [pack.verificationLevel, pack.registrationIdentifier.verificationLevel, pack.dataResidency.verificationLevel]) {
      assert.ok(level === 'secondary' || level === 'pending', `${file}: a v1 fact is declared ${level}`);
    }
    const servedV1 = structuredClone(pack) as unknown as Record<string, unknown> & { registrationIdentifier: Record<string, unknown>; dataResidency: Record<string, unknown> };
    for (const key of ['schemaVersion', 'verificationLevel', 'timeZones', 'facets'] as const) delete servedV1[key];
    delete servedV1.registrationIdentifier.verificationLevel;
    delete servedV1.dataResidency.verificationLevel;
    assert.deepEqual(servedV1, v1, `${file}: the served pack keeps every v1 field and source verbatim`);
  }
  assert.equal(getPack('UZ')?.registrationIdentifier.verificationLevel, 'secondary', 'UZ-STIR rests on secondary sources');
  assert.equal(getPack('UZ')?.dataResidency.verificationLevel, 'pending', 'UZ residency article numbering is pending');
});
