import { sql } from 'kysely';
import { jobs, outbox, type DataPool, type OutboxEvent, type Transaction } from '@trustwork/data';
import { retryDelaySeconds } from './backoff.js';
import type { WorkerConfig } from './config.js';
import { inTransaction } from './db.js';
import type { HandlerRegistry, OutboxEventEnvelope, OutboxHandler, TransactionalContext } from './handlers.js';
import { describeError, type Logger } from './log.js';
import { M, type Metrics } from './metrics.js';

/** Job kind that re-runs one outbox handler for one event after it failed inside the relay. */
export const REDELIVER_KIND = 'outbox.redeliver';
export interface RedeliverPayload { eventId: string; handler: string }

export function envelopeOf<P>(event: OutboxEvent, handler: OutboxHandler<P>): OutboxEventEnvelope<P> {
  return {
    id: event.id,
    type: event.type,
    aggregateKind: event.aggregate_kind,
    aggregateId: event.aggregate_id,
    revision: event.revision,
    payload: handler.parse ? handler.parse(event.payload) : (event.payload as P),
    createdAt: event.created_at,
  };
}

export function transactionalContext(trx: Transaction, config: WorkerConfig): TransactionalContext {
  return {
    trx,
    enqueue: (request) => jobs.enqueue(trx, {
      kind: request.kind, payload: request.payload ?? {}, max_attempts: request.maxAttempts ?? config.retry.maxAttempts,
      ...(request.delaySeconds === undefined ? {} : { delay_seconds: request.delaySeconds }),
    }),
  };
}

/**
 * Outbox relay: claims unpublished rows with FOR UPDATE SKIP LOCKED (concurrent relays never see the same row),
 * dispatches each to the handlers registered for its type inside the same transaction, and marks the batch published
 * in that transaction. A handler failure rolls back to a savepoint and becomes an `outbox.redeliver` job (backoff, dead
 * letter); a crash before COMMIT leaves the rows unpublished with no handler effect, so they are delivered again.
 */
export class OutboxRelay {
  constructor(private readonly deps: { pool: DataPool; registry: HandlerRegistry; config: WorkerConfig; metrics: Metrics; log: Logger }) {}

  async relayOnce(): Promise<number> {
    const { pool, registry, config, metrics, log } = this.deps;
    return inTransaction(pool, async (trx) => {
      const events = await outbox.claimUnpublished(trx, config.relayBatchSize);
      if (!events.length) return 0;
      const context = transactionalContext(trx, config);
      for (const event of events) {
        const handlers = registry.outboxHandlersFor(event.type);
        if (!handlers.length) {
          metrics.inc(...M.outboxEvents, { result: 'unhandled' });
          continue;
        }
        for (const handler of handlers) {
          await sql`SAVEPOINT trustwork_relay_handler`.execute(trx);
          try {
            await handler.handle(envelopeOf(event, handler), context);
            await sql`RELEASE SAVEPOINT trustwork_relay_handler`.execute(trx);
            metrics.inc(...M.outboxEvents, { result: 'handled' });
          } catch (error) {
            await sql`ROLLBACK TO SAVEPOINT trustwork_relay_handler`.execute(trx);
            await sql`RELEASE SAVEPOINT trustwork_relay_handler`.execute(trx);
            const payload: RedeliverPayload = { eventId: event.id, handler: handler.name };
            // The first redelivery waits one backoff step, so a transient outage is not hit again at once.
            const job = await context.enqueue({ kind: REDELIVER_KIND, payload, delaySeconds: retryDelaySeconds(config.retry, 1, config.retryJitter) });
            metrics.inc(...M.outboxEvents, { result: 'redelivery_queued' });
            log('warn', 'outbox handler failed; redelivery queued', { eventId: event.id, eventType: event.type, handler: handler.name, jobId: job.id, error: describeError(error) });
          }
        }
      }
      await outbox.markPublished(trx, events.map((e) => e.id));
      return events.length;
    });
  }
}
