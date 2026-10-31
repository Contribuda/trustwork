import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { bindTransaction, createPool, type DataPool, type Transaction } from '@trustwork/data';
import { WORKER_ROLE } from '../../../packages/data/src/config.js';
import { provisionTestDatabase, type TestDatabase } from '../../data/helpers/postgres.js';

export interface WorkerTestDatabase {
  db: TestDatabase;
  /** URL of a login that is a member of trustwork_worker only. */
  workerUrl: string;
  workerLoginRole: string;
  /** Opens a new pool on the worker login (one per simulated worker process). */
  workerPool(max?: number): DataPool;
  /** Pool on the API login (member of trustwork_app). */
  apiPool: DataPool;
  close(): Promise<void>;
}

/** Real PostgreSQL with the package migrations, an API login and a worker login; null when no backend is available. */
export async function provisionWorkerDatabase(label: string): Promise<WorkerTestDatabase | null> {
  // Worker files open several worker pools and child processes (measured peaks of 9 to 16 connections), so they take
  // two cluster test slots (tests/data/helpers/postgres.ts) instead of one.
  const db = await provisionTestDatabase(label, { weight: 2 });
  if (!db) return null;
  await db.migrate();
  await db.createAppLogin();
  const suffix = randomBytes(4).toString('hex');
  const workerLoginRole = `trustwork_worker_test_${suffix}`;
  const password = randomBytes(12).toString('hex');
  await db.admin.query(`CREATE ROLE ${workerLoginRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT IN ROLE ${WORKER_ROLE}`);
  const host = String(db.appConfig.host);
  const port = Number(db.appConfig.port);
  const workerUrl = `postgresql://${workerLoginRole}:${password}@${host}:${port}/${db.databaseName}`;
  const pools: DataPool[] = [];
  const apiPool = createPool({ ...db.appConfig, max: 4 });
  pools.push(apiPool);
  return {
    db,
    workerUrl,
    workerLoginRole,
    apiPool,
    workerPool(max = 8) {
      const pool = createPool({ connectionString: workerUrl, max });
      pools.push(pool);
      return pool;
    },
    async close() {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      // The login owns nothing and holds no direct grants, so it can go before the per-file database is dropped.
      await db.admin.query(`DROP ROLE IF EXISTS ${workerLoginRole}`).catch(() => undefined);
      await db.close();
    },
  };
}

/** Plain transaction (no principal) on any pool. */
export async function tx<T>(pool: DataPool, fn: (trx: Transaction, client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    const result = await fn(bindTransaction(client), client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(failed ? true : undefined);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns a truthy value or the deadline passes. */
export async function waitFor<T>(check: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 15_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/** A promise with its resolver, for handlers that must block until the test releases them. */
export function gate(): { promise: Promise<void>; open(): void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
