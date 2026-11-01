import { createPool, databaseConfigFromEnv, withMaintenance, type DataPool } from '../../../deps/data.js';
import { SETUP_TOKEN_TTL_HOURS, setupRuns } from './deps.js';
import { newSetupToken, setupTokenHash } from './token.js';

/**
 * Issues the one-time setup token (installation.md, "The setup token"): 32 random bytes, printed once to the
 * installer's terminal; only the SHA-256 and the expiry are stored. Issuing again replaces the previous token (it stops
 * working at once) and keeps the answers, so setup resumes. Refused once setup finished (`setup.finished`): the node is
 * set up and staff are assigned through the console. Owner-run: it needs the migrator connection (maintenance).
 *
 *   DATABASE_URL=<migrator url> PUBLIC_ORIGIN=https://build.example.org npm run setup:token -w @trustwork/api
 */
export async function issueSetupToken(pool: DataPool, now: Date = new Date(), ttlHours: number = SETUP_TOKEN_TTL_HOURS): Promise<{ token: string; expiresAt: Date }> {
  const token = newSetupToken();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  await withMaintenance(pool, (trx) => setupRuns.issueToken(trx, setupTokenHash(token), expiresAt));
  return { token, expiresAt };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const pool = createPool(databaseConfigFromEnv(process.env, 'trustwork-setup-token'));
  try {
    const { token, expiresAt } = await issueSetupToken(pool);
    const origin = (process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
    process.stdout.write(`Open ${origin}/admin/setup?token=${token} before ${expiresAt.toISOString()} to set up this node.\nThe token works for one setup. Run this command again to replace it.\n`);
  } catch (error) {
    const hint = (error as { hint?: string }).hint;
    process.stderr.write(hint === 'setup.finished' ? 'Setup already finished on this node; staff are assigned in the console.\n' : `Could not issue a setup token: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
