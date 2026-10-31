import type { FastifyReply, FastifyRequest } from 'fastify';
import { toSessionView, type Principal, type SessionView } from '../../deps/contracts.js';
import { assumePrincipal, auditEvents, auth, authTokens, clearOwnLoginFailures, credentials, emailBindings, persons, preIdentity, sessions, withPrincipal, type Transaction } from '../../deps/data.js';
import { clearSessionCookie } from '../../common/cookies.js';
import { withoutPrincipal } from '../../common/db.js';
import { ApiError, LocalApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from './context.js';
import { journal, type AuditEntry, type Intent } from './journal.js';
import { hoursOf, minutesOf } from './mail.js';
import { lockoutPolicy, remainingWaitSeconds, type LockoutPolicy } from './lockout.js';
import type { PasswordService } from './password.service.js';
import type { PrincipalService } from './principal.service.js';
import { toPerson, toSession } from './serializers.js';
import { randomToken, sha256Hex, subjectHash } from './tokens.js';

interface Subjects { accountSubject: string; ipSubject: string }

/**
 * Classic authentication: signup with verification, login with a progressive delay, logout, recovery, step-up,
 * password and e-mail change, session listing and revocation. Responses of pre-identity commands are identical
 * whether an address exists (enumeration safety); the work performed is identical too (hashing always happens).
 * Every change commits in one transaction with its audit rows, outbox intents (`journal`) and mail intents
 * (`ctx.mail.record`, MAIL-001): the worker delivers the mail, so no request waits for or depends on a mail provider.
 */
export class AuthService {
  private readonly lockout: LockoutPolicy;
  constructor(private readonly ctx: AppContext, private readonly passwords: PasswordService, private readonly principals: PrincipalService) {
    this.lockout = lockoutPolicy(ctx.config.lockout);
  }

  private get now(): Date {
    return this.ctx.clock.now();
  }

  /**
   * Same status, body and work for new and already-bound addresses; the difference is only which e-mail goes out.
   * An address held only by another person's unverified binding is claimable: the new person receives the
   * verification mail, and the mailbox proof removes the squatting binding (auth_prove_mailbox).
   */
  async signup(input: { name: string; email: string; password: string; acceptedTermsVersion: string }, requestId: string, locales: readonly string[] = []): Promise<{ status: 'verification_sent' }> {
    const passwordHash = await this.passwords.hash(input.password);
    const token = randomToken();
    const emailRef = sha256Hex(input.email).slice(0, 32);
    const expiresAt = new Date(this.now.getTime() + this.ctx.config.tokens.verifyEmailMs);
    await withoutPrincipal(this.ctx.pool, async (trx) => {
      const signup = await preIdentity.signup(trx, {
        displayName: input.name, emailNormalized: input.email, passwordHash, verifyTokenHashHex: sha256Hex(token), verifyExpiresAt: expiresAt,
      });
      if (signup.outcome === 'bound') {
        await journal(trx, { action: 'auth.signup_duplicate', objectKind: 'email', objectId: emailRef, requestId, basis: { acceptedTermsVersion: input.acceptedTermsVersion, personId: signup.personId } },
          signup.personId ? [{ personId: signup.personId, type: 'identity.signup_on_bound_address' }] : []);
        // Same work in both branches: one mail intent; only the template differs (enumeration safety).
        await this.ctx.mail.record(trx, { to: input.email, template: 'already_registered', locales });
      } else {
        const personId = signup.personId as string;
        await journal(trx, { action: 'auth.signup', objectKind: 'email', objectId: emailRef, requestId, basis: { acceptedTermsVersion: input.acceptedTermsVersion, personId, claimPending: signup.outcome === 'claim_pending' } },
          [{ personId, type: 'identity.person_registered', payload: { method: 'password', claimPending: signup.outcome === 'claim_pending' } }]);
        await this.ctx.mail.record(trx, { to: input.email, template: 'verify_email', params: { hours: hoursOf(this.ctx.config.tokens.verifyEmailMs) }, secret: { token, expiresAt }, locales });
      }
    });
    return { status: 'verification_sent' };
  }

  /**
   * Verification POST (the mailbox proof): consumes the single-use token, binds the address verified (removing a
   * squatting unverified binding of another person), invalidates everything created for the person before
   * verification (sessions, tokens, provider links) and issues the first session, or keeps the acting session of the
   * same person and revokes the others. Also completes e-mail change tokens. One transaction.
   */
  async verifyEmail(token: string, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'verified'; personId: string; email: string }> {
    const hash = sha256Hex(token);
    const now = this.now;
    const result = await withoutPrincipal(this.ctx.pool, async (trx) => {
      const proof = await preIdentity.proveMailbox(trx, hash);
      if (!proof) throw new ApiError('access.not_found', 'verification token is invalid or expired');
      if (proof.outcome === 'taken') throw new LocalApiError('auth.email_taken', 'this e-mail address is already bound to an account');
      const personId = proof.person_id;
      const epoch = proof.authz_epoch;
      await assumePrincipal(trx, { personId, authzEpoch: epoch });
      const acting = state.session && state.session.personId === personId ? state.session.id : null;
      if (proof.kind === 'email_change' && proof.binding_id) await emailBindings.setPrimary(trx, personId, proof.binding_id);
      await sessions.revokeCreatedBefore(trx, personId, now, 'suspicious', acting, now);
      // Pre-hijack defence (T02) targets links planted on a password-signup account; a provider-first person's own
      // link is the way they signed in and is kept (as is the acting session's provider).
      const creds = await credentials.listForPerson(trx, personId);
      const actingProvider = acting && state.session && (state.session.authMethod === 'google' || state.session.authMethod === 'apple') ? state.session.authMethod : null;
      if (creds.some((c) => c.kind === 'password' && !c.disabled_at)) await credentials.disableProvidersCreatedBefore(trx, personId, now, now, actingProvider);
      await authTokens.consumeOutstanding(trx, personId, proof.kind === 'verify_email' ? 'verify_email' : null, now);
      const issued = acting ? null : await this.principals.createSession(trx, request, personId, 'password');
      const entries: AuditEntry[] = [{ action: proof.kind === 'verify_email' ? 'auth.email_verified' : 'auth.email_changed', objectKind: 'person', objectId: personId, requestId: state.requestId, actor: personId, epoch, basis: { outcome: proof.outcome } }];
      const intents: Intent[] = [{ personId, type: proof.kind === 'verify_email' ? 'identity.email_verified' : 'identity.email_changed' }];
      if (proof.displaced_person_id) {
        entries.push({ action: 'auth.squatting_binding_removed', objectKind: 'person', objectId: proof.displaced_person_id, requestId: state.requestId, actor: personId, basis: { claimedBy: personId } });
        intents.push({ personId, type: 'identity.binding_claimed' }, { personId: proof.displaced_person_id, type: 'identity.sessions_revoked', payload: { reason: 'binding_claimed' } });
      }
      if (issued) intents.push({ personId, type: 'identity.session_started', payload: { sessionId: issued.sessionId, method: 'password' } });
      await journal(trx, entries, intents);
      return { personId, email: proof.email_normalized, issued };
    });
    if (result.issued) this.principals.setCookie(reply, result.issued.token);
    return { status: 'verified', personId: result.personId, email: result.email };
  }

  /** Pre-check before any verification: a progressive per-account delay and the per-IP threshold answer auth.throttled. */
  private async throttle(email: string, state: RequestState, action: string): Promise<Subjects> {
    const accountSubject = subjectHash('account', email);
    const ipSubject = subjectHash('ip', state.client.ip);
    const { windowSeconds } = this.lockout;
    const wait = await withoutPrincipal(this.ctx.pool, async (trx) => {
      const account = await preIdentity.throttleState(trx, accountSubject, windowSeconds);
      const ip = await preIdentity.throttleState(trx, ipSubject, windowSeconds);
      const seconds = remainingWaitSeconds(account, ip, this.lockout);
      // Audit-only event: nothing changes, so the row commits on its own.
      if (seconds > 0) await journal(trx, { action: `${action}_throttled`, objectKind: 'email', objectId: accountSubject.slice(0, 32), requestId: state.requestId, basis: { retryAfterSeconds: seconds } });
      return seconds;
    });
    if (wait > 0) throw new ApiError('auth.throttled', 'too many failed attempts; try again later', { retryAfterSeconds: wait });
    return { accountSubject, ipSubject };
  }

  /**
   * Records a failed password proof for the account and the IP together with its audit row. Reaching the threshold
   * starts the delay and notifies the owner (audit, outbox intent and security notice); the password is never
   * disabled by failures.
   */
  private async recordFailure(email: string, subjects: Subjects, state: RequestState, action: string, ownerId: string | null): Promise<void> {
    const { windowSeconds, retentionSeconds, accountThreshold } = this.lockout;
    const objectId = subjects.accountSubject.slice(0, 32);
    await withoutPrincipal(this.ctx.pool, async (trx) => {
      const failures = await preIdentity.recordLoginFailure(trx, subjects.accountSubject, windowSeconds, retentionSeconds);
      await preIdentity.recordLoginFailure(trx, subjects.ipSubject, windowSeconds, retentionSeconds);
      const entries: AuditEntry[] = [{ action: `${action}_failed`, objectKind: 'email', objectId, requestId: state.requestId, basis: { windowFailures: failures } }];
      const intents: Intent[] = [];
      if (failures === accountThreshold) {
        entries.push({ action: `${action}_lockout`, objectKind: 'email', objectId, requestId: state.requestId, basis: { failures } });
        if (ownerId) {
          intents.push({ personId: ownerId, type: 'identity.login_throttled', payload: { action } });
          // Caused by whoever typed the passwords: no language preference, the hub default applies.
          await this.ctx.mail.record(trx, { to: email, template: 'security_notice', params: { event: 'login_throttled' } });
        }
      }
      await journal(trx, entries, intents);
    });
  }

  async login(input: { email: string; password: string }, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<{ status: 'authenticated'; personId: string }> {
    const subjects = await this.throttle(input.email, state, 'auth.login');
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, input.email);
    const verified = await this.passwords.verify(lookup.password_hash, input.password);
    const ok = verified && lookup.person_id !== null && lookup.disabled_at === null && lookup.email_verified;
    if (!ok || lookup.person_id === null || lookup.authz_epoch === null) {
      await this.recordFailure(input.email, subjects, state, 'auth.login', lookup.person_id);
      throw new ApiError('auth.invalid_credentials', 'invalid e-mail or password');
    }
    const personId = lookup.person_id;
    const epoch = lookup.authz_epoch;
    const rehashed = this.passwords.needsRehash(lookup.password_hash) ? await this.passwords.hash(input.password) : null;
    const issued = await withPrincipal(this.ctx.pool, { personId, authzEpoch: epoch }, async (trx) => {
      if (rehashed) await credentials.setPasswordHash(trx, personId, rehashed);
      const session = await this.principals.createSession(trx, request, personId, 'password');
      await clearOwnLoginFailures(trx);
      await journal(trx, { action: 'auth.login', objectKind: 'person', objectId: personId, requestId: state.requestId, actor: personId, epoch, basis: { sessionId: session.sessionId, method: 'password' } },
        [{ personId, type: 'identity.session_started', payload: { sessionId: session.sessionId, method: 'password' } }]);
      return session;
    });
    this.principals.setCookie(reply, issued.token);
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

  /**
   * Identical response for unknown addresses, and no provider call in either case. The token, the invalidation of
   * earlier recovery tokens (RC-03), the audit row, the outbox intent and the mail intent commit together.
   */
  async requestRecovery(email: string, requestId: string, locales: readonly string[] = []): Promise<{ status: 'recovery_sent' }> {
    const token = randomToken();
    const tokenHash = sha256Hex(token);
    const now = this.now;
    const expiresAt = new Date(now.getTime() + this.ctx.config.tokens.recoveryMs);
    await withoutPrincipal(this.ctx.pool, async (trx) => {
      const owner = await preIdentity.issueToken(trx, { emailNormalized: email, kind: 'recovery', tokenHashHex: tokenHash, expiresAt, requireVerified: true });
      if (owner) {
        const epoch = await preIdentity.personEpoch(trx, owner);
        if (epoch === null) throw new ApiError('access.not_found');
        await assumePrincipal(trx, { personId: owner, authzEpoch: epoch });
        await authTokens.consumeOutstanding(trx, owner, 'recovery', now, tokenHash);
        await this.ctx.mail.record(trx, { to: email, template: 'recovery', params: { minutes: minutesOf(this.ctx.config.tokens.recoveryMs) }, secret: { token, expiresAt }, locales });
      }
      await journal(trx, { action: 'auth.recovery_requested', objectKind: 'email', objectId: sha256Hex(email).slice(0, 32), requestId, actor: owner }, owner ? [{ personId: owner, type: 'identity.recovery_requested' }] : []);
    });
    return { status: 'recovery_sent' };
  }

  async completeRecovery(input: { token: string; newPassword: string }, requestId: string, locales: readonly string[] = []): Promise<{ status: 'password_reset' }> {
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.now;
    await withoutPrincipal(this.ctx.pool, async (trx) => {
      const consumed = await preIdentity.consumeToken(trx, sha256Hex(input.token), 'recovery');
      if (!consumed) throw new ApiError('access.not_found', 'recovery token is invalid or expired');
      await assumePrincipal(trx, { personId: consumed.person_id, authzEpoch: consumed.authz_epoch });
      const updated = await credentials.setPasswordHash(trx, consumed.person_id, passwordHash);
      if (updated === 0) await credentials.insertPassword(trx, consumed.person_id, passwordHash);
      const binding = await emailBindings.getOwnByEmail(trx, consumed.email_normalized);
      if (binding && !binding.verified_at) {
        await emailBindings.markVerified(trx, binding.id, now);
        if (updated > 0) await credentials.disableProvidersCreatedBefore(trx, consumed.person_id, now, now);
      }
      await sessions.revokeAllForPerson(trx, consumed.person_id, 'recovery', null, now);
      await authTokens.consumeOutstanding(trx, consumed.person_id, null, now);
      await clearOwnLoginFailures(trx);
      await journal(trx, { action: 'auth.recovery_completed', objectKind: 'person', objectId: consumed.person_id, requestId, actor: consumed.person_id, epoch: consumed.authz_epoch },
        [{ personId: consumed.person_id, type: 'identity.sessions_revoked', payload: { reason: 'recovery' } }]);
      await this.ctx.mail.record(trx, { to: consumed.email_normalized, template: 'security_notice', params: { event: 'password_reset' }, locales });
    });
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
      await this.recordFailure(email, subjects, state, 'auth.step_up', principal.personId);
      throw new ApiError('auth.invalid_credentials', 'invalid password');
    }
    const now = this.now;
    const sessionId = (state.session as { id: string }).id;
    await this.principals.runAs(state, async (trx, p) => {
      await sessions.reauthenticate(trx, sessionId, now);
      await clearOwnLoginFailures(trx);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.step_up', object_kind: 'session', object_id: sessionId, request_id: state.requestId, authz_epoch: p.authzEpoch });
    });
    if (state.session) state.session.authenticatedAt = now;
    return { status: 'authenticated', authenticatedAt: now.toISOString() };
  }

  async changePassword(input: { currentPassword: string; newPassword: string }, state: RequestState, locales: readonly string[] = []): Promise<void> {
    const principal = state.principal as Principal;
    const email = await this.primaryEmail(state);
    const subjects = await this.throttle(email, state, 'auth.password_change');
    const lookup = await auth.lookupPasswordCredential(this.ctx.pool, email);
    const verified = await this.passwords.verify(lookup.password_hash, input.currentPassword);
    if (!verified || lookup.person_id !== principal.personId || lookup.disabled_at) {
      await this.recordFailure(email, subjects, state, 'auth.password_change', principal.personId);
      throw new ApiError('auth.invalid_credentials', 'current password is invalid');
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.now;
    const sessionId = (state.session as { id: string }).id;
    await this.principals.runAs(state, async (trx, p) => {
      const updated = await credentials.setPasswordHash(trx, p.personId, passwordHash);
      if (updated === 0) await credentials.insertPassword(trx, p.personId, passwordHash);
      await sessions.revokeAllForPerson(trx, p.personId, 'password_change', sessionId, now);
      await clearOwnLoginFailures(trx);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.password_changed', object_kind: 'person', object_id: p.personId, request_id: state.requestId, authz_epoch: p.authzEpoch });
      await this.ctx.mail.record(trx, { to: email, template: 'security_notice', params: { event: 'password_changed' }, locales });
    });
  }

  /** Issues an e-mail change token; the new address becomes a verified primary binding when the token is consumed. */
  async changeEmail(newEmail: string, state: RequestState, locales: readonly string[] = []): Promise<{ status: 'verification_sent' }> {
    const token = randomToken();
    const expiresAt = new Date(this.now.getTime() + this.ctx.config.tokens.emailChangeMs);
    await this.principals.runAs(state, async (trx, p) => {
      const bindings = await emailBindings.listForPerson(trx, p.personId);
      const current = (bindings.find((b) => b.is_primary) ?? bindings[0])?.email_normalized ?? null;
      await authTokens.consumeOutstanding(trx, p.personId, 'email_change', this.now);
      await authTokens.insert(trx, p.personId, 'email_change', newEmail, sha256Hex(token), expiresAt);
      await auditEvents.append(trx, { actor_person_id: p.personId, action: 'auth.email_change_requested', object_kind: 'person', object_id: p.personId, request_id: state.requestId, authz_epoch: p.authzEpoch });
      await this.ctx.mail.record(trx, { to: newEmail, template: 'email_change', params: { hours: hoursOf(this.ctx.config.tokens.emailChangeMs) }, secret: { token, expiresAt }, locales });
      if (current) await this.ctx.mail.record(trx, { to: current, template: 'security_notice', params: { event: 'email_change_requested' }, locales });
    });
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

  /** Dev/test helper: current session row of the acting principal. */
  currentSession(state: RequestState, trx: Transaction) {
    return sessions.getById(trx, (state.session as { id: string }).id);
  }
}

