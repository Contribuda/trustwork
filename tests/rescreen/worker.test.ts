import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { defaultWorkerConfig, expireLeasesTask, HandlerRegistry } from '@trustwork/worker';
import { rescreenStaff, rescreenWorker as rescreenPort } from '../../packages/data/src/repositories/rescreen.js';
import { screeningStates } from '../../packages/data/src/repositories/screening.js';
import { MATCHER_VERSION } from '../../packages/compliance/src/matching/index.js';
import { RescreenRunSchema } from '../../packages/contracts/src/sanctions.js';
import { kickRescreen, rescreenTickTask, rescreenWeeklyTask, runBatch, VersionCache, RESCREEN_BATCH_KIND } from '../../apps/worker/src/rescreen/index.js';
import { DEFAULT_RESCREEN_CONFIG } from '../../apps/worker/src/rescreen/config.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { rejects } from '../data/admin/helpers.js';
import { provisionWorkerDatabase, tx, waitFor } from '../worker/helpers/worker-db.js';
import { activateList, company, CONFIG, CONS_ENTRIES, person, screeningWorld, SDN_ENTRIES } from '../screening/helpers.js';
import { drain, dueNow, population, rescreenWorker, syntheticName, type LogLine } from './helpers.js';

const env = await provisionWorkerDatabase('rescreen_worker');
const FIXTURE = fileURLToPath(new URL('./fixtures/crash-rescreen.ts', import.meta.url));

/**
 * SANC-005 end to end on real PostgreSQL under the worker, runtime and owner roles: a list activation re-screens every
 * subject without any other trigger, the same delta twice opens nothing twice, a run interrupted half-way (an error
 * mid-batch, and a worker killed with SIGKILL mid-batch) resumes without screening finished subjects again, screening
 * unavailable records nothing, the manual trigger is staff-only and audited, the database refuses delta clears that do
 * not qualify, two workers never duplicate work, and the watchdog alerts on failed and overdue runs. No network; every
 * name is synthetic.
 */
test('SANC-005 re-screening on PostgreSQL', { skip: env ? false : SKIP_REASON, timeout: 600_000 }, async (t) => {
  if (!env) return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network access is forbidden in tests');
  }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-rescreen-'));
  t.after(async () => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    await env.close();
  });
  const admin = env.db.admin;
  const api = env.apiPool;
  const workerPool = env.workerPool(8);
  const world = await screeningWorld(admin, api, workerPool);
  const { w, as, elevate, owner } = world;
  const logs: LogLine[] = [];
  const main = rescreenWorker(workerPool, { logs, config: { batchSize: 50 } });

  const count = async (query: string, params: unknown[] = []) => (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
  const runOf = async (versionId: string) => (await admin.query<Record<string, unknown> & { id: string; state: string }>('SELECT * FROM trustwork.screening_rescreen_run WHERE list_version_id = $1', [versionId])).rows;
  const latestRun = async () => (await admin.query<Record<string, unknown> & { id: string; state: string; trigger: string }>('SELECT * FROM trustwork.screening_rescreen_run ORDER BY queued_at DESC, id DESC LIMIT 1')).rows[0];
  const results = async (subjectId: string) => (await admin.query<{ id: string; trigger: string; outcome: string; list_version_ids: string[] }>(
    'SELECT id, trigger, outcome, list_version_ids FROM trustwork.screening_result WHERE subject_person_id = $1 OR subject_company_id = $1 ORDER BY screened_at, id', [subjectId])).rows;
  const effective = (kind: 'person' | 'company', id: string) => tx(api, (trx) => screeningStates.state(trx, { kind, id }));
  const outbox = (type: string) => admin.query<{ aggregate_id: string; payload: Record<string, unknown> }>('SELECT aggregate_id, payload FROM trustwork.outbox_event WHERE type = $1 ORDER BY id', [type]).then((r) => r.rows);

  // A synthetic hub: named subjects, one who will meet a future entry, and a bulk population (more than four batches).
  const ansel = await person(admin, 'Ansel Mockridge');
  const quentin = await person(admin, 'Quentin Brightwater');
  const freight = await company(admin, 'Brightquay Synthetic Freight LLC');
  await population(admin, { persons: 180, companies: 20 });
  const subjects = await count('SELECT id FROM trustwork.person UNION ALL SELECT id FROM trustwork.company');

  await t.test('the first activations screen every subject: one delta run per version, the later one finds everyone current', async () => {
    await drain(main.worker);
    const runs = (await admin.query<{ trigger: string; state: string; subjects_done: number; screened_full: number; already_current: number; candidates_screened: number }>(
      "SELECT trigger, state, subjects_done, screened_full, already_current, candidates_screened FROM trustwork.screening_rescreen_run ORDER BY queued_at")).rows;
    assert.equal(runs.length, 2, 'one run per activated baseline version');
    assert.ok(runs.every((r) => r.state === 'done' && r.subjects_done === subjects), JSON.stringify(runs));
    assert.ok(runs.some((r) => r.screened_full + r.candidates_screened === subjects), 'nobody was screened before: everyone in full');
    assert.ok(runs.some((r) => r.already_current === subjects), 'the other run finds everyone screened against both versions');
    assert.deepEqual((await results(ansel.id)).map((r) => [r.trigger, r.outcome]), [['list_update', 'clear']]);
    assert.deepEqual((await effective('person', quentin.id)).reasons, []);
  });

  let sdn2 = '';
  await t.test('a new version that adds an entry matching an existing subject opens a review case without any other trigger', async () => {
    const reviewBefore = (await outbox('screening.review_requested')).length;
    sdn2 = await activateList(workerPool, world.lists.sdn, [...SDN_ENTRIES, { uid: '920010', type: 'individual', firstName: 'Ansel', lastName: 'MOCKRIDGE', programs: ['SYNTHETIC-B'] }], '2026-10-27');
    // Money is held for everyone until the re-screen reaches them (fail closed).
    assert.ok((await effective('person', quentin.id)).reasons.includes('rescreen_due'));
    await drain(main.worker);
    const [run] = await runOf(sdn2);
    assert.equal(run?.state, 'done');
    assert.equal(run?.candidates_screened, 1, 'only the subject sharing a token with the added entry is a candidate');
    assert.equal(run?.matches_opened, 1);
    assert.equal((run?.screened_delta as number) + (run?.screened_full as number) + (run?.already_current as number), subjects, 'the candidate is current in the second pass');
    assert.ok((run?.screened_delta as number) > 150, 'subjects whose clear carries over get a delta clear');
    const anselResults = await results(ansel.id);
    assert.deepEqual(anselResults.map((r) => [r.trigger, r.outcome]), [['list_update', 'clear'], ['list_update', 'possible_match']]);
    const matches = (await admin.query<{ entry_uid: string; state: string }>('SELECT entry_uid, state FROM trustwork.screening_match WHERE subject_person_id = $1', [ansel.id])).rows;
    assert.deepEqual(matches, [{ entry_uid: '920010', state: 'open' }]);
    const state = await effective('person', ansel.id);
    assert.deepEqual([state.moneyHeld, state.reasons], [true, ['review_pending']]);
    const reviews = await outbox('screening.review_requested');
    assert.equal(reviews.length, reviewBefore + 1, 'one review case for the subject');
    assert.equal(await count("SELECT 1 FROM trustwork.job WHERE kind = 'screening.screen_subject' AND payload -> 'subject' ->> 'id' = $1", [ansel.id]), 0, 'no other trigger screened the subject');
    // Everyone else is clear against the new versions: no rescreen_due left.
    assert.deepEqual((await effective('person', quentin.id)).reasons, []);
    assert.deepEqual((await effective('company', freight)).reasons, []);
    const delta = (await admin.query<{ base_versions: string[]; result_id: string }>("SELECT base_versions, result_id FROM trustwork.screening_rescreen_item WHERE run_id = $1 AND subject_person_id = $2", [run?.id, quentin.id])).rows[0];
    assert.deepEqual([...(delta?.base_versions ?? [])].sort(), [world.versions.sdn, world.versions.cons].sort(), 'the delta item names the versions the earlier clear was against');
    const quentinLast = (await results(quentin.id)).at(-1);
    assert.deepEqual([quentinLast?.outcome, [...(quentinLast?.list_version_ids ?? [])].sort()], ['clear', [sdn2, world.versions.cons].sort()]);
    assert.equal(await count('SELECT 1 FROM trustwork.screening_rescreen_item WHERE run_id = $1', [run?.id]), (run?.screened_delta as number) + (run?.screened_full as number) + 1);
  });

  await t.test('running the same delta twice opens no duplicate matches', async () => {
    const matchesBefore = await count('SELECT 1 FROM trustwork.screening_match');
    const resultsBefore = await count('SELECT 1 FROM trustwork.screening_result');
    const reviewsBefore = (await outbox('screening.review_requested')).length;
    // The same activation event delivered again (a duplicate outbox row): the run of that version exists already.
    const original = (await admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM trustwork.outbox_event WHERE type = 'screening.list_version_activated' AND payload ->> 'versionId' = $1", [sdn2])).rows[0];
    await owner((trx) => trx.insertInto('outbox_event').values({ aggregate_kind: 'screening_list', aggregate_id: world.lists.sdn, revision: 2, type: 'screening.list_version_activated', payload: JSON.stringify(original?.payload) }).execute());
    await drain(main.worker);
    assert.equal((await runOf(sdn2)).length, 1, 'one run per (list version)');
    assert.deepEqual(await tx(workerPool, (trx) => rescreenPort.request(trx, { trigger: 'list_version', listVersionId: sdn2, windowSeconds: 3600 })).then((r) => r.created), false);
    // Every subject goes through the same versions again (a full pass): nothing is opened twice, nothing re-recorded.
    const weekly = await rescreenWeeklyTask(main.runtime).run();
    assert.equal(weekly.queued, 1);
    await drain(main.worker);
    const full = await latestRun();
    assert.deepEqual([full?.trigger, full?.state, full?.matches_opened], ['scheduled', 'done', 0]);
    assert.equal(full?.verified, subjects - 1, 'every current clear is verified without a new result');
    assert.equal(await count('SELECT 1 FROM trustwork.screening_match'), matchesBefore, 'no duplicate match');
    assert.equal(await count('SELECT 1 FROM trustwork.screening_result'), resultsBefore + 1, 'only the open case is recorded again (it touches its match)');
    assert.equal((await outbox('screening.review_requested')).length, reviewsBefore, 'no second review notification');
    assert.equal(await count('SELECT 1 FROM trustwork.screening_match WHERE subject_person_id = $1', [ansel.id]), 1);
  });

  await t.test('a run interrupted half-way by an error resumes without re-screening finished subjects', async () => {
    const consV2 = await activateList(workerPool, world.lists.cons, [...CONS_ENTRIES, { uid: '930002', type: 'individual', firstName: 'Nobody', lastName: 'SYNTHETICUS', programs: ['SYNTHETIC-D'] }], '2026-10-28');
    // Queue and start the run, but run its batches by hand.
    const runId = await tx(workerPool, async (trx) => {
      const { runId: id } = await rescreenPort.request(trx, { trigger: 'list_version', listVersionId: consV2, windowSeconds: 3600 });
      await rescreenPort.promote(trx, 3600);
      return id;
    });
    const deps = { config: { ...DEFAULT_RESCREEN_CONFIG, batchSize: 50 }, screening: CONFIG, cache: new VersionCache() };
    const batch = () => tx(workerPool, (trx) => runBatch(trx, deps, runId));
    // Candidates phase (nobody shares a token with the added entry) and two batches of the full pass.
    let report = await batch();
    while (report.kind !== 'phase') report = await batch();
    await batch();
    await batch();
    const halfway = await runOf(consV2).then((r) => r[0]);
    assert.equal(halfway?.subjects_done, 100);
    const finished = (await admin.query<{ subject_person_id: string | null; subject_company_id: string | null; result_id: string }>('SELECT subject_person_id, subject_company_id, result_id FROM trustwork.screening_rescreen_item WHERE run_id = $1', [runId])).rows;
    // The third batch does all its work, then the transaction dies before COMMIT.
    await assert.rejects(tx(workerPool, async (trx) => {
      await runBatch(trx, deps, runId);
      throw new Error('synthetic crash before commit');
    }), /synthetic crash/);
    const after = await runOf(consV2).then((r) => r[0]);
    assert.deepEqual([after?.cursor_id, after?.subjects_done], [halfway?.cursor_id, 100], 'the cursor did not move');
    for (;;) {
      report = await batch();
      if (report.kind === 'done') break;
    }
    const items = (await admin.query<{ subject_person_id: string | null; subject_company_id: string | null; result_id: string; n: number }>(
      'SELECT subject_person_id, subject_company_id, result_id, count(*) OVER (PARTITION BY coalesce(subject_person_id, subject_company_id))::int AS n FROM trustwork.screening_rescreen_item WHERE run_id = $1', [runId])).rows;
    assert.ok(items.every((i) => i.n === 1), 'one item per subject and run');
    for (const done of finished) assert.ok(items.some((i) => i.result_id === done.result_id), 'finished subjects keep their result');
    const final = await runOf(consV2).then((r) => r[0]);
    assert.deepEqual([final?.state, final?.subjects_done], ['done', subjects]);
    // Results of this version per subject: at most one each (nobody screened twice).
    const twice = await count(`SELECT 1 FROM trustwork.screening_result r WHERE $1 = ANY (r.list_version_ids) GROUP BY coalesce(r.subject_person_id, r.subject_company_id) HAVING count(*) > 1`, [consV2]);
    assert.equal(twice, 0);
  });

  await t.test('a worker killed with SIGKILL mid-batch: the run resumes from its cursor and screens nobody twice', async () => {
    const sdn3 = await activateList(workerPool, world.lists.sdn, [...SDN_ENTRIES, { uid: '920010', type: 'individual', firstName: 'Ansel', lastName: 'MOCKRIDGE', programs: ['SYNTHETIC-B'] },
      { uid: '920011', type: 'entity', lastName: 'GREYMARSH SYNTHETIC TRADING', programs: ['SYNTHETIC-C'] }], '2026-10-29');
    await tx(workerPool, async (trx) => {
      await rescreenPort.request(trx, { trigger: 'list_version', listVersionId: sdn3, windowSeconds: 3600 });
      await kickRescreen(trx, async (request) => trx.insertInto('job').values({ kind: request.kind, payload: JSON.stringify(request.payload) }).execute(), { config: DEFAULT_RESCREEN_CONFIG, log: () => undefined });
    });
    const ready = join(dir, 'ready');
    // The candidates pass (one batch per 50 subjects and an empty one), two committed batches of the full pass, then the crash.
    const crashAt = Math.ceil(subjects / 50) + 1 + 3;
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE], { env: { ...process.env, WORKER_DATABASE_URL: env.workerUrl, CRASH_READY: ready, CRASH_AT: String(crashAt), RESCREEN_BATCH: '50' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
    await waitFor(() => existsSync(ready) || child.exitCode !== null, 90_000, 'the child to block inside a batch');
    assert.ok(existsSync(ready), `child exited early: ${stderr.slice(-800)}`);
    const [before] = await runOf(sdn3);
    const committed = (await admin.query<{ result_id: string }>('SELECT result_id FROM trustwork.screening_rescreen_item WHERE run_id = $1', [before?.id])).rows.map((r) => r.result_id);
    assert.equal(before?.subjects_done, 100, 'the run is half-way: two batches of the full pass committed');
    child.kill('SIGKILL');
    assert.equal(await exited, 'SIGKILL');
    // The survivor parks the expired lease and reconciles the transactional batch back to the queue.
    const survivor = rescreenWorker(workerPool, { config: { batchSize: 50 } });
    await waitFor(async () => (await admin.query("SELECT 1 FROM trustwork.job WHERE kind = $1 AND state = 'leased' AND leased_until < now()", [RESCREEN_BATCH_KIND])).rowCount === 1, 20_000, 'lease expiry');
    // The maintenance task parks the expired lease and, the kind being transactional, reconciles it back to the queue.
    const registry = new HandlerRegistry().onJob({ kind: RESCREEN_BATCH_KIND, mode: 'transactional', run: async () => undefined });
    const expired = await expireLeasesTask({ pool: workerPool, registry, config: defaultWorkerConfig(), metrics: survivor.metrics, log: () => undefined }).run();
    assert.equal(expired.autoReconciled, 1);
    await drain(survivor.worker);
    const [after] = await runOf(sdn3);
    assert.deepEqual([after?.state, after?.subjects_done], ['done', subjects]);
    const items = (await admin.query<{ result_id: string; n: number }>(
      'SELECT result_id, count(*) OVER (PARTITION BY coalesce(subject_person_id, subject_company_id))::int AS n FROM trustwork.screening_rescreen_item WHERE run_id = $1', [after?.id])).rows;
    assert.ok(items.every((i) => i.n === 1), 'one item per subject');
    for (const id of committed) assert.ok(items.some((i) => i.result_id === id), 'batches committed before the crash were not screened again');
    const twice = await count('SELECT 1 FROM trustwork.screening_result r WHERE $1 = ANY (r.list_version_ids) GROUP BY coalesce(r.subject_person_id, r.subject_company_id) HAVING count(*) > 1', [sdn3]);
    assert.equal(twice, 0);
  });

  await t.test('screening unavailable: the run waits, records nothing and money stays held', async () => {
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() - interval '30 days' WHERE baseline`.execute(trx));
    const consV3 = await activateList(workerPool, world.lists.cons, [...CONS_ENTRIES, { uid: '930003', type: 'individual', firstName: 'Ferris', lastName: 'PLACEHOLM', programs: ['SYNTHETIC-D'] }], '2026-10-30');
    const resultsBefore = await count('SELECT 1 FROM trustwork.screening_result');
    await drain(main.worker);
    const [run] = await runOf(consV3);
    assert.deepEqual([run?.state, run?.blocked_reason, run?.subjects_done], ['running', 'lists_unavailable', 0]);
    assert.equal(await count('SELECT 1 FROM trustwork.screening_result'), resultsBefore, 'nothing is recorded, least of all clear');
    const held = await effective('person', quentin.id);
    assert.equal(held.moneyHeld, true);
    assert.ok(held.reasons.includes('rescreen_due') && held.reasons.includes('lists_unavailable'), held.reasons.join(','));
    await owner((trx) => sql`UPDATE trustwork.screening_list SET last_checked_at = now() WHERE baseline`.execute(trx));
    await dueNow(admin);
    await drain(main.worker);
    const [done] = await runOf(consV3);
    assert.deepEqual([done?.state, done?.blocked_reason, done?.subjects_done], ['done', null, subjects]);
    assert.deepEqual((await effective('person', quentin.id)).reasons, []);
  });

  await t.test('the manual trigger: a compliance officer under an elevation only, audited, one unfinished full run', async () => {
    const officer = await elevate(w.people.moderator);
    await rejects(as(w.people.moderator, (trx) => rescreenStaff.requestRun(trx, { elevationId: '00000000-0000-4000-8000-000000000000', requestId: 'req-x', reasonCode: 'synthetic_test', reasonText: 'x' }, { reason: 'Synthetic', windowSeconds: 3600 })), '42501', 'admin.elevation_required');
    const auditorCtx = await elevate(w.people.auditor);
    const customerCtx = await elevate(w.people.customer);
    await rejects(as(w.people.auditor, (trx) => rescreenStaff.requestRun(trx, auditorCtx, { reason: 'Synthetic', windowSeconds: 3600 })), '42501', 'admin.forbidden');
    await rejects(as(w.people.customer, (trx) => rescreenStaff.requestRun(trx, customerCtx, { reason: 'Synthetic', windowSeconds: 3600 })), '42501', 'admin.forbidden');
    await rejects(as(w.people.moderator, (trx) => rescreenStaff.requestRun(trx, officer, { reason: 'Synthetic', windowSeconds: 60 })), '22023', 'screening.rescreen_invalid');
    await rejects(as(w.people.moderator, (trx) => rescreenStaff.requestRun(trx, officer, { reason: ' ', windowSeconds: 3600 })), '22023', 'screening.reason_required');
    const run = await as(w.people.moderator, (trx) => rescreenStaff.requestRun(trx, officer, { reason: 'Synthetic: a counsel asked for a full re-screen', windowSeconds: 3600 }));
    assert.deepEqual([run.trigger, run.mode, run.state, run.requestedBy], ['manual', 'full', 'queued', w.people.moderator]);
    assert.ok(RescreenRunSchema.safeParse(run).success);
    const leadCtx = await elevate(w.people.lead);
    const again = await as(w.people.lead, (trx) => rescreenStaff.requestRun(trx, leadCtx, { reason: 'Synthetic: second request', windowSeconds: 3600 }));
    assert.equal(again.id, run.id, 'one unfinished full run');
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'screening.rescreen_requested' AND object_id = $1", [run.id]), 2, 'both requests audited');
    // Staff read runs; anyone else reads nothing.
    assert.ok((await as(w.people.auditor, (trx) => rescreenStaff.runs(trx))).some((r) => r.id === run.id));
    assert.deepEqual(await as(w.people.customer, (trx) => rescreenStaff.runs(trx)), []);
    assert.deepEqual(await as(w.people.customer, (trx) => trx.selectFrom('screening_rescreen_item').select('id').execute()), []);
    await tx(workerPool, (trx) => kickRescreen(trx, async (request) => trx.insertInto('job').values({ kind: request.kind, payload: JSON.stringify(request.payload) }).execute(), { config: DEFAULT_RESCREEN_CONFIG, log: () => undefined }));
    await drain(main.worker);
    const done = (await as(w.people.moderator, (trx) => rescreenStaff.runs(trx))).find((r) => r.id === run.id);
    assert.deepEqual([done?.state, done?.subjectsDone, done?.matchesOpened], ['done', subjects, 0]);
  });

  await t.test('database guards: the worker reads no table, the runtime calls no worker entry point, delta clears only where they qualify', async () => {
    await rejects(tx(workerPool, (trx) => trx.selectFrom('screening_rescreen_run').select('id').execute()), '42501');
    await rejects(tx(workerPool, (trx) => trx.selectFrom('screening_rescreen_item').select('id').execute()), '42501');
    await rejects(tx(api, (trx) => rescreenPort.request(trx, { trigger: 'scheduled', listVersionId: null, windowSeconds: 3600 })), '42501');
    await rejects(tx(api, (trx) => rescreenPort.subjects(trx, null, 10)), '42501');
    await rejects(tx(workerPool, (trx) => rescreenPort.request(trx, { trigger: 'manual' as never, listVersionId: null, windowSeconds: 3600 })), '22023', 'screening.rescreen_invalid');
    const finished = (await latestRun()) as { id: string };
    await rejects(tx(workerPool, (trx) => rescreenPort.advance(trx, { runId: finished.id, phase: null, cursor: null, counts: {}, finished: false, blocked: null })), '23514', 'screening.rescreen_not_running');
    // A running delta run, held open: forged delta clears.
    const consV4 = await activateList(workerPool, world.lists.cons, [...CONS_ENTRIES, { uid: '930004', type: 'individual', firstName: 'Ida', lastName: 'NONMATCHWELL', programs: ['SYNTHETIC-D'] }], '2026-10-31');
    const runId = await tx(workerPool, async (trx) => {
      const { runId: id } = await rescreenPort.request(trx, { trigger: 'list_version', listVersionId: consV4, windowSeconds: 3600 });
      await rescreenPort.promote(trx, 3600);
      return id;
    });
    const active = (await admin.query<{ id: string }>("SELECT v.id FROM trustwork.screening_list_version v JOIN trustwork.screening_list l ON l.id = v.list_id WHERE v.state = 'active' AND l.status = 'active' ORDER BY v.id")).rows.map((r) => r.id);
    const rowOf = async (id: string) => (await tx(workerPool, (trx) => rescreenPort.subjects(trx, null, 5000))).find((r) => r.id === id);
    const quentinRow = await rowOf(quentin.id);
    const anselRow = await rowOf(ansel.id);
    const item = (row: NonNullable<typeof quentinRow>, base = row.screenedVersions) => ({ subject: { kind: row.kind, id: row.id }, namesDigest: row.namesDigest, screenedNamesDigest: row.lastScreenedNamesDigest ?? 'a'.repeat(64), baseVersions: base });
    await rejects(tx(workerPool, (trx) => rescreenPort.recordDelta(trx, { runId, listVersionIds: active.slice(0, 1), matcherVersion: MATCHER_VERSION, fuzzyThreshold: null, items: [item(quentinRow!)] })), '23514', 'screening.stale_versions');
    const forged = await tx(workerPool, (trx) => rescreenPort.recordDelta(trx, {
      runId, listVersionIds: active, matcherVersion: MATCHER_VERSION, fuzzyThreshold: null,
      items: [item(anselRow!), item(quentinRow!, [world.versions.sdn]), { ...item(quentinRow!), subject: { kind: 'company', id: freight } }],
    }));
    assert.equal(forged.recorded, 0, 'a subject with a match, a wrong base and a mismatched digest are all refused');
    assert.equal(forged.refused.length, 3);
    const other = await tx(workerPool, (trx) => rescreenPort.recordDelta(trx, { runId, listVersionIds: active, matcherVersion: 'engine-rule-0', fuzzyThreshold: null, items: [item(quentinRow!)] }));
    assert.equal(other.recorded, 0, 'another matcher version cannot carry a clear over');
    await rejects(tx(workerPool, (trx) => rescreenPort.recordItems(trx, runId, [{ subject: { kind: 'person', id: quentin.id }, resultId: (anselRow as { id: string }).id, phase: 'all' }])), '22023', 'screening.rescreen_invalid');
    // A full run never records delta clears.
    await rejects(tx(workerPool, (trx) => rescreenPort.recordDelta(trx, { runId: finished.id, listVersionIds: active, matcherVersion: MATCHER_VERSION, fuzzyThreshold: null, items: [] })), '23514', 'screening.rescreen_not_running');
    // Rows are append-only and runs are never deleted.
    await rejects(owner((trx) => trx.deleteFrom('screening_rescreen_run').where('id', '=', finished.id).execute()), '23514', 'screening.record_permanent');
    const anyItem = (await admin.query<{ id: string }>('SELECT id FROM trustwork.screening_rescreen_item LIMIT 1')).rows[0]?.id as string;
    await rejects(owner((trx) => trx.updateTable('screening_rescreen_item').set({ outcome: 'possible_match' }).where('id', '=', anyItem).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.deleteFrom('screening_rescreen_item').where('id', '=', anyItem).execute()), '23000', 'audit.append_only');
    await rejects(owner((trx) => trx.updateTable('screening_rescreen_run').set({ state: 'queued' }).where('id', '=', runId).execute()), '23514', 'screening.rescreen_transition');
    // Let the held-open run finish normally.
    await tx(workerPool, (trx) => kickRescreen(trx, async (request) => trx.insertInto('job').values({ kind: request.kind, payload: JSON.stringify(request.payload) }).execute(), { config: DEFAULT_RESCREEN_CONFIG, log: () => undefined }));
    await drain(main.worker);
    assert.equal((await runOf(consV4))[0]?.state, 'done');
  });

  await t.test('two workers at once: one batch of a run at a time, no subject screened twice', async () => {
    await population(admin, { persons: 120, companies: 10, offset: 5000 });
    const all = await count('SELECT id FROM trustwork.person UNION ALL SELECT id FROM trustwork.company');
    const consV5 = await activateList(workerPool, world.lists.cons, [...CONS_ENTRIES, { uid: '930005', type: 'individual', firstName: 'Hollis', lastName: 'NEVERMATCH', programs: ['SYNTHETIC-D'] }], '2026-11-01');
    const a = rescreenWorker(env.workerPool(6), { config: { batchSize: 50 } });
    const b = rescreenWorker(env.workerPool(6), { config: { batchSize: 50 } });
    await Promise.all([drain(a.worker), drain(b.worker)]);
    await drain(a.worker);
    const [run] = await runOf(consV5);
    assert.deepEqual([run?.state, run?.subjects_done], ['done', all]);
    const twice = await count('SELECT 1 FROM trustwork.screening_rescreen_item WHERE run_id = $1 GROUP BY coalesce(subject_person_id, subject_company_id) HAVING count(*) > 1', [run?.id]);
    assert.equal(twice, 0);
    assert.equal(await count("SELECT 1 FROM trustwork.screening_rescreen_run WHERE state = 'running'"), 0);
    const fresh = await count(`SELECT 1 FROM trustwork.screening_result r WHERE $1 = ANY (r.list_version_ids) GROUP BY coalesce(r.subject_person_id, r.subject_company_id) HAVING count(*) > 1`, [consV5]);
    assert.equal(fresh, 0);
  });

  await t.test('the watchdog: a lost batch chain fails the run with an alert and it resumes; an overdue run alerts once; cohort gauges', async () => {
    const consV6 = await activateList(workerPool, world.lists.cons, [...CONS_ENTRIES, { uid: '930006', type: 'individual', firstName: 'Linnea', lastName: 'OUTOFREACH', programs: ['SYNTHETIC-D'] }], '2026-11-02');
    const watcher = rescreenWorker(workerPool, { config: { batchSize: 50, retryAfterSeconds: 3600 } });
    // Relay the activation (the run starts and its first batch is queued), then lose the batch chain (dead letter).
    await watcher.worker.runOnce({ rethrow: true });
    await watcher.worker.idle();
    await admin.query("UPDATE trustwork.job SET state = 'dead' WHERE kind = $1 AND state IN ('queued', 'leased')", [RESCREEN_BATCH_KIND]);
    const tick = rescreenTickTask({ pool: workerPool, config: watcher.runtime.config, log: watcher.runtime.log, metrics: watcher.metrics });
    const first = await tick.run();
    assert.equal(first.alerts, 1);
    const [failed] = await runOf(consV6);
    assert.deepEqual([failed?.state, failed?.last_error, failed?.failures], ['failed', 'batch_lost', 1]);
    const alert = (await outbox('screening.rescreen_run_alert')).at(-1);
    assert.deepEqual(alert?.payload, { runId: failed?.id, trigger: 'list_version', alert: 'failed', mutable: false });
    assert.equal(watcher.metrics.value('trustwork_rescreen_alerts_total', { kind: 'failed' }), 1);
    assert.ok(watcher.logs.some((l) => l.level === 'error' && l.fields.runId === failed?.id));
    // Within the retry interval it stays failed; after it, the run resumes from its cursor.
    await tick.run();
    assert.equal((await runOf(consV6))[0]?.state, 'failed');
    const resumeTick = rescreenTickTask({ pool: workerPool, config: { ...watcher.runtime.config, retryAfterSeconds: 0 }, log: watcher.runtime.log, metrics: watcher.metrics });
    await resumeTick.run();
    const [resumed] = await runOf(consV6);
    assert.deepEqual([resumed?.state, resumed?.resumed], ['running', 1]);
    // Past its window: one overdue alert, not two.
    await owner((trx) => sql`UPDATE trustwork.screening_rescreen_run SET started_at = now() - interval '7 hours' WHERE id = ${resumed?.id}::uuid`.execute(trx));
    const overdue = await tick.run();
    assert.equal(overdue.alerts, 1);
    assert.equal((await tick.run()).alerts, 0);
    assert.equal(watcher.metrics.value('trustwork_rescreen_run_overdue', { trigger: 'list_version' }), 1);
    await drain(watcher.worker);
    const [done] = await runOf(consV6);
    assert.deepEqual([done?.state, done?.subjects_done], ['done', await count('SELECT id FROM trustwork.person UNION ALL SELECT id FROM trustwork.company')]);
    await tick.run();
    assert.equal(watcher.metrics.value('trustwork_rescreen_run_progress_ratio', { trigger: 'list_version' }), 1);
    assert.equal(watcher.metrics.value('trustwork_rescreen_run_state', { trigger: 'list_version', state: 'done' }), 1);
    assert.ok((watcher.metrics.value('trustwork_rescreen_run_subjects_per_minute', { trigger: 'list_version' }) ?? 0) > 0);
    assert.equal(watcher.metrics.value('trustwork_rescreen_run_overdue', { trigger: 'list_version' }), 0);
  });

  await t.test('privacy: logs, metrics and events carry identifiers and counts only', async () => {
    const text = JSON.stringify(logs) + main.metrics.render();
    for (const name of ['Ansel', 'Mockridge', 'Quentin', 'Brightwater', 'Brightquay', syntheticName(3, 'person').split(' ')[0] as string]) assert.ok(!text.includes(name), `no log or metric names ${name}`);
    for (const event of [...await outbox('screening.rescreen_run_finished'), ...await outbox('screening.rescreen_run_alert')]) {
      assert.deepEqual(Object.keys(event.payload).filter((k) => !['runId', 'trigger', 'mode', 'subjectsTotal', 'subjectsDone', 'matchesOpened', 'durationSeconds', 'alert', 'mutable'].includes(k)), []);
    }
    assert.ok((main.metrics.value('trustwork_rescreen_subjects_total', { mode: 'delta', method: 'delta' }) ?? 0) > 0);
    assert.ok((main.metrics.value('trustwork_rescreen_matches_opened_total') ?? 0) >= 1);
  });
});
