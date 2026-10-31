/**
 * SANC-005 measurement on the local PostgreSQL (not part of `npm test`: no `.test` suffix):
 *
 *   node --import tsx tests/rescreen/bench.ts [persons] [companies] [entries]
 *
 * Builds a synthetic hub (default 50 000 persons and 5 000 companies, every name invented by `syntheticName`) and a
 * synthetic baseline (default 15 000 SDN entries, about the size of the real SDN list, every entry invented), then times
 * three runs through the real worker and job runner:
 *
 *   1. cold: the first activation, nobody screened yet, so every subject is screened in full;
 *   2. delta: a new SDN version that adds 20 entries (two of them meet existing subjects); everyone else gets a delta
 *      clear;
 *   3. weekly: the full safety-net run over subjects already current (verification, no new rows for unchanged clears).
 *
 * Prints one JSON line per run with seconds, subjects per minute and the run's counts. No network.
 */
import { performance } from 'node:perf_hooks';
import { withMaintenance } from '@trustwork/data';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';
import { baselineIds } from '../screening-lists/helpers.js';
import { activateList, CONS_ENTRIES } from '../screening/helpers.js';
import { rescreenWeeklyTask } from '../../apps/worker/src/rescreen/index.js';
import { drain, population, rescreenWorker, syntheticEntries, syntheticName } from './helpers.js';

const persons = Number(process.argv[2] ?? 50_000);
const companies = Number(process.argv[3] ?? 5_000);
const entryCount = Number(process.argv[4] ?? 15_000);
globalThis.fetch = (async () => {
  throw new Error('network access is forbidden');
}) as typeof fetch;

const env = await provisionWorkerDatabase('rescreen_bench');
if (!env) {
  process.stderr.write(`${SKIP_REASON}\n`);
  process.exit(2);
}
try {
  const admin = env.db.admin;
  const workerPool = env.workerPool(8);
  const lists = await baselineIds(admin);
  await withMaintenance(admin, (trx) => trx.updateTable('screening_list').set({ min_entries: 1, max_drop_share: '0.99' }).where('baseline', '=', true).execute());
  let t0 = performance.now();
  await population(admin, { persons, companies });
  const populationSeconds = (performance.now() - t0) / 1000;
  const entries = syntheticEntries(entryCount);
  t0 = performance.now();
  await activateList(workerPool, lists.sdn, entries, '2026-10-20');
  await activateList(workerPool, lists.cons, CONS_ENTRIES, '2026-10-20');
  const listSeconds = (performance.now() - t0) / 1000;
  process.stdout.write(`${JSON.stringify({ setup: { persons, companies, entries: entryCount, populationSeconds: Math.round(populationSeconds), listSeconds: Math.round(listSeconds) } })}\n`);

  const { worker } = rescreenWorker(workerPool, { config: { batchSize: 500, yieldReadyJobs: 100_000 } });
  const measure = async (label: string) => {
    const since = (await admin.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now as Date;
    const start = performance.now();
    await drain(worker, 100_000);
    const seconds = (performance.now() - start) / 1000;
    // Every run that finished during this measurement, with its own duration from the database.
    const runs = (await admin.query<Record<string, number | string>>(
      `SELECT *, extract(epoch FROM finished_at - started_at)::float8 AS run_seconds FROM trustwork.screening_rescreen_run WHERE finished_at >= $1 ORDER BY finished_at`, [since])).rows;
    for (const run of runs) {
      const subjects = Number(run.subjects_done);
      const runSeconds = Number(run.run_seconds);
      process.stdout.write(`${JSON.stringify({
        run: label, trigger: run.trigger, mode: run.mode, state: run.state, seconds: Math.round(runSeconds * 10) / 10, subjectsPerMinute: Math.round(subjects / (runSeconds / 60)), subjects,
        candidates: run.candidates_screened, full: run.screened_full, delta: run.screened_delta, current: run.already_current, verified: run.verified,
        clear: run.outcome_clear, possibleMatch: run.outcome_possible_match, insufficientName: run.outcome_insufficient_name, matchesOpened: run.matches_opened, batches: run.batches,
      })}\n`);
    }
    process.stdout.write(`${JSON.stringify({ measured: label, wallSeconds: Math.round(seconds * 10) / 10 })}\n`);
  };
  // 1. cold: the two activation events start one run each; the second finds everyone current.
  await measure('cold (first activation, everyone screened in full; includes the second, all-current run)');
  // 2. delta: 20 added entries, two of them shaped like existing synthetic subjects' names.
  const meet = [syntheticName(17, 'person').split(' '), syntheticName(4242, 'person').split(' ')];
  const added = [
    ...meet.map(([first, last], i) => ({ uid: `990000${i}`, type: 'individual' as const, firstName: first as string, lastName: (last as string).toUpperCase(), programs: ['SYNTHETIC-F'] })),
    ...syntheticEntries(18, 98),
  ];
  await activateList(workerPool, lists.sdn, [...entries, ...added], '2026-10-27');
  await measure('delta (new SDN version, 20 added entries)');
  // 3. weekly: the full safety net over current subjects.
  await rescreenWeeklyTask({ pool: workerPool, config: { batchSize: 500, windowSeconds: 21_600, weeklySeconds: 604_800, retryAfterSeconds: 3600, yieldReadyJobs: 100_000, yieldSeconds: 1, blockedSeconds: 300 }, log: () => undefined }).run();
  await measure('weekly (full safety net, subjects current)');
} finally {
  await env.close();
}
