import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  enabledPacks, factsFor, formatMoney, getCountry, getCountryPack, getPack,
  holidaysInYear, identifierKinds, listFacts, packProblems, packTimeZones,
  regionName, validateIdentifier, type CountryPack,
} from '@trustwork/country-packs';
import { BUILT_IN_CLIENT_PACKS, getClientPack, toClientPack } from '@trustwork/country-packs/client';
import { intlTagFor } from '@trustwork/ui/i18n';
import { negotiate } from '../../../apps/web/app/_lib/locale-negotiation.js';
import raw from '../../../packages/country-packs/packs/ca.json' with { type: 'json' };

const canada = (): CountryPack => {
  const pack = getPack('CA');
  assert.ok(pack);
  return pack;
};
const allFacts = () => {
  const pack = canada();
  return [
    ...listFacts(pack.facets).map((entry) => ({ scope: pack.code, ...entry })),
    ...pack.regions.flatMap((region) => listFacts(region.facets).map((entry) => ({ scope: region.code, ...entry }))),
  ];
};

test('Canada validates as v2 and replaces the generic profile in the country registry', () => {
  assert.deepEqual(packProblems(raw).problems, []);
  const pack = canada();
  assert.equal(pack.schemaVersion, 2);
  assert.equal(pack.status, 'partial');
  assert.equal(getCountryPack('ca'), pack);
  assert.ok(getCountry('CA')?.pack);
  assert.ok(enabledPacks().includes(pack));
  assert.equal(pack.layers, undefined, 'Canada does not inherit the EU layer');
});

test('the browser receives Canadian formats and regions without server-only facts or sources', () => {
  const generated = BUILT_IN_CLIENT_PACKS.find((pack) => pack.code === 'CA');
  assert.ok(generated);
  assert.deepEqual(generated, toClientPack(canada()));
  assert.deepEqual(getClientPack('ca'), generated);
  assert.equal(generated.currency.code, 'CAD');
  assert.equal(generated.regions.length, 13);
  assert.equal(generated.registrationIdentifier.kind, 'CA-BN');
  const browserData = JSON.stringify(generated);
  for (const key of ['facets', 'sources', 'notes', 'verification', 'verificationNote', 'candidateAdapters', 'dataResidency', 'legalTemplates', 'timeZones']) {
    assert.ok(!browserData.includes(`"${key}"`), `client data carries ${key}`);
  }
  assert.doesNotMatch(browserData, /PIPEDA|HUB-005|gst-hst|canada\.ca/);
});

test('Canada offers exactly ten provinces and three territories through the generic helpers', () => {
  const pack = canada();
  const codes = (kind: string) => pack.regions.filter((r) => r.kind === kind).map((r) => r.code).sort();
  assert.deepEqual(codes('province'), ['CA-AB', 'CA-BC', 'CA-MB', 'CA-NB', 'CA-NL', 'CA-NS', 'CA-ON', 'CA-PE', 'CA-QC', 'CA-SK']);
  assert.deepEqual(codes('territory'), ['CA-NT', 'CA-NU', 'CA-YT']);
  assert.equal(pack.regions.length, 13);
  assert.equal(regionName(pack, 'CA-NL', 'en'), 'Newfoundland and Labrador');
  assert.equal(regionName(pack, 'CA-QC', 'en'), 'Quebec');
  for (const region of pack.regions) assert.equal(region.parent, undefined);
});

test('a Canadian visitor gets en-CA formats and CAD; French formatting is ready without claiming LANG-FR', () => {
  const pack = getCountryPack('CA');
  assert.ok(pack);
  assert.equal(pack.currency.code, 'CAD');
  assert.equal(pack.currency.minorUnitDigits, 2);
  assert.equal(pack.defaultLocale, 'en');
  assert.equal(negotiate('en-CA,en;q=0.9', pack, true), 'en');
  assert.equal(intlTagFor('en', pack.code), 'en-CA');
  assert.equal(intlTagFor('fr', pack.code), 'fr-CA');
  for (const locale of ['en-CA', 'fr-CA']) {
    assert.equal(formatMoney('123456', pack.currency.code, locale), new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(1234.56));
  }
  assert.deepEqual(pack.locales, ['en'], 'no missing French dictionary is advertised as implemented');
  assert.ok(pack.notes?.some((note) => note.includes('LANG-FR') && note.includes('Quebec')));
});

test('Canadian postal syntax excludes forbidden letters and requires the ANA NAN separator', () => {
  const pack = canada();
  const pattern = new RegExp(pack.formats.postalCode.pattern);
  for (const value of ['K1A 0B1', 'H2X 1Y4', 'X0A 0H0', 'V6B 1A1']) assert.ok(pattern.test(value), value);
  for (const value of ['K1A0B1', 'K1A-0B1', 'k1a 0b1', '12345', 'D1A 0B1', 'W1A 0B1', 'Z1A 0B1', 'K1O 0B1', 'K1A 0U1', 'K1A 0B11']) assert.equal(pattern.test(value), false, value);
  assert.equal(pack.formats.phone.callingCode, '+1');
  assert.equal(pack.formats.phone.nationalLength, 10);
  assert.match(pack.formats.phone.example, /^\+1 \d{3} 555 01\d{2}$/);
  assert.deepEqual(pack.address.lines, ['street', 'street2', 'city', 'region', 'postalCode']);
});

test('IANA zones preserve local exceptions and Newfoundland half-hour time', () => {
  const pack = canada();
  assert.equal(pack.timeZones.length, 23);
  assert.ok(pack.timeZones.includes(pack.formats.timeZone));
  for (const zone of pack.timeZones) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }));
  for (const region of pack.regions) {
    assert.ok(region.timeZones?.length);
    for (const zone of region.timeZones!) assert.ok(pack.timeZones.includes(zone));
  }
  assert.deepEqual(packTimeZones(pack, 'CA-NL'), ['America/St_Johns', 'America/Goose_Bay']);
  assert.ok(packTimeZones(pack, 'CA-NU').includes('America/Atikokan'), 'Coral Harbour exception');
  assert.ok(packTimeZones(pack, 'CA-QC').includes('America/Blanc-Sablon'), 'Lower North Shore exception');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/St_Johns', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  assert.equal(time.format(new Date('2026-01-15T12:00:00Z')), '08:30');
});

test('BN, CRA programs, federal corporation numbers and NEQ are distinct formats and scoped correctly', () => {
  const pack = canada();
  assert.ok(validateIdentifier(pack, '123456789'));
  for (const bad of ['12345678', '1234567890', '123 456 789', '123456789RT0001', 'ABCDEFGHI']) assert.equal(validateIdentifier(pack, bad), false, bad);
  assert.ok(validateIdentifier(pack, '123456789RP0002', 'CA-PROGRAM'));
  assert.ok(validateIdentifier(pack, '123456789RT0001', 'CA-GSTHST'));
  assert.equal(validateIdentifier(pack, '123456789RP0001', 'CA-GSTHST'), false);
  assert.equal(validateIdentifier(pack, '123456789RT001', 'CA-PROGRAM'), false);
  assert.equal(validateIdentifier(pack, '123456789rt0001', 'CA-PROGRAM'), false);
  assert.ok(validateIdentifier(pack, '1234567', 'CA-CORP'));
  assert.equal(validateIdentifier(pack, '123456789', 'CA-CORP'), false);
  assert.ok(validateIdentifier(pack, '1234567890', 'CA-QC-NEQ'));
  assert.equal(validateIdentifier(pack, '123456789', 'CA-QC-NEQ'), false);
  assert.ok(identifierKinds(pack, 'CA-QC').some((kind) => kind.kind === 'CA-QC-NEQ'));
  assert.ok(!identifierKinds(pack, 'CA-ON').some((kind) => kind.kind === 'CA-QC-NEQ'));
  assert.ok(!identifierKinds(pack).some((kind) => kind.kind === 'CA-QC-NEQ'));
});

test('GST/HST overrides prevent double GST while provincial taxes remain separate', () => {
  const pack = canada();
  const expected: Record<string, [string, string | null | undefined]> = {
    AB: ['5', null], BC: ['5', '7'], MB: ['5', '7'], NB: ['15', undefined], NL: ['15', undefined],
    NS: ['14', undefined], NT: ['5', null], NU: ['5', null], ON: ['13', undefined], PE: ['15', undefined],
    QC: ['5', '9.975'], SK: ['5', '6'], YT: ['5', null],
  };
  for (const [region, [gst, provincial]] of Object.entries(expected)) {
    const facts = factsFor(pack, 'tax', `CA-${region}`);
    const rates = facts.filter(({ fact }) => fact.type === 'rate');
    const combined = rates.filter(({ fact }) => fact.id === 'gst-hst');
    assert.equal(combined.length, 1, region);
    assert.equal(combined[0]?.scope, `CA-${region}`);
    assert.equal(combined[0]?.fact.type === 'rate' && combined[0].fact.standardRate, gst);
    const pst = rates.find(({ fact }) => fact.id === 'provincial-sales-tax')?.fact;
    assert.equal(pst?.type === 'rate' ? pst.standardRate : undefined, provincial, region);
    assert.equal(rates.length, provincial === undefined ? 1 : 2, region);
    for (const { fact } of rates) {
      assert.equal(fact.type === 'rate' && fact.calculation, 'adapter');
      assert.ok('candidateAdapters' in fact && fact.candidateAdapters?.length);
      assert.equal('adapter' in fact, false);
    }
  }
  const novaScotia = factsFor(pack, 'tax', 'CA-NS').find(({ fact }) => fact.id === 'gst-hst')?.fact;
  assert.equal(novaScotia?.effectiveFrom, '2025-04-01');
});

test('provincial privacy, licensing, registries and payment law never leak to another province', () => {
  const pack = canada();
  assert.ok(factsFor(pack, 'licensing', 'CA-QC').some(({ fact }) => fact.id === 'rbq-construction-licence'));
  assert.ok(!factsFor(pack, 'licensing', 'CA-ON').some(({ fact }) => fact.id === 'rbq-construction-licence'));
  for (const region of pack.regions) {
    assert.ok(factsFor(pack, 'licensing', region.code).some(({ fact, scope }) => fact.id === 'trade-certification' && scope === region.code));
  }
  for (const cc of ['AB', 'BC', 'QC']) {
    const privacy = factsFor(pack, 'privacy', `CA-${cc}`);
    assert.ok(privacy.some(({ fact }) => fact.id === 'pipeda'));
    assert.ok(privacy.some(({ fact, scope }) => fact.id === 'provincial-private-sector-privacy' && scope === `CA-${cc}`));
  }
  assert.ok(!factsFor(pack, 'privacy', 'CA-ON').some(({ fact }) => fact.id === 'provincial-private-sector-privacy'));
  assert.ok(!factsFor(pack, 'payments', 'CA-QC').some(({ fact }) => fact.id === 'ontario-prompt-payment'));
  const terms = factsFor(pack, 'payments', 'CA-ON').find(({ fact }) => fact.id === 'ontario-prompt-payment')?.fact;
  assert.ok(terms?.type === 'payment-terms');
  assert.equal(terms.verification, 'pending');
  assert.equal(terms.businessMaxDays, undefined, 'no unconditional deadline while application is unresolved');
});

test('published holiday dates do not imply universal site closures or guess future movable holidays', () => {
  const pack = canada();
  const days = holidaysInYear(pack, 2026);
  assert.equal(days.length, 10);
  assert.equal(days.find((d) => d.id === 'good-friday')?.date, '2026-04-03');
  assert.equal(days.find((d) => d.id === 'victoria-day')?.date, '2026-05-18');
  assert.equal(days.find((d) => d.id === 'thanksgiving')?.date, '2026-10-12');
  assert.ok(days.every((d) => !d.nonWorking && d.observed === d.date));
  assert.equal(holidaysInYear(pack, 2027).some((d) => ['good-friday', 'victoria-day'].includes(d.id)), false);
  assert.equal(holidaysInYear(pack, 2026, 'CA-QC').find((d) => d.id === 'quebec-national-holiday')?.date, '2026-06-24');
  assert.equal(holidaysInYear(pack, 2026, 'CA-AB').find((d) => d.id === 'family-day')?.date, '2026-02-16');
  assert.ok(!holidaysInYear(pack, 2026, 'CA-ON').some((d) => d.id === 'quebec-national-holiday'));
});

test('sourced thresholds are bounded by agreement, buyer type and effective period', () => {
  const thresholds = factsFor(canada(), 'procurement').flatMap(({ fact }) => fact.type === 'threshold' ? [fact] : []);
  assert.equal(thresholds.length, 2);
  assert.deepEqual(thresholds.map((f) => f.amount), [{ minorUnits: '13900000', currency: 'CAD' }, { minorUnits: '920000000', currency: 'CAD' }]);
  for (const threshold of thresholds) {
    assert.equal(threshold.effectiveFrom, '2026-01-01');
    assert.equal(threshold.effectiveTo, '2027-12-31');
    assert.match(threshold.summary.en!, /federal departments and agencies/);
  }
});

test('every fact has a dated primary source and honest levels; no adapter is activated', () => {
  const pack = canada();
  const facts = allFacts();
  const hosts = ['canada.ca', 'gc.ca', 'quebec.ca', 'gouv.qc.ca', 'ontario.ca', 'alberta.ca', 'red-seal.ca', 'engineerscanada.ca', 'roac.ca', 'csagroup.org', 'interac.ca', 'payments.ca', 'iana.org', 'doi.org', 'cnac.ca', 'canadapost-postescanada.ca', 'princeedwardisland.ca'];
  assert.ok(facts.length >= 80);
  for (const source of [...pack.sources, ...pack.registrationIdentifier.sources, ...pack.dataResidency.sources, ...facts.flatMap(({ fact }) => fact.sources)]) {
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)), url.hostname);
    assert.equal(source.accessed, '2026-11-01');
    assert.ok(source.what.length > 20);
  }
  for (const { scope, fact, facet } of facts) {
    const at = `${scope}/${facet}/${fact.id}`;
    assert.ok(fact.sources.length, at);
    if (fact.verification !== 'official') assert.ok(fact.verificationNote, at);
    assert.equal('adapter' in fact && fact.adapter !== undefined, false, at);
    if (facet === 'agentLaw') {
      assert.equal(fact.verification, 'pending');
      assert.equal('counselReview' in fact && fact.counselReview, 'pending');
    }
  }
  assert.equal(pack.dataResidency.required, false);
  assert.match(pack.dataResidency.note.en!, /not clearance/);
  const invoicing = factsFor(pack, 'tax').find(({ fact }) => fact.type === 'e-invoicing')?.fact;
  assert.equal(invoicing?.verification, 'pending');
  assert.match(invoicing?.verificationNote ?? '', /not legal conclusions/);
});

test('mutations cannot remove evidence, approve agent law or inject a restricted subdivision', () => {
  const unsourced = structuredClone(raw);
  unsourced.facets.tax[0]!.sources = [];
  assert.notDeepEqual(packProblems(unsourced).problems, []);
  const approved = structuredClone(raw);
  approved.facets.agentLaw[0]!.verification = 'official';
  assert.match(packProblems(approved).problems.join('; '), /counsel/);
  const restricted = structuredClone(raw);
  restricted.regions[0]!.code = 'UA-43';
  assert.match(packProblems(restricted).problems.join('; '), /restricted/);
});

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'fixtures', 'locales'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

test('Canada is data: no engine branches or Russian providers are introduced', () => {
  const branch = /(?:===|!==|==|!=)\s*['"`]CA(?:-[A-Z0-9]{1,3})?['"`]|['"`]CA(?:-[A-Z0-9]{1,3})?['"`]\s*(?:===|!==|==|!=)|case\s+['"`]CA(?:-[A-Z0-9]{1,3})?['"`]/;
  assert.deepEqual([...sources('apps'), ...sources('packages')].filter((path) => branch.test(readFileSync(path, 'utf8'))), []);
  const serialized = JSON.stringify(raw);
  assert.doesNotMatch(serialized, /(?<![\p{L}\p{N}])(?:sberbank|vtb|tinkoff|yandex|qiwi|yoomoney|nspk|mir|RUB)(?![\p{L}\p{N}])|https?:[^"\s]*\.(?:ru|su)(?:\/|\b)/iu);
});
