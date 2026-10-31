import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { buildIdempotencyScope, computeDigest, IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema } from '../deps/contracts.js';
import { idempotency, type DataPool, type IdempotencyRecord, type IdempotencyScope, type Transaction } from '../deps/data.js';
import { withoutPrincipal } from './db.js';
import type { ApiConfig } from '../config.js';
import { ApiError, renderError } from './errors.js';
import { IDEMPOTENT, stateOf, type IdempotentOptions } from './request.js';

interface StoredResult { httpStatus: number; body: unknown }
interface Clock { now(): Date }
const systemClock: Clock = { now: () => new Date() };

/**
 * How long an unfinished first execution blocks a retry with the same key. A process that crashes between the
 * handler's commit and the bookkeeping write leaves the record `in_progress`; once this lease has passed, the next
 * retry takes the record over (exactly one concurrent retry wins) and executes the handler again. Effects committed
 * by the crashed execution are therefore not deduplicated; that is the documented price of not blocking the user for
 * the whole retention period (architecture audit B3).
 */
export const IDEMPOTENCY_TAKEOVER_LEASE_MS = 30_000;

/** Lease bookkeeping on idempotency_record: `expires_at` is the lease while in_progress and the retention once completed. */
const leases = {
  /** Takes over an in_progress record whose lease has passed; undefined when another request holds a live lease. */
  takeOver(trx: Transaction, id: string, now: Date, leaseUntil: Date): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ expires_at: leaseUntil })
      .where('id', '=', id).where('state', '=', 'in_progress').where('expires_at', '<=', now).returningAll().executeTakeFirst();
  },
  /** Re-opens a recorded server-side failure (5xx) for exactly one retry. */
  reopen(trx: Transaction, id: string, leaseUntil: Date): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ state: 'in_progress', result: null, expires_at: leaseUntil })
      .where('id', '=', id).where('state', '=', 'completed').where(sql<boolean>`(result ->> 'httpStatus')::int >= 500`).returningAll().executeTakeFirst();
  },
  /** Completes the record only while this execution still holds its lease (a takeover moved `expires_at`). */
  async complete(trx: Transaction, id: string, heldLease: Date, result: StoredResult, retainUntil: Date): Promise<boolean> {
    const done = await trx.updateTable('idempotency_record').set({ state: 'completed', result: JSON.stringify(result), expires_at: retainUntil })
      .where('id', '=', id).where('state', '=', 'in_progress').where('expires_at', '=', heldLease).executeTakeFirst();
    return Number(done.numUpdatedRows) === 1;
  },
};

/**
 * `Idempotency-Key` for authenticated mutations (`@Idempotent(action, contextParam)`): scope
 * `(principalId, action, contextId, key)` with the canonical payload digest. Same key + same payload replays the
 * recorded result; a different payload is `validation.idempotency_conflict`; an unfinished first execution is
 * `validation.idempotency_in_progress` until its takeover lease passes. Recorded 5xx results are re-executed by
 * exactly one retry. Every instant comes from the injected clock.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly pool: DataPool,
    private readonly config: ApiConfig,
    private readonly log: (message: string, error?: unknown) => void = () => undefined,
    private readonly clock: Clock = systemClock,
    private readonly leaseMs: number = IDEMPOTENCY_TAKEOVER_LEASE_MS,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT, context.getHandler());
    if (!options) return next.handle();
    return from(this.run(context, next, options));
  }

  private async run(context: ExecutionContext, next: CallHandler, options: IdempotentOptions): Promise<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const state = stateOf(request);
    if (!state.principal) throw new ApiError('auth.session_invalid', 'authentication required');
    const header = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    const key = IdempotencyKeySchema.safeParse(Array.isArray(header) ? header[0] : header);
    if (!key.success) throw new ApiError('validation.schema', `${IDEMPOTENCY_KEY_HEADER} header is required for this mutation`, { header: IDEMPOTENCY_KEY_HEADER });
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const contextId = (options.contextParam ? params[options.contextParam] : undefined) ?? 'none';
    const { scope } = buildIdempotencyScope({ principalId: state.principal.personId, action: options.action, contextId, key: key.data });
    const payloadDigest = computeDigest(request.body ?? null).value;

    // idempotency_record carries no party data and no RLS; the scope already binds the principal id. Running it
    // without the transaction identity keeps bookkeeping independent of epoch bumps caused by the handler itself.
    const claimed = await this.claim(scope, payloadDigest);
    if ('replay' in claimed) {
      reply.status(claimed.replay.httpStatus);
      return claimed.replay.body;
    }
    const { recordId, lease } = claimed;
    const store = async (result: StoredResult) => {
      const retainUntil = new Date(this.clock.now().getTime() + this.config.idempotency.retentionMs);
      const stored = await withoutPrincipal(this.pool, (trx) => leases.complete(trx, recordId, lease, result, retainUntil)).catch((error: unknown) => {
        this.log('idempotency record not stored', error);
        return true;
      });
      if (!stored) this.log('idempotency record taken over by a retry; result not stored');
    };
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      const declared = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
      const httpStatus = declared ?? (request.method === 'POST' ? 201 : 200);
      await store({ httpStatus, body: body === undefined ? null : body });
      return body;
    } catch (error) {
      const rendered = renderError(error, state.requestId);
      await store({ httpStatus: rendered.status, body: rendered.body });
      throw error;
    }
  }

  /** Reserves the key, replays a finished result, or takes over an abandoned or failed execution. */
  private async claim(scope: IdempotencyScope, payloadDigest: string): Promise<{ replay: StoredResult } | { recordId: string; lease: Date }> {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + this.leaseMs);
    const fresh = await withoutPrincipal(this.pool, async (trx) => {
      try {
        return await idempotency.begin(trx, scope, payloadDigest, lease);
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return null;
      }
    });
    if (fresh) return { recordId: fresh.id, lease };
    const existing = await withoutPrincipal(this.pool, (trx) => idempotency.get(trx, scope));
    if (!existing) throw new ApiError('validation.idempotency_in_progress');
    if (existing.payload_digest !== payloadDigest) throw new ApiError('validation.idempotency_conflict');
    if (existing.state === 'completed' && existing.result) {
      const stored = existing.result as unknown as StoredResult;
      if (stored.httpStatus < 500) return { replay: stored };
      const reopened = await withoutPrincipal(this.pool, (trx) => leases.reopen(trx, existing.id, lease));
      if (reopened) return { recordId: reopened.id, lease };
      throw new ApiError('validation.idempotency_in_progress');
    }
    const takenOver = await withoutPrincipal(this.pool, (trx) => leases.takeOver(trx, existing.id, now, lease));
    if (takenOver) return { recordId: takenOver.id, lease };
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.expires_at.getTime() - now.getTime()) / 1000));
    throw new ApiError('validation.idempotency_in_progress', 'an earlier request with this key is still running', { retryAfterSeconds });
  }
}
