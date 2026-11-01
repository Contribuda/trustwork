import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { OWNER_ROLE, SCHEMA } from './config.js';
import type { Database } from './schema.js';

export type DataPool = pg.Pool;
/** Kysely bound to exactly one checked-out connection inside an open transaction. */
export type Transaction = Kysely<Database>;

/** Opens a pg pool whose connections always resolve unqualified names inside the `trustwork` schema. */
export function createPool(config: pg.PoolConfig): DataPool {
  const options = `-c search_path=${SCHEMA},pg_temp`;
  return new pg.Pool({ ...config, options: config.options ? `${config.options} ${options}` : options });
}

export interface Principal {
  personId: string;
  /** `person.authz_epoch` at principal resolution; a stale value is rejected by the database. */
  authzEpoch: number;
}
export type PrincipalErrorCode = 'access.no_principal' | 'access.stale_epoch' | 'access.invalid_principal';
export class PrincipalError extends Error {
  constructor(readonly code: PrincipalErrorCode, message: string) {
    super(message);
    this.name = 'PrincipalError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePrincipal(principal: Principal): void {
  if (!UUID.test(principal.personId)) throw new PrincipalError('access.invalid_principal', 'personId must be a UUID');
  if (!Number.isInteger(principal.authzEpoch) || principal.authzEpoch < 1) throw new PrincipalError('access.invalid_principal', 'authzEpoch must be a positive integer');
}

function mapSetterError(error: unknown): unknown {
  const e = error as { code?: string; hint?: string; message?: string };
  if (e && e.code === '28000') return new PrincipalError(e.hint === 'access.stale_epoch' ? 'access.stale_epoch' : 'access.no_principal', e.message ?? 'principal rejected');
  return error;
}

/** Minimal pool adapter so Kysely runs every statement on the one client that holds the transaction. */
class BoundPool {
  readonly options = {};
  constructor(private readonly client: pg.PoolClient) {}
  async connect() {
    const client = this.client;
    return {
      query: ((text: unknown, parameters?: readonly unknown[]) => client.query(text as string, parameters as unknown[])) as never,
      release() {},
    };
  }
  async end() {}
}

export function bindTransaction(client: pg.PoolClient): Transaction {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new BoundPool(client) }) });
}

async function runBound<T>(pool: DataPool, prepare: (client: pg.PoolClient) => Promise<void>, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    await prepare(client);
    const result = await fn(bindTransaction(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    // A failed transaction destroys the connection instead of returning it to the pool, so no
    // session-level state (which this module never sets) can leak into another checkout.
    client.release(failed ? true : undefined);
  }
}

/**
 * Runs `fn` inside one transaction whose identity is set by the trusted setter `trustwork.set_principal`
 * (transaction-local; gone at COMMIT/ROLLBACK). Missing or stale identity fails closed in the database.
 * `fn` must not open nested transactions; everything it does is committed together or not at all.
 */
export async function withPrincipal<T>(pool: DataPool, principal: Principal, fn: (trx: Transaction) => Promise<T>, options?: { snapshot: true }): Promise<T> {
  validatePrincipal(principal);
  return runBound(pool, async (client) => {
    if (options?.snapshot) await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    try {
      await client.query(`SELECT ${SCHEMA}.set_principal($1::uuid, $2::integer)`, [principal.personId, principal.authzEpoch]);
    } catch (error) {
      throw mapSetterError(error);
    }
  }, fn);
}

/**
 * Maintenance transaction for the migrator/owner connection only: `SET LOCAL ROLE trustwork_owner` plus the
 * transaction-local maintenance flag. The runtime role cannot use this (SET ROLE fails and the policy is
 * declared TO trustwork_owner).
 */
export function withMaintenance<T>(pool: DataPool, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return runBound(pool, async (client) => {
    await client.query(`SET LOCAL ROLE ${OWNER_ROLE}`);
    await client.query(`SET LOCAL search_path = ${SCHEMA}, pg_temp`);
    await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
  }, fn);
}
