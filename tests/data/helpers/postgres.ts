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
 * caller skips with an explicit "SKIPPED: no PostgreSQL" message instead of failing, unless
 * TRUSTWORK_REQUIRE_PG=1 (set in CI), which turns a missing database into a failure of the test file.
 *
 * Several checkouts (worktrees, agents, CI-like local runs) may share one cluster. Databases and login roles
 * are unique per test file, and a file only starts after it holds one of a bounded number of cluster-wide
 * test slots (session advisory locks), so parallel runs queue instead of exhausting max_connections.
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

/** TRUSTWORK_REQUIRE_PG=1: a database suite that cannot reach PostgreSQL fails instead of skipping. */
export function postgresRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRUSTWORK_REQUIRE_PG === '1';
}

async function startServer(): Promise<Server | null> {
  const forced = process.env.TRUSTWORK_TEST_PG_BACKEND;
  if (forced === 'none') return null;
  if (process.env.TRUSTWORK_TEST_DATABASE_URL && (!forced || forced === 'external')) {
    return { backend: 'external', adminUrl: process.env.TRUSTWORK_TEST_DATABASE_URL, stop: async () => {} };
  }
  // A forced external backend without a URL must not silently fall back to Docker or an embedded server.
  if (forced === 'external') return null;
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
  /** Superuser/migrator URL of the cluster's maintenance database (not the per-file database). */
  clusterUrl: string;
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

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/** SQLSTATEs that mean "the cluster is busy right now", not "the cluster is unavailable": retried with backoff. */
const BUSY_CODES = new Set(['53300', '57P03', '53400']);

/**
 * Connects with retries while the server answers "too many clients" (53300) or "starting up" (57P03), which
 * happen when several checkouts share one cluster. A refused or unreachable server fails at once.
 */
export async function connectWithRetry(config: string | pg.ClientConfig, attempts = 40): Promise<pg.Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client(typeof config === 'string' ? { connectionString: config } : config);
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!BUSY_CODES.has(sqlState(error) ?? '') || attempt >= attempts) throw error;
      await sleep(Math.min(2_000, 100 * attempt) + Math.floor(Math.random() * 250));
    }
  }
}

/** Advisory-lock class (first key) for test slots; the second key is the slot number. "TWST". */
export const SLOT_LOCK_CLASS = 0x54575354;
/** Upper bound of connections one test file may hold (admin pool, app pool, extra node pools, the slot itself). */
export const CONNECTIONS_PER_FILE = 12;
/** Connections left for everything that is not a test file (dev servers, psql, other tools). */
export const CONNECTION_HEADROOM = 10;

/** Number of concurrent test files the cluster can carry: TRUSTWORK_TEST_PG_SLOTS, else derived from max_connections. */
export function slotCount(availableConnections: number, override: string | undefined = process.env.TRUSTWORK_TEST_PG_SLOTS): number {
  if (override !== undefined && override !== '') {
    const forced = Number(override);
    if (!Number.isInteger(forced) || forced < 1) throw new Error(`TRUSTWORK_TEST_PG_SLOTS must be a positive integer, got ${JSON.stringify(override)}`);
    return forced;
  }
  return Math.max(1, Math.floor((availableConnections - CONNECTION_HEADROOM) / CONNECTIONS_PER_FILE));
}

export interface TestSlot { slot: number; slots: number; waitedMs: number; release(): Promise<void> }

/**
 * Takes one of the cluster-wide test slots: a session advisory lock (SLOT_LOCK_CLASS, n) held on a dedicated
 * connection until release(). The lock disappears with the connection, so a crashed or killed test file never
 * leaks a slot. Waiting files poll with jitter; after `timeoutMs` the file fails with an explicit message.
 */
export async function acquireTestSlot(adminUrl: string, label: string, options: { timeoutMs?: number; slots?: number } = {}): Promise<TestSlot> {
  const client = await connectWithRetry(adminUrl);
  // An idle slot connection that the server closes only gives up the slot; it must not crash the test file.
  client.on('error', (error) => console.warn(`[trustwork-data] ${label}: test slot connection lost (${error.message})`));
  try {
    const slots = options.slots ?? slotCount((await client.query<{ n: number }>(`SELECT current_setting('max_connections')::int
      - current_setting('superuser_reserved_connections')::int
      - coalesce(current_setting('reserved_connections', true)::int, 0) AS n`)).rows[0]?.n ?? 0);
    const started = Date.now();
    const deadline = started + (options.timeoutMs ?? Number(process.env.TRUSTWORK_TEST_PG_SLOT_TIMEOUT_MS ?? 15 * 60_000));
    let announced = false;
    for (;;) {
      const order = Array.from({ length: slots }, (_, n) => n).sort(() => Math.random() - 0.5);
      for (const slot of order) {
        const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [SLOT_LOCK_CLASS, slot]);
        if (rows[0]?.ok) {
          let released = false;
          return {
            slot,
            slots,
            waitedMs: Date.now() - started,
            async release() {
              if (released) return;
              released = true;
              await client.query('SELECT pg_advisory_unlock($1, $2)', [SLOT_LOCK_CLASS, slot]).catch(() => undefined);
              await client.end().catch(() => undefined);
            },
          };
        }
      }
      if (Date.now() >= deadline) throw new Error(`[trustwork-data] ${label}: no free test slot among ${slots} after ${Date.now() - started} ms; another run holds the cluster (raise TRUSTWORK_TEST_PG_SLOT_TIMEOUT_MS or stop stale runs)`);
      if (!announced) {
        console.log(`[trustwork-data] ${label}: all ${slots} cluster test slots are busy (other runs share this PostgreSQL); waiting`);
        announced = true;
      }
      await sleep(150 + Math.floor(Math.random() * 350));
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/** Test databases and login roles carry their creation time (base-36 seconds) so leaked ones can be reaped. */
const STAMPED_DATABASE = /^trustwork_test_[a-z0-9_]+_([0-9a-z]{6,8})_[0-9a-f]{8}$/;
const STAMPED_ROLE = /^trustwork_app_test_([0-9a-z]{6,8})_[0-9a-f]{8}$/;
/** Older than this, a stamped test database or role belongs to a run that crashed or was killed. */
export const STALE_AFTER_MS = 6 * 60 * 60_000;

export function stamp(now = Date.now()): string {
  return Math.floor(now / 1000).toString(36);
}

/** Names whose embedded stamp is older than STALE_AFTER_MS; names without a stamp are never selected. */
export function staleNames(names: readonly string[], pattern: RegExp, now = Date.now()): string[] {
  return names.filter((name) => {
    const match = pattern.exec(name);
    if (!match?.[1]) return false;
    return now - Number.parseInt(match[1], 36) * 1000 > STALE_AFTER_MS;
  });
}

/**
 * Best effort: drops stamped test databases and login roles left by killed runs. DROP DATABASE without FORCE
 * refuses a database that still has sessions, and DROP ROLE refuses a role that still has dependencies, so a
 * live run is never disturbed; every failure is ignored.
 */
async function reapStale(client: pg.Client): Promise<void> {
  const databases = (await client.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'trustwork\\_test\\_%'")).rows.map((r) => r.datname);
  for (const name of staleNames(databases, STAMPED_DATABASE)) await client.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
  const roles = (await client.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname LIKE 'trustwork\\_app\\_test\\_%'")).rows.map((r) => r.rolname);
  for (const name of staleNames(roles, STAMPED_ROLE)) await client.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
}

/** CREATE DATABASE fails with 55006 while another session is connected to the template; retried briefly. */
async function createDatabase(client: pg.Client, name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(`CREATE DATABASE ${name}`);
      return;
    } catch (error) {
      if (sqlState(error) !== '55006' || attempt >= 10) throw error;
      await sleep(200 * attempt);
    }
  }
}

/** Milliseconds the server clock is ahead of this process (negative: behind), midpoint of one round trip. */
async function clockSkewMs(client: pg.Client): Promise<number> {
  const before = Date.now();
  const { rows } = await client.query<{ ms: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS ms');
  const after = Date.now();
  return Math.round(Number(rows[0]?.ms ?? before) - (before + after) / 2);
}

/**
 * Waits until the database clock has passed `at`. Use it after creating anything whose expiry is computed from this
 * process's clock but checked against now() in the database: a Docker VM clock runs tens of milliseconds apart, so a
 * fixed sleep is either too short (the row is not yet expired for the database) or wastefully long.
 */
export async function untilDatabaseTimePasses(pool: pg.Pool, at: Date, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ passed: boolean }>('SELECT clock_timestamp() > $1::timestamptz AS passed', [at.toISOString()]);
    if (rows[0]?.passed) return;
    if (Date.now() > deadline) throw new Error(`database clock did not pass ${at.toISOString()} within ${timeoutMs} ms`);
    await sleep(10);
  }
}

/** Server clocks further apart than this break tests that compare process time with now() (permit/lease expiry). */
export const CLOCK_SKEW_WARN_MS = 250;

export function databaseLabel(label: string): string {
  const cleaned = label.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20);
  if (!/[a-z0-9]/.test(cleaned)) throw new Error('test database label must contain letters or digits');
  return cleaned;
}

/**
 * Returns null when no PostgreSQL backend is available (the caller must skip explicitly), or throws when
 * TRUSTWORK_REQUIRE_PG=1 so CI cannot pass with skipped database suites.
 */
export async function provisionTestDatabase(label: string): Promise<TestDatabase | null> {
  const server = await startServer();
  if (!server) {
    if (postgresRequired()) throw new Error(`[trustwork-data] ${label}: TRUSTWORK_REQUIRE_PG=1 but ${SKIP_REASON.replace(/^SKIPPED: /, '')}`);
    console.warn(`[trustwork-data] ${label}: ${SKIP_REASON}. Set TRUSTWORK_REQUIRE_PG=1 to make this a failure.`);
    return null;
  }
  const slot = server.backend === 'embedded' ? null : await acquireTestSlot(server.adminUrl, label);
  const suffix = randomBytes(4).toString('hex');
  const created = stamp();
  const databaseName = `trustwork_test_${databaseLabel(label)}_${created}_${suffix}`;
  const appLoginRole = `trustwork_app_test_${created}_${suffix}`;
  const appPassword = randomBytes(12).toString('hex');
  let serverVersion = 'unknown';
  let skew = 0;
  try {
    const maintenance = await connectWithRetry(server.adminUrl);
    try {
      await reapStale(maintenance);
      await createDatabase(maintenance, databaseName);
      serverVersion = (await maintenance.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? 'unknown';
      skew = await clockSkewMs(maintenance);
    } finally {
      await maintenance.end();
    }
  } catch (error) {
    await slot?.release();
    await server.stop().catch(() => undefined);
    throw error;
  }
  const adminUrl = withDatabase(server.adminUrl, databaseName);
  const options = '-c search_path=trustwork,pg_temp';
  const adminConfig: pg.PoolConfig = { connectionString: adminUrl, options, max: 4 };
  const admin = new pg.Pool(adminConfig);
  const parsed = new URL(adminUrl);
  const appConfig: pg.PoolConfig = { host: parsed.hostname, port: Number(parsed.port || 5432), database: databaseName, user: appLoginRole, password: appPassword, options, max: 6 };
  const app = new pg.Pool(appConfig);
  let loginCreated = false;
  const slotNote = slot ? ` slot=${slot.slot + 1}/${slot.slots}${slot.waitedMs > 1_000 ? ` waited_ms=${slot.waitedMs}` : ''}` : '';
  console.log(`[trustwork-data] backend=${server.backend} server_version=${serverVersion} database=${databaseName}${slotNote} clock_skew_ms=${skew}`);
  if (Math.abs(skew) > CLOCK_SKEW_WARN_MS) {
    console.warn(`[trustwork-data] ${label}: the database clock is ${skew} ms off this process; tests comparing process time with now() may fail (resync the Docker VM clock)`);
  }
  return {
    backend: server.backend,
    serverVersion,
    databaseName,
    clusterUrl: server.adminUrl,
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
      try {
        const cleanup = await connectWithRetry(server.adminUrl);
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
          if (loginCreated) await cleanup.query(`DROP ROLE IF EXISTS ${appLoginRole}`);
        } finally {
          await cleanup.end();
        }
      } finally {
        await slot?.release();
        await server.stop();
      }
    },
  };
}

export const SKIP_REASON = 'SKIPPED: no PostgreSQL (TRUSTWORK_TEST_DATABASE_URL unset, Docker not answering within 15 s, embedded-postgres unavailable)';

/** SQLSTATE of a pg error, or null for non-database errors. */
export function sqlState(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : null;
}
