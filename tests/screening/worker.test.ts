import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance, type DataPool } from '@trustwork/data';
import { HandlerRegistry, Metrics, Worker } from '@trustwork/worker';
import {
  registerScreening, screeningConfigFromEnv, ScreeningConfigError, screeningSweepTask, subjectOfEvent, SCREENING_JOB_KIND, type ScreeningRuntime,
} from '../../apps/worker/src/screening/index.js';
import type { LogLevel } from '../../apps/worker/src/log.js';
import { PermanentJobError } from '../../apps/worker/src/handlers.js';
import { SCREENING_TRIGGER_EVENTS } from '../../packages/contracts/src/sanctions.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { company, person, screeningWorld } from './helpers.js';

test('worker settings: the fuzzy layer is off by default and bounded; malformed settings refuse to start', () => {
  assert.deepEqual(screeningConfigFromEnv({}), { fuzzyThreshold: null, vesselsAndAircraft: false, sweepBatch: 500 });
  assert.equal(screeningConfigFromEnv({ SCREENING_FUZZY_THRESHOLD: 'off' }).fuzzyThreshold, null);
  assert.equal(screeningConfigFromEnv({ SCREENING_FUZZY_THRESHOLD: '0.92' }).fuzzyThreshold, 0.92);
  for (const bad of ['0.5', '1', 'abc', '0.999']) assert.throws(() => screeningConfigFromEnv({ SCREENING_FUZZY_THRESHOLD: bad }), ScreeningConfigError, bad);
  assert.throws(() => screeningConfigFromEnv({ SCREENING_VESSELS_AND_AIRCRAFT: 'yes' }), ScreeningConfigError);
  assert.throws(() => screeningConfigFromEnv({ SCREENING_SWEEP_BATCH: '0' }), ScreeningConfigError);
  assert.equal(screeningConfigFromEnv({ SCREENING_VESSELS_AND_AIRCRAFT: '1' }).vesselsAndAircraft, true);
});

test('trigger events name their subject by the aggregate; anything else is a permanent failure', () => {
  assert.deepEqual(Object.keys(SCREENING_TRIGGER_EVENTS).sort(), ['company.created', 'company.ownership_declaration_changed', 'company.renamed', 'identity.name_changed', 'identity.person_registered', 'identity.session_started']);
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(subjectOfEvent({ type: 'identity.person_registered', aggregateKind: 'person', aggregateId: id }), { kind: 'person', id });
  assert.deepEqual(subjectOfEvent({ type: 'company.renamed', aggregateKind: 'company', aggregateId: id }), { kind: 'company', id });
  assert.throws(() => subjectOfEvent({ type: 'identity.person_registered', aggregateKind: 'company', aggregateId: id }), PermanentJobError);
  assert.throws(() => subjectOfEvent({ type: 'company.created', aggregateKind: 'company', aggregateId: 'not-a-uuid' }), PermanentJobError);
});

const env = await provisionWorkerDatabase('screening_worker');

/**
 * SANC-003 worker end to end on the worker role: outbox trigger events enqueue one screening job per subject, sign-in
 * screens only when something changed, renames screen again, the nightly sweep is the safety net, and the fuzzy layer
 * adds matches only when configured. No test touches the network; every name is synthetic.
 */
test('SANC-003 worker: triggers, sign-in rule, renames, sweep and the fuzzy layer', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network access is forbidden in tests');
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await env.close();
  });
  const admin = env.db.admin;
  const workerPool = env.workerPool(6);
  await screeningWorld(admin, env.apiPool, workerPool);
  const logs: { level: LogLevel; message: string; fields: Record<string, unknown> }[] = [];
  const metrics = new Metrics();
  const runtimeOf = (pool: DataPool, fuzzyThreshold: number | null = null): ScreeningRuntime => ({ pool, metrics, log: (level, message, fields = {}) => logs.push({ level, message, fields }), config: { fuzzyThreshold, vesselsAndAircraft: false, sweepBatch: 1000 } });
  const makeWorker = (fuzzyThreshold: number | null = null) => {
    const registry = new HandlerRegistry();
    registerScreening(registry, runtimeOf(workerPool, fuzzyThreshold));
    return new Worker({ pool: workerPool, registry, metrics, config: { pollIntervalMs: 50, concurrency: 2 }, tasks: () => [], random: () => 0 });
  };
  const drain = async (worker: Worker) => {
    let quiet = 0;
    for (let i = 0; i < 60 && quiet < 2; i += 1) {
      const report = await worker.runOnce({ rethrow: true });
      await worker.idle();
      quiet = report.leased === 0 && report.relayed === 0 ? quiet + 1 : 0;
    }
  };
  const main = makeWorker();
  await drain(main); // the setup's own events (list activations, staff renames) settle first
  const emit = (type: string, kind: 'person' | 'company', id: string) => withMaintenance(admin, (trx) => trx.insertInto('outbox_event').values({ aggregate_kind: kind, aggregate_id: id, revision: 1, type, payload: JSON.stringify({}) }).execute());
  const results = async (id: string) => (await admin.query<{ trigger: string; outcome: string; matcher_version: string }>(
    'SELECT trigger, outcome, matcher_version FROM trustwork.screening_result WHERE subject_person_id = $1 OR subject_company_id = $1 ORDER BY screened_at, id', [id])).rows;
  const jobsFor = async (id: string) => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.job WHERE kind = $1 AND payload -> 'subject' ->> 'id' = $2", [SCREENING_JOB_KIND, id])).rows[0]?.n;

  await t.test('registration screens the person once, from the database names, with the matcher version', async () => {
    const milo = await person(admin, 'Milo Fictivsky');
    await emit('identity.person_registered', 'person', milo.id);
    await emit('identity.person_registered', 'person', milo.id);
    await drain(main);
    const rows = await results(milo.id);
    assert.equal(rows.length, 1, 'two events while one job waited: one screening');
    assert.deepEqual([rows[0]?.trigger, rows[0]?.outcome], ['registration', 'possible_match']);
    assert.match(rows[0]?.matcher_version ?? '', /^engine-rule-1\+fuzzy-jw-1\+name-key-1$/);
    assert.equal(await jobsFor(milo.id), 1);
    assert.ok(!JSON.stringify(logs).toLowerCase().includes('fictivsky'), 'no log line names the subject');
  });

  await t.test('sign-in screens only when the names changed or newer list versions are active', async () => {
    const clean = await person(admin, 'Quentin Brightwater');
    await emit('identity.person_registered', 'person', clean.id);
    await drain(main);
    await emit('identity.session_started', 'person', clean.id);
    await drain(main);
    assert.deepEqual((await results(clean.id)).map((r) => r.trigger), ['registration'], 'nothing changed: no screening at sign-in');
    await withMaintenance(admin, (trx) => trx.updateTable('person').set({ display_name: 'Petra Samplewood' }).where('id', '=', clean.id).execute());
    await drain(main);
    const after = await results(clean.id);
    assert.deepEqual(after.map((r) => [r.trigger, r.outcome]), [['registration', 'clear'], ['name_change', 'possible_match']], 'the database appended identity.name_changed and the worker screened the new name');
    await emit('identity.session_started', 'person', clean.id);
    await drain(main);
    assert.equal((await results(clean.id)).length, 2);
  });

  await t.test('company creation and renames screen the company against entities', async () => {
    const northwind = await company(admin, 'Synthetic Pebble Works');
    await emit('company.created', 'company', northwind);
    await drain(main);
    assert.deepEqual((await results(northwind)).map((r) => [r.trigger, r.outcome]), [['company_change', 'clear']]);
    await withMaintenance(admin, (trx) => trx.updateTable('company').set({ display_name: 'Northwind Synthetic Supply' }).where('id', '=', northwind).execute());
    await drain(main);
    assert.deepEqual((await results(northwind)).map((r) => r.outcome), ['clear', 'possible_match']);
    await emit('company.ownership_declaration_changed', 'company', northwind);
    await drain(main);
    assert.equal((await results(northwind)).length, 3);
  });

  await t.test('the nightly sweep enqueues subjects never screened and renamed ones', async () => {
    const quiet = await person(admin, 'Orla Testworthy');
    const enqueued = await screeningSweepTask(runtimeOf(workerPool)).run();
    assert.ok((enqueued.enqueued ?? 0) >= 1);
    await drain(main);
    assert.deepEqual((await results(quiet.id)).map((r) => [r.trigger, r.outcome]), [['scheduled', 'possible_match']]);
    const again = await screeningSweepTask(runtimeOf(workerPool)).run();
    assert.equal(again.enqueued, 0, 'everyone is screened now');
  });

  await t.test('the fuzzy layer adds a near spelling only when configured', async () => {
    const near = await person(admin, 'Zorvan Exampletonn');
    await emit('identity.person_registered', 'person', near.id);
    await drain(main);
    assert.equal((await results(near.id))[0]?.outcome, 'clear', 'off by default');
    const fuzzy = makeWorker(0.9);
    await withMaintenance(admin, (trx) => trx.updateTable('person').set({ display_name: 'Exampletonn Zorvan' }).where('id', '=', near.id).execute());
    await drain(fuzzy);
    const rows = await results(near.id);
    assert.equal(rows.at(-1)?.outcome, 'possible_match');
    const match = (await admin.query<{ rule: string; score: string }>('SELECT rule, score FROM trustwork.screening_match WHERE subject_person_id = $1', [near.id])).rows[0];
    assert.equal(match?.rule, 'fuzzy');
    assert.ok(Number(match?.score) >= 0.9 && Number(match?.score) < 1);
    const fuzzyResult = (await admin.query<{ fuzzy_threshold: string }>('SELECT fuzzy_threshold FROM trustwork.screening_result WHERE subject_person_id = $1 ORDER BY screened_at DESC LIMIT 1', [near.id])).rows[0];
    assert.equal(fuzzyResult?.fuzzy_threshold, '0.90', 'the threshold is recorded with the result');
  });

  assert.ok((metrics.value('trustwork_screening_results_total', { kind: 'person', trigger: 'registration', outcome: 'possible_match' }) ?? 0) >= 1);
});
