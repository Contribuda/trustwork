import { installSyntheticListSources, syntheticListSources } from '../web/admin/screening/list-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobs, type DataPool } from '@trustwork/data';
import { FAKE_LIST_ENTRIES } from '../../packages/compliance/src/lists/index.js';
import { screeningFreshness, screeningListsStaff } from '../../packages/data/src/repositories/screening-lists.js';
import { HandlerRegistry, Metrics, Worker } from '@trustwork/worker';
import {
  ingestList, registerScreeningLists, screeningFreshnessTask, screeningListsDueTask, screeningListSources, SCREENING_LIST_INGEST_KIND, type LiveActivation, type ScreeningListsRuntime,
} from '../../apps/worker/src/screening-lists/index.js';
import type { LogLevel } from '../../apps/worker/src/log.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { baselineIds, complianceWorld, fixture } from './helpers.js';

const env = await provisionWorkerDatabase('screening_lists_worker');
const DAY = 86_400_000;

/**
 * SANC-002 ingestion end to end on the worker role: `file` mode from a lists directory, `live` through a fake fetcher
 * only with a second-person activation, `fake` outside production; a truncated, malformed or shrunken export never
 * replaces the active version; two workers ingesting the same list create one version. No test touches the network:
 * `globalThis.fetch` is a tripwire for the whole file.
 */
test('SANC-002 worker: ingestion modes, sanity bounds, activation and freshness', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  const dir = mkdtempSync(join(tmpdir(), 'sanc-002-lists-'));
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error('network access is forbidden in tests');
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    await env.close();
  });
  const admin = env.db.admin;
  const { w, as, elevate, owner } = await complianceWorld(admin, env.apiPool);
  const ids = await baselineIds(admin);
  await owner((trx) => trx.updateTable('screening_list').set({ min_entries: 1 }).where('baseline', '=', true).execute());

  const logs: { level: LogLevel; message: string; fields: Record<string, unknown> }[] = [];
  let activation: LiveActivation | null = null;
  const fetched: string[] = [];
  let liveBody = fixture('ofac-cons-synthetic.xml');
  const metrics = new Metrics();
  const makeRuntime = (pool: DataPool): ScreeningListsRuntime => ({
    pool, metrics, log: (level, message, fields = {}) => logs.push({ level, message, fields }),
    config: { listsDir: dir, maxExportBytes: 4 * 1024 * 1024, production: false },
    live: { fetcher: async (url) => { fetched.push(url); return { status: 200, body: new TextEncoder().encode(liveBody) }; }, activation: () => activation },
  });
  const workers: Worker[] = [];
  const makeWorker = () => {
    const pool = env.workerPool(4);
    const runtime = makeRuntime(pool);
    const registry = new HandlerRegistry();
    registerScreeningLists(registry, runtime);
    const worker = new Worker({ pool, registry, metrics, config: { pollIntervalMs: 50, concurrency: 1 }, tasks: () => [screeningListsDueTask(runtime), screeningFreshnessTask(runtime)], random: () => 0 });
    workers.push(worker);
    return { worker, pool, runtime };
  };
  const main = makeWorker();
  const drain = async (worker = main.worker) => {
    let quiet = 0;
    for (let i = 0; i < 40 && quiet < 2; i += 1) {
      const report = await worker.runOnce({ rethrow: true });
      await worker.idle();
      quiet = report.leased === 0 && report.relayed === 0 && report.scheduled.length === 0 ? quiet + 1 : 0;
    }
  };
  const ingest = async (listId: string, worker = main) => {
    await tx(worker.pool, (trx) => jobs.enqueue(trx, { kind: SCREENING_LIST_INGEST_KIND, payload: { listId } }));
    await drain(worker.worker);
  };
  const list = async (id: string) => (await admin.query<{ last_outcome: string; last_error: string | null; last_checked_at: Date | null }>('SELECT last_outcome, last_error, last_checked_at FROM trustwork.screening_list WHERE id = $1', [id])).rows[0]!;
  const versions = async (id: string) => (await admin.query<{ id: string; version: number; state: string; rejected_reason: string | null; entry_count: number }>(
    'SELECT id, version, state, rejected_reason, entry_count FROM trustwork.screening_list_version WHERE list_id = $1 ORDER BY version', [id])).rows;
  const activeVersion = async (id: string) => (await versions(id)).find((v) => v.state === 'active')?.id ?? null;
  const put = (code: string, text: string, mtime: Date) => {
    const path = join(dir, `${code}.xml`);
    writeFileSync(path, text);
    utimesSync(path, mtime, mtime);
  };

  await t.test('without export files the due task enqueues each baseline list once; nothing activates and screening stays unavailable', async () => {
    await drain();
    const queued = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.job WHERE kind = $1', [SCREENING_LIST_INGEST_KIND]);
    assert.equal(queued.rows[0]?.n, 2, 'one job per baseline list, not more after further iterations');
    assert.equal((await list(ids.sdn)).last_outcome, 'source_missing');
    assert.deepEqual(await versions(ids.sdn), []);
    assert.equal(await tx(main.pool, (trx) => screeningFreshness.available(trx)), false);
    assert.equal(metrics.value('trustwork_screening_available'), 0);
    assert.ok(logs.some((l) => l.level === 'error' && /screening unavailable/.test(l.message)));
  });

  const obtained = new Date(Date.now() - DAY);
  await t.test('file mode: the official exports activate, each with an outbox event; the age counts from the file time', async () => {
    put('ofac-sdn', fixture('ofac-sdn-synthetic.xml'), obtained);
    copyFileSync(join(import.meta.dirname, 'fixtures', 'ofac-cons-synthetic.xml'), join(dir, 'ofac-cons.xml'));
    await ingest(ids.sdn);
    await ingest(ids.cons);
    assert.equal((await list(ids.sdn)).last_outcome, 'activated');
    assert.equal((await list(ids.cons)).last_outcome, 'activated');
    assert.equal((await list(ids.sdn)).last_checked_at?.getTime(), obtained.getTime());
    const events = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.outbox_event WHERE type = 'screening.list_version_activated'");
    assert.equal(events.rows[0]?.n, 2);
    const availability = await tx(env.apiPool, (trx) => screeningFreshness.availability(trx));
    assert.equal(availability.available, true);
    const sdnFreshness = availability.lists.find((l) => l.code === 'ofac-sdn');
    assert.equal(sdnFreshness?.publishedOn, '2026-10-28');
    assert.ok((sdnFreshness?.ageSeconds ?? 0) >= 86_000, 'one day old');
  });

  await t.test('an unchanged export confirms the active version without a new one; a fresh copy moves the clock', async () => {
    const before = await versions(ids.sdn);
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_outcome, 'unchanged');
    assert.equal((await list(ids.sdn)).last_checked_at?.getTime(), obtained.getTime(), 're-reading the same file is not a new confirmation');
    const fresh = new Date(Date.now() - 60_000);
    put('ofac-sdn', fixture('ofac-sdn-synthetic.xml'), fresh);
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_checked_at?.getTime(), fresh.getTime());
    assert.deepEqual(await versions(ids.sdn), before);
  });

  await t.test('a truncated or malformed export is never activated and the previous version stays active', async () => {
    const active = await activeVersion(ids.sdn);
    put('ofac-sdn', fixture('ofac-sdn-truncated.xml'), new Date());
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_outcome, 'malformed');
    assert.match((await list(ids.sdn)).last_error ?? '', /unclosed element/);
    put('ofac-sdn', '<sdnList><sdnEntry><uid>1</uid></sdnEntry></sdnList>', new Date());
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_outcome, 'malformed');
    // A complete document that declares more entries than it holds: staged for the record, then rejected.
    const short = fixture('ofac-sdn-synthetic.xml').replace(/<sdnEntry>\s*<uid>910006<\/uid>[\s\S]*?<\/sdnEntry>/, '');
    put('ofac-sdn', short, new Date());
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_outcome, 'rejected');
    const all = await versions(ids.sdn);
    assert.deepEqual(all.at(-1), { ...all.at(-1)!, state: 'rejected', rejected_reason: 'declared_count_mismatch', entry_count: 5 });
    assert.equal(await activeVersion(ids.sdn), active, 'the previous version is still the active one');
    assert.equal(await tx(env.apiPool, (trx) => screeningFreshness.available(trx)), true, 'screening keeps running on the previous version');
  });

  await t.test('a shrunken export waits for a compliance officer; repeating it stages nothing new; confirmation activates it', async () => {
    const active = await activeVersion(ids.sdn);
    const reduced = fixture('ofac-sdn-synthetic.xml')
      .replace(/<sdnEntry>\s*<uid>910005<\/uid>[\s\S]*?<\/sdnEntry>/, '').replace(/<sdnEntry>\s*<uid>910006<\/uid>[\s\S]*?<\/sdnEntry>/, '')
      .replace('<Record_Count>6</Record_Count>', '<Record_Count>4</Record_Count>');
    put('ofac-sdn', reduced, new Date());
    await ingest(ids.sdn);
    assert.equal((await list(ids.sdn)).last_outcome, 'needs_confirmation');
    const count = (await versions(ids.sdn)).length;
    await ingest(ids.sdn);
    assert.equal((await versions(ids.sdn)).length, count, 'the same export does not stage again');
    assert.equal(await activeVersion(ids.sdn), active);
    const staged = (await versions(ids.sdn)).find((v) => v.state === 'staged')!;
    const officer = await elevate(w.people.moderator);
    assert.equal(await as(w.people.moderator, (trx) => screeningListsStaff.confirmVersion(trx, officer, { versionId: staged.id, reason: 'Synthetic: checked against the publication notice' })), 'activated');
    assert.equal(await activeVersion(ids.sdn), staged.id);
  });

  await t.test('two workers ingesting the same new export create exactly one version', async () => {
    const second = makeWorker();
    const grown = fixture('ofac-sdn-synthetic.xml').replace('</sdnList>', '<sdnEntry><uid>910007</uid><lastName>SECOND SYNTHETIC HOLDINGS</lastName><sdnType>Entity</sdnType><programList><program>SYNTHETIC-C</program></programList></sdnEntry></sdnList>')
      .replace('<Record_Count>6</Record_Count>', '<Record_Count>7</Record_Count>');
    put('ofac-sdn', grown, new Date());
    const before = (await versions(ids.sdn)).length;
    await tx(main.pool, async (trx) => {
      await jobs.enqueue(trx, { kind: SCREENING_LIST_INGEST_KIND, payload: { listId: ids.sdn } });
      await jobs.enqueue(trx, { kind: SCREENING_LIST_INGEST_KIND, payload: { listId: ids.sdn } });
    });
    await Promise.all([main.worker.runOnce({ rethrow: true }), second.worker.runOnce({ rethrow: true })]);
    await Promise.all([main.worker.idle(), second.worker.idle()]);
    await Promise.all([drain(main.worker), drain(second.worker)]);
    const after = await versions(ids.sdn);
    assert.equal(after.length, before + 1, 'one new version');
    assert.equal(after.at(-1)?.state, 'active');
    assert.equal(after.at(-1)?.entry_count, 7);
    const outcomes = logs.filter((l) => l.fields.listId === ids.sdn).slice(-2).map((l) => l.fields.outcome).sort();
    assert.deepEqual(outcomes, ['activated', 'unchanged'], 'the second ingestion found the first one\'s version');
  });

  await t.test('live mode refuses without a second-person activation and calls nothing; with one it downloads through the fetcher', async () => {
    await owner((trx) => trx.updateTable('screening_list').set({ mode: 'live' }).where('id', '=', ids.cons).execute());
    await ingest(ids.cons);
    assert.equal((await list(ids.cons)).last_outcome, 'refused');
    assert.match((await list(ids.cons)).last_error ?? '', /live_not_activated/);
    activation = { connectionId: 'synthetic-connection', activatedBy: w.people.moderator, approvedBy: w.people.moderator };
    await ingest(ids.cons);
    assert.match((await list(ids.cons)).last_error ?? '', /live_not_activated/, 'one person activating alone is not enough');
    assert.deepEqual(fetched, []);
    activation = { connectionId: 'synthetic-connection', activatedBy: w.people.moderator, approvedBy: w.people.lead };
    liveBody = fixture('ofac-cons-synthetic.xml').replace('</sdnList>', '<sdnEntry><uid>920004</uid><lastName>LIVE SYNTHETIC ADDITION LTD</lastName><sdnType>Entity</sdnType><programList><program>SYNTHETIC-SSI</program></programList></sdnEntry></sdnList>')
      .replace('<Record_Count>3</Record_Count>', '<Record_Count>4</Record_Count>');
    await ingest(ids.cons);
    assert.equal((await list(ids.cons)).last_outcome, 'activated');
    assert.deepEqual(fetched, ['https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML'], 'the list\'s source URL, through the injected fetcher');
    const modes = await admin.query<{ mode: string }>("SELECT mode FROM trustwork.screening_list_version WHERE list_id = $1 AND state = 'active'", [ids.cons]);
    assert.equal(modes.rows[0]?.mode, 'live');
  });

  await t.test('fake mode ingests the synthetic list outside production and refuses it in production; unknown adapters and paused lists refuse', async () => {
    await installSyntheticListSources(admin);
    const source=(await admin.query<{id:string}>('SELECT id FROM trustwork.screening_list_source WHERE current')).rows[0]!;
    const fact=syntheticListSources()[0]!;
    const hubList = (await owner((trx) => trx.insertInto('screening_list').values({
      hub_id: w.hubId, source_id:source.id, code: fact.code, name: 'Synthetic demo list', authority: 'Synthetic authority', source_url: fact.sourceUrl, adapter: fact.adapter,
      mode: 'fake', cadence: '1 day', warn_after: '3 days', stale_after: '20 days', max_drop_share: '0.2',
    }).returning('id').executeTakeFirstOrThrow())).id;
    await ingest(hubList);
    assert.equal((await list(hubList)).last_outcome, 'activated');
    assert.equal((await versions(hubList))[0]?.entry_count, FAKE_LIST_ENTRIES.length);
    const production = { ...makeRuntime(main.pool), config: { listsDir: dir, maxExportBytes: 1 << 20, production: true } };
    const report = await tx(main.pool, (trx) => ingestList(trx, hubList, { sources: screeningListSources(production) }, new AbortController().signal));
    assert.equal(report.outcome, 'refused');
    assert.match(report.error ?? '', /fake_in_production/);
    await owner((trx) => trx.updateTable('screening_list').set({ adapter: 'unknown-format' }).where('id', '=', hubList).execute());
    await ingest(hubList);
    assert.match((await list(hubList)).last_error ?? '', /source_authority_retired/);
    await owner((trx) => trx.updateTable('screening_list').set({ status: 'paused', adapter: 'ofac-sls-xml' }).where('id', '=', hubList).execute());
    await ingest(hubList);
    assert.equal((await list(hubList)).last_error, 'list_paused');
  });

  await t.test('clock: once the baseline confirmations pass the stale age, screening is unavailable and the freshness task says so', async () => {
    await owner((trx) => trx.updateTable('screening_list').set({ last_checked_at: new Date(Date.now() - 8 * DAY) }).where('id', '=', ids.sdn).execute());
    logs.length = 0;
    const report = await screeningFreshnessTask(main.runtime).run();
    assert.equal(report.unavailable, 1);
    assert.equal(metrics.value('trustwork_screening_available'), 0);
    assert.equal(metrics.value('trustwork_screening_list_state', { list: 'ofac-sdn', state: 'stale' }), 1);
    assert.ok(logs.some((l) => l.level === 'error' && l.fields.reasons === 'baseline_stale:ofac-sdn'));
    assert.equal(await tx(env.apiPool, (trx) => screeningFreshness.available(trx)), false);
  });

  await t.test('no network call happened anywhere in this file', () => {
    assert.equal(networkCalls, 0);
  });
});
