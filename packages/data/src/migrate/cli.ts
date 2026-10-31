import pg from 'pg';
import { databaseConfigFromEnv } from '../config.js';
import { DEFAULT_MIGRATIONS_DIR, migrateUp, migrationStatus, statusProblems, verifyMigrations } from './runner.js';

const USAGE = `Usage: node packages/data/bin/migrate.mjs <status|up|verify> [--dir <migrations directory>]
Connection: DATABASE_URL or TRUSTWORK_DATABASE_HOST/PORT/NAME/USER/PASSWORD (never loaded from .env).
Exit codes: 0 ok, 1 failure or inconsistent ledger, 2 usage.`;

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, out: { log(s: string): void; error(s: string): void }): Promise<number> {
  const [command, ...rest] = argv;
  let directory = env.TRUSTWORK_MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir' && rest[i + 1]) { directory = rest[i + 1] as string; i++; }
    else { out.error(USAGE); return 2; }
  }
  if (command !== 'status' && command !== 'up' && command !== 'verify') { out.error(USAGE); return 2; }
  let config;
  try {
    config = databaseConfigFromEnv(env, 'trustwork-migrate');
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const client = new pg.Client(config);
  try {
    await client.connect();
    if (command === 'up') {
      const applied = await migrateUp(client, directory, { info: (m) => out.log(m) });
      out.log(applied.length ? `applied ${applied.length} migration(s)` : 'nothing to apply');
      return 0;
    }
    if (command === 'verify') {
      const status = await verifyMigrations(client, directory);
      out.log(`verified ${status.applied.length} applied migration(s); ${status.pending.length} pending`);
      return 0;
    }
    const status = await migrationStatus(client, directory);
    for (const row of status.applied) out.log(`applied  ${row.filename}  ${row.checksum.slice(0, 12)}  ${row.applied_at.toISOString()}  by ${row.applied_by}`);
    for (const file of status.pending) out.log(`pending  ${file.filename}  ${file.checksum.slice(0, 12)}`);
    const problems = statusProblems(status);
    for (const problem of problems) out.error(`problem  ${problem}`);
    return problems.length ? 1 : 0;
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}
