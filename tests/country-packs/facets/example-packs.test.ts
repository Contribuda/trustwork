import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  RESTRICTED,
  VERIFICATION_LEVELS,
  factsFor,
  getPack,
  holidaysInYear,
  identifierKinds,
  isRestricted,
  listFacts,
  packProblems,
  type AnyFact,
  type CountryPack,
  type FacetName,
} from '@trustwork/country-packs';

/**
 * CTRY-003: sourced v2 facts for the four example packs (Uzbekistan, Georgia, Armenia, Azerbaijan). These tests hold the
 * acceptance criteria: every pack validates as v2, every fact cites a source and labels anything short of official,
 * official facts cite a primary (government or statutory) page, adapters are only candidates, and no Russian provider
 * or payment rail appears anywhere in a pack.
 */

const FILES = ['uz', 'ge', 'am', 'az'] as const;
const raw = (file: string): Record<string, unknown> => JSON.parse(readFileSync(`packages/country-packs/packs/${file}.json`, 'utf8')) as Record<string, unknown>;
const served = (file: string): CountryPack => {
  const pack = getPack(file);
  assert.ok(pack, `${file} is loaded`);
  return pack;
};

/** Every fact of a pack with its scope, country first. */
function allFacts(pack: CountryPack): { scope: string; facet: FacetName; fact: AnyFact }[] {
  return [
    ...listFacts(pack.facets).map((entry) => ({ scope: pack.code, ...entry })),
    ...pack.regions.flatMap((region) => listFacts(region.facets).map((entry) => ({ scope: region.code, ...entry }))),
  ];
}

/** Hosts of primary sources: legal databases, ministries, central banks, registers and official portals of the four countries. */
const PRIMARY_HOSTS = [
  'lex.uz',
  'xarid.uzex.uz',
  'matsne.gov.ge',
  'nbg.gov.ge',
  'enreg.reestri.gov.ge',
  'tenders.procurement.gov.ge',
  'www.arlis.am',
  'old.cba.am',
  'www.armeps.am',
  'e-qanun.az',
  'taxes.gov.az',
  'www.taxes.gov.az',
  'www.cbar.az',
];
const host = (url: string): string => new URL(url).hostname;

/**
 * Russian providers and payment rails the engine must never depend on (owner decision: Russia is not a market).
 * Names are matched as whole words with Unicode letter boundaries (so place names such as Kurdamir never match). Also refused: Russian top-level domains and RUB.
 */
const RUSSIAN_PROVIDER_LATIN = /(?<![\p{L}\p{N}])(?:sberbank|sber|vtb|tinkoff|t-bank|yandex|yoomoney|yumoney|qiwi|webmoney|mir|nspk|sbp|gazprombank|alfa-?bank|kontur|cryptopro|crypto-pro|rostelecom|gosuslugi)(?![\p{L}\p{N}])/iu;
const RUSSIAN_PROVIDER_CYRILLIC = /(?<!\p{L})(?:сбер\p{L}*|втб|тинькофф|т-банк|яндекс\p{L}*|юmoney|юмани|киви|мир|нспк|сбп|газпромбанк|альфа-банк|контур|криптопро|ростелеком|госуслуги)(?!\p{L})/iu;
const RUSSIAN_TLD = /\.(?:ru|su|xn--p1ai)$/i;

function russianProviderMentions(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const found: string[] = [];
    if (RUSSIAN_PROVIDER_LATIN.test(value) || RUSSIAN_PROVIDER_CYRILLIC.test(value)) found.push(`${path}: ${value}`);
    if (/^https?:\/\//.test(value) && RUSSIAN_TLD.test(host(value))) found.push(`${path}: Russian domain ${value}`);
    if (value === 'RUB') found.push(`${path}: RUB`);
    return found;
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => russianProviderMentions(item, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => russianProviderMentions(item, `${path}.${key}`));
  return [];
}

test('all four example packs are v2 files that validate without a single problem and are served as v2', () => {
  for (const file of FILES) {
    const file_ = raw(file);
    assert.equal(file_.schemaVersion, 2, `${file}.json is v2`);
    assert.deepEqual(packProblems(file_).problems, [], file);
    const pack = served(file);
    assert.equal(pack.schemaVersion, 2);
    assert.deepEqual(pack.timeZones, [pack.formats.timeZone], `${file}: one IANA zone`);
    assert.ok(allFacts(pack).length >= 10, `${file}: carries v2 facts`);
  }
});

test('every fact cites a dated source; anything short of official says why; official facts cite a primary source', () => {
  for (const file of FILES) {
    const pack = served(file);
    for (const { scope, facet, fact } of allFacts(pack)) {
      const at = `${scope} ${facet}/${fact.id}`;
      assert.ok(fact.sources.length >= 1, `${at}: no source`);
      assert.ok((VERIFICATION_LEVELS as readonly string[]).includes(fact.verification), `${at}: level`);
      for (const source of fact.sources) {
        assert.match(source.url, /^https:\/\//, `${at}: https source`);
        assert.ok(source.accessed >= '2026-10-31', `${at}: retrieved for CTRY-003 (${source.accessed})`);
        assert.ok(source.what.length > 10, `${at}: says what the source shows`);
      }
      if (fact.verification !== 'official') assert.ok(fact.verificationNote, `${at}: ${fact.verification} fact needs a note saying what is unconfirmed`);
      else assert.ok(fact.sources.some((s) => PRIMARY_HOSTS.includes(host(s.url))), `${at}: official fact without a primary source (${fact.sources.map((s) => host(s.url)).join(', ')})`);
      if (fact.verification === 'official') {
        for (const s of fact.sources) assert.doesNotMatch(s.url, /wikipedia|lookuptax|trykintsugi|calendarific/, `${at}: official fact rests on ${s.url}`);
      }
    }
  }
});

test('the facets the package covers are present: registers, VAT, e-invoicing, e-signature, payments and holidays', () => {
  for (const file of FILES) {
    const pack = served(file);
    const of = <F extends FacetName>(facet: F) => factsFor(pack, facet).map((e) => e.fact);
    assert.ok(of('registers').length >= 1, `${file}: a register`);
    const vat = of('tax').find((f) => f.type === 'rate' && f.taxKind === 'vat');
    assert.ok(vat && vat.type === 'rate' && vat.standardRate !== null && /^\d+$/.test(vat.standardRate), `${file}: VAT standard rate as a decimal string`);
    assert.ok(of('tax').some((f) => f.type === 'e-invoicing'), `${file}: e-invoicing`);
    assert.ok(of('eSignature').length >= 1, `${file}: e-signature`);
    assert.ok(of('payments').some((f) => f.type === 'scheme' && f.rails.includes('card')), `${file}: a card scheme`);
    assert.ok(holidaysInYear(pack, 2026).filter((h) => h.nonWorking).length >= 9, `${file}: non-working holidays`);
    for (const kind of identifierKinds(pack)) assert.ok(kind.sources.length > 0, `${file}: ${kind.kind} sourced`);
  }
  const rate = (file: string) => {
    const vat = factsFor(served(file), 'tax').map((e) => e.fact).find((f) => f.type === 'rate' && f.taxKind === 'vat');
    return vat?.type === 'rate' ? vat : null;
  };
  assert.equal(rate('UZ')?.standardRate, '12');
  assert.equal(rate('GE')?.standardRate, '18');
  assert.equal(rate('AM')?.standardRate, '20');
  assert.equal(rate('AZ')?.standardRate, '18');
  assert.deepEqual(rate('GE')?.registrationThreshold, { minorUnits: '10000000', currency: 'GEL' }, 'Tax Code of Georgia art. 165: GEL 100 000');
  assert.deepEqual(rate('AZ')?.registrationThreshold, { minorUnits: '20000000', currency: 'AZN' }, 'Tax Code of Azerbaijan art. 155.1: AZN 200 000');
  assert.equal(rate('AM')?.registrationThreshold, null, 'the Armenian threshold is not recorded until confirmed');
  assert.equal(rate('AM')?.verification, 'secondary', 'the Armenian rate rests on a 2018 translation');
});

test('holidays come out of the calendar facts as the laws list them', () => {
  const nonWorking = (file: string, year: number) => holidaysInYear(served(file), year).filter((h) => h.nonWorking).map((h) => h.date);
  const uz = nonWorking('UZ', 2026);
  for (const date of ['2026-01-01', '2026-03-08', '2026-03-21', '2026-05-09', '2026-09-01', '2026-10-01', '2026-12-08', '2026-03-20', '2026-05-27']) assert.ok(uz.includes(date), `UZ ${date}`);
  const navruz = holidaysInYear(served('UZ'), 2026).find((h) => h.id === 'navruz');
  assert.equal(navruz?.observed, '2026-03-23', 'Labour Code art. 208: the Saturday holiday moves the rest day to Monday');

  const ge = nonWorking('GE', 2026);
  for (const date of ['2026-01-07', '2026-01-19', '2026-04-09', '2026-04-10', '2026-04-13', '2026-05-17', '2026-05-26', '2026-11-23']) assert.ok(ge.includes(date), `GE ${date}`);
  assert.equal(ge.length, 18, 'fourteen fixed holidays and four Easter days');
  assert.ok(!nonWorking('GE', 2027).includes('2027-04-10'), 'Easter dates are per year, never guessed');

  const am = nonWorking('AM', 2026);
  assert.deepEqual(am, ['2026-01-01', '2026-01-02', '2026-01-06', '2026-01-27', '2026-01-28', '2026-03-08', '2026-04-24', '2026-05-01', '2026-05-09', '2026-05-28', '2026-07-05', '2026-09-21', '2026-12-31'], 'Law HO-200 as in force from 24.07.2026');

  const az = holidaysInYear(served('AZ'), 2026);
  const azDay = (date: string) => az.find((h) => h.date === date);
  assert.equal(azDay('2026-11-08')?.nonWorking, true, 'Victory Day');
  assert.equal(azDay('2026-01-20')?.nonWorking, true, 'National Mourning Day is not a working day (art. 106)');
  for (const date of ['2026-09-20', '2026-10-18', '2026-11-12', '2026-11-17']) assert.equal(azDay(date)?.nonWorking, false, `AZ ${date} is a holiday but a working day`);
  assert.equal(azDay('2026-05-09')?.observed, '2026-05-11', 'art. 105.5: a Saturday holiday moves the rest day to the next working day');
});

test('adapters are named only as candidates: no pack fact references a live adapter or calls a register', () => {
  for (const file of FILES) {
    const pack = served(file);
    for (const { scope, facet, fact } of allFacts(pack)) {
      assert.equal('adapter' in fact && fact.adapter !== undefined, false, `${scope} ${facet}/${fact.id}: live adapter reference`);
      if ('candidateAdapters' in fact && fact.candidateAdapters) for (const name of fact.candidateAdapters) assert.equal(typeof name, 'string');
    }
    for (const register of factsFor(pack, 'registers').map((e) => e.fact)) assert.notEqual(register.query, 'api', `${file} ${register.id}: no API access was reviewed`);
  }
});

test('no Russian provider, payment rail, domain or currency appears in any of the four packs', () => {
  for (const file of FILES) assert.deepEqual(russianProviderMentions(raw(file)), [], file);
  // The scanner itself catches what it must (negative cases on a copy).
  const tainted = structuredClone(raw('am')) as { facets: { payments: Record<string, unknown>[] } };
  tainted.facets.payments.push({ type: 'scheme', id: 'mir', name: { en: 'Mir cards' }, rails: ['card'], sources: [{ url: 'https://www.nspk.ru/', what: 'operator', accessed: '2026-10-31' }], verification: 'candidate' });
  const found = russianProviderMentions(tainted);
  assert.ok(found.some((f) => f.includes('Mir cards')));
  assert.ok(found.some((f) => f.includes('Russian domain')));
  assert.ok(russianProviderMentions({ name: { ru: 'Карты Мир' } }).length === 1, 'Cyrillic name');
  assert.deepEqual(russianProviderMentions({ name: { ru: 'Мингячевир', en: 'Mirzo Ulugbek district', 'az-Latn': 'Kürdəmir' } }), [], 'no false positive on place names');
  assert.ok(russianProviderMentions({ currency: 'RUB' }).length === 1);
});

test('subdivisions stay consistent with the restricted list and carry no facts of their own', () => {
  const restrictedCodes = RESTRICTED.places.map((p) => p.code);
  for (const file of FILES) {
    const pack = served(file);
    for (const region of pack.regions) {
      assert.equal(isRestricted(region.code), false, region.code);
      assert.equal(region.facets, undefined, `${region.code}: CTRY-003 records country-level facts only`);
    }
    const text = JSON.stringify(pack.facets);
    for (const code of restrictedCodes) assert.doesNotMatch(text, new RegExp(`\\b${code}\\b`), `${file}: facets name restricted place ${code}`);
  }
  // A v2 example pack that tried to list a restricted subdivision is refused like any other.
  const bad = structuredClone(raw('ge')) as { regions: unknown[] };
  bad.regions.push({ code: 'GE-XX', name: { en: 'x', ka: 'x' }, kind: 'region', parent: 'RU-MOW' });
  assert.match(packProblems(bad).problems.join('; '), /restricted/);
});

test('a fact without a source or with an unknown level never validates (negative cases on a copy)', () => {
  const unsourced = structuredClone(raw('uz')) as { facets: { tax: { sources: unknown[] }[] } };
  unsourced.facets.tax[0]!.sources = [];
  assert.match(packProblems(unsourced).problems.join('; '), /at least one source/);
  const unlabelled = structuredClone(raw('az')) as { facets: { payments: { verification: string }[] } };
  unlabelled.facets.payments[0]!.verification = 'verified';
  assert.notDeepEqual(packProblems(unlabelled).problems, []);
  const live = structuredClone(raw('ge')) as { facets: { registers: Record<string, unknown>[] } };
  live.facets.registers[0]!.adapter = { capability: 'business-register', id: 'napr-live' };
  assert.notDeepEqual(packProblems(live).problems, [], 'an adapter that does not exist in the engine is refused');
});
