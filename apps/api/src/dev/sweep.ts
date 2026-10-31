import { createPool, databaseConfigFromEnv, maintenance, withMaintenance, type DataPool, type SweepOptions, type SweepReport } from '../deps/data.js';

/**
 * Manual bounded-table sweep for local stands: expired/consumed auth tokens, expired login failures and idempotency
 * records, settled admission leases past the grace period, old revoked/expired sessions and never-verified signups.
 * The scheduled sweep belongs to apps/worker (`trustwork.worker_sweep_expired()`, fixed intervals); the runtime API
 * role can no longer run `trustwork.sweep_expired` with caller-chosen intervals (BE-002), so this script uses the
 * migrator connection in a maintenance transaction.
 *
 *   DATABASE_URL=<migrator url> npm run sweep -w @trustwork/api
 */
export function runSweep(pool: DataPool, options: SweepOptions = {}): Promise<SweepReport> {
  return withMaintenance(pool, (trx) => maintenance.sweepExpired(trx, options));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const pool = createPool(databaseConfigFromEnv(process.env, 'trustwork-sweep'));
  try {
    console.log(JSON.stringify(await runSweep(pool), null, 2));
  } finally {
    await pool.end();
  }
}
