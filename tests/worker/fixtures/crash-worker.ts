/**
 * Child process for fault-injection tests: a real worker that blocks inside its work and waits to be killed with
 * SIGKILL by the parent test. Never imported by the test runner (no .test suffix).
 *
 *   CRASH_MODE=external-after-effect | external-before-effect | transactional | relay
 *   CRASH_LEDGER=<file>   fake provider ledger shared with the parent (one line per external effect)
 *   CRASH_READY=<file>    written when the worker is blocked at the injection point
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { inbox } from '@trustwork/data';
import { createWorkerPool, HandlerRegistry, Worker } from '@trustwork/worker';

const mode = process.env.CRASH_MODE ?? '';
const ledger = process.env.CRASH_LEDGER ?? '';
const ready = process.env.CRASH_READY ?? '';
const url = process.env.WORKER_DATABASE_URL ?? '';
if (!mode || !ledger || !ready || !url) throw new Error('CRASH_MODE, CRASH_LEDGER, CRASH_READY and WORKER_DATABASE_URL are required');

const forever = new Promise<never>(() => {});
const blocked = (): Promise<never> => {
  writeFileSync(ready, `${process.pid}\n`);
  return forever;
};
setInterval(() => {}, 1_000);

const registry = new HandlerRegistry()
  .onJob({
    kind: 'crash.external', mode: 'external',
    run: async (context) => {
      // The fake provider commits the effect (ledger line) before the worker could persist the result.
      if (mode === 'external-after-effect') appendFileSync(ledger, `effect ${context.effectKey} ${context.attemptId} pid=${process.pid}\n`);
      return blocked();
    },
  })
  .onJob<{ n: string }>({
    kind: 'crash.transactional', mode: 'transactional',
    run: async (context) => {
      await inbox.record(context.trx, { provider: 'crash', account: 'transactional', event_id: context.payload.n });
      return blocked();
    },
  })
  .onOutbox({
    name: 'crash.relay', type: 'crash.event',
    handle: async (event, context) => {
      await inbox.record(context.trx, { provider: 'crash', account: 'relay', event_id: event.id });
      return blocked();
    },
  });

const worker = new Worker({
  pool: createWorkerPool(url, 4),
  registry,
  config: { workerId: `crash-${process.pid}`, leaseSeconds: 2, heartbeatMs: 300, externalTimeoutMs: 600_000 },
  tasks: () => [],
});
// One iteration reaches the injection point; the child runs no scheduled maintenance.
void worker.runOnce({ rethrow: true });
