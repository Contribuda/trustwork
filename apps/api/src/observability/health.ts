import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Health, Readiness } from '../deps/contracts.js';
import type { DataPool } from '../deps/data.js';
import { loadMigrations, migrationStatus } from '../../../../packages/data/src/migrate/runner.js';

/**
 * `GET /health/live`: the process answers (no dependency is touched, so a database outage never restarts it).
 * `GET /health/ready`: 200 only when the database answers and the migration ledger matches the migrations this
 * build ships (every checksum equal, nothing pending, nothing missing or out of order); otherwise 503. A ledger
 * that is *ahead* of this build (newer migrations applied by a later release during a rolling deploy) stays
 * ready: migrations are expand/contract. Bodies carry states and migration file names only, never error text.
 */
export type ReadinessProbe = () => Promise<{ ready: boolean; body: Readiness }>;

/** Finds `packages/data/migrations` above this module (works from `src` under tsx and from `dist` after the build). */
export function discoverMigrationsDir(start = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'packages', 'data', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

class TimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError('readiness timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface ReadinessOptions {
  pool: DataPool | null;
  migrationsDir: string | null;
  timeoutMs: number;
  onError?: (error: unknown) => void;
}

/** Builds the readiness probe; concurrent probes share one in-flight check so a slow database is not stampeded. */
export function createReadinessProbe(options: ReadinessOptions): ReadinessProbe {
  const onError = options.onError ?? (() => undefined);
  let inflight: Promise<{ ready: boolean; body: Readiness }> | null = null;

  const check = async (): Promise<{ ready: boolean; body: Readiness }> => {
    let expected: string | null = null;
    let files: ReturnType<typeof loadMigrations> | null = null;
    if (options.migrationsDir) {
      try {
        files = loadMigrations(options.migrationsDir);
        expected = files.at(-1)?.filename ?? null;
      } catch (error) {
        onError(error);
      }
    }
    const notReady = (database: Readiness['checks']['database'], ledger: Readiness['checks']['ledger'], schemaVersion: string | null = null) =>
      ({ ready: false, body: { status: 'not_ready', checks: { database, ledger }, schemaVersion, expectedSchemaVersion: expected } satisfies Readiness });
    if (!options.pool) return notReady('not_configured', 'not_checked');
    const pool = options.pool;

    let client: PoolClient | null = null;
    const work = (async () => {
      const connected = await pool.connect();
      client = connected;
      await connected.query('SELECT 1');
      if (!files || !options.migrationsDir) return { database: 'ok' as const, ledger: 'unverifiable' as const, schemaVersion: null };
      let status: Awaited<ReturnType<typeof migrationStatus>>;
      try {
        status = await migrationStatus(connected, options.migrationsDir);
      } catch (error) {
        onError(error);
        return { database: 'ok' as const, ledger: 'unreadable' as const, schemaVersion: null };
      }
      const schemaVersion = status.applied.at(-1)?.filename ?? null;
      const last = expected ?? '';
      const ahead = status.missing.filter((name) => name > last);
      const missing = status.missing.filter((name) => name <= last);
      let ledger: Readiness['checks']['ledger'] = 'ok';
      if (status.mismatched.length) ledger = 'checksum_mismatch';
      else if (missing.length) ledger = 'missing';
      else if (status.outOfOrder.length) ledger = 'out_of_order';
      else if (status.pending.length) ledger = 'pending';
      else if (ahead.length) ledger = 'schema_ahead';
      return { database: 'ok' as const, ledger, schemaVersion };
    })();
    try {
      const result = await withTimeout(work, options.timeoutMs);
      const ready = result.ledger === 'ok' || result.ledger === 'schema_ahead';
      return { ready, body: { status: ready ? 'ready' : 'not_ready', checks: { database: result.database, ledger: result.ledger }, schemaVersion: result.schemaVersion, expectedSchemaVersion: expected } };
    } catch (error) {
      if (!(error instanceof TimeoutError)) onError(error);
      return notReady(error instanceof TimeoutError ? 'timeout' : 'unreachable', 'not_checked');
    } finally {
      // A timed-out check releases its connection when the query finally returns.
      const release = (destroy: boolean) => (client as PoolClient | null)?.release(destroy);
      void work.then(() => release(false), () => release(true));
    }
  };

  return () => {
    inflight ??= check().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export function registerHealthRoutes(fastify: FastifyInstance, health: () => Health, readiness: ReadinessProbe): void {
  fastify.get('/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return health();
  });
  fastify.get('/health/ready', async (_request, reply) => {
    const { ready, body } = await readiness();
    reply.header('Cache-Control', 'no-store').status(ready ? 200 : 503);
    return body;
  });
}
