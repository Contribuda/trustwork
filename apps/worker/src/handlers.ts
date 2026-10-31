import type { Job, Transaction } from '@trustwork/data';

/** A typed view of one outbox row handed to a handler. */
export interface OutboxEventEnvelope<P = unknown> {
  id: string;
  type: string;
  aggregateKind: string;
  aggregateId: string;
  revision: number;
  payload: P;
  createdAt: Date;
}

export interface EnqueueRequest {
  kind: string;
  payload?: unknown;
  /** Defaults to the worker's retry policy `maxAttempts`. */
  maxAttempts?: number;
  /** First attempt after this many seconds (database clock). */
  delaySeconds?: number;
}

/** Database work done in the caller's transaction; commits or rolls back with it. */
export interface TransactionalContext {
  trx: Transaction;
  enqueue(request: EnqueueRequest): Promise<Job>;
}

/**
 * Outbox handler, keyed by event type. It runs inside the relay transaction (or a redelivery job's transaction) and
 * must only touch the database: provider effects are jobs it enqueues. A failure rolls back to a savepoint and hands
 * the event to an `outbox.redeliver` job that retries with backoff and dead-letters after the last attempt.
 */
export interface OutboxHandler<P = unknown> {
  /** Unique, stable name (stored in redelivery jobs). */
  name: string;
  type: string;
  /** Validates and types the payload, for example a contract schema's `parse`. A throw counts as a handler failure. */
  parse?: (payload: unknown) => P;
  handle(event: OutboxEventEnvelope<P>, context: TransactionalContext): Promise<void>;
}

export interface JobContext<P = unknown> {
  job: Job;
  payload: P;
  /** Differs per attempt (`<job id>:<attempt>`). */
  attemptId: string;
  /** Stable across attempts and reconciliation (`job:<job id>`): pass it as the provider idempotency key. */
  effectKey: string;
  /** Aborted when the lease is lost or the worker shuts down. */
  signal: AbortSignal;
}

/**
 * Database-only job: `run` and the fencing-checked completion share one transaction, so a crash, a lost lease or a
 * stale fencing token rolls the effect back. Exactly-once on the database; an expired lease is reconciled
 * automatically (proof of no effect: the completion never committed).
 */
export interface TransactionalJobHandler<P = unknown> {
  kind: string;
  mode: 'transactional';
  parse?: (payload: unknown) => P;
  run(context: JobContext<P> & TransactionalContext): Promise<void>;
}

/**
 * Job with an effect outside the database (provider call). Persisted before dispatch (the job row), completed after.
 * A normal return records success; `RetryableJobError` (no effect happened) retries with backoff;
 * `PermanentJobError` dead-letters; anything else, a timeout or a crash parks the job as `outcome_unknown`, which only
 * an explicit reconciliation (`npm run reconcile -w @trustwork/worker`) resolves. Never replayed blindly.
 */
export interface ExternalJobHandler<P = unknown> {
  kind: string;
  mode: 'external';
  parse?: (payload: unknown) => P;
  /** Overrides the worker's `externalTimeoutMs`. */
  timeoutMs?: number;
  run(context: JobContext<P>): Promise<void>;
}

export type JobHandler<P = unknown> = TransactionalJobHandler<P> | ExternalJobHandler<P>;

/** Definitive failure with proof that no effect happened: safe to retry with backoff. */
export class RetryableJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableJobError';
  }
}

/** Definitive failure that a retry cannot fix (invalid payload, rejected by the provider before any effect). */
export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

const NAME = /^[a-z][a-z0-9_.-]{0,99}$/;

/** Handler registry: outbox handlers keyed by event type (several per type), job handlers keyed by job kind. */
export class HandlerRegistry {
  private readonly outboxByType = new Map<string, OutboxHandler[]>();
  private readonly outboxByName = new Map<string, OutboxHandler>();
  private readonly jobByKind = new Map<string, JobHandler>();

  onOutbox<P>(handler: OutboxHandler<P>): this {
    if (!NAME.test(handler.name) || !NAME.test(handler.type)) throw new Error(`invalid outbox handler name or type: ${handler.name} / ${handler.type}`);
    if (this.outboxByName.has(handler.name)) throw new Error(`outbox handler ${handler.name} is already registered`);
    const erased = handler as OutboxHandler;
    this.outboxByName.set(handler.name, erased);
    this.outboxByType.set(handler.type, [...(this.outboxByType.get(handler.type) ?? []), erased]);
    return this;
  }

  onJob<P>(handler: JobHandler<P>): this {
    if (!NAME.test(handler.kind)) throw new Error(`invalid job kind: ${handler.kind}`);
    if (this.jobByKind.has(handler.kind)) throw new Error(`job handler ${handler.kind} is already registered`);
    this.jobByKind.set(handler.kind, handler as JobHandler);
    return this;
  }

  outboxHandlersFor(type: string): readonly OutboxHandler[] {
    return this.outboxByType.get(type) ?? [];
  }

  outboxHandler(name: string): OutboxHandler | undefined {
    return this.outboxByName.get(name);
  }

  jobHandler(kind: string): JobHandler | undefined {
    return this.jobByKind.get(kind);
  }

  jobKinds(): string[] {
    return [...this.jobByKind.keys()].sort();
  }

  isTransactional(kind: string): boolean {
    return this.jobByKind.get(kind)?.mode === 'transactional';
  }
}
