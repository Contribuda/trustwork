import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENGINE_ADAPTERS,
  FACET_NAMES,
  FacetsSchema,
  RESTRICTED,
  facetProblems,
  factsFor,
  findIdentifierKind,
  holidaysInYear,
  identifierKinds,
  isRestricted,
  listFacts,
  packProblems,
  packTimeZones,
  validateIdentifier,
  validatePack,
  workingWeek,
  type Facets,
} from '@trustwork/country-packs';
import { federalFixture } from './federal-fixture.js';

type Mutable = ReturnType<typeof federalFixture> & Record<string, unknown>;
const fixture = (): Mutable => federalFixture() as Mutable;
const problemsOf = (raw: unknown) => packProblems(raw).problems.join('\n');

test('a synthetic federal country with states, a district, a territory and a county validates as v2', () => {
  const pack = validatePack(federalFixture());
  assert.equal(pack.schemaVersion, 2);
  assert.deepEqual(
    pack.regions.map((r) => r.kind),
    ['state', 'municipality', 'state', 'district', 'territory'],
  );
  assert.deepEqual(pack.timeZones, ['America/New_York', 'America/Chicago', 'America/Denver', 'Pacific/Honolulu']);
  assert.deepEqual(packTimeZones(pack, 'XF-SO'), ['America/Chicago', 'America/Denver']);
  assert.deepEqual(packTimeZones(pack, 'XF-CD'), pack.timeZones, 'a subdivision without its own list uses the country list');
  assert.ok(pack.address.lines.includes('street2'));
  assert.ok(FACET_NAMES.every((facet) => listFacts(pack.facets).some((entry) => entry.facet === facet) || pack.regions.some((r) => listFacts(r.facets).some((e) => e.facet === facet))), 'the fixture exercises every facet');
});

test('per-state facts resolve along the subdivision chain and narrower facts override by id', () => {
  const pack = validatePack(federalFixture());
  const tax = (region?: string) => factsFor(pack, 'tax', region).map(({ scope, fact }) => [scope, fact.id, fact.type === 'rate' ? fact.standardRate : null]);
  assert.deepEqual(tax(), [['XF', 'xf-federal-vat', null]]);
  assert.deepEqual(tax('XF-NO'), [['XF', 'xf-federal-vat', null], ['XF-NO', 'xf-state-sales-tax', '6.25']]);
  assert.deepEqual(tax('XF-NOA'), [['XF', 'xf-federal-vat', null], ['XF-NO', 'xf-state-sales-tax', '6.25'], ['XF-NOA', 'xf-noa-local-sales-tax', '1.5']]);
  assert.deepEqual(tax('XF-SO'), [['XF', 'xf-federal-vat', null], ['XF-SO', 'xf-state-sales-tax', null]]);
  assert.equal(factsFor(pack, 'privacy', 'XF-NO').some(({ fact }) => fact.id === 'xf-no-consumer-privacy'), true);
  assert.equal(factsFor(pack, 'privacy', 'XF-SO').some(({ fact }) => fact.id === 'xf-no-consumer-privacy'), false, 'a state law does not leak into another state');
  assert.deepEqual(workingWeek(pack, 'XF-SO'), { days: ['mon', 'tue', 'wed', 'thu'], stated: true });
  assert.deepEqual(workingWeek(pack, 'XF-NO').days, ['mon', 'tue', 'wed', 'thu', 'fri']);
});

test('several identifier kinds per pack: national, procurement and state licence', () => {
  const pack = validatePack(federalFixture());
  assert.deepEqual(identifierKinds(pack).map((k) => [k.kind, k.role, k.primary]), [['XF-FTIN', 'registration', true], ['XF-UEI', 'procurement', false]]);
  assert.deepEqual(identifierKinds(pack, 'XF-NOA').map((k) => k.kind), ['XF-FTIN', 'XF-UEI', 'XF-NO-CLN']);
  assert.deepEqual(identifierKinds(pack, 'XF-SO').map((k) => k.kind), ['XF-FTIN', 'XF-UEI']);
  assert.equal(findIdentifierKind(pack, 'XF-NO-CLN')?.scope, 'XF-NO');
  assert.equal(validateIdentifier(pack, '12-3456789'), true);
  assert.equal(validateIdentifier(pack, 'ABCDEF123456', 'XF-UEI'), true);
  assert.equal(validateIdentifier(pack, '12-3456789', 'XF-UEI'), false);
  assert.equal(validateIdentifier(pack, '000123', 'XF-NO-CLN'), true);
  assert.equal(validateIdentifier(pack, '000123', 'XF-NOPE'), false, 'an unknown kind never validates');
});

test('holidays: fixed, nth and last weekday, published dates, observed-date rules and state holidays', () => {
  const pack = validatePack(federalFixture());
  const y2027 = holidaysInYear(pack, 2027, 'XF-NO');
  assert.deepEqual(
    y2027.map((h) => [h.id, h.date, h.observed]),
    [
      ['new-year', '2027-01-01', '2027-01-01'],
      ['founders-day', '2027-03-02', '2027-03-02'],
      ['remembrance-day', '2027-05-31', '2027-05-31'],
      ['labour-day', '2027-09-06', '2027-09-06'],
      ['moon-festival', '2027-09-15', '2027-09-15'],
      ['harvest-day', '2027-11-25', '2027-11-25'],
    ],
  );
  const y2028 = holidaysInYear(pack, 2028);
  assert.deepEqual(y2028.find((h) => h.id === 'new-year'), { id: 'new-year', scope: 'XF', name: { en: 'New Year' }, nonWorking: true, date: '2028-01-01', observed: '2027-12-31' }, 'Saturday is observed on Friday');
  assert.equal(y2028.some((h) => h.id === 'founders-day'), false, 'state holidays only in that state');
  assert.equal(holidaysInYear(pack, 2029).some((h) => h.id === 'moon-festival'), false, 'movable dates exist only where published');
});

test('every fact requires at least one source and a verification level', () => {
  const base = federalFixture();
  const located: { path: string; get: (raw: Mutable) => Record<string, unknown> }[] = [];
  for (const [facet, facts] of Object.entries(base.facets)) {
    facts.forEach((_, i) => located.push({ path: `facets.${facet}[${i}]`, get: (raw) => (raw.facets as Record<string, Record<string, unknown>[]>)[facet]![i]! }));
  }
  base.regions.forEach((region, r) => {
    for (const [facet, facts] of Object.entries((region as { facets?: Record<string, unknown[]> }).facets ?? {})) {
      facts.forEach((_, i) => located.push({ path: `regions[${r}].facets.${facet}[${i}]`, get: (raw) => ((raw.regions as { facets: Record<string, Record<string, unknown>[]> }[])[r]!.facets)[facet]![i]! }));
    }
  });
  assert.ok(located.length >= 30, `${located.length} facts checked`);
  for (const { path, get } of located) {
    for (const mutate of [
      (f: Record<string, unknown>) => delete f.sources,
      (f: Record<string, unknown>) => (f.sources = []),
      (f: Record<string, unknown>) => delete f.verification,
      (f: Record<string, unknown>) => (f.verification = 'verified'),
      (f: Record<string, unknown>) => (f.verification = 'Official'),
      (f: Record<string, unknown>) => (f.sources = [{ url: 'not a url', what: 'x', accessed: '2026-10-30' }]),
    ]) {
      const raw = fixture();
      mutate(get(raw));
      const { pack, problems } = packProblems(raw);
      assert.equal(pack, null, `${path} must be refused after ${mutate.toString()}`);
      assert.ok(problems.length > 0);
    }
  }
});

test('v2 requires verification levels on the v1 facts and v1 files cannot use v2 fields', () => {
  for (const drop of ['verificationLevel', 'registrationIdentifier.verificationLevel', 'dataResidency.verificationLevel']) {
    const raw = fixture();
    const [head, tail] = drop.split('.') as [string, string?];
    if (tail) delete (raw[head] as Record<string, unknown>)[tail];
    else delete (raw as Record<string, unknown>)[head];
    assert.match(problemsOf(raw), /verificationLevel is required in v2/, drop);
  }
  const v1 = fixture();
  delete (v1 as Record<string, unknown>).schemaVersion;
  const message = problemsOf(v1);
  assert.match(message, /facets needs "schemaVersion": 2/);
  assert.match(message, /timeZones needs "schemaVersion": 2/);
  assert.match(message, /region XF-NO: parent, timeZones and facets needs "schemaVersion": 2/);
  assert.match(problemsOf({ ...fixture(), schemaVersion: 3 }), /schemaVersion/);
});

test('rates are decimal strings between 0 and 100', () => {
  const setRate = (rate: unknown) => {
    const raw = fixture();
    (raw.regions[0]!.facets!.tax![0] as Record<string, unknown>).standardRate = rate;
    return packProblems(raw);
  };
  assert.equal(setRate('7').pack?.code, 'XF');
  assert.equal(setRate('0.125').pack?.code, 'XF');
  assert.equal(setRate('100').pack?.code, 'XF');
  for (const bad of [6.25, '6,25', '-1', '100.5', '106', '6.2500001', '', '1e2']) assert.equal(setRate(bad).pack, null, String(bad));
  const reduced = fixture();
  (reduced.regions[0]!.facets!.tax![0] as { reducedRates: unknown[] }).reducedRates = [{ rate: 5, appliesTo: { en: 'x' } }];
  assert.equal(packProblems(reduced).pack, null);
  const noAdapter = fixture();
  delete (noAdapter.regions[0]!.facets!.tax![0] as Record<string, unknown>).candidateAdapters;
  assert.match(problemsOf(noAdapter), /calculation "adapter" needs an adapter or candidateAdapters/);
});

test('referenced adapters must exist in the engine; candidates are only named', () => {
  const withAdapter = (adapter: unknown) => {
    const raw = fixture();
    (raw.facets.sanctions![0] as Record<string, unknown>).adapter = adapter;
    return raw;
  };
  assert.ok(ENGINE_ADAPTERS.some((a) => a.id === 'us-consolidated-screening-list'));
  assert.equal(packProblems(withAdapter({ capability: 'sanctions_list', id: 'us-consolidated-screening-list' })).pack?.code, 'XF');
  assert.match(problemsOf(withAdapter({ capability: 'sanctions_list', id: 'imaginary-list' })), /adapter sanctions_list\/imaginary-list does not exist in the engine/);
  assert.match(problemsOf(withAdapter({ capability: 'tax_calculation', id: 'us-consolidated-screening-list' })), /does not exist in the engine/, 'capability must match');
  assert.match(problemsOf(withAdapter({ capability: 'not_a_capability', id: 'us-consolidated-screening-list' })), /capability/);
  const taxAdapter = fixture();
  (taxAdapter.regions[0]!.facets!.tax![0] as Record<string, unknown>).adapter = { capability: 'tax_calculation', id: 'fake-tax' };
  assert.match(problemsOf(taxAdapter), /tax_calculation\/fake-tax does not exist/);
  const registry = [...ENGINE_ADAPTERS, { capability: 'tax_calculation' as const, id: 'fake-tax', module: 'test', withoutCredentials: 'fake' as const }];
  assert.equal(packProblems(taxAdapter, { adapters: registry }).pack?.code, 'XF', 'once the adapter exists in the registry the reference is accepted');
});

test('no pack can name or enable a restricted place', () => {
  for (const code of ['RU', 'CU', 'IR', 'KP']) {
    const raw = { ...fixture(), code, regions: [{ code: `${code}-AA`, name: { en: 'A' }, kind: 'state' }], registrationIdentifier: { ...fixture().registrationIdentifier, kind: `${code}-FTIN` }, facets: {} };
    assert.throws(() => validatePack(raw), /restricted/, code);
  }
  const ukraine = (regions: { code: string; name: { en: string }; kind: string; parent?: string }[]) => ({
    ...fixture(),
    code: 'UA',
    regions,
    registrationIdentifier: { ...fixture().registrationIdentifier, kind: 'UA-EDRPOU' },
    facets: {},
  });
  assert.equal(packProblems(ukraine([{ code: 'UA-30', name: { en: 'Kyiv' }, kind: 'city' }])).pack?.code, 'UA', 'government-controlled territory is allowed');
  for (const restricted of ['UA-43', 'UA-40', 'UA-14', 'UA-09']) {
    assert.match(problemsOf(ukraine([{ code: restricted, name: { en: 'x' }, kind: 'region' }])), new RegExp(`region ${restricted} is a restricted place`));
    assert.match(problemsOf(ukraine([{ code: 'UA-30', name: { en: 'Kyiv' }, kind: 'city', parent: restricted }])), /restricted place/);
  }
  const kind = fixture();
  kind.facets.identifiers![0]!.kind = 'XF-43-LIC';
  assert.match(problemsOf(kind), /must be XF-<NAME>/, 'a country-level kind cannot carry a subdivision part');
  for (const field of ['restricted', 'restrictedPlaces', 'enabledPlaces', 'allowRestricted']) {
    assert.equal(packProblems({ ...fixture(), [field]: [] }).pack, null, `${field} is not a pack field`);
    const facets = fixture();
    (facets.facets as Record<string, unknown>)[field] = [];
    assert.equal(packProblems(facets).pack, null, `${field} is not a facet`);
  }
  assert.deepEqual(RESTRICTED.places.map((p) => p.code), ['RU', 'UA-43', 'UA-40', 'UA-14', 'UA-09', 'CU', 'IR', 'KP'], 'the restricted list is unchanged by validation');
  assert.equal(isRestricted('UA-43'), true);
});

test('time zones are valid IANA zones and subdivisions use the pack list', () => {
  const bad = fixture();
  bad.timeZones = [...bad.timeZones, 'Mars/Olympus_Mons'];
  assert.match(problemsOf(bad), /Mars\/Olympus_Mons is not a valid IANA time zone/);
  const missing = fixture();
  missing.timeZones = ['America/New_York', 'America/Denver', 'Pacific/Honolulu'];
  assert.match(problemsOf(missing), /timeZones must include formats.timeZone America\/Chicago/);
  assert.match(problemsOf(missing), /region XF-NO: time zone America\/Chicago is not in the pack's timeZones/);
  const repeated = fixture();
  repeated.timeZones = [...repeated.timeZones, 'America/Chicago'];
  assert.match(problemsOf(repeated), /repeats a zone/);
});

test('subdivision hierarchy: parents exist and never form a cycle', () => {
  const orphan = fixture();
  orphan.regions[1]!.parent = 'XF-ZZ';
  assert.match(problemsOf(orphan), /parent XF-ZZ is not a region of this pack/);
  const self = fixture();
  self.regions[1]!.parent = 'XF-NOA';
  assert.match(problemsOf(self), /is its own parent/);
  const cycle = fixture();
  (cycle.regions[0] as Record<string, unknown>).parent = 'XF-NOA';
  assert.match(problemsOf(cycle), /cycle/);
});

test('identifier kinds are unique, prefixed by their scope and their examples match', () => {
  const dup = fixture();
  dup.facets.identifiers![0]!.kind = 'XF-FTIN';
  assert.match(problemsOf(dup), /identifier kinds repeat: XF-FTIN/);
  const prefix = fixture();
  prefix.regions[0]!.facets!.identifiers![0]!.kind = 'XF-SO-CLN';
  assert.match(problemsOf(prefix), /kind XF-SO-CLN must be XF-NO-<NAME>/);
  const example = fixture();
  example.facets.identifiers![0]!.example = 'too-short';
  assert.match(problemsOf(example), /example does not match its pattern/);
  const register = fixture();
  register.facets.identifiers![0]!.register = 'xf-no-licence-board';
  assert.match(problemsOf(register), /register xf-no-licence-board is not declared in this or a wider scope/, 'a national fact cannot rely on a state register');
  const covers = fixture();
  covers.facets.registers![0]!.covers = ['XF-NOPE'];
  assert.match(problemsOf(covers), /covers unknown identifier kind XF-NOPE/);
});

test('fact rules: unique ids, consistent overrides, counsel review, residency scope, calendar sanity', () => {
  const dupId = fixture();
  dupId.facets.payments![1]!.id = 'xf-cards';
  assert.match(problemsOf(dupId), /duplicate fact id/);
  const crossKind = fixture();
  crossKind.regions[2]!.facets!.calendar![0]!.id = 'new-year';
  assert.match(problemsOf(crossKind), /overrides calendar\/new-year of a wider scope with a different kind of fact/);
  const counsel = fixture();
  counsel.facets.agentLaw![0]!.verification = 'official';
  assert.match(problemsOf(counsel), /stay unverified until counsel review/);
  counsel.facets.agentLaw![0]!.counselReview = 'done';
  assert.equal(packProblems(counsel).pack?.code, 'XF');
  const residency = fixture();
  (residency.facets.privacy as unknown[]).push({ type: 'data-residency', id: 'xf-residency', required: true, note: { en: 'x' }, sources: residency.sources, verification: 'pending' });
  assert.match(problemsOf(residency), /country data-residency rule belongs in dataResidency/);
  const feb30 = fixture();
  (feb30.facets.calendar![2] as { rule: unknown }).rule = { kind: 'fixed', month: 2, day: 30 };
  assert.match(problemsOf(feb30), /fixed holiday on a day that does not exist/);
  const week = fixture();
  (week.facets.calendar![0] as { days: string[] }).days = ['mon', 'mon'];
  assert.match(problemsOf(week), /repeats a day/);
  const dates = fixture();
  (dates.facets.tax![0] as Record<string, unknown>).effectiveFrom = '2027-01-01';
  (dates.facets.tax![0] as Record<string, unknown>).effectiveTo = '2026-01-01';
  assert.match(problemsOf(dates), /effectiveFrom is after effectiveTo/);
  const badDate = fixture();
  (badDate.facets.tax![0] as Record<string, unknown>).effectiveFrom = '2027-02-30';
  assert.equal(packProblems(badDate).pack, null);
  const noEnglish = fixture();
  (noEnglish.facets.contentLaw![0] as Record<string, unknown>).summary = { fr: 'Les faux avis sont interdits' };
  assert.equal(packProblems(noEnglish).pack, null, 'fact text needs the en fallback');
});

test('a shared layer (for example the EU, CTRY-EU) can be expressed and checked with the same facets', () => {
  const layer: Facets = FacetsSchema.parse({
    privacy: [{ type: 'law', id: 'xl-data-protection', name: { en: 'Synthetic regional data-protection regulation' }, breachNotificationHours: 72, sources: [{ url: 'https://example.invalid/xl/law', what: 'Synthetic layer law', accessed: '2026-10-30' }], verification: 'pending' }],
    identifiers: [{ id: 'xl-vat-number', kind: 'XL-VATID', role: 'vat', label: { en: 'Regional VAT number' }, pattern: '^XL[0-9]{8}$', example: 'XL00000000', issuer: { name: { en: 'Member tax offices' }, url: 'https://example.invalid/xl' }, sources: [{ url: 'https://example.invalid/xl/vat', what: 'Synthetic', accessed: '2026-10-30' }], verification: 'pending' }],
  });
  assert.deepEqual(facetProblems(layer, { scope: 'XL', wider: [], identifierKinds: new Set(['XL-VATID']), countryScope: false }), []);
  const memberOverride: Facets = FacetsSchema.parse({ privacy: [{ ...layer.privacy![0]!, breachNotificationHours: 48, sources: [{ url: 'https://example.invalid/xf/law', what: 'Synthetic national override', accessed: '2026-10-30' }] }] });
  assert.deepEqual(facetProblems(memberOverride, { scope: 'XF', wider: listFacts(layer), identifierKinds: new Set(), countryScope: true }), [], 'an override with its own sources is accepted');
  assert.throws(() => FacetsSchema.parse({ privacy: [{ ...layer.privacy![0]!, sources: [] }] }), 'an override without its own source is refused');
});
