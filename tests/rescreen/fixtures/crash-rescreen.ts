/**
 * Child process for the SANC-005 crash test: a real worker that runs re-screening batches and, inside batch number
 * CRASH_AT (after the batch did all its work, before its transaction commits), blocks and waits to be killed with
 * SIGKILL by the parent test. Never imported by the test runner (no .test suffix).
 *
 *   WORKER_DATABASE_URL=<worker login>  CRASH_AT=<batch number>  CRASH_READY=<file written when blocked>  RESCREEN_BATCH=<size>
 */
import { writeFileSync } from 'node:fs';
import { createWorkerPool, HandlerRegistry, Worker } from '@trustwork/worker';
import { RESCREEN_BATCH_ATTEMPTS, RESCREEN_BATCH_KIND, runBatch, VersionCache } from '../../../apps/worker/src/rescreen/index.js';
import { DEFAULT_RESCREEN_CONFIG } from '../../../apps/worker/src/rescreen/config.js';
import { DEFAULT_SCREENING_CONFIG } from '../../../apps/worker/src/screening/config.js';

const url = process.env.WORKER_DATABASE_URL ?? '';
const ready = process.env.CRASH_READY ?? '';
const crashAt = Number(process.env.CRASH_AT ?? '0');
const batchSize = Number(process.env.RESCREEN_BATCH ?? '50');
if (!url || !ready || !Number.isInteger(crashAt) || crashAt < 1) throw new Error('WORKER_DATABASE_URL, CRASH_READY and CRASH_AT are required');

const forever = new Promise<never>(() => {});
setInterval(() => {}, 1_000);
const deps = { config: { ...DEFAULT_RESCREEN_CONFIG, batchSize }, screening: DEFAULT_SCREENING_CONFIG, cache: new VersionCache() };
let calls = 0;
const registry = new HandlerRegistry().onJob<{ runId: string }>({
  kind: RESCREEN_BATCH_KIND,
  mode: 'transactional',
  run: async (context) => {
    calls += 1;
    const report = await runBatch(context.trx, deps, context.payload.runId);
    if (report.next) await context.enqueue({ kind: RESCREEN_BATCH_KIND, payload: { runId: report.runId }, maxAttempts: RESCREEN_BATCH_ATTEMPTS, delaySeconds: report.next.delaySeconds });
    if (calls === crashAt) {
      writeFileSync(ready, `${process.pid}\n`);
      await forever;
    }
  },
});
const pool = createWorkerPool(url, 4);
const worker = new Worker({ pool, registry, config: { workerId: `rescreen-crash-${process.pid}`, leaseSeconds: 3, pollIntervalMs: 20, concurrency: 1 }, tasks: () => [] });
worker.start();
