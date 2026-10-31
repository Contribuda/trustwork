import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { buildIdempotencyScope, computeDigest, IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema } from '../../deps/contracts.js';
import { idempotency, type DataPool, type IdempotencyRecord, type IdempotencyScope } from '../../deps/data.js';
import { withoutPrincipal } from '../db.js';
import type { ApiConfig } from '../../config.js';
import { ApiError, renderError } from '../errors.js';
import { IDEMPOTENT, stateOf, type IdempotentOptions } from '../request.js';
import { bindCompletion, InTransactionCompletion, unbindCompletion } from './completion.js';
import { leases, type StoredResult } from './records.js';
import { completionModeOf } from './routes.js';

interface Clock { now(): Date }
const systemClock: Clock = { now: () => new Date() };

/**
 * How long an unfinished execution blocks a retry with the same key before the retry may take the record over
 * (exactly one concurrent retry wins).
 *
 * For `in_transaction` routes (common/idempotency/routes.ts) the takeover is safe: the completion commits together
 * with the effect, so an execution that left the record `in_progress` committed nothing, and the lease fence makes a
 * still-running original roll back instead of committing after it lost the record. The lease only bounds how long a
 * retry waits for an execution that may have died before COMMIT.
 *
 * For `lease` routes the completion is a separate bookkeeping write; an execution that crashed between its commit
 * and that write is re-run by the takeover and its effects are repeated (documented per route).
 */
export const IDEMPOTENCY_TAKEOVER_LEASE_MS = 30_000;

type Claim = { replay: StoredResult } | { recordId: string; lease: Date };

/**
 * `Idempotency-Key` for authenticated mutations (`@Idempotent(action, contextParam)`): scope
 * `(principalId, action, contextId, key)` with the canonical payload digest. Same key + same payload replays the
 * recorded result; a different payload is `validation.idempotency_conflict`; an unfinished execution is
 * `validation.idempotency_in_progress` until its takeover lease passes. Successful `in_transaction` routes complete the
 * record inside the handler's transaction; error results and `lease` routes complete it in a bookkeeping transaction.
 * Recorded 5xx results are re-executed by exactly one retry. Every instant comes from the injected clock.
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
    const mode = completionModeOf(options.action);
    const header = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    const key = IdempotencyKeySchema.safeParse(Array.isArray(header) ? header[0] : header);
    if (!key.success) throw new ApiError('validation.schema', `${IDEMPOTENCY_KEY_HEADER} header is required for this mutation`, { header: IDEMPOTENCY_KEY_HEADER });
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const contextId = (options.contextParam ? params[options.contextParam] : undefined) ?? 'none';
    const { scope } = buildIdempotencyScope({ principalId: state.principal.personId, action: options.action, contextId, key: key.data });
    const payloadDigest = computeDigest(request.body ?? null).value;

    // idempotency_record carries no party data and no RLS; the scope already binds the principal id. Claiming and the
    // bookkeeping writes run without the transaction identity, independent of epoch bumps caused by the handler.
    const claimed = await this.claim(scope, payloadDigest);
    if ('replay' in claimed) {
      reply.status(claimed.replay.httpStatus);
      return claimed.replay.body;
    }
    const { recordId, lease } = claimed;
    const retainUntil = () => new Date(this.clock.now().getTime() + this.config.idempotency.retentionMs);
    const declared = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    const httpStatus = declared ?? (request.method === 'POST' ? 201 : 200);
    const completion = mode.kind === 'in_transaction' ? new InTransactionCompletion(recordId, lease, httpStatus, retainUntil) : null;
    const store = async (result: StoredResult) => {
      const stored = await withoutPrincipal(this.pool, (trx) => leases.complete(trx, recordId, lease, result, retainUntil())).catch((error: unknown) => {
        this.log('idempotency record not stored', error);
        return true;
      });
      if (!stored) this.log('idempotency record already completed or taken over by a retry; result not stored');
    };
    if (completion) bindCompletion(state, completion);
    try {
      const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
      // The completion committed with the handler's transaction: there is no bookkeeping left to lose.
      if (completion?.recorded) return body;
      if (completion) this.log(`idempotent action ${options.action} returned without completing in its transaction; stored by bookkeeping`);
      await store({ httpStatus, body: body === undefined ? null : body });
      return body;
    } catch (error) {
      // The handler's transaction rolled back (or its outcome is unknown): the conditional write stores the error
      // only while the record is still in progress under this execution's lease.
      const rendered = renderError(error, state.requestId);
      await store({ httpStatus: rendered.status, body: rendered.body });
      throw error;
    } finally {
      if (completion) unbindCompletion(state);
    }
  }

  /** Reserves the key, replays a finished result, or takes over an abandoned or failed execution. */
  private async claim(scope: IdempotencyScope, payloadDigest: string): Promise<Claim> {
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
    if (existing.state === 'completed') return this.settled(existing, lease);
    const takenOver = await withoutPrincipal(this.pool, (trx) => leases.takeOver(trx, existing.id, now, lease));
    if (takenOver) return { recordId: takenOver.id, lease };
    // The takeover is conditional on `in_progress`: when it lost, the execution may just have committed its
    // completion (the takeover waited on its row lock). Re-read and replay a committed completion instead of
    // answering "in progress" or re-running the handler.
    const current = await withoutPrincipal(this.pool, (trx) => idempotency.get(trx, scope));
    if (current?.state === 'completed') return this.settled(current, lease);
    const until = current?.expires_at ?? existing.expires_at;
    const retryAfterSeconds = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
    throw new ApiError('validation.idempotency_in_progress', 'an earlier request with this key is still running', { retryAfterSeconds });
  }

  /** A completed record replays its result; a recorded 5xx is re-opened for exactly one retry. */
  private async settled(record: IdempotencyRecord, lease: Date): Promise<Claim> {
    const stored = record.result as unknown as StoredResult;
    if (stored.httpStatus < 500) return { replay: stored };
    const reopened = await withoutPrincipal(this.pool, (trx) => leases.reopen(trx, record.id, lease));
    if (reopened) return { recordId: reopened.id, lease };
    throw new ApiError('validation.idempotency_in_progress');
  }
}
