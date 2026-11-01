import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  factsFor, formatMoney, getCountryPack, getPack, holidaysInYear, identifierKinds,
  listFacts, packProblems, regionName, validateIdentifier, validatePack,
} from '@trustwork/country-packs';
import { intlTagFor } from '@trustwork/ui/i18n';

const raw = JSON.parse(readFileSync('packages/country-packs/packs/gb.json', 'utf8')) as unknown;
const pack = validatePack(raw);
const allFacts = [
  ...listFacts(pack.facets),
  ...pack.regions.flatMap((region) => listFacts(region.facets)),
];

test('GB validates as v2 and visitors resolve the contributed pack with en-GB formats', () => {
  assert.deepEqual(packProblems(raw).problems, []);
  assert.equal(pack.schemaVersion, 2);
  assert.equal(getPack('gb')?.code, 'GB');
  assert.deepEqual(getCountryPack('GB')?.regions, pack.regions);
  assert.equal(pack.currency.code, 'GBP');
  assert.equal(pack.defaultLocale, 'en');
  assert.equal(intlTagFor('en', 'GB'), 'en-GB');
  assert.equal(formatMoney('123456', pack.currency.code, 'en-GB'), '£1,234.56');
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London' }).format(new Date('2026-07-04T12:00:00Z')), '04/07/2026');
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit' }).format(new Date('2026-07-04T12:00:00Z')), '13');
  assert.deepEqual(pack.timeZones, ['Europe/London']);
  assert.ok(!pack.locales.includes('cy'), 'Welsh is a contribution lead, not an installed locale');
});

test('four nations contain the labelled CLDR subdivision snapshot with no orphan or foreign child', () => {
  assert.deepEqual(pack.regions.filter((r) => !r.parent).map((r) => r.code), ['GB-ENG', 'GB-SCT', 'GB-WLS', 'GB-NIR']);
  for (const [nation, count] of [['GB-ENG', 152], ['GB-SCT', 32], ['GB-WLS', 22], ['GB-NIR', 11]] as const) {
    assert.equal(pack.regions.filter((r) => r.parent === nation).length, count, nation);
  }
  for (const r of pack.regions) {
    assert.match(r.code, /^GB-[A-Z]{3}$/);
    if (r.parent) assert.ok(pack.regions.some((parent) => parent.code === r.parent && !parent.parent));
  }
  assert.equal(regionName(pack, 'GB-EDH', 'en'), 'Edinburgh');
  assert.equal(regionName(pack, 'GB-CRF', 'es'), 'Cardiff', 'pack text falls back to English');
  assert.equal(pack.verificationLevel, 'secondary');
  assert.match(pack.notes!.join(' '), /do not use it as a current local-authority/);
  assert.equal(pack.layers, undefined, 'GB does not inherit the EU member layer');
});

test('company and VAT patterns check shape only, while UTR is never an offered identifier', () => {
  for (const value of ['00000000', '01234567', 'SC000001', 'NI000001', 'OC000001', 'SO000001']) assert.ok(validateIdentifier(pack, value), value);
  for (const value of ['1234567', '123456789', 'S0000001', 'SC00001', 'SC0000001', 'sc000001', '1234567890']) assert.equal(validateIdentifier(pack, value), false, value);
  for (const value of ['123456789', 'GB123456789', 'GB 123 4567 89', '123 4567 89']) assert.ok(validateIdentifier(pack, value, 'GB-VAT'), value);
  for (const value of ['12345678', '1234567890', 'GB12345678A', 'XI123456789']) assert.equal(validateIdentifier(pack, value, 'GB-VAT'), false, value);
  for (const region of [undefined, 'GB-ENG', 'GB-SCT', 'GB-WLS', 'GB-NIR', 'GB-BFS']) {
    assert.deepEqual(identifierKinds(pack, region).map((k) => k.kind), ['GB-CRN', 'GB-VAT']);
  }
  assert.equal(validateIdentifier(pack, '1234567890', 'GB-UTR'), false);
  assert.match(pack.facets.contentLaw!.find((f) => f.id === 'sensitive-utr')!.verificationNote!, /sensitive tax information/);
  assert.equal(pack.registrationIdentifier.verificationLevel, 'pending', 'special register formats have not been exhaustively confirmed');
});

test('postcodes allow common outward shapes without asserting deliverability', () => {
  const pattern = new RegExp(pack.formats.postalCode.pattern);
  for (const value of ['SW1A 1AA', 'M1 1AA', 'W1A 0AX', 'B33 8TH', 'CR2 6XH', 'DN55 1PT', 'GIR 0AA', 'BT1 1AA', 'CF10 1AA', 'EH1 1AA']) assert.ok(pattern.test(value), value);
  for (const value of ['', '12345', 'ABC123', 'SW1A 1A', 'SW1A 11AA']) assert.equal(pattern.test(value), false, value);
  assert.match(pack.notes!.join(' '), /not Royal Mail deliverability/);
});

test('nation building rules and England higher-risk approval never leak across regional boundaries', () => {
  for (const [child, nation, title] of [['GB-LND', 'GB-ENG', 'England'], ['GB-EDH', 'GB-SCT', 'Scotland'], ['GB-CRF', 'GB-WLS', 'Wales'], ['GB-BFS', 'GB-NIR', 'Northern Ireland']]) {
    const building = factsFor(pack, 'standards', child).find(({ fact }) => fact.id === 'building-regulations');
    assert.equal(building?.scope, nation);
    assert.ok(building?.fact.system.en!.includes(title!), child);
    assert.ok(factsFor(pack, 'standards', child).some(({ fact }) => fact.id === 'british-eurocodes'));
    const higherRisk = factsFor(pack, 'licensing', child).some(({ fact }) => fact.id === 'higher-risk-building-approval');
    assert.equal(higherRisk, nation === 'GB-ENG', child);
  }
  assert.equal(factsFor(pack, 'procurement', 'GB-EDH').find(({ fact }) => fact.id === 'find-a-tender')?.scope, 'GB-SCT');
  assert.equal(factsFor(pack, 'payments', 'GB-BFS').find(({ fact }) => fact.id === 'construction-payment-law')?.scope, 'GB-NIR');
  assert.ok(!factsFor(pack, 'licensing', 'GB-BFS').some(({ fact }) => fact.id === 'competent-person-schemes'));
});

test('bank calendars use published nation-specific dates, including substitutes and the one-off Scotland day', () => {
  const dates = (year: number, region: string) => holidaysInYear(pack, year, region).map((h) => h.observed);
  const england2026 = ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'];
  assert.deepEqual(dates(2026, 'GB-ENG'), england2026);
  assert.deepEqual(dates(2026, 'GB-WLS'), england2026);
  assert.deepEqual(dates(2026, 'GB-LND'), england2026);
  const scotland = dates(2026, 'GB-EDH');
  assert.ok(scotland.includes('2026-06-15'));
  assert.ok(scotland.includes('2026-08-03') && scotland.includes('2026-11-30'));
  assert.ok(!scotland.includes('2026-04-06') && !scotland.includes('2026-08-31'));
  const ni = dates(2026, 'GB-BFS');
  assert.ok(ni.includes('2026-03-17') && ni.includes('2026-07-13'));
  assert.ok(!ni.includes('2026-06-15'));
  assert.deepEqual(dates(2027, 'GB-ENG').filter((d) => d.startsWith('2027-12')), ['2027-12-27', '2027-12-28'], 'Christmas and Boxing Day substitutes do not collide');
  assert.deepEqual(dates(2028, 'GB-SCT').slice(0, 2), ['2028-01-03', '2028-01-04']);
  assert.deepEqual(holidaysInYear(pack, 2026), [], 'no nation is silently selected at country level');
  assert.deepEqual(dates(2029, 'GB-ENG'), [], 'unpublished dates are not extrapolated');
});

test('VAT, CIS and future invoicing facts do not become automatic tax or current mandate decisions', () => {
  const vat = pack.facets.tax!.find((f) => f.id === 'vat');
  assert.ok(vat?.type === 'rate');
  assert.equal(vat.standardRate, '20');
  assert.deepEqual(vat.reducedRates.map((r) => r.rate), ['5', '0']);
  assert.equal(vat.calculation, 'adapter');
  const cis = pack.facets.tax!.find((f) => f.id === 'cis-deductions');
  assert.ok(cis?.type === 'rate');
  assert.equal(cis.standardRate, '20');
  assert.deepEqual(cis.reducedRates.map((r) => r.rate), ['30', '0']);
  assert.equal(cis.calculation, 'adapter');
  const future = pack.facets.tax!.find((f) => f.id === 'electronic-invoicing-2029');
  assert.ok(future?.type === 'e-invoicing');
  assert.equal(future.effectiveFrom, '2029-04-01');
  assert.equal(future.verification, 'pending');
  assert.match(future.verificationNote!, /not a current operational mandate/);
});

test('every fact has dated provenance and lower levels explain the remaining verification work', () => {
  const sources = [...pack.sources, ...pack.registrationIdentifier.sources, ...pack.dataResidency.sources, ...allFacts.flatMap(({ fact }) => fact.sources)];
  for (const source of sources) {
    assert.match(source.url, /^https:\/\//);
    assert.equal(source.accessed, '2026-11-01');
    assert.ok(source.what.length > 20);
    assert.doesNotMatch(source.url, /example\.(com|org|invalid)/);
  }
  for (const { facet, fact } of allFacts) {
    if (fact.verification !== 'official') assert.ok(fact.verificationNote, `${facet}/${fact.id}`);
    assert.ok(!('adapter' in fact && fact.adapter), `${fact.id} must not enable a provider`);
    if (facet === 'agentLaw') {
      assert.equal(fact.verification, 'pending');
      assert.ok('counselReview' in fact && fact.counselReview === 'pending');
    }
  }
  assert.equal(pack.dataResidency.verificationLevel, 'pending');
  assert.doesNotMatch(JSON.stringify(pack), /RUB|₽|\.ru(?:\/|\")|Yandex|Sberbank|UnionPay Russia/i);
});

test('the pack rejects source removal, restricted subdivisions and invented adapters', () => {
  const unsourced = structuredClone(pack);
  unsourced.facets.identifiers![0]!.sources = [];
  assert.ok(packProblems(unsourced).problems.length > 0);
  const restricted = structuredClone(pack);
  restricted.regions.push({ code: 'UA-43', name: { en: 'Forbidden test region' }, kind: 'region' });
  assert.ok(packProblems(restricted).problems.some((p) => /restricted/.test(p)));
  const fakeAdapter = structuredClone(pack);
  fakeAdapter.facets.registers![0]!.adapter = { capability: 'business_registry', id: 'invented-gb-register' } as never;
  assert.ok(packProblems(fakeAdapter).problems.length > 0);
});

function engineSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'fixtures', 'locales'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return engineSources(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

test('engine code has no United Kingdom branch', () => {
  const countryBranch = /(?:===|!==|==|!=)\s*['"`]GB(?:-[A-Z0-9]{1,3})?['"`]|['"`]GB(?:-[A-Z0-9]{1,3})?['"`]\s*(?:===|!==|==|!=)|case\s+['"`]GB(?:-[A-Z0-9]{1,3})?['"`]/;
  assert.deepEqual([...engineSources('apps'), ...engineSources('packages')].filter((file) => countryBranch.test(readFileSync(file, 'utf8'))), []);
});
