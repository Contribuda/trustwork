import { createPool, databaseConfigFromEnv, maintenance, type DataPool, type SweepOptions, type SweepReport } from '../deps/data.js';
import { withoutPrincipal } from '../common/db.js';

/**
 * Bounded-table sweeper (worker-callable): expired/consumed auth tokens, expired login failures and idempotency
 * records, settled admission leases past the grace period, old revoked/expired sessions and never-verified signups
 * older than seven days. Runs with the restricted runtime role (`trustwork.sweep_expired` is owner-run).
 *
 *   API_DATABASE_URL=... npm run sweep -w @trustwork/api
 */
export function runSweep(pool: DataPool, options: SweepOptions = {}): Promise<SweepReport> {
  return withoutPrincipal(pool, (trx) => maintenance.sweepExpired(trx, options));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const env = process.env;
  const pool = createPool(databaseConfigFromEnv({ ...env, DATABASE_URL: env.API_DATABASE_URL ?? env.DATABASE_URL }, 'trustwork-sweep'));
  try {
    console.log(JSON.stringify(await runSweep(pool), null, 2));
  } finally {
    await pool.end();
  }
}
