import type { DataPool } from '@trustwork/data';
import { verificationWorker, type DueCheck } from '../../../../packages/data/src/repositories/verification.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';

/**
 * Scheduled re-checks of verification results (HUB-003 part 4). Every hour the worker takes the results that expire
 * within a week and re-checks what an adapter can re-check without a person:
 *
 * - **fake** providers (tests and demos) repeat their deterministic answer: the same result as before, with a `fake:`
 *   evidence reference that names the check type, so a demo hub's standing never silently lapses;
 * - **manual** results wait for a reviewer: the console lists them (`GET .../verification/rechecks`);
 * - **live** providers have no adapter yet (they arrive with the country packs); they are reported, never guessed;
 * - the **sanctions** check is re-screened by SANC-003's own re-screening, not here.
 *
 * A result that a reviewer or another worker replaced in the meantime is skipped (`verification.superseded`).
 */
export interface RecheckDeps { pool: DataPool; log: Logger; withinDays?: number; batch?: number }

export function fakeAnswer(due: DueCheck): { result: 'pass' | 'fail' | 'inconclusive' | 'unavailable'; evidenceRef: string } {
  return { result: due.result as 'pass' | 'fail' | 'inconclusive' | 'unavailable', evidenceRef: `fake:${due.check_type}:recheck` };
}

export async function runRechecks(deps: RecheckDeps): Promise<Record<string, number>> {
  const counts = { rechecked: 0, awaitingReviewer: 0, liveWithoutAdapter: 0, superseded: 0, screening: 0 };
  const due = await inTransaction(deps.pool, (trx) => verificationWorker.dueAll(trx, deps.withinDays ?? 7, deps.batch ?? 200));
  for (const item of due) {
    if (item.provider_mode === 'screening') { counts.screening += 1; continue; }
    if (item.provider_mode === 'manual') { counts.awaitingReviewer += 1; continue; }
    if (item.provider_mode === 'live') { counts.liveWithoutAdapter += 1; continue; }
    const answer = fakeAnswer(item);
    try {
      await inTransaction(deps.pool, (trx) => verificationWorker.recordAdapterResult(trx, item.check_id, answer.result, answer.evidenceRef));
      counts.rechecked += 1;
    } catch (error) {
      if ((error as { hint?: string }).hint === 'verification.superseded') { counts.superseded += 1; continue; }
      throw error;
    }
  }
  if (counts.liveWithoutAdapter > 0) deps.log('warn', 'verification re-checks wait for live adapters', { count: counts.liveWithoutAdapter });
  return counts;
}

export function verificationRecheckTask(deps: RecheckDeps): ScheduledTask {
  return { name: 'verification.recheck', intervalSeconds: 3600, run: () => runRechecks(deps) };
}
