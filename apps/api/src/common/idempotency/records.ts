import { sql } from 'kysely';
import type { IdempotencyRecord, Transaction } from '../../deps/data.js';

/** The response a retry with the same key replays: HTTP status plus the JSON body (or the rendered error). */
export interface StoredResult { httpStatus: number; body: unknown }

/**
 * Lease bookkeeping on idempotency_record: `expires_at` is the lease while `in_progress` and the retention once
 * `completed`. Every write is conditional, so the lease doubles as a fencing token: an execution whose lease was
 * taken over can no longer complete the record.
 */
export const leases = {
  /** Takes over an in_progress record whose lease has passed; undefined when the lease is live or the record completed. */
  takeOver(trx: Transaction, id: string, now: Date, leaseUntil: Date): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ expires_at: leaseUntil })
      .where('id', '=', id).where('state', '=', 'in_progress').where('expires_at', '<=', now).returningAll().executeTakeFirst();
  },
  /** Re-opens a recorded server-side failure (5xx) for exactly one retry. */
  reopen(trx: Transaction, id: string, leaseUntil: Date): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ state: 'in_progress', result: null, expires_at: leaseUntil })
      .where('id', '=', id).where('state', '=', 'completed').where(sql<boolean>`(result ->> 'httpStatus')::int >= 500`).returningAll().executeTakeFirst();
  },
  /**
   * Completes the record only while this execution still holds its lease (a takeover moved `expires_at`). Used both
   * inside the handler's own transaction and, for lease routes and error results, in a separate bookkeeping transaction.
   */
  async complete(trx: Transaction, id: string, heldLease: Date, result: StoredResult, retainUntil: Date): Promise<boolean> {
    const done = await trx.updateTable('idempotency_record').set({ state: 'completed', result: JSON.stringify(result), expires_at: retainUntil })
      .where('id', '=', id).where('state', '=', 'in_progress').where('expires_at', '=', heldLease).executeTakeFirst();
    return Number(done.numUpdatedRows) === 1;
  },
};
