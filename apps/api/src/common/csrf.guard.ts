import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { CSRF_HEADER } from '../deps/contracts.js';
import type { ApiConfig } from '../config.js';
import { ApiError } from './errors.js';
import { CSRF_EXEMPT } from './request.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Mutation CSRF defence (ADR 002 amendment): a non-safe request must carry the custom header `X-Trustwork-Request`
 * and prove same-origin through `Sec-Fetch-Site: same-origin`, or, when fetch metadata is absent, through an
 * `Origin` (or `Referer` origin) equal to the configured public origin. `none`, `same-site`, `cross-site`, a missing
 * or `null` origin are rejected. GET never mutates; provider callbacks opt out explicitly and rely on `state`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT, [context.getHandler(), context.getClass()])) return true;
    const header = request.headers[CSRF_HEADER.toLowerCase()];
    if (header === undefined || header === '') throw new ApiError('auth.csrf_rejected', `missing ${CSRF_HEADER} header`);
    const site = request.headers['sec-fetch-site'];
    if (typeof site === 'string') {
      if (site === 'same-origin') return true;
      throw new ApiError('auth.csrf_rejected', 'cross-site mutation rejected');
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : originOf(request.headers.referer);
    if (origin && origin === this.config.publicOrigin) return true;
    throw new ApiError('auth.csrf_rejected', 'origin verification failed');
  }
}

function originOf(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
