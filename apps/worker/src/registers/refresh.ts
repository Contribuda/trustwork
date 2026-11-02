import type { DataPool } from '@trustwork/data';
import { registersWorker } from '../../../../packages/data/src/repositories/registers.js';
import { fakeRegisterObservations } from '../../../../packages/contracts/src/sourced-facts.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';

/**
 * Register facts in the worker (REG-001 part 2).
 *
 * - **Refresh** (hourly tick): adapters whose cadence has passed re-observe the records they already hold. A **fake**
 *   adapter computes its deterministic observations for those identifiers (or record references) and records them with
 *   no person as author; an unchanged record adds nothing. A **live** adapter has no code yet: it is reported once per
 *   cadence and never guessed. Nothing new is discovered here (discovery belongs to datasets, MINE-001).
 * - **Expiry watch** (hourly tick, idempotent): claimed and verified companies get one reminder per step (60, 30 and 7
 *   days) before a licence or registration lapses; company administrators read them on the company's reminders route.
 */
export interface RegistersDeps { pool: DataPool; log: Logger; now?: () => Date; batch?: number }

export async function refreshRegisters(deps: RegistersDeps): Promise<Record<string, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const counts = { refreshed: 0, observations: 0, liveWithoutAdapter: 0, empty: 0 };
  const due = await inTransaction(deps.pool, (trx) => registersWorker.dueAdapters(trx, now, deps.batch ?? 50));
  for (const adapter of due) {
    if (adapter.mode === 'live') {
      await inTransaction(deps.pool, (trx) => registersWorker.markVisited(trx, adapter.id, now));
      counts.liveWithoutAdapter += 1;
      continue;
    }
    const subjects = await inTransaction(deps.pool, (trx) => registersWorker.adapterSubjects(trx, adapter.id, 5000));
    const observations = fakeRegisterObservations(adapter.adapter, subjects.map((s) => (s.identifier_value !== null ? { identifierValue: s.identifier_value } : { identifierValue: null, recordRef: s.record_ref as string })), now);
    counts.observations += await inTransaction(deps.pool, (trx) => registersWorker.recordAdapterRun(trx, adapter.id, observations, now));
    if (subjects.length === 0) counts.empty += 1; else counts.refreshed += 1;
  }
  if (counts.liveWithoutAdapter > 0) deps.log('warn', 'register adapters wait for live adapter code', { count: counts.liveWithoutAdapter });
  return counts;
}

export async function runRegisterExpiryWatch(deps: RegistersDeps): Promise<Record<string, number>> {
  const now = (deps.now ?? (() => new Date()))();
  const reminders = await inTransaction(deps.pool, (trx) => registersWorker.runExpiryWatch(trx, now));
  return { reminders: reminders.length };
}

export function registersRefreshTask(deps: RegistersDeps): ScheduledTask {
  return { name: 'registers.refresh', intervalSeconds: 3600, run: () => refreshRegisters(deps) };
}

export function registersExpiryTask(deps: RegistersDeps): ScheduledTask {
  return { name: 'registers.expiry_watch', intervalSeconds: 3600, run: () => runRegisterExpiryWatch(deps) };
}
