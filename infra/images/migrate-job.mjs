// One-shot release job of the migrate image (OPS-002). Runs as the migrator role, never as a runtime role.
//   node bin/migrate-job.mjs [release]          migrate up, then the kernel reference-data sync (default)
//   node bin/migrate-job.mjs up|status|verify   the migration runner (packages/data/src/migrate/cli.ts)
//   node bin/migrate-job.mjs kernel-sync [--dry-run]
// Connection: DATABASE_URL or TRUSTWORK_DATABASE_HOST/PORT/NAME/USER/PASSWORD of the migrator. The job refuses a login
// that is a member of trustwork_app or trustwork_worker (the API and worker groups) unless it is a superuser (local
// compose only). Exit codes: 0 ok, 1 failure, 2 usage or configuration, 3 refused role. Same logic as
// packages/data/bin/migrate.mjs and kernel-sync.mjs, but over the compiled tree (no tsx in the image).
import pg from 'pg';
import { runCli } from '../packages/data/src/migrate/cli.js';
import { APP_ROLE, WORKER_ROLE, databaseConfigFromEnv } from '../packages/data/src/config.js';
import { createPool, withMaintenance } from '../packages/data/src/pool.js';
import { kernelReference, kernelSync } from '../packages/data/src/repositories/kernel.js';

const out = { log: (line) => console.log(line), error: (line) => console.error(line) };
const USAGE = 'usage: migrate-job.mjs [release | up | status | verify | kernel-sync [--dry-run]]';

/** Returns null when the connected login may migrate, otherwise the runtime groups it belongs to. */
async function refusedRuntimeRole(env) {
  const client = new pg.Client(databaseConfigFromEnv(env, 'trustwork-migrate-guard'));
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT r.rolname, me.rolsuper FROM pg_roles me CROSS JOIN pg_roles r
        WHERE me.rolname = current_user AND r.rolname = ANY($1::text[]) AND pg_has_role(current_user, r.oid, 'MEMBER')`,
      [[APP_ROLE, WORKER_ROLE]],
    );
    if (rows.length === 0 || rows[0].rolsuper) return null;
    return rows.map((row) => row.rolname);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function guard(env) {
  try {
    const groups = await refusedRuntimeRole(env);
    if (!groups) return 0;
    out.error(`refused: the database login is a member of ${groups.join(', ')}; run migrations as the migrator role, never as a runtime role`);
    return 3;
  } catch (error) {
    out.error(`migrate guard failed: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof Error && /No database configured|TRUSTWORK_DATABASE_/.test(error.message) ? 2 : 1;
  }
}

async function kernel(env, dryRun) {
  const data = await kernelReference.fromRepository();
  const summary = `restricted=${data.restricted.length} units=${data.units.length} rules=${data.conversionRules.length} jurisdictions=${data.jurisdictions.length} terms=${data.taxonomy.terms.length} relations=${data.taxonomy.relations.length}`;
  if (dryRun) {
    out.log(`kernel-sync (dry run): ${summary}`);
    return 0;
  }
  const pool = createPool(databaseConfigFromEnv(env, 'trustwork-kernel-sync'));
  try {
    const report = await withMaintenance(pool, (trx) => kernelSync.apply(trx, data));
    out.log(`kernel-sync: ${JSON.stringify(report)}`);
    return 0;
  } catch (error) {
    out.error(`kernel-sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

async function main(argv, env) {
  const [command = 'release', ...rest] = argv;
  if (command === 'status' || command === 'verify') return runCli([command, ...rest], env, out);
  if (command === 'kernel-sync') {
    if (rest.some((arg) => arg !== '--dry-run')) { out.error(USAGE); return 2; }
    if (rest.includes('--dry-run')) return kernel(env, true);
    return (await guard(env)) || kernel(env, false);
  }
  if (command === 'up') return (await guard(env)) || runCli(['up', ...rest], env, out);
  if (command === 'release' && rest.length === 0) {
    const refused = await guard(env);
    if (refused) return refused;
    const migrated = await runCli(['up'], env, out);
    if (migrated !== 0) return migrated;
    return kernel(env, false);
  }
  out.error(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2), process.env);
