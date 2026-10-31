import type pg from 'pg';
import { bindTransaction, type DataPool, type Transaction } from '../deps/data.js';

/**
 * Transaction without an identity, for tables that carry no party data and have no RLS (audit_event,
 * outbox_event, idempotency_record, company public rows). Party tables yield nothing here by design.
 */
export async function withoutPrincipal<T>(pool: DataPool, fn: (trx: Transaction) => Promise<T>): Promise<T> {
  const client: pg.PoolClient = await pool.connect();
  let failed = false;
  try {
    await client.query('BEGIN');
    const result = await fn(bindTransaction(client));
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
