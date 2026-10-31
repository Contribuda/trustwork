import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { APP_ROLE } from '@trustwork/data';
import { DEFAULT_MIGRATIONS_DIR, migrateUp } from '@trustwork/data/migrate';

/**
 * Real-PostgreSQL test backend. Order: TRUSTWORK_TEST_DATABASE_URL (any reachable superuser/migrator URL),
 * Docker compose (infra/compose.yaml) when `docker version` answers within 15 s, otherwise the
 * embedded-postgres dev dependency (PostgreSQL binaries installed by npm). When none is available the
 * caller skips with an explicit "SKIPPED: no PostgreSQL" message instead of failing.
 */
export type Backend = 'external' | 'docker' | 'embedded';
const COMPOSE_FILE = resolve('infra/compose.yaml');
const COMPOSE_ADMIN_URL = 'postgresql://trustwork_dev:local_only_change_me@127.0.0.1:54329/trustwork_dev';

interface Server { backend: Backend; adminUrl: string; stop(): Promise<void> }

function dockerAvailable(): boolean {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
  return probe.status === 0 && !probe.error && probe.stdout.trim() !== '';
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function startServer(): Promise<Server | null> {
  const forced = process.env.TRUSTWORK_TEST_PG_BACKEND;
  if (forced === 'none') return null;
  if (process.env.TRUSTWORK_TEST_DATABASE_URL && (!forced || forced === 'external')) {
    return { backend: 'external', adminUrl: process.env.TRUSTWORK_TEST_DATABASE_URL, stop: async () => {} };
  }
  if ((!forced || forced === 'docker') && dockerAvailable()) {
    // The compose stack is the developer's database and is deliberately left running after the tests
    // (volume retained); stop it with `npm run infra:down`. Only the per-file test databases are dropped.
    // Test files run in parallel processes and may call `compose up` at the same time; a concurrent create fails
    // transiently, so retry a few times before falling back (keeps the backend deterministic across files).
    let up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { encoding: 'utf8', timeout: 180_000 });
    for (let attempt = 0; attempt < 5 && up.status !== 0; attempt++) {
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { timeout: 10_000 });
      up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { encoding: 'utf8', timeout: 180_000 });
    }
    if (up.status === 0) return { backend: 'docker', adminUrl: COMPOSE_ADMIN_URL, stop: async () => {} };
    console.warn(`[trustwork-data] docker compose up failed, trying embedded-postgres: ${(up.stderr || up.stdout).slice(-500)}`);
  }
  if (forced === 'docker') return null;
  let EmbeddedPostgres: (typeof import('embedded-postgres'))['default'];
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default;
  } catch {
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-data-pg-'));
  const port = await freePort();
  const password = randomBytes(12).toString('hex');
  const server = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password, persistent: false, onLog() {}, onError() {} });
  await server.initialise();
  await server.start();
  return {
    backend: 'embedded',
    adminUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface TestDatabase {
  backend: Backend;
  serverVersion: string;
  databaseName: string;
  /** Superuser/migrator connection to the per-file database. */
  admin: pg.Pool;
  adminConfig: pg.PoolConfig;
  /** Login role that is a member of trustwork_app (the documented production pattern). */
  app: pg.Pool;
  appConfig: pg.PoolConfig;
  appLoginRole: string;
  /** Runs the in-repo runner against a directory (default: the package migrations) with the admin connection. */
  migrate(directory?: string): Promise<string[]>;
  /** Creates the app login role; call after the first migrate() (the bootstrap creates trustwork_app). */
  createAppLogin(): Promise<void>;
  close(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Returns null when no PostgreSQL backend is available; the caller must skip explicitly. */
export async function provisionTestDatabase(label: string): Promise<TestDatabase | null> {
  const server = await startServer();
  if (!server) return null;
  const suffix = randomBytes(4).toString('hex');
  const databaseName = `trustwork_test_${label}_${suffix}`;
  const appLoginRole = `trustwork_app_test_${suffix}`;
  const appPassword = randomBytes(12).toString('hex');
  const maintenance = new pg.Client({ connectionString: server.adminUrl });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${databaseName}`);
  const serverVersion = (await maintenance.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? 'unknown';
  await maintenance.end();
  const adminUrl = withDatabase(server.adminUrl, databaseName);
  const options = '-c search_path=trustwork,pg_temp';
  const adminConfig: pg.PoolConfig = { connectionString: adminUrl, options, max: 4 };
  const admin = new pg.Pool(adminConfig);
  const parsed = new URL(adminUrl);
  const appConfig: pg.PoolConfig = { host: parsed.hostname, port: Number(parsed.port || 5432), database: databaseName, user: appLoginRole, password: appPassword, options, max: 6 };
  const app = new pg.Pool(appConfig);
  let loginCreated = false;
  console.log(`[trustwork-data] backend=${server.backend} server_version=${serverVersion} database=${databaseName}`);
  return {
    backend: server.backend,
    serverVersion,
    databaseName,
    admin,
    adminConfig,
    app,
    appConfig,
    appLoginRole,
    async migrate(directory = DEFAULT_MIGRATIONS_DIR) {
      const client = await admin.connect();
      try {
        return await migrateUp(client, directory);
      } finally {
        client.release(true);
      }
    },
    async createAppLogin() {
      await admin.query(`CREATE ROLE ${appLoginRole} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE ${APP_ROLE}`);
      loginCreated = true;
    },
    async close() {
      await app.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      const cleanup = new pg.Client({ connectionString: server.adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
        if (loginCreated) await cleanup.query(`DROP ROLE IF EXISTS ${appLoginRole}`);
      } finally {
        await cleanup.end();
      }
      await server.stop();
    },
  };
}

export const SKIP_REASON = 'SKIPPED: no PostgreSQL (TRUSTWORK_TEST_DATABASE_URL unset, Docker not answering within 15 s, embedded-postgres unavailable)';

/** SQLSTATE of a pg error, or null for non-database errors. */
export function sqlState(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null;
}
