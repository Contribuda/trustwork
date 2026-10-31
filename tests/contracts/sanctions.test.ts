import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClearJurisdictionHoldCommandSchema, coveringRestrictedPlace, edgeHeaderGate, fakeGate, JURISDICTION_ERROR_STATUS, jurisdictionGateFromEnv, JurisdictionGateConfigError,
  JurisdictionHoldSchema, JurisdictionStatusSchema, loadRangeTable, parseAddress, RANGE_TABLE_FORMAT, rangeTableAgeInMonths, RangeTableError, restrictedPlaces, upstreamGate,
} from '../../packages/contracts/src/sanctions.js';
import { RESTRICTED } from '../../packages/country-packs/src/restricted.js';

// The authoritative list, exactly as the web and the API receive it.
const restricted = restrictedPlaces(RESTRICTED.places.map((p) => p.code));
const request = (address: string | null, headers: Record<string, string> = {}) => ({ address, header: (name: string) => headers[name.toLowerCase()] ?? null });

test('restricted places: the list is injected, never hard-coded; coverage follows country and subdivision', () => {
  assert.equal(coveringRestrictedPlace('RU', restricted), 'RU');
  assert.equal(coveringRestrictedPlace('ru-mow', restricted), 'RU', 'a subdivision of a wholly restricted country is covered by the country');
  assert.equal(coveringRestrictedPlace('UA-43', restricted), 'UA-43');
  assert.equal(coveringRestrictedPlace('UA-30', restricted), null, 'Kyiv is not restricted');
  assert.equal(coveringRestrictedPlace('UA', restricted), null, 'a partly restricted country as a whole is not');
  assert.equal(coveringRestrictedPlace('US', restricted), null);
  assert.equal(coveringRestrictedPlace('not a code', restricted), null);
  assert.throws(() => restrictedPlaces([]), /empty/);
  assert.throws(() => restrictedPlaces(['Russia']), /invalid/);
  const source = readFileSync(join(import.meta.dirname, '../../packages/contracts/src/sanctions.ts'), 'utf8');
  for (const place of RESTRICTED.places) assert.ok(!source.includes(`'${place.code}'`), `the contract does not list ${place.code}`);
});

test('addresses: IPv4, IPv6, IPv4-mapped IPv6 and garbage', () => {
  assert.deepEqual(parseAddress('192.0.2.1'), { family: 4, value: 0xc0000201 });
  assert.deepEqual(parseAddress('::ffff:192.0.2.1'), { family: 4, value: 0xc0000201 });
  assert.deepEqual(parseAddress('2001:db8::1'), { family: 6, value: 0x20010db8000000000000000000000001n });
  assert.deepEqual(parseAddress('2001:DB8:0:0:0:0:0:1%eth0'), { family: 6, value: 0x20010db8000000000000000000000001n });
  for (const bad of ['', '1.2.3', '256.1.1.1', '01.2.3.4', '1.2.3.4.5', '2001:db8:::1', ':::', 'example.org', 'x'.repeat(60), null, undefined]) assert.equal(parseAddress(bad as string), null, String(bad));
});

const table = (extra: Partial<Record<string, unknown>> = {}) => ({
  format: RANGE_TABLE_FORMAT, dataset: 'test-ranges', month: '2026-09', attribution: 'synthetic', codes: ['RU', 'UA-43'],
  v4: [[0xc0000200, 0xc00002ff, 0], [0xc6336400, 0xc633647f, 1]], v6: [['20010db8000000000000000000000000', '20010db80000ffffffffffffffffffff', 0]], ...extra,
});

test('range table: lookup at the edges of every range, both families', () => {
  const t = loadRangeTable(table(), restricted);
  assert.equal(t.datasetId, 'test-ranges-2026-09');
  assert.equal(t.rangeCount, 3);
  assert.equal(t.lookup('192.0.2.0'), 'RU');
  assert.equal(t.lookup('192.0.2.255'), 'RU');
  assert.equal(t.lookup('192.0.3.0'), null);
  assert.equal(t.lookup('198.51.100.127'), 'UA-43');
  assert.equal(t.lookup('198.51.100.128'), null);
  assert.equal(t.lookup('2001:db8::'), 'RU');
  assert.equal(t.lookup('2001:db8:0:ffff:ffff:ffff:ffff:ffff'), 'RU');
  assert.equal(t.lookup('2001:db8:1::'), null);
  assert.equal(t.lookup('203.0.113.9'), null);
  assert.equal(t.lookup(null), null);
});

test('range table: a corrupt or widening table is refused, never read as "not restricted"', () => {
  const bad: [string, unknown][] = [
    ['format', table({ format: 'other' })],
    ['month', table({ month: '2026-13' })],
    ['unlisted code', table({ codes: ['US'] })],
    ['partly listed country', table({ codes: ['UA'] })],
    ['subdivision under a listed country', table({ codes: ['RU-MOW'] })],
    ['unsorted', table({ v4: [[0xc6336400, 0xc633647f, 1], [0xc0000200, 0xc00002ff, 0]] })],
    ['overlap', table({ v4: [[1, 10, 0], [10, 20, 1]] })],
    ['inverted', table({ v4: [[20, 10, 0]] })],
    ['index', table({ v4: [[1, 2, 5]] })],
    ['v6 hex', table({ v6: [['zz', '20', 0]] })],
    ['not an object', [1, 2, 3]],
  ];
  for (const [name, input] of bad) assert.throws(() => loadRangeTable(input, restricted), RangeTableError, name);
});

test('gates: fake answers documentation ranges only; edge header needs the region for a partly restricted country; upstream decides nothing', () => {
  const fake = fakeGate(restricted);
  assert.deepEqual(fake.decide(request('192.0.2.10')), { place: 'CU', dataset: 'fake' });
  assert.equal(fake.decide(request('198.51.100.5'))?.place.includes('-'), true);
  assert.equal(fake.decide(request('203.0.113.7')), null);
  assert.equal(fake.decide(request('198.51.100.200')), null);
  assert.equal(fake.decide(request('2001:db8::5'))?.place, 'CU');
  assert.equal(fake.describe().mode, 'fake');

  const edge = edgeHeaderGate({ restricted, countryHeader: 'X-Geo-Country', regionHeader: 'X-Geo-Region' });
  assert.deepEqual(edge.decide(request(null, { 'x-geo-country': 'ir' })), { place: 'IR', dataset: 'edge-header' });
  assert.equal(edge.decide(request(null, { 'x-geo-country': 'UA' })), null, 'Ukraine without a region is not refused');
  assert.deepEqual(edge.decide(request(null, { 'x-geo-country': 'UA', 'x-geo-region': '43' })), { place: 'UA-43', dataset: 'edge-header' });
  assert.deepEqual(edge.decide(request(null, { 'x-geo-country': 'UA', 'x-geo-region': 'UA-09' })), { place: 'UA-09', dataset: 'edge-header' });
  assert.equal(edge.decide(request(null, { 'x-geo-country': 'UA', 'x-geo-region': 'US-43' })), null, 'a region of another country is ignored');
  assert.equal(edge.decide(request(null, { 'x-geo-country': 'UA', 'x-geo-region': '30' })), null);
  assert.equal(edge.decide(request(null, { 'x-geo-country': 'Russia' })), null, 'malformed header');
  assert.equal(upstreamGate().decide(request('192.0.2.10')), null);
});

test('configuration: production needs an explicit mode, refuses fake, and a ranges file must load', () => {
  const base = { restricted, readJson: () => table(), joinPath: (...p: string[]) => p.join('/') };
  assert.throws(() => jurisdictionGateFromEnv({}, { ...base, production: true, requireMode: true }), JurisdictionGateConfigError);
  assert.equal(jurisdictionGateFromEnv({}, { ...base, production: false, requireMode: false }).mode, 'unconfigured');
  assert.throws(() => jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'fake' }, { ...base, production: true, requireMode: true }), /refused in production/);
  assert.throws(() => jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'off' }, { ...base, production: false, requireMode: false }), JurisdictionGateConfigError);
  assert.throws(() => jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'edge_header' }, { ...base, production: true, requireMode: true }), /COUNTRY_HEADER/);
  assert.equal(jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'upstream_gate' }, { ...base, production: true, requireMode: true }).mode, 'upstream_gate');
  let read = '';
  const ranges = jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'ranges_file', TRUSTWORK_DATA_DIR: '/data' }, { ...base, readJson: (p) => { read = p; return table(); }, production: true, requireMode: true });
  assert.equal(read, '/data/jurisdiction/restricted-ranges.json');
  assert.equal(ranges.describe().dataset, 'test-ranges-2026-09');
  assert.throws(() => jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'ranges_file' }, { ...base, production: true, requireMode: true }), /must locate/);
  assert.throws(() => jurisdictionGateFromEnv({ TRUSTWORK_JURISDICTION_GATE: 'ranges_file', TRUSTWORK_JURISDICTION_RANGES_FILE: '/x' }, { ...base, readJson: () => { throw new Error('ENOENT /x'); }, production: true, requireMode: true }), (e: Error) => !e.message.includes('/x'));
  assert.equal(rangeTableAgeInMonths('2026-08', new Date('2026-10-31T00:00:00Z')), 2);
});

test('records: a hold is cleared whole or not at all, never by its subject; the subject sees only held or not', () => {
  const hold = { id: 'h1', personId: 'p1', place: 'UA-43', source: 'geolocation', dataset: 'fake', placedAt: '2026-10-31T10:00:00.000Z', clearedAt: null, clearedBy: null, clearReason: null, clearEvidence: null };
  assert.ok(JurisdictionHoldSchema.safeParse(hold).success);
  assert.ok(JurisdictionHoldSchema.safeParse({ ...hold, clearedAt: '2026-11-01T10:00:00.000Z', clearedBy: 'p2', clearReason: 'Synthetic: back home', clearEvidence: 'call' }).success);
  assert.ok(!JurisdictionHoldSchema.safeParse({ ...hold, clearedAt: '2026-11-01T10:00:00.000Z' }).success, 'partial clear');
  assert.ok(!JurisdictionHoldSchema.safeParse({ ...hold, clearedAt: '2026-11-01T10:00:00.000Z', clearedBy: 'p1', clearReason: 'x', clearEvidence: 'call' }).success, 'self clear');
  assert.ok(!JurisdictionHoldSchema.safeParse({ ...hold, address: '192.0.2.1' }).success, 'no address field');
  assert.ok(!ClearJurisdictionHoldCommandSchema.safeParse({ reason: '   ', evidence: 'call' }).success);
  assert.ok(!JurisdictionStatusSchema.safeParse({ held: true, place: 'RU' }).success, 'the subject is not told the place');
  assert.deepEqual(JURISDICTION_ERROR_STATUS, { 'jurisdiction.restricted': 451, 'auth.jurisdiction_hold': 403 });
});
