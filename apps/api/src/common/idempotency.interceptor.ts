import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { buildIdempotencyScope, computeDigest, IDEMPOTENCY_KEY_HEADER, IdempotencyKeySchema } from '../deps/contracts.js';
import { idempotency, type DataPool, type IdempotencyRecord } from '../deps/data.js';
import { withoutPrincipal } from './db.js';
import type { ApiConfig } from '../config.js';
import { ApiError, renderError } from './errors.js';
import { IDEMPOTENT, stateOf, type IdempotentOptions } from './request.js';

interface StoredResult { httpStatus: number; body: unknown }

/**
 * `Idempotency-Key` for authenticated mutations (`@Idempotent(action, contextParam)`): scope
 * `(principalId, action, contextId, key)` with the canonical payload digest. Same key + same payload replays the
 * recorded result; a different payload is `validation.idempotency_conflict`; an unfinished first execution is
 * `validation.idempotency_in_progress`. Recorded 5xx results are re-executed (and overwritten) on retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly pool: DataPool, private readonly config: ApiConfig, private readonly log: (message: string, error?: unknown) => void = () => undefined) {}

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
    const expiresAt = new Date(Date.now() + this.config.idempotency.retentionMs);

    // idempotency_record carries no party data and no RLS; the scope already binds the principal id. Running it
    // without the transaction identity keeps bookkeeping independent of epoch bumps caused by the handler itself.
    const record = await withoutPrincipal(this.pool, async (trx) => {
      try {
        return { fresh: true as const, row: await idempotency.begin(trx, scope, payloadDigest, expiresAt) };
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        return { fresh: false as const, row: null };
      }
    });
    let existing: IdempotencyRecord | undefined;
    if (!record.fresh) {
      existing = await withoutPrincipal(this.pool, (trx) => idempotency.get(trx, scope));
      if (!existing) throw new ApiError('validation.idempotency_in_progress');
      if (existing.payload_digest !== payloadDigest) throw new ApiError('validation.idempotency_conflict');
      if (existing.state === 'in_progress' || !existing.result) throw new ApiError('validation.idempotency_in_progress');
      const stored = existing.result as unknown as StoredResult;
      if (stored.httpStatus < 500) {
        reply.status(stored.httpStatus);
        return stored.body;
      }
    }
    const recordId = record.fresh ? record.row.id : (existing as IdempotencyRecord).id;
    const store = async (result: StoredResult) => {
      await withoutPrincipal(this.pool, (trx) => (record.fresh ? idempotency.complete(trx, recordId, result) : idempotency.overwrite(trx, recordId, result))).catch((error: unknown) => this.log('idempotency record not stored', error));
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
}
