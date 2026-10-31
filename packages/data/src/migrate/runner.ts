import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { APP_ROLE, OWNER_ROLE, SCHEMA, WORKER_ROLE } from '../config.js';
import { parseDirectives, rowsSatisfy, splitStatements, type MigrationDirectives } from './sql.js';

export interface MigrationFile {
  /** Ledger identity: the bare file name, unique across the root and every module directory. */
  filename: string;
  /** Module directory the file lives in (`packages/data/migrations/<module>/`), or null for the flat root. */
  module: string | null;
  path: string;
  checksum: string;
  script: string;
  directives: MigrationDirectives;
}
export interface LedgerRow {
  filename: string;
  checksum: string;
  applied_at: Date;
  applied_by: string;
  duration_ms: number;
  transactional: boolean;
}
export interface MigrationStatus {
  applied: LedgerRow[];
  pending: MigrationFile[];
  /** Applied rows whose file content no longer matches the recorded checksum. */
  mismatched: { filename: string; recorded: string; actual: string }[];
  /** Applied rows whose file is no longer present in the directory. */
  missing: string[];
  /** Pending files that sort before an already applied one (forward-only ordering violated). */
  outOfOrder: string[];
}
export interface RunnerLogger { info(message: string): void }
export type MigrationClient = pg.Client | pg.PoolClient;

const FILENAME = /^\d{14}_[a-z0-9_]+\.sql$/;
const MODULE_NAME = /^[a-z][a-z0-9_-]*$/;
/** Editor and VCS artefacts that may sit in a migrations directory without being migrations. */
const IGNORED_ENTRIES = new Set(['.gitkeep', '.DS_Store']);
export const LOCK_KEY = 'trustwork.migrations';
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

export function checksumOf(script: string): string {
  return createHash('sha256').update(script).digest('hex');
}

function sortedEntries(directory: string): Dirent[] {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => !IGNORED_ENTRIES.has(entry.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function assertMigrationFile(entry: Dirent, location: string): void {
  if (!entry.isFile()) throw new Error(`Migration directory entry is not a regular file or module directory: ${location}`);
  if (!entry.name.endsWith('.sql')) throw new Error(`Non-SQL file in the migrations directory: ${location}`);
  if (!FILENAME.test(entry.name)) throw new Error(`Migration file name is not <timestamp>_<name>.sql: ${location}`);
}

/**
 * Loads and validates the migration tree: SQL files in the flat root (the foundation migrations, whose ledger
 * names never change) plus exactly one level of module directories (`<root>/<module>/<file>.sql`, one directory
 * per owning work package). File names must be `<14-digit timestamp>_<snake_name>.sql` and unique across the whole
 * tree because the bare file name is the ledger identity; files are ordered globally by name, i.e. by timestamp.
 * A nested directory, a non-SQL file, a malformed file or module name or a duplicated file name fails loudly.
 */
export function loadMigrations(directory = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const found: { filename: string; module: string | null; path: string }[] = [];
  for (const entry of sortedEntries(directory)) {
    if (entry.isDirectory()) {
      if (!MODULE_NAME.test(entry.name)) throw new Error(`Migration module directory name is not lower-case [a-z][a-z0-9_-]*: ${entry.name}`);
      const moduleDir = join(directory, entry.name);
      for (const child of sortedEntries(moduleDir)) {
        const location = `${entry.name}/${child.name}`;
        if (child.isDirectory()) throw new Error(`Nested migration directory (only one level of module directories is allowed): ${location}`);
        assertMigrationFile(child, location);
        found.push({ filename: child.name, module: entry.name, path: join(moduleDir, child.name) });
      }
      continue;
    }
    assertMigrationFile(entry, entry.name);
    found.push({ filename: entry.name, module: null, path: join(directory, entry.name) });
  }
  const seen = new Map<string, string | null>();
  for (const file of found) {
    if (seen.has(file.filename)) {
      const where = (module: string | null) => (module === null ? 'the root' : `module ${module}`);
      throw new Error(`Duplicate migration file name ${file.filename} in ${where(seen.get(file.filename) ?? null)} and ${where(file.module)} (file names are the ledger identity and must be unique)`);
    }
    seen.set(file.filename, file.module);
  }
  found.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return found.map(({ filename, module, path }) => {
    const script = readFileSync(path, 'utf8');
    return { filename, module, path, checksum: checksumOf(script), script, directives: parseDirectives(script) };
  });
}

async function withLock<T>(client: MigrationClient, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  }
}

/**
 * Idempotent cluster/database preparation executed by the connecting (migrator) role: the NOLOGIN owner,
 * runtime (API) and worker roles, the schema owned by the owner role and the checksum ledger. The migrator must be a
 * superuser or a member of the owner role; it never becomes the runtime role.
 */
export async function bootstrap(client: MigrationClient): Promise<void> {
  // Roles and parameter privileges are cluster-wide while the advisory lock is per database: two runners on
  // different databases may race here, so every step checks first and tolerates a concurrent creation.
  await retryOnce(() => client.query(`DO $bootstrap$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
      BEGIN
        CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; -- a concurrent runner on another database won the race
      END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      BEGIN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; -- a concurrent runner on another database won the race
      END;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
      BEGIN
        CREATE ROLE ${WORKER_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; -- a concurrent runner on another database won the race
      END;
    END IF;
  END $bootstrap$`));
  const version = Number((await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]?.v ?? 0);
  // SET ROLE requires the SET option of the membership on PostgreSQL 16+.
  const privilege = version >= 160000 ? 'SET' : 'MEMBER';
  const { rows } = await client.query<{ ok: boolean; user: string }>(
    `SELECT (rolsuper OR pg_has_role(current_user, $1, $2)) AS ok, current_user AS user FROM pg_roles WHERE rolname = current_user`, [OWNER_ROLE, privilege],
  );
  if (!rows[0]?.ok) throw new Error(`Migrator role ${rows[0]?.user ?? '?'} must be a superuser or a member (with SET) of ${OWNER_ROLE}`);
  await ensureParameterPrivilege(client);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA} AUTHORIZATION ${OWNER_ROLE}`);
  await client.query(`SET ROLE ${OWNER_ROLE}`);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.migration_ledger (
      filename text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL,
      duration_ms integer NOT NULL CHECK (duration_ms >= 0),
      transactional boolean NOT NULL
    )`);
  } finally {
    await client.query('RESET ROLE');
  }
}

const PARAMETER = 'trustwork.maintenance';
const CONCURRENT_CODES = new Set(['XX000', '42710', '23505']);
const isConcurrentCatalogueRace = (error: unknown): boolean => CONCURRENT_CODES.has((error as { code?: string }).code ?? '');

/**
 * The owner attaches `SET trustwork.maintenance = 'on'` to SECURITY DEFINER functions; a non-superuser may only
 * do that for a placeholder parameter it has been granted (pg_parameter_acl, PostgreSQL 15+). The ACL is
 * cluster-wide: two runners bootstrapping different databases at once both see "not granted" and both issue the
 * GRANT; the loser gets 23505 on pg_parameter_acl_parname_index (or XX000 "tuple concurrently updated"). The
 * privilege is re-checked after such a race instead of failing the migration.
 */
export async function ensureParameterPrivilege(client: Pick<MigrationClient, 'query'>): Promise<'present' | 'granted'> {
  const granted = async () => (await client.query<{ ok: boolean }>("SELECT has_parameter_privilege($1, $2, 'SET') AS ok", [OWNER_ROLE, PARAMETER])).rows[0]?.ok === true;
  if (await granted()) return 'present';
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(`GRANT SET ON PARAMETER ${PARAMETER} TO ${OWNER_ROLE}`);
      return 'granted';
    } catch (error) {
      if (!isConcurrentCatalogueRace(error) || attempt >= 2) throw error;
      if (await granted()) return 'present';
    }
  }
}

/** Catalogue races between cluster-wide steps surface as XX000 "tuple concurrently updated" or a catalogue unique violation; one retry suffices. */
async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isConcurrentCatalogueRace(error)) throw error;
    return fn();
  }
}

async function ledgerExists(client: MigrationClient): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`${SCHEMA}.migration_ledger`]);
  return rows[0]?.present === true;
}

async function readLedger(client: MigrationClient): Promise<LedgerRow[]> {
  if (!(await ledgerExists(client))) return [];
  const { rows } = await client.query<LedgerRow>(`SELECT filename, checksum, applied_at, applied_by, duration_ms, transactional FROM ${SCHEMA}.migration_ledger ORDER BY filename`);
  return rows;
}

/** Compares the ledger with the directory without changing anything. */
export async function migrationStatus(client: MigrationClient, directory = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = loadMigrations(directory);
  const applied = await readLedger(client);
  const byName = new Map(files.map((f) => [f.filename, f]));
  const appliedNames = new Set(applied.map((row) => row.filename));
  const mismatched: MigrationStatus['mismatched'] = [];
  const missing: string[] = [];
  for (const row of applied) {
    const file = byName.get(row.filename);
    if (!file) missing.push(row.filename);
    else if (file.checksum !== row.checksum) mismatched.push({ filename: row.filename, recorded: row.checksum, actual: file.checksum });
  }
  const lastApplied = applied.at(-1)?.filename ?? '';
  const pending = files.filter((f) => !appliedNames.has(f.filename));
  const outOfOrder = pending.filter((f) => f.filename < lastApplied).map((f) => f.filename);
  return { applied, pending, mismatched, missing, outOfOrder };
}

/** Problems that make the ledger untrustworthy; `up` refuses while any exist. */
export function statusProblems(status: MigrationStatus): string[] {
  return [
    ...status.mismatched.map((m) => `Checksum mismatch for applied migration ${m.filename}: ledger ${m.recorded}, file ${m.actual} (applied migrations are immutable; add a new migration instead)`),
    ...status.missing.map((name) => `Applied migration ${name} is missing from the migrations directory`),
    ...status.outOfOrder.map((name) => `Pending migration ${name} sorts before an already applied migration (forward-only ordering)`),
  ];
}

/** Verifies every applied migration against its file; throws with all problems when the ledger is inconsistent. */
export async function verifyMigrations(client: MigrationClient, directory = DEFAULT_MIGRATIONS_DIR): Promise<MigrationStatus> {
  const status = await migrationStatus(client, directory);
  const problems = statusProblems(status);
  if (problems.length) throw new Error(problems.join('\n'));
  return status;
}

type QueryResults = pg.QueryResult | pg.QueryResult[];
function affectedRows(result: QueryResults): number {
  const list = Array.isArray(result) ? result : [result];
  return list.reduce((sum, r) => (['INSERT', 'UPDATE', 'DELETE'].includes(r.command) ? sum + (r.rowCount ?? 0) : sum), 0);
}

async function applyTransactional(client: MigrationClient, file: MigrationFile): Promise<void> {
  const started = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    await client.query(`SET LOCAL search_path = ${SCHEMA}, pg_temp`);
    await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
    const result = (await client.query(file.script)) as QueryResults;
    const expect = file.directives.expectRows;
    if (expect) {
      const affected = affectedRows(result);
      if (!rowsSatisfy(expect, affected)) throw new Error(`Migration ${file.filename} affected ${affected} rows, expected ${expect.kind} ${expect.value}; rolled back`);
    }
    await client.query(
      `INSERT INTO ${SCHEMA}.migration_ledger (filename, checksum, applied_by, duration_ms, transactional) VALUES ($1, $2, session_user, $3, true)`,
      [file.filename, file.checksum, Date.now() - started],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/** No transaction block: each statement is sent alone (CREATE INDEX CONCURRENTLY). Partial failure leaves
 *  earlier statements applied and no ledger row, so such files must be written idempotently (IF NOT EXISTS). */
async function applyNonTransactional(client: MigrationClient, file: MigrationFile): Promise<void> {
  const started = Date.now();
  await client.query(`SET ROLE ${OWNER_ROLE}`);
  try {
    await client.query(`SET search_path = ${SCHEMA}, pg_temp`);
    for (const statement of splitStatements(file.script)) await client.query(statement);
    await client.query(
      `INSERT INTO ${SCHEMA}.migration_ledger (filename, checksum, applied_by, duration_ms, transactional) VALUES ($1, $2, session_user, $3, false)`,
      [file.filename, file.checksum, Date.now() - started],
    );
  } finally {
    await client.query('RESET ROLE');
    await client.query('RESET search_path');
  }
}

/** Applies pending migrations in order after bootstrap and verification; returns the applied file names. */
export async function migrateUp(client: MigrationClient, directory = DEFAULT_MIGRATIONS_DIR, log: RunnerLogger = { info() {} }): Promise<string[]> {
  return withLock(client, async () => {
    await bootstrap(client);
    const status = await verifyMigrations(client, directory);
    const applied: string[] = [];
    for (const file of status.pending) {
      log.info(`applying ${file.filename}${file.directives.noTransaction ? ' (no transaction)' : ''}`);
      if (file.directives.noTransaction) await applyNonTransactional(client, file);
      else await applyTransactional(client, file);
      applied.push(file.filename);
    }
    return applied;
  });
}

/** Convenience for scripts and tests: opens one client, runs `up`, closes it. */
export async function migrateWithConfig(config: pg.ClientConfig, directory = DEFAULT_MIGRATIONS_DIR, log?: RunnerLogger): Promise<string[]> {
  const client = new pg.Client(config);
  await client.connect();
  try {
    return await migrateUp(client, directory, log);
  } finally {
    await client.end();
  }
}
