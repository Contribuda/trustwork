import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../errors.js';
import { leases } from './records.js';

/**
 * Completion of an idempotency record inside the handler's own transaction (ADR 012 decision 39). The interceptor
 * binds one to the request state before the handler runs; the request transaction (`PrincipalService.runAs`) calls
 * `completeInTransaction` with the value it returns, so the record turns `completed` with the stored response in the
 * same commit as the change, its audit event and its outbox intents. Either both commit or neither does: a crash at any
 * point after COMMIT leaves a completed record that every retry replays, and a crash before COMMIT leaves no effect.
 */
export class InTransactionCompletion {
  private written = false;
  constructor(
    readonly recordId: string,
    /** The lease this execution holds; the conditional write fails once a retry has taken the record over. */
    readonly lease: Date,
    private readonly httpStatus: number,
    private readonly retainUntil: () => Date,
  ) {}

  /** True once the completion was written by a transaction whose callback returned (the handler then committed it). */
  get recorded(): boolean {
    return this.written;
  }

  /**
   * Writes the completion in `trx`. A lost lease (a retry took the record over after the lease passed) aborts this
   * execution: the error rolls back the handler's transaction, so a late execution never commits a second effect.
   * A second committed transaction in the same request fails the same way (the record is no longer in progress).
   */
  async record(trx: Transaction, body: unknown): Promise<void> {
    const done = await leases.complete(trx, this.recordId, this.lease, { httpStatus: this.httpStatus, body: body === undefined ? null : body }, this.retainUntil());
    if (!done) throw new ApiError('validation.idempotency_in_progress', 'a retry with this key took the request over; this execution was rolled back');
    this.written = true;
  }
}

const bound = new WeakMap<object, InTransactionCompletion>();

/** Attaches the completion to the request state for the duration of the handler. */
export function bindCompletion(state: object, completion: InTransactionCompletion): void {
  bound.set(state, completion);
}
export function unbindCompletion(state: object): void {
  bound.delete(state);
}

/**
 * Hook for the request transaction: completes the bound idempotency record with the transaction's result. A no-op for
 * requests without an in-transaction completion (reads, lease routes, requests without `@Idempotent`).
 */
export async function completeInTransaction(state: object, trx: Transaction, body: unknown): Promise<void> {
  const completion = bound.get(state);
  if (completion) await completion.record(trx, body);
}

/** Stable command identity for a staged effect. Preparatory transactions must use an unbound state copy. */
export function completionRecordId(state: object): string | null {
  return bound.get(state)?.recordId ?? null;
}
