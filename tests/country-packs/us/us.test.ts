import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  RESTRICTED,
  countryName,
  enabledPacks,
  factsFor,
  findIdentifierKind,
  formatMoney,
  getCountry,
  getCountryPack,
  getPack,
  holidaysInYear,
  identifierKinds,
  isRestricted,
  listFacts,
  packProblems,
  packTimeZones,
  regionName,
  validateIdentifier,
  workingWeek,
  type AnyFact,
  type CountryPack,
  type FacetName,
} from '@trustwork/country-packs';
import { intlTagFor } from '@trustwork/ui/i18n';
import { negotiate } from '../../../apps/web/app/_lib/locale-negotiation.js';

/** INTL-US: the United States pack, the model pack for every other country and the pack the San Diego reference hub runs on. */

const RAW = JSON.parse(readFileSync('packages/country-packs/packs/us.json', 'utf8')) as unknown;
const us = (): CountryPack => {
  const pack = getPack('US');
  assert.ok(pack, 'the US pack is loaded');
  return pack;
};

const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const TERRITORIES = ['AS', 'GU', 'MP', 'PR', 'UM', 'VI'];

/** Every fact of the pack with its scope, country first. */
function allFacts(pack: CountryPack): { scope: string; facet: FacetName; fact: AnyFact }[] {
  return [
    ...listFacts(pack.facets).map((entry) => ({ scope: pack.code, ...entry })),
    ...pack.regions.flatMap((region) => listFacts(region.facets).map((entry) => ({ scope: region.code, ...entry }))),
  ];
}

/** Percentages as integer hundred-thousandths, so rate arithmetic in tests is exact. */
const units = (rate: string): number => Math.round(Number(rate) * 100_000);

test('the pack file validates without a single problem and is served as an enabled v2 pack', () => {
  assert.deepEqual(packProblems(RAW).problems, []);
  const pack = us();
  assert.equal(pack.schemaVersion, 2);
  assert.equal(pack.enabled, true);
  assert.ok(enabledPacks().some((p) => p.code === 'US'));
  assert.equal(getCountry('US')?.pack, true, 'the country dataset flags US as having a pack');
  assert.equal(getCountryPack('us'), pack, 'the contributed pack replaces the generic profile');
  assert.equal(pack.defaultLocale, 'en');
  assert.ok(pack.locales.includes('en'));
});

test('regions: the 50 states, the District of Columbia and the six ISO 3166-2 outlying areas, with the right kinds', () => {
  const pack = us();
  const byKind = (kind: string) => pack.regions.filter((r) => r.kind === kind).map((r) => r.code.slice(3)).sort();
  assert.deepEqual(byKind('state'), [...STATES].sort());
  assert.deepEqual(byKind('district'), ['DC']);
  assert.deepEqual(byKind('territory'), [...TERRITORIES].sort());
  assert.equal(pack.regions.length, 57);
  for (const region of pack.regions) {
    assert.match(region.code, /^US-[A-Z]{2}$/);
    assert.equal(isRestricted(region.code), false);
    assert.ok(region.name.en, `${region.code} has an English name`);
    assert.equal(region.parent, undefined, 'no invented sub-state codes');
  }
  assert.equal(regionName(pack, 'US-CA', 'en'), 'California');
  assert.equal(regionName(pack, 'US-DC', 'en'), 'District of Columbia');
  assert.equal(regionName(pack, 'US-CA', 'ka'), 'California', 'other languages fall back to the English name');
});

test('a US visitor gets en-US formats, USD and the state list (no hard-coded country in the app)', () => {
  // The app resolves the visitor's country with getCountryPack and reads currency, regions and labels from it (apps/web/app/_lib/country.ts).
  const pack = getCountryPack('US');
  assert.ok(pack);
  assert.equal(pack.currency.code, 'USD');
  const codes = pack.regions.map((r) => r.code);
  assert.equal(codes.length, 57);
  assert.equal(codes[0], 'US-AL');
  assert.ok(codes.includes('US-CA') && codes.includes('US-PR'));
  assert.equal(regionName(pack, 'US-CA', 'en'), 'California');
  assert.equal(pack.registrationIdentifier.label.en, 'EIN (Employer Identification Number)');
  assert.equal(intlTagFor('en', 'US'), 'en-US');
  assert.equal(new Intl.DateTimeFormat(intlTagFor('en', 'US'), { timeZone: 'UTC' }).format(new Date('2026-07-04T00:00:00Z')), '7/4/2026');
  assert.equal(formatMoney('123456', 'USD', 'en-US'), '$1,234.56');
  assert.equal(countryName('US', 'en'), 'United States');
  assert.equal(countryName('US', 'es'), 'Estados Unidos');
  assert.equal(negotiate(null, us(), true), 'en', 'a visitor who chose the United States gets English');
  assert.equal(negotiate('es-US,es;q=0.9', us(), true), 'en', 'Spanish is offered once LANG-ES adds it; until then English');
});

test('formats: +1 and ten digits, ZIP or ZIP+4, a second address line, USD with cents', () => {
  const pack = us();
  assert.equal(pack.formats.phone.callingCode, '+1');
  assert.equal(pack.formats.phone.nationalLength, 10);
  assert.match(pack.formats.phone.example, /^\+1 \d{3} 555 01\d{2}$/, 'the example uses the reserved fictitious 555-01XX range');
  const zip = new RegExp(pack.formats.postalCode.pattern);
  for (const ok of ['92101', '92101-1234', '00501']) assert.ok(zip.test(ok), ok);
  for (const bad of ['9210', '921011', '92101-123', '92101 1234', 'ABCDE']) assert.equal(zip.test(bad), false, bad);
  assert.deepEqual(pack.address.lines, ['street', 'street2', 'city', 'region', 'postalCode']);
  assert.equal(pack.address.cityFirst, false);
  assert.deepEqual(pack.currency, { code: 'USD', minorUnitDigits: 2, displayFractionDigits: 2, symbol: '$' });
});

test('time zones: every IANA zone of the states and territories, and each region lists its own', () => {
  const pack = us();
  assert.ok(pack.timeZones.length >= 30);
  for (const zone of pack.timeZones) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }), zone);
  for (const region of pack.regions) {
    assert.ok(region.timeZones?.length, `${region.code} lists its time zones`);
    for (const zone of region.timeZones ?? []) assert.ok(pack.timeZones.includes(zone), `${region.code}: ${zone}`);
  }
  assert.deepEqual(packTimeZones(pack, 'US-CA'), ['America/Los_Angeles'], 'the San Diego reference hub is on Pacific time');
  assert.deepEqual(packTimeZones(pack, 'US-HI'), ['Pacific/Honolulu']);
  assert.ok(packTimeZones(pack, 'US-AZ').includes('America/Phoenix'));
  assert.equal(packTimeZones(pack, 'US-AK').length, 7);
  assert.ok(packTimeZones(pack, 'US-TX').includes('America/Denver'), 'El Paso is on Mountain time');
  assert.ok(packTimeZones(pack, 'US-FL').includes('America/Chicago'), 'the Florida panhandle is on Central time');
  assert.deepEqual(packTimeZones(pack), pack.timeZones);
});

test('identifiers: EIN with IRS prefixes, SAM.gov UEI, California entity and CSLB licence numbers, Arizona ROC numbers', () => {
  const pack = us();
  for (const ok of ['12-3456789', '123456789', '01-0000001', '27-1234567', '99-7654321', '20-1234567']) assert.ok(validateIdentifier(pack, ok), ok);
  for (const bad of ['00-1234567', '07-1234567', '17-1234567', '28-1234567', '49-1234567', '69-1234567', '70-1234567', '78-1234567', '89-1234567', '96-1234567', '97-1234567', '12-345678', '12-34567890', '12 3456789']) {
    assert.equal(validateIdentifier(pack, bad), false, bad);
  }
  assert.ok(validateIdentifier(pack, 'A1B2C3D4E5F6', 'US-UEI'));
  assert.ok(validateIdentifier(pack, 'a1b2c3d4e5f6', 'US-UEI'), 'the UEI is not case sensitive');
  for (const bad of ['01B2C3D4E5F6', 'I1B2C3D4E5F6', 'A1B2C3D4E5O6', 'A1B2C3D4E5F', 'A1B2C3D4E5F67']) assert.equal(validateIdentifier(pack, bad, 'US-UEI'), false, bad);
  for (const ok of ['C1234567', '201912345678', 'B20260000001']) assert.ok(validateIdentifier(pack, ok, 'US-CA-SOS'), ok);
  for (const bad of ['C123456', '20191234567', 'X1234567']) assert.equal(validateIdentifier(pack, bad, 'US-CA-SOS'), false, bad);
  assert.ok(validateIdentifier(pack, '1000000', 'US-CA-CSLB'));
  assert.equal(validateIdentifier(pack, '123456789', 'US-CA-CSLB'), false, 'CSLB numbers have at most 8 digits');
  assert.equal(validateIdentifier(pack, 'B123456', 'US-CA-CSLB'), false, 'CSLB numbers have no letters');
  assert.ok(validateIdentifier(pack, '000123', 'US-AZ-ROC'));
  assert.equal(validateIdentifier(pack, '12345', 'US-AZ-ROC'), false);

  const inCalifornia = identifierKinds(pack, 'US-CA').map((k) => k.kind);
  assert.deepEqual(inCalifornia, ['US-EIN', 'US-UEI', 'US-CA-SOS', 'US-CA-CSLB']);
  assert.ok(!identifierKinds(pack, 'US-NV').some((k) => k.kind.startsWith('US-CA-')), 'California kinds do not leak into Nevada');
  assert.equal(findIdentifierKind(pack, 'US-CA-CSLB')?.scope, 'US-CA');
  assert.equal(pack.registrationIdentifier.verificationLevel, 'official');
});

test('legal entity forms: sole proprietorship, partnership, LLC, C and S corporations, nonprofit', () => {
  assert.deepEqual(us().legalEntityTypes.map((t) => t.code), ['sole-proprietorship', 'partnership', 'llc', 'c-corporation', 's-corporation', 'nonprofit-corporation']);
});

test('every fact cites dated sources, carries a level, and unverified facts say what is missing', () => {
  const pack = us();
  const facts = allFacts(pack);
  assert.ok(facts.length > 120, `${facts.length} facts`);
  const today = new Date().toISOString().slice(0, 10);
  const sources = [...pack.sources, ...pack.registrationIdentifier.sources, ...pack.dataResidency.sources, ...facts.flatMap(({ fact }) => fact.sources)];
  for (const source of sources) {
    assert.match(source.url, /^https:\/\//, source.url);
    assert.doesNotMatch(source.url, /example\.(invalid|com|org)/, source.url);
    assert.ok(source.accessed >= '2026-10-01' && source.accessed <= today, `${source.url} accessed ${source.accessed}`);
  }
  for (const { scope, facet, fact } of facts) {
    const at = `${scope} ${facet}/${fact.id}`;
    assert.ok(fact.sources.length > 0, at);
    if (fact.verification !== 'official') assert.ok(fact.verificationNote, `${at}: a ${fact.verification} fact says what is unconfirmed`);
    if (facet === 'agentLaw') {
      assert.notEqual(fact.verification, 'official', `${at}: agent-law defaults stay below official until counsel review`);
      assert.equal((fact as { counselReview: string }).counselReview, 'pending', at);
    }
  }
  const levels = new Set(facts.map(({ fact }) => fact.verification));
  for (const level of ['official', 'secondary', 'candidate', 'pending'] as const) assert.ok(levels.has(level), `the pack uses the ${level} level honestly`);
  assert.equal(pack.dataResidency.required, false);
});

test('California in depth: CSLB classes, bond, workers compensation, registers and the CCPA', () => {
  const pack = us();
  const licensing = factsFor(pack, 'licensing', 'US-CA').map((f) => f.fact);
  const cslb = licensing.find((f) => f.id === 'contractor-licensing-board');
  assert.ok(cslb && cslb.type === 'activity');
  assert.equal(cslb.verification, 'official');
  assert.equal(cslb.identifierKind, 'US-CA-CSLB');
  const classes = cslb.categories?.map((c) => c.code) ?? [];
  assert.equal(classes.length, 46);
  for (const code of ['A', 'B', 'B-2', 'C-10', 'C-36', 'C-39', 'C-46', 'C-61']) assert.ok(classes.includes(code), code);
  assert.match(cslb.verificationNote ?? '', /\$1,000/);
  const insurance = licensing.filter((f) => f.type === 'insurance');
  assert.deepEqual(insurance.map((f) => f.id).sort(), ['ca-contractor-bond', 'ca-workers-compensation']);
  assert.ok(insurance.every((f) => f.type === 'insurance' && f.mandatory));
  assert.deepEqual(factsFor(pack, 'registers', 'US-CA').map((f) => f.fact.id), ['sam-entity-registrations', 'irs-exempt-organizations', 'ca-bizfile', 'ca-cslb-license-check', 'ca-cslb-public-data', 'sd-city-development-permits']);

  const ccpa = factsFor(pack, 'privacy', 'US-CA').find((f) => f.fact.id === 'consumer-privacy-law')?.fact;
  assert.ok(ccpa && ccpa.type === 'law');
  assert.equal(ccpa.subjectRequestDays, 45);
  assert.equal(ccpa.minorsAge, 16);
  assert.equal(ccpa.consent, 'opt-out');
  assert.equal(ccpa.verification, 'official');
  assert.match(ccpa.appliesWhen?.en ?? '', /26,625,000/);
  assert.ok(factsFor(pack, 'privacy', 'US-CA').some((f) => f.fact.id === 'coppa'), 'federal COPPA also holds in California');
});

test('California sales tax and the San Diego County district tax are dated facts that add up to the CDTFA rate', () => {
  const pack = us();
  const tax = factsFor(pack, 'tax', 'US-CA').map((f) => f.fact);
  const state = tax.find((f) => f.id === 'state-sales-tax');
  const district = tax.find((f) => f.id === 'sd-county-district-tax');
  assert.ok(state?.type === 'rate' && district?.type === 'rate');
  assert.equal(state.standardRate, '7.25');
  assert.equal(state.localRates, 'additive');
  assert.equal(state.calculation, 'adapter', 'the engine never computes local US sales tax itself');
  assert.ok(state.candidateAdapters?.length && !state.adapter, 'no tax adapter exists yet; it is named as a candidate');
  assert.equal(state.effectiveFrom, '2017-01-01');
  assert.equal(district.standardRate, '0.5');
  assert.equal(district.effectiveFrom, '1988-04-01');
  assert.equal(district.effectiveTo, '2048-03-31');
  assert.equal(units(state.standardRate!) + units(district.standardRate!), units('7.75'), 'CDTFA lists 7.75% for the City of San Diego on 2026-10-01');
  assert.ok(district.sources.some((s) => s.url.endsWith('cdtfa823.pdf')));
  assert.match(district.verificationNote ?? '', /San Diego County/);
  assert.ok(!factsFor(pack, 'tax', 'US-NV').some((f) => f.fact.id.startsWith('sd-')), 'San Diego facts never reach another state');
});

test('San Diego permitting is recorded as a candidate source, never as a confirmed rule', () => {
  const pack = us();
  const sanDiego = allFacts(pack).filter(({ fact }) => fact.id.startsWith('sd-') && fact.id !== 'sd-county-district-tax');
  assert.deepEqual(sanDiego.map(({ fact }) => fact.id).sort(), ['sd-city-building-permit', 'sd-city-development-permits', 'sd-county-building-permit']);
  for (const { scope, fact } of sanDiego) {
    assert.equal(scope, 'US-CA');
    assert.equal(fact.verification, 'candidate');
    assert.match(fact.verificationNote ?? '', /Scope:/);
  }
});

test('sales tax: every state, DC and Puerto Rico state their treatment; the five states without one say so', () => {
  const pack = us();
  for (const code of [...STATES, 'DC', 'PR']) {
    const fact = factsFor(pack, 'tax', `US-${code}`).find((f) => f.fact.id === 'state-sales-tax');
    assert.ok(fact && fact.scope === `US-${code}` && fact.fact.type === 'rate', code);
    const rate = fact.fact;
    if (rate.type !== 'rate') continue;
    if (rate.standardRate !== null) assert.match(rate.standardRate, /^\d{1,2}(\.\d{1,4})?$/, code);
    if (rate.localRates === 'additive') assert.equal(rate.calculation, 'adapter', `${code}: local rates come from an adapter`);
  }
  const without = [...STATES, 'DC'].filter((code) => factsFor(pack, 'tax', `US-${code}`).find((f) => f.fact.id === 'state-sales-tax')?.fact.type === 'rate' && (factsFor(pack, 'tax', `US-${code}`).find((f) => f.fact.id === 'state-sales-tax')!.fact as { standardRate: string | null }).standardRate === null);
  assert.deepEqual(without.sort(), ['AK', 'DE', 'MT', 'NH', 'OR']);
  const rateOf = (code: string) => (factsFor(pack, 'tax', `US-${code}`).find((f) => f.fact.id === 'state-sales-tax')!.fact as { standardRate: string | null }).standardRate;
  assert.equal(rateOf('NJ'), '6.625');
  assert.equal(rateOf('MO'), '4.225');
  assert.equal(rateOf('MN'), '6.875');
  assert.equal(rateOf('TX'), '6.25');
  assert.equal(factsFor(pack, 'tax').length, 0, 'there is no national sales tax fact to inherit by mistake');
});

test('federal holidays follow 5 U.S.C. 6103 with the Saturday-to-Friday and Sunday-to-Monday observance', () => {
  const pack = us();
  const year = (y: number, region?: string) => holidaysInYear(pack, y, region).map((h) => [h.id, h.date, h.observed]);
  assert.deepEqual(year(2026), [
    ['new-years-day', '2026-01-01', '2026-01-01'],
    ['martin-luther-king-jr-day', '2026-01-19', '2026-01-19'],
    ['washingtons-birthday', '2026-02-16', '2026-02-16'],
    ['memorial-day', '2026-05-25', '2026-05-25'],
    ['juneteenth', '2026-06-19', '2026-06-19'],
    ['independence-day', '2026-07-04', '2026-07-03'],
    ['labor-day', '2026-09-07', '2026-09-07'],
    ['columbus-day', '2026-10-12', '2026-10-12'],
    ['veterans-day', '2026-11-11', '2026-11-11'],
    ['thanksgiving-day', '2026-11-26', '2026-11-26'],
    ['christmas-day', '2026-12-25', '2026-12-25'],
  ]);
  const y2027 = new Map(holidaysInYear(pack, 2027).map((h) => [h.id, h.observed]));
  assert.equal(y2027.get('juneteenth'), '2027-06-18');
  assert.equal(y2027.get('independence-day'), '2027-07-05');
  assert.equal(y2027.get('christmas-day'), '2027-12-24');
  assert.equal(holidaysInYear(pack, 2022).find((h) => h.id === 'new-years-day')?.observed, '2021-12-31', 'a Saturday New Year is observed the Friday before');
  assert.ok(!holidaysInYear(pack, 2020).some((h) => h.id === 'juneteenth'), 'Juneteenth is a federal holiday from 2021');
  assert.deepEqual(workingWeek(pack), { days: ['mon', 'tue', 'wed', 'thu', 'fri'], stated: true });
});

test('California adds its state holidays (CalHR), and they stay in California', () => {
  const pack = us();
  const ca2026 = holidaysInYear(pack, 2026, 'US-CA');
  assert.equal(ca2026.length, 13);
  assert.deepEqual(ca2026.filter((h) => h.scope === 'US-CA').map((h) => [h.id, h.date, h.observed]), [
    ['cesar-chavez-day', '2026-03-31', '2026-03-31'],
    ['day-after-thanksgiving', '2026-11-27', '2026-11-27'],
  ]);
  assert.equal(holidaysInYear(pack, 2024, 'US-CA').find((h) => h.id === 'cesar-chavez-day')?.observed, '2024-04-01', 'a Sunday state holiday moves to Monday');
  for (const y of [2026, 2027, 2028, 2029, 2030]) {
    const days = holidaysInYear(pack, y, 'US-CA');
    const thanksgiving = days.find((h) => h.id === 'thanksgiving-day')!.date;
    const after = new Date(`${thanksgiving}T00:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 1);
    assert.equal(days.find((h) => h.id === 'day-after-thanksgiving')?.date, after.toISOString().slice(0, 10), `${y}`);
  }
  assert.equal(holidaysInYear(pack, 2026, 'US-NV').length, 11, 'no California holiday in Nevada');
});

test('state privacy laws: dated, sourced, and future laws carry their future effective date', () => {
  const pack = us();
  const laws = pack.regions.flatMap((r) => factsFor(pack, 'privacy', r.code).filter((f) => f.scope === r.code && f.fact.id === 'consumer-privacy-law'));
  assert.ok(laws.length >= 23, `${laws.length} state privacy laws`);
  for (const { scope, fact } of laws) {
    assert.ok(fact.effectiveFrom, `${scope} has an effective date`);
    assert.ok(fact.sources.length > 0);
  }
  const effective = (code: string) => laws.find((l) => l.scope === code)?.fact.effectiveFrom;
  assert.equal(effective('US-VA'), '2023-01-01');
  assert.equal(effective('US-TX'), '2024-07-01');
  assert.equal(effective('US-VT'), '2028-01-01');
  assert.equal(laws.find((l) => l.scope === 'US-VA')?.fact.type === 'law' && (laws.find((l) => l.scope === 'US-VA')!.fact as { subjectRequestDays?: number }).subjectRequestDays, 45);
});

test('national facets: SAM.gov and FAR thresholds, ESIGN and UETA, card, ACH and instant rails, US customary units, sanctions lists', () => {
  const pack = us();
  const ids = (facet: FacetName) => factsFor(pack, facet).map((f) => f.fact.id);
  assert.deepEqual(ids('procurement'), ['sam-gov', 'far-simplified-acquisition-threshold', 'far-micro-purchase-threshold']);
  const sat = factsFor(pack, 'procurement').find((f) => f.fact.id === 'far-simplified-acquisition-threshold')!.fact;
  assert.ok(sat.type === 'threshold');
  assert.deepEqual(sat.amount, { minorUnits: '35000000', currency: 'USD' });
  assert.equal(sat.effectiveFrom, '2025-10-01');
  assert.deepEqual(ids('eSignature'), ['esign-act', 'ueta']);
  const rails = new Set(factsFor(pack, 'payments').flatMap(({ fact }) => (fact.type === 'scheme' ? fact.rails : [])));
  for (const rail of ['card', 'credit-transfer', 'direct-debit', 'instant-credit-transfer'] as const) assert.ok(rails.has(rail), rail);
  const system = factsFor(pack, 'units').find((f) => f.fact.type === 'system')!.fact;
  assert.ok(system.type === 'system' && system.system === 'us-customary');
  for (const unit of ['ft', 'ft2', 'yd3', 'bdft', 'sq', 'lb']) assert.ok(system.common.includes(unit as never), unit);
  const csl = factsFor(pack, 'sanctions').find((f) => f.fact.id === 'consolidated-screening-list')!.fact;
  assert.deepEqual(csl.adapter, { capability: 'sanctions_list', id: 'us-consolidated-screening-list' }, 'the only adapter reference is one that exists in the engine');
  for (const { fact } of allFacts(pack)) if ('adapter' in fact && fact.adapter) assert.equal(fact.adapter.id, 'us-consolidated-screening-list');
});

test('restricted places stay excluded: no region, fact or text re-enables one', () => {
  const pack = us();
  const restrictedCodes = RESTRICTED.places.map((p) => p.code);
  for (const region of pack.regions) assert.ok(!restrictedCodes.includes(region.code));
  const regionLike = JSON.stringify(pack).match(/"(?:code|parent|scope)":"([A-Z]{2}(?:-[A-Z0-9]{1,3})?)"/g) ?? [];
  for (const match of regionLike) assert.equal(isRestricted(match.split(':')[1]!.replaceAll('"', '')), false, match);
  const tampered = structuredClone(RAW) as { regions: unknown[] };
  tampered.regions.push({ code: 'UA-43', name: { en: 'Crimea' }, kind: 'region' });
  assert.ok(packProblems(tampered).problems.some((p) => /restricted/.test(p)), 'a restricted region is refused even inside the US pack file');
});

/** Source files of the engine (apps and packages), excluding tests, build output and dependencies. */
function engineSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (['node_modules', '.next', '.next-e2e', 'dist', 'fixtures', 'locales'].includes(name) || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return engineSources(path);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.(test|spec)\./.test(name) ? [path] : [];
  });
}

test('no engine code branches on the United States', () => {
  const branch = /(?:===|!==|==|!=)\s*['"`]US(?:-[A-Z0-9]{1,3})?['"`]|['"`]US(?:-[A-Z0-9]{1,3})?['"`]\s*(?:===|!==|==|!=)|case\s+['"`]US(?:-[A-Z0-9]{1,3})?['"`]/;
  const offenders = [...engineSources('apps'), ...engineSources('packages')].filter((file) => branch.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
