import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OFAC_SLS_XML_ADAPTER, fakeListExport, sourceDigest } from '../../packages/compliance/src/lists/index.js';
import type { LockedScreeningList } from '../../packages/data/src/repositories/screening-lists.js';
import { fakeListSource, fileListSource, liveListSource, listFilePath, ListSourceError, rangeTableAge, rangesAgeTask, screeningListsConfigFromEnv, ScreeningListsConfigError } from '../../apps/worker/src/screening-lists/index.js';
import { Metrics } from '../../apps/worker/src/metrics.js';
import type { LogLevel } from '../../apps/worker/src/log.js';
import { fixture } from './helpers.js';

const list = (over: Partial<LockedScreeningList> = {}): LockedScreeningList => ({
  id: '00000000-0000-4000-8000-000000000001', hubId: null, code: 'ofac-sdn', adapter: 'ofac-sls-xml', mode: 'file', sourceUrl: 'https://example.invalid/SDN.XML', status: 'active', baseline: true,
  maxDropShare: 0.1, minEntries: 1, active: null, staged: null, ...over,
});
const signal = new AbortController().signal;
const refused = (code: string) => (e: unknown) => e instanceof ListSourceError && e.code === code;

test('file source: reads <dir>/<code>.xml, a hub list under its hub, takes the modification time and never a future one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sanc-002-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date('2026-10-31T12:00:00Z');
  const source = fileListSource({ dir, maxBytes: 1024 * 1024, now: () => now });
  await assert.rejects(source.obtain(list(), OFAC_SLS_XML_ADAPTER, signal), (e: unknown) => e instanceof ListSourceError && e.outcome === 'source_missing' && e.code === 'file_missing');
  const path = listFilePath(dir, list(), OFAC_SLS_XML_ADAPTER);
  assert.equal(path, join(dir, 'ofac-sdn.xml'));
  writeFileSync(path, fixture('ofac-sdn-synthetic.xml'));
  const obtainedAt = new Date('2026-10-30T08:00:00Z');
  utimesSync(path, obtainedAt, obtainedAt);
  const got = await source.obtain(list(), OFAC_SLS_XML_ADAPTER, signal);
  assert.equal(got.obtainedAt.toISOString(), obtainedAt.toISOString(), 'obtained when the operator saved the file');
  assert.equal(got.sourceDigest, sourceDigest(fixture('ofac-sdn-synthetic.xml')));
  utimesSync(path, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
  assert.equal((await source.obtain(list(), OFAC_SLS_XML_ADAPTER, signal)).obtainedAt.toISOString(), now.toISOString(), 'a future modification time counts as now');
  const hubList = list({ hubId: '00000000-0000-4000-8000-0000000000aa', code: 'synthetic-national', baseline: false });
  assert.equal(listFilePath(dir, hubList, OFAC_SLS_XML_ADAPTER), join(dir, '00000000-0000-4000-8000-0000000000aa', 'synthetic-national.xml'));
  await assert.rejects(fileListSource({ dir, maxBytes: 100 }).obtain(list(), OFAC_SLS_XML_ADAPTER, signal), refused('too_large'));
  await assert.rejects(fileListSource({ dir: null, maxBytes: 100 }).obtain(list(), OFAC_SLS_XML_ADAPTER, signal), refused('no_lists_directory'));
  mkdirSync(join(dir, 'ofac-cons.xml'));
  await assert.rejects(source.obtain(list({ code: 'ofac-cons' }), OFAC_SLS_XML_ADAPTER, signal), refused('not_a_file'));
});

test('live source: refuses before any call without a second-person activation or a fetcher; downloads through the fetcher only', async () => {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return { status: 200, body: new TextEncoder().encode(fixture('ofac-cons-synthetic.xml')) };
  };
  await assert.rejects(liveListSource({ fetcher, activation: () => null, maxBytes: 1 << 20 }).obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal), refused('live_not_activated'));
  await assert.rejects(liveListSource({ fetcher, activation: () => ({ connectionId: 'c1', activatedBy: 'p1', approvedBy: 'p1' }), maxBytes: 1 << 20 }).obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal), refused('live_not_activated'));
  await assert.rejects(liveListSource({ fetcher: null, activation: () => ({ connectionId: 'c1', activatedBy: 'p1', approvedBy: 'p2' }), maxBytes: 1 << 20 }).obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal), refused('no_fetcher'));
  assert.deepEqual(calls, [], 'no call without an activated provider');
  const activated = liveListSource({ fetcher, activation: () => ({ connectionId: 'c1', activatedBy: 'p1', approvedBy: 'p2' }), maxBytes: 1 << 20, now: () => new Date('2026-10-31T00:00:00Z') });
  const got = await activated.obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal);
  assert.deepEqual(calls, ['https://example.invalid/SDN.XML']);
  assert.equal(got.obtainedAt.toISOString(), '2026-10-31T00:00:00.000Z');
  await assert.rejects(liveListSource({ fetcher: async () => ({ status: 503, body: new Uint8Array() }), activation: () => ({ connectionId: 'c1', activatedBy: 'p1', approvedBy: 'p2' }), maxBytes: 1 << 20 }).obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal), (e: unknown) => e instanceof ListSourceError && e.outcome === 'failed' && e.code === 'http_503');
  await assert.rejects(liveListSource({ fetcher, activation: () => ({ connectionId: 'c1', activatedBy: 'p1', approvedBy: 'p2' }), maxBytes: 10 }).obtain(list({ mode: 'live' }), OFAC_SLS_XML_ADAPTER, signal), refused('too_large'));
});

test('fake source: the synthetic list outside production, refused in production', async () => {
  const got = await fakeListSource({ production: false }).obtain(list({ mode: 'fake' }), OFAC_SLS_XML_ADAPTER, signal);
  assert.equal(got.text, fakeListExport());
  await assert.rejects(fakeListSource({ production: true }).obtain(list({ mode: 'fake' }), OFAC_SLS_XML_ADAPTER, signal), refused('fake_in_production'));
});

test('configuration: lists directory from SCREENING_LISTS_DIR or the data directory; bounded export size', () => {
  assert.deepEqual(screeningListsConfigFromEnv({}), { listsDir: null, maxExportBytes: 256 * 1024 * 1024, production: false });
  assert.equal(screeningListsConfigFromEnv({ TRUSTWORK_DATA_DIR: '/srv/data' }).listsDir, join('/srv/data', 'screening-lists'));
  assert.equal(screeningListsConfigFromEnv({ TRUSTWORK_DATA_DIR: '/srv/data', SCREENING_LISTS_DIR: '/lists' }).listsDir, '/lists');
  assert.equal(screeningListsConfigFromEnv({ NODE_ENV: 'production' }).production, true);
  assert.throws(() => screeningListsConfigFromEnv({ SCREENING_LIST_MAX_BYTES: '10' }), ScreeningListsConfigError);
});

test('geolocation range table: an operations warning past two months; other gate modes have no table to age', async () => {
  const header = (month: string) => () => ({ format: 'trustwork-restricted-ranges-1', dataset: 'dbip-city-lite', month });
  const env = { TRUSTWORK_JURISDICTION_GATE: 'ranges_file', TRUSTWORK_JURISDICTION_RANGES_FILE: '/data/ranges.json' };
  const now = new Date('2026-10-31T00:00:00Z');
  assert.deepEqual(rangeTableAge(env, now, header('2026-09')), { state: 'current', dataset: 'dbip-city-lite', month: '2026-09', ageMonths: 1 });
  assert.equal(rangeTableAge(env, now, header('2026-08')).state, 'current', 'two months is still current');
  assert.deepEqual(rangeTableAge(env, now, header('2026-07')), { state: 'overdue', dataset: 'dbip-city-lite', month: '2026-07', ageMonths: 3 });
  assert.deepEqual(rangeTableAge({ TRUSTWORK_JURISDICTION_GATE: 'edge_header' }, now), { state: 'not_applicable', mode: 'edge_header' });
  assert.deepEqual(rangeTableAge({}, now), { state: 'not_applicable', mode: 'unconfigured' });
  assert.deepEqual(rangeTableAge(env, now, () => { throw new Error('ENOENT'); }), { state: 'unreadable', reason: 'unreadable' });
  assert.deepEqual(rangeTableAge(env, now, () => ({ format: 'other' })), { state: 'unreadable', reason: 'not_a_range_table' });
  assert.deepEqual(rangeTableAge({ TRUSTWORK_JURISDICTION_GATE: 'ranges_file', TRUSTWORK_DATA_DIR: '/srv' }, now, (path) => ({ format: 'trustwork-restricted-ranges-1', dataset: path.endsWith(join('jurisdiction', 'restricted-ranges.json')) ? 'default-path' : 'x', month: '2026-10' })).state, 'current');

  const logs: { level: LogLevel; message: string }[] = [];
  const metrics = new Metrics();
  const task = rangesAgeTask({ env, log: (level, message) => logs.push({ level, message }), metrics, now: () => now, readJson: header('2026-06') });
  assert.equal(task.name, 'jurisdiction.ranges_age');
  assert.deepEqual(await task.run(), { checked: 1, overdue: 1, unreadable: 0 });
  assert.equal(metrics.value('trustwork_geolocation_table_age_months'), 4);
  assert.ok(logs.some((l) => l.level === 'warn' && /older than two months/.test(l.message)));
});
