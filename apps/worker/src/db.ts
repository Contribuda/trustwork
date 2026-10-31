import type pg from 'pg';
import { bindTransaction, createPool, type DataPool, type Transaction } from '@trustwork/data';
import { WORKER_ROLE } from './config.js';

export function createWorkerPool(databaseUrl: string, max: number): DataPool {
  return createPool({ connectionString: databaseUrl, application_name: 'trustwork-worker', max });
}

export interface TransactionHandle {
  trx: Transaction;
  /** Backend pid of this transaction's connection (used to cancel a running statement at shutdown). */
  pid: number;
}

/**
 * One transaction without an identity on the worker role (the reliability tables carry no party data and have no
 * RLS). A failed transaction destroys its connection instead of returning it to the pool.
 */
export async function inTransaction<T>(pool: DataPool, fn: (trx: Transaction, handle: TransactionHandle) => Promise<T>): Promise<T> {
  const client: pg.PoolClient = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
    const trx = bindTransaction(client);
    const result = await fn(trx, { trx, pid });
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

export class WorkerRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRoleError';
  }
}

/**
 * Refuses to run with anything but a plain member of trustwork_worker: no superuser, no BYPASSRLS, not a member of
 * the API role (which reads party tables) or of the owner role.
 */
export async function assertWorkerRole(pool: DataPool): Promise<string> {
  const { rows } = await pool.query<{ user: string; rolsuper: boolean; rolbypassrls: boolean; worker: boolean; app: boolean; owner: boolean }>(
    `SELECT current_user AS user, r.rolsuper, r.rolbypassrls,
       pg_has_role(current_user, $1, 'MEMBER') AS worker,
       coalesce((SELECT pg_has_role(current_user, a.oid, 'MEMBER') FROM pg_roles a WHERE a.rolname = 'trustwork_app'), false) AS app,
       coalesce((SELECT pg_has_role(current_user, o.oid, 'MEMBER') FROM pg_roles o WHERE o.rolname = 'trustwork_owner'), false) AS owner
     FROM pg_roles r WHERE r.rolname = current_user`,
    [WORKER_ROLE],
  );
  const row = rows[0];
  if (!row) throw new WorkerRoleError('cannot read the current role');
  if (row.rolsuper || row.rolbypassrls) throw new WorkerRoleError(`worker login ${row.user} must not be a superuser or bypass row-level security`);
  if (row.app || row.owner) throw new WorkerRoleError(`worker login ${row.user} must not be a member of trustwork_app or trustwork_owner`);
  if (!row.worker) throw new WorkerRoleError(`worker login ${row.user} must be a member of ${WORKER_ROLE}`);
  return row.user;
}
