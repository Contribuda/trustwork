import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DataPool } from '../../deps/data.js';
import type { RequestState, TrustworkRequest } from '../../common/request.js';
import { screeningStates } from './deps.js';

/**
 * Suspension of a person whose possible match was confirmed (SANC-003; ADR 014 decisions 14 and 15). The confirmation
 * itself ends the person's sessions and stops their agent (screening_apply_suspension). The person may sign in again,
 * but only to read their own compliance status, appeal and sign out: every other request of a suspended person is
 * answered 403 `auth.compliance_suspended`. A possible match never refuses anything here.
 *
 * Runs as an `onRequest` hook after the jurisdiction gate, so a restricted place is still refused first.
 */
const SELF_SERVICE = new Set(['GET /v1/me', 'POST /v1/auth/logout', 'POST /v1/auth/step-up', 'POST /v1/auth/second-factor', 'GET /v1/screening/me', 'POST /v1/screening/me/appeal']);
export function suspensionAllows(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return SELF_SERVICE.has(`${method.toUpperCase()} ${path}`) || path === '/health' || path.startsWith('/health/');
}

export interface SuspensionHookDeps {
  pool: DataPool;
  log: { error(event: string, fields?: Record<string, unknown>): void };
}

export function suspensionHook(deps: SuspensionHookDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const state: RequestState | undefined = (request as TrustworkRequest).trustwork;
    const tokenHash = state?.sessionTokenHash ?? null;
    if (!tokenHash || !state?.session || suspensionAllows(request.method, request.url)) return;
    let suspended: boolean;
    try {
      suspended = await screeningStates.sessionSuspended(deps.pool, tokenHash);
    } catch (error) {
      deps.log.error('screening.suspension_check_failed', { err: error });
      return reply.code(503).header('Cache-Control', 'no-store').type('application/json; charset=utf-8').send({ code: 'internal.error', message: 'temporarily unavailable', requestId: String(request.id) });
    }
    if (suspended) {
      return reply.code(403).header('Cache-Control', 'no-store').type('application/json; charset=utf-8')
        .send({ code: 'auth.compliance_suspended', message: 'This account is suspended for legal reasons. You can read your compliance status and appeal.', requestId: String(request.id) });
    }
  };
}
