import type { FastifyReply, FastifyRequest } from 'fastify';
import { toSessionView, type Principal, type SessionView } from '../../deps/contracts.js';
import { auditEvents, auth, authTokens, credentials, emailBindings, outbox, persons, sessions, withPrincipal, type Transaction } from '../../deps/data.js';
import { clearSessionCookie } from '../../common/cookies.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from './context.js';
import type { PasswordService } from './password.service.js';
import type { PrincipalService } from './principal.service.js';
import { toPerson, toSession } from './serializers.js';
import { randomToken, sha256Hex, subjectHash } from './tokens.js';

/**
 * Classic authentication: signup with verification, login with lockout, logout, recovery, step-up, password and
 * e-mail change, session listing and revocation. Responses of pre-identity commands are identical whether an address
 * exists (enumeration safety); the work performed is identical too (hashing always happens).
 */
export class AuthService {
  constructor(private readonly ctx: AppContext, private readonly passwords: PasswordService, private readonly principals: PrincipalService) {}

  private get now(): Date {
    return this.ctx.clock.now();
  }

  private audit(action: string, objectKind: string, objectId: string, requestId: string, actor: string | null = null, basis?: unknown, reason?: string): Promise<unknown> {
    return withoutPrincipal(this.ctx.pool, (trx) => auditEvents.append(trx, { actor_person_id: actor, action, object_kind: objectKind, object_id: objectId, request_id: requestId, ...(reason ? { reason } : {}), basis }));
  }

  /** Same status, body and work for new and already-bound addresses; the difference is only which e-mail goes out. */
  async signup(input: { name: string; email: string; password: string; acceptedTermsVersion: string }, requestId: string): Promise<{ status: 'verification_sent' }> {
    const passwordHash = await this.passwords.hash(input.password);
    const token = randomToken();
    const personId = await auth.registerPerson(this.ctx.pool, {
      displayName: input.name, emailNormalized: input.email, passwordHash, verifyTokenHashHex: sha256Hex(token), verifyExpiresAt: new Date(this.now.getTime() + this.ctx.config.tokens.verifyEmailMs),
    });
    const message = personId
      ? { to: input.email, template: 'verify_email' as const, params: { token, expiresInHours: String(this.ctx.config.tokens.verifyEmailMs / 3_600_000) } }
      : { to: input.email, template: 'already_registered' as const, params: {} };
    await this.ctx.mail.send(message);
    await this.audit(personId ? 'auth.signup' : 'auth.signup_duplicate', 'email', sha256Hex(input.email).slice(0, 32), requestId, null, { acceptedTermsVersion: input.acceptedTermsVersion, personId });
    return { status: 'verification_sent' };
  }

  /**
   * Verification POST: consumes the single-use token, marks the binding verified, invalidates everything created for
   * the address before verification (sessions, tokens, provider links) and issues the first session, or keeps the
   * acting session of the same person and revokes the others. Also completes e-mail change tokens.
   */
  async verifyEmail(token: string, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'verified'; personId: string; email: string }> {
    const hash = sha256Hex(token);
    let consumed = await auth.consumeToken(this.ctx.pool, hash, 'verify_email');
    let kind: 'verify_email' | 'email_change' = 'verify_email';
    if (!consumed) {
      consumed = await auth.consumeToken(this.ctx.pool, hash, 'email_change');
      kind = 'email_change';
    }
    if (!consumed) throw new ApiError('access.not_found', 'verification token is invalid or expired');
    const { person_id: personId, authz_epoch: epoch, email_normalized: email } = consumed;
    const acting = state.session && state.session.personId === personId ? state.session.id : null;
    const now = this.now;
    await withPrincipal(this.ctx.pool, { personId, authzEpoch: epoch }, async (trx) => {
      if (kind === 'verify_email') {
        const binding = await emailBindings.getOwnByEmail(trx, email);
        if (!binding) throw new ApiError('access.not_found', 'verification token is invalid or expired');
        if (!binding.verified_at) await emailBindings.markVerified(trx, binding.id, now);
      } else {
        const inserted = await emailBindings.insert(trx, personId, email, false);
        await emailBindings.markVerified(trx, inserted.id, now);
        await emailBindings.setPrimary(trx, personId, inserted.id);
      }
      await sessions.revokeCreatedBefore(trx, personId, now, 'suspicious', acting, now);
      // Pre-hijack defence (T02) targets links planted on a password-signup account; a provider-first person's own
      // link is the way they signed in and is kept (as is the acting session's provider).
      const creds = await credentials.listForPerson(trx, personId);
      const actingProvider = acting && state.session && (state.session.authMethod === 'google' || state.session.authMethod === 'apple') ? state.session.authMethod : null;
      if (creds.some((c) => c.kind === 'password' && !c.disabled_at)) await credentials.disableProvidersCreatedBefore(trx, personId, now, now, actingProvider);
      await authTokens.consumeOutstanding(trx, personId, kind === 'verify_email' ? 'verify_email' : null, now);
      await auditEvents.append(trx, { actor_person_id: personId, action: kind === 'verify_email' ? 'auth.email_verified' : 'auth.email_changed', object_kind: 'person', object_id: personId, request_id: state.requestId, authz_epoch: epoch });
      await outbox.append(trx, { aggregate_kind: 'person', aggregate_id: personId, revision: 1, type: kind === 'verify_email' ? 'identity.email_verified' : 'identity.email_changed', payload: {} });
    });
    if (!acting) await this.principals.issueSession(reply, request, personId, epoch, 'password');
    return { status: 'verified', personId, email };
  }

  /** H03 pre-check: per-account and per-IP failure counts inside the window answer auth.throttled before any verification. */
  private async throttle(email: string, state: RequestState, action: string): Promise<{ accountSubject: string; ipSubject: string }> {
    const accountSubject = subjectHash('account', email);
    const ipSubject = subjectHash('ip', state.client.ip);
    const { lockout } = this.ctx.config;
    const [accountFailures, ipFailures] = await Promise.all([
      auth.loginFailureCount(this.ctx.pool, accountSubject, lockout.windowSeconds),
      auth.loginFailureCount(this.ctx.pool, ipSubject, lockout.windowSeconds),
    ]);
    if (accountFailures >= lockout.accountThreshold || ipFailures >= lockout.ipThreshold) {
      await this.audit(`${action}_throttled`, 'email', accountSubject.slice(0, 32), state.requestId);
      throw new ApiError('auth.throttled', 'too many failed attempts; try again later', { retryAfterSeconds: lockout.windowSeconds });
    }
    return { accountSubject, ipSubject };
  }

  /** Records a failed password proof for the account and the IP; disables the password after the daily threshold. */
  private async recordFailure(email: string, subjects: { accountSubject: string; ipSubject: string }, state: RequestState, action: string): Promise<void> {
    const { lockout } = this.ctx.config;
    const count = await auth.recordLoginFailure(this.ctx.pool, subjects.accountSubject, lockout.windowSeconds, lockout.retentionSeconds);
    await auth.recordLoginFailure(this.ctx.pool, subjects.ipSubject, lockout.windowSeconds, lockout.retentionSeconds);
    const daily = await auth.loginFailureCount(this.ctx.pool, subjects.accountSubject, lockout.disableWindowSeconds);
    if (daily >= lockout.disableThreshold && (await auth.disablePassword(this.ctx.pool, email))) {
      await this.audit('auth.password_disabled', 'email', subjects.accountSubject.slice(0, 32), state.requestId, null, { failures: daily });
    }
    await this.audit(`${action}_failed`, 'email', subjects.accountSubject.slice(0, 32), state.requestId, null, { windowFailures: count });
  }

  async login(input: { email: string; password: string }, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'authenticated'; personId: string }> {
    const subjects = await this.throttle(input.email, state, 'auth.login');
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, input.email);
    const verified = await this.passwords.verify(lookup.password_hash, input.password);
    const ok = verified && lookup.person_id !== null && lookup.disabled_at === null && lookup.email_verified;
    if (!ok || lookup.person_id === null || lookup.authz_epoch === null) {
      await this.recordFailure(input.email, subjects, state, 'auth.login');
      throw new ApiError('auth.invalid_credentials', 'invalid e-mail or password');
    }
    const personId = lookup.person_id;
    const epoch = lookup.authz_epoch;
    if (this.passwords.needsRehash(lookup.password_hash)) {
      const rehashed = await this.passwords.hash(input.password);
      await withPrincipal(this.ctx.pool, { personId, authzEpoch: epoch }, (trx) => credentials.setPasswordHash(trx, personId, rehashed));
    }
    const { sessionId } = await this.principals.issueSession(reply, request, personId, epoch, 'password');
    await this.audit('auth.login', 'person', personId, state.requestId, personId, { sessionId, method: 'password' });
    return { status: 'authenticated', personId };
  }

  async logout(state: RequestState, reply: FastifyReply): Promise<void> {
    if (state.session && state.principal) {
      const sessionId = state.session.id;
      await this.principals.runAs(state, async (trx, principal) => {
        await sessions.revoke(trx, sessionId, 'logout', this.now);
        await auditEvents.append(trx, { actor_person_id: principal.personId, action: 'auth.logout', object_kind: 'session', object_id: sessionId, request_id: state.requestId, authz_epoch: principal.authzEpoch });
      });
    }
    clearSessionCookie(reply, this.ctx.config);
  }

  /** Identical work and response for unknown addresses; the mail decision is taken after the response is prepared. */
  async requestRecovery(email: string, requestId: string): Promise<{ status: 'recovery_sent' }> {
    const token = randomToken();
    const personId = await auth.issueToken(this.ctx.pool, {
      emailNormalized: email, kind: 'recovery', tokenHashHex: sha256Hex(token), expiresAt: new Date(this.now.getTime() + this.ctx.config.tokens.recoveryMs), requireVerified: true,
    });
    const response = { status: 'recovery_sent' as const };
    if (personId) {
      // A newer request invalidates earlier tokens (RC-03): consume everything created before this issuance.
      await withPrincipal(this.ctx.pool, await this.epochOf(personId, email), (trx) => authTokens.consumeOutstanding(trx, personId, 'recovery', this.now, sha256Hex(token))).catch(() => undefined);
      await this.ctx.mail.send({ to: email, template: 'recovery', params: { token, expiresInMinutes: String(this.ctx.config.tokens.recoveryMs / 60_000) } });
    }
    await this.audit('auth.recovery_requested', 'email', sha256Hex(email).slice(0, 32), requestId, personId);
    return response;
  }

  async completeRecovery(input: { token: string; newPassword: string }, requestId: string): Promise<{ status: 'password_reset' }> {
    const consumed = await auth.consumeToken(this.ctx.pool, sha256Hex(input.token), 'recovery');
    if (!consumed) throw new ApiError('access.not_found', 'recovery token is invalid or expired');
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.now;
    await withPrincipal(this.ctx.pool, { personId: consumed.person_id, authzEpoch: consumed.authz_epoch }, async (trx) => {
      const updated = await credentials.setPasswordHash(trx, consumed.person_id, passwordHash);
      if (updated === 0) await credentials.insertPassword(trx, consumed.person_id, passwordHash);
      const binding = await emailBindings.getOwnByEmail(trx, consumed.email_normalized);
      if (binding && !binding.verified_at) {
        await emailBindings.markVerified(trx, binding.id, now);
        if (updated > 0) await credentials.disableProvidersCreatedBefore(trx, consumed.person_id, now, now);
      }
      await sessions.revokeAllForPerson(trx, consumed.person_id, 'recovery', null, now);
      await authTokens.consumeOutstanding(trx, consumed.person_id, null, now);
      await auditEvents.append(trx, { actor_person_id: consumed.person_id, action: 'auth.recovery_completed', object_kind: 'person', object_id: consumed.person_id, request_id: requestId, authz_epoch: consumed.authz_epoch });
      await outbox.append(trx, { aggregate_kind: 'person', aggregate_id: consumed.person_id, revision: 1, type: 'identity.sessions_revoked', payload: { reason: 'recovery' } });
    });
    await this.ctx.mail.send({ to: consumed.email_normalized, template: 'security_notice', params: { event: 'password_reset' } });
    return { status: 'password_reset' };
  }

  /** Step-up: the password of the acting person refreshes `authenticatedAt` of the acting session only. */
  async stepUp(password: string, state: RequestState): Promise<{ status: 'authenticated'; authenticatedAt: string }> {
    const principal = state.principal as Principal;
    const email = await this.primaryEmail(state);
    const subjects = await this.throttle(email, state, 'auth.step_up');
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, email);
    const verified = await this.passwords.verify(lookup.password_hash, password);
    if (!verified || lookup.person_id !== principal.personId || lookup.disabled_at) {
      await this.recordFailure(email, subjects, state, 'auth.step_up');
      throw new ApiError('auth.invalid_credentials', 'invalid password');
    }
    const now = this.now;
    const sessionId = (state.session as { id: string }).id;
    await this.principals.runAs(state, async (trx, p) => {
      await sessions.reauthenticate(trx, sessionId, now);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.step_up', object_kind: 'session', object_id: sessionId, request_id: state.requestId, authz_epoch: p.authzEpoch });
    });
    if (state.session) state.session.authenticatedAt = now;
    return { status: 'authenticated', authenticatedAt: now.toISOString() };
  }

  async changePassword(input: { currentPassword: string; newPassword: string }, state: RequestState): Promise<void> {
    const principal = state.principal as Principal;
    const email = await this.primaryEmail(state);
    const subjects = await this.throttle(email, state, 'auth.password_change');
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, email);
    const verified = await this.passwords.verify(lookup.password_hash, input.currentPassword);
    if (!verified || lookup.person_id !== principal.personId || lookup.disabled_at) {
      await this.recordFailure(email, subjects, state, 'auth.password_change');
      throw new ApiError('auth.invalid_credentials', 'current password is invalid');
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.now;
    const sessionId = (state.session as { id: string }).id;
    await this.principals.runAs(state, async (trx, p) => {
      const updated = await credentials.setPasswordHash(trx, p.personId, passwordHash);
      if (updated === 0) await credentials.insertPassword(trx, p.personId, passwordHash);
      await sessions.revokeAllForPerson(trx, p.personId, 'password_change', sessionId, now);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.password_changed', object_kind: 'person', object_id: p.personId, request_id: state.requestId, authz_epoch: p.authzEpoch });
    });
    await this.ctx.mail.send({ to: email, template: 'security_notice', params: { event: 'password_changed' } });
  }

  /** Issues an e-mail change token; the new address becomes a verified primary binding when the token is consumed. */
  async changeEmail(newEmail: string, state: RequestState): Promise<{ status: 'verification_sent' }> {
    const token = randomToken();
    await this.principals.runAs(state, async (trx, p) => {
      await authTokens.consumeOutstanding(trx, p.personId, 'email_change', this.now);
      await authTokens.insert(trx, p.personId, 'email_change', newEmail, sha256Hex(token), new Date(this.now.getTime() + this.ctx.config.tokens.emailChangeMs));
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.email_change_requested', object_kind: 'person', object_id: p.personId, request_id: state.requestId, authz_epoch: p.authzEpoch });
    });
    await this.ctx.mail.send({ to: newEmail, template: 'email_change', params: { token } });
    const current = await this.primaryEmail(state).catch(() => null);
    if (current) await this.ctx.mail.send({ to: current, template: 'security_notice', params: { event: 'email_change_requested' } });
    return { status: 'verification_sent' };
  }

  async me(state: RequestState) {
    return this.principals.runAs(state, async (trx, principal) => {
      const row = await persons.getById(trx, principal.personId);
      if (!row) throw new ApiError('auth.session_invalid');
      const [bindings, creds] = await Promise.all([emailBindings.listForPerson(trx, principal.personId), credentials.listForPerson(trx, principal.personId)]);
      return { person: toPerson(row, bindings, creds), principal };
    });
  }

  async listSessions(state: RequestState): Promise<{ items: SessionView[]; currentSessionId: string }> {
    const items = await this.principals.runAs(state, async (trx, p) => (await sessions.listForPerson(trx, p.personId)).map((row) => toSessionView(toSession(row))));
    return { items, currentSessionId: (state.session as { id: string }).id };
  }

  async revokeSession(sessionId: string, state: RequestState): Promise<void> {
    await this.principals.runAs(state, async (trx, p) => {
      const revoked = await sessions.revoke(trx, sessionId, 'logout', this.now);
      if (!revoked) throw new ApiError('access.not_found', 'session not found');
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.session_revoked', object_kind: 'session', object_id: sessionId, request_id: state.requestId, authz_epoch: p.authzEpoch });
    });
  }

  async revokeOtherSessions(state: RequestState): Promise<{ revoked: number }> {
    const sessionId = (state.session as { id: string }).id;
    const revoked = await this.principals.runAs(state, async (trx, p) => {
      const n = await sessions.revokeAllForPerson(trx, p.personId, 'logout_all', sessionId, this.now);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.sessions_revoked', object_kind: 'person', object_id: p.personId, request_id: state.requestId, authz_epoch: p.authzEpoch, basis: { revoked: n } });
      return n;
    });
    return { revoked };
  }

  private async primaryEmail(state: RequestState): Promise<string> {
    const bindings = await this.principals.runAs(state, (trx, p) => emailBindings.listForPerson(trx, p.personId));
    const primary = bindings.find((b) => b.is_primary) ?? bindings[0];
    if (!primary) throw new ApiError('auth.email_unverified', 'no e-mail binding');
    return primary.email_normalized;
  }

  /** Epoch of a person reached through a verified binding (recovery path, no session). */
  private async epochOf(personId: string, email: string): Promise<{ personId: string; authzEpoch: number }> {
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, email);
    if (lookup.person_id !== personId || lookup.authz_epoch === null) throw new ApiError('access.not_found');
    return { personId, authzEpoch: lookup.authz_epoch };
  }

  /** Dev/test helper: current session row of the acting principal. */
  currentSession(state: RequestState, trx: Transaction) {
    return sessions.getById(trx, (state.session as { id: string }).id);
  }
}
