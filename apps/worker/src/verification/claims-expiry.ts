import type { DataPool } from '@trustwork/data';
import { claimsWorker } from '../../../../packages/data/src/repositories/claims.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';

/**
 * Verifications past their date (CLM-001). Every hour the worker lets them lapse: the badge disappears, the company's
 * claim status follows in the same transaction and the holder hears of it in the bell. Nothing is renewed here: a
 * re-check needs a reviewer and a passing standing (`POST .../claims/verifications/:id/recheck`).
 */
export interface ClaimsExpiryDeps { pool: DataPool; log: Logger; now?: () => Date; batch?: number }

export async function runClaimsExpiry(deps: ClaimsExpiryDeps): Promise<{ expired: number }> {
  const now = deps.now?.() ?? new Date();
  const expired = await inTransaction(deps.pool, (trx) => claimsWorker.runExpiry(trx, now, deps.batch ?? 200));
  if (expired > 0) deps.log('info', 'company verifications lapsed', { count: expired });
  return { expired };
}

export function claimsExpiryTask(deps: ClaimsExpiryDeps): ScheduledTask {
  return { name: 'claims.verification_expiry', intervalSeconds: 3600, run: () => runClaimsExpiry(deps) };
}
