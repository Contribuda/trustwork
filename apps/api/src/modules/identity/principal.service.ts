import type { FastifyReply, FastifyRequest } from 'fastify';
import { PrincipalSchema, type Principal } from '../../deps/contracts.js';
import { auth, companies, emailBindings, memberships, persons, PrincipalError, sessions, withPrincipal, type Transaction } from '../../deps/data.js';
import { clearSessionCookie, readCookie, sessionCookieName, setSessionCookie } from '../../common/cookies.js';
import { ApiError, LocalApiError } from '../../common/errors.js';
import { jurisdictionHolds } from '../jurisdiction/deps.js';
import { completeInTransaction } from '../../common/idempotency/completion.js';
import type { RequestState, SessionState, TrustworkRequest } from '../../common/request.js';
import type { AppContext } from './context.js';
import { ipPrefix, randomToken, sha256Hex, userAgentFamily } from './tokens.js';

/**
 * Per-request principal resolution: session cookie -> hashed lookup through the pre-identity allowlist ->
 * one `withPrincipal` transaction that loads the person, the active employer membership with its permissions and
 * both authorization epochs. Nothing is cached across requests; a stale epoch is refused by the database and the
 * principal is re-resolved once (`runAs`).
 */
export class PrincipalService {
  constructor(private readonly ctx: AppContext) {}

  /** Fastify hook body: attaches `request.trustwork`; an invalid, expired or revoked cookie is treated as anonymous. */
  async attach(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const state: RequestState = {
      requestId: String(request.id),
      principal: null,
      session: null,
      sessionTokenHash: null,
      client: { userAgentFamily: userAgentFamily(request.headers['user-agent']), ipPrefix: ipPrefix(request.ip), ip: request.ip },
    };
    (request as TrustworkRequest).trustwork = state;
    const token = readCookie(request, sessionCookieName(this.ctx.config));
    if (!token) return;
    state.sessionTokenHash = sha256Hex(token);
    const resolved = await this.resolve(token);
    if (!resolved) {
      clearSessionCookie(reply, this.ctx.config);
      return;
    }
    state.principal = resolved.principal;
    state.session = resolved.session;
  }

  async resolve(token: string): Promise<{ principal: Principal; session: SessionState } | null> {
    const now = this.ctx.clock.now();
    const lookup = await auth.lookupSession(this.ctx.pool, sha256Hex(token));
    if (!lookup || lookup.revoked_at || lookup.idle_expires_at.getTime() <= now.getTime() || lookup.absolute_expires_at.getTime() <= now.getTime()) return null;
    const base = { personId: lookup.person_id, authzEpoch: lookup.authz_epoch };
    return this.load(base, lookup.session_id, now, true);
  }

  /** Loads the principal; a stale epoch (authority changed between lookup and transaction) re-reads it once. */
  private async load(base: { personId: string; authzEpoch: number }, sessionId: string, now: Date, retry: boolean): Promise<{ principal: Principal; session: SessionState } | null> {
    try {
      return await withPrincipal(this.ctx.pool, base, async (trx) => {
        const row = await sessions.getById(trx, sessionId);
        if (!row || row.revoked_at) return null;
        if (now.getTime() - row.last_seen_at.getTime() > this.ctx.config.session.touchIntervalMs) {
          const idle = new Date(Math.min(now.getTime() + this.ctx.config.session.idleMs, row.absolute_expires_at.getTime()));
          await sessions.touch(trx, row.id, idle, now);
        }
        const principal = await this.buildPrincipal(trx, base.personId, base.authzEpoch, row.authenticated_at);
        return { principal, session: { id: row.id, personId: row.person_id, authenticatedAt: row.authenticated_at, createdAt: row.created_at, authMethod: row.auth_method } };
      });
    } catch (error) {
      if (error instanceof PrincipalError && error.code === 'access.stale_epoch' && retry) {
        const fresh = await this.epochOf(base.personId);
        if (fresh === null) return null;
        return this.load({ personId: base.personId, authzEpoch: fresh }, sessionId, now, false);
      }
      if (error instanceof PrincipalError) return null;
      throw error;
    }
  }

  /** Current epoch of a person through the owner-run epoch lookup (no identity needed; the value is not secret). */
  private async epochOf(personId: string): Promise<number | null> {
    const { rows } = await this.ctx.pool.query<{ authz_epoch: number }>('SELECT authz_epoch FROM trustwork.auth_person_epoch($1::uuid)', [personId]);
    return rows[0]?.authz_epoch ?? null;
  }

  async buildPrincipal(trx: Transaction, personId: string, authzEpoch: number, authenticatedAt: Date): Promise<Principal> {
    const person = await persons.getById(trx, personId);
    if (!person) throw new ApiError('auth.session_invalid', 'person not visible');
    const bindings = await emailBindings.listForPerson(trx, personId);
    const membership = await memberships.activeForPerson(trx, personId);
    let membershipView: Principal['membership'] = null;
    if (membership && membership.valid_from && membership.valid_from.getTime() <= this.ctx.clock.now().getTime()) {
      const company = await companies.getById(trx, membership.company_id);
      membershipView = {
        companyId: membership.company_id,
        membershipId: membership.id,
        role: membership.role,
        permissions: membership.permissions as Principal extends { membership: infer M } ? (M extends { permissions: infer P } ? P : never) : never,
        companyAuthzEpoch: company?.authz_epoch ?? 0,
      };
    }
    return PrincipalSchema.parse({
      personId,
      emailVerified: bindings.some((b) => b.is_primary && b.verified_at !== null),
      authenticatedAt: authenticatedAt.toISOString(),
      authzEpoch,
      membership: membershipView,
      staff: await this.ctx.staffRoles(personId, trx),
      delegation: null,
    });
  }

  /**
   * Runs `fn` as the request principal. A stale epoch (authority changed since resolution) re-resolves the principal
   * from the same session once and retries; a second failure surfaces as a conflict. Commands whose decisions
   * bind the resolved request authority pass refreshStale=false and fail closed without a refresh or retry.
   */
  async runAs<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>, options: { snapshot?: true; refreshStale?: boolean } = {}): Promise<T> {
    if (!state.principal || !state.session) throw new ApiError('auth.session_invalid', 'authentication required');
    const principal = state.principal;
    const transactionOptions = options.snapshot ? { snapshot: true as const } : undefined;
    // An idempotent request completes its idempotency record in this same transaction (BE-005, ADR 012 decision 39).
    const run = async (trx: Transaction, p: Principal): Promise<T> => {
      const result = await fn(trx, p);
      await completeInTransaction(state, trx, result);
      return result;
    };
    try {
      return await withPrincipal(this.ctx.pool, { personId: principal.personId, authzEpoch: principal.authzEpoch }, (trx) => run(trx, principal), transactionOptions);
    } catch (error) {
      if (options.refreshStale === false || !(error instanceof PrincipalError) || error.code !== 'access.stale_epoch') throw error;
      const fresh = await this.refresh(state);
      return withPrincipal(this.ctx.pool, { personId: fresh.personId, authzEpoch: fresh.authzEpoch }, (trx) => run(trx, fresh), transactionOptions);
    }
  }

  private async refresh(state: RequestState): Promise<Principal> {
    const session = state.session as SessionState;
    if (!state.sessionTokenHash) throw new ApiError('auth.session_invalid', 'session no longer valid');
    const lookup = await auth.lookupSession(this.ctx.pool, state.sessionTokenHash);
    if (!lookup || lookup.revoked_at) throw new ApiError('auth.session_invalid', 'session no longer valid');
    const principal = await withPrincipal(this.ctx.pool, { personId: lookup.person_id, authzEpoch: lookup.authz_epoch }, (trx) => this.buildPrincipal(trx, lookup.person_id, lookup.authz_epoch, session.authenticatedAt));
    state.principal = principal;
    return principal;
  }

  /**
   * Creates a session row inside the caller's transaction (the principal must already be set on it), so the session,
   * its audit row and its outbox intent commit together. The raw token is returned for `setCookie` after COMMIT.
   */
  async createSession(trx: Transaction, request: FastifyRequest, personId: string, authMethod: 'password' | 'google' | 'apple' | 'recovery'): Promise<{ sessionId: string; token: string }> {
    // A person held after a sighting in a restricted place is refused at every sign-in path, by name (SANC-001).
    if (await jurisdictionHolds.callerHeld(trx)) throw new LocalApiError('auth.jurisdiction_hold', 'this account is paused for a location check');
    const now = this.ctx.clock.now();
    const token = randomToken();
    const absolute = new Date(now.getTime() + this.ctx.config.session.absoluteMs);
    const idle = new Date(Math.min(now.getTime() + this.ctx.config.session.idleMs, absolute.getTime()));
    const row = await sessions.insert(trx, {
      person_id: personId, token_hash_hex: sha256Hex(token), created_at: now, last_seen_at: now, authenticated_at: now,
      idle_expires_at: idle, absolute_expires_at: absolute, auth_method: authMethod, user_agent_family: userAgentFamily(request.headers['user-agent']), ip_prefix: ipPrefix(request.ip),
    });
    return { sessionId: row.id, token };
  }

  /** Sets the session cookie; call only after the transaction that created the session has committed. */
  setCookie(reply: FastifyReply, token: string): void {
    setSessionCookie(reply, this.ctx.config, token);
  }

  /** Creates a session in its own transaction and sets the cookie (callers without other changes to commit). */
  async issueSession(reply: FastifyReply, request: FastifyRequest, personId: string, authzEpoch: number, authMethod: 'password' | 'google' | 'apple' | 'recovery'): Promise<{ sessionId: string }> {
    const { sessionId, token } = await withPrincipal(this.ctx.pool, { personId, authzEpoch }, (trx) => this.createSession(trx, request, personId, authMethod));
    this.setCookie(reply, token);
    return { sessionId };
  }
}
