import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../deps/contracts.js';
import { ApiError } from './errors.js';

/** Acting session summary attached to the request after resolution (never the token or its hash). */
export interface SessionState { id: string; personId: string; authenticatedAt: Date; createdAt: Date; authMethod: string }

/** Per-request state resolved by the identity hook before any controller runs. */
export interface RequestState {
  requestId: string;
  principal: Principal | null;
  session: SessionState | null;
  /** SHA-256 of the presented session token (never the token); lets a stale principal be re-resolved in place. */
  sessionTokenHash: string | null;
  /** Coarse client data for the "my sessions" list only (never surfaced to employers). */
  client: { userAgentFamily: string; ipPrefix: string; ip: string };
}
export type TrustworkRequest = FastifyRequest & { trustwork: RequestState };
export type { FastifyReply };

export function stateOf(request: FastifyRequest): RequestState {
  const state = (request as TrustworkRequest).trustwork;
  if (!state) throw new Error('request state missing: the identity hook did not run');
  return state;
}

/** Metadata keys read by the global guards and interceptors. */
export const AUTH_REQUIREMENT = 'trustwork:auth';
export const CSRF_EXEMPT = 'trustwork:csrf-exempt';
export const IDEMPOTENT = 'trustwork:idempotent';
export type AuthRequirement = 'session' | 'step_up';

/** Route requires an authenticated session; `step_up` additionally requires a recent authentication proof. */
export const Authenticated = (requirement: AuthRequirement = 'session') => SetMetadata(AUTH_REQUIREMENT, requirement);
/** Provider callbacks are top-level navigations from the provider; they are protected by `state` + the flow cookie. */
export const CsrfExempt = () => SetMetadata(CSRF_EXEMPT, true);
export interface IdempotentOptions { action: string; contextParam?: string }
export const Idempotent = (action: string, contextParam?: string) => SetMetadata(IDEMPOTENT, { action, ...(contextParam ? { contextParam } : {}) } satisfies IdempotentOptions);

export const Req = createParamDecorator((_: unknown, ctx: ExecutionContext): TrustworkRequest => ctx.switchToHttp().getRequest<TrustworkRequest>());
export const ReqState = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestState => stateOf(ctx.switchToHttp().getRequest<FastifyRequest>()));
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const state = stateOf(ctx.switchToHttp().getRequest<FastifyRequest>());
  if (!state.principal) throw new ApiError('auth.session_invalid', 'authentication required');
  return state.principal;
});
export const OptionalPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal | null => stateOf(ctx.switchToHttp().getRequest<FastifyRequest>()).principal);
