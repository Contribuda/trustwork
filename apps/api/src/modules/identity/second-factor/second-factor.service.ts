import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Principal } from '../../../deps/contracts.js';
import { clearOwnLoginFailures, emailBindings, preIdentity, withPrincipal, type Transaction } from '../../../deps/data.js';
import { readCookie } from '../../../common/cookies.js';
import { withoutPrincipal } from '../../../common/db.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../context.js';
import { journal, type AuditEntry, type Intent } from '../journal.js';
import { lockoutPolicy, remainingWaitSeconds, type LockoutPolicy } from '../lockout.js';
import type { PrincipalService } from '../principal.service.js';
import { randomToken, sha256Hex, subjectHash } from '../tokens.js';
import {
  clearOwnSecondFactorFailures, ELEVATION_LIFETIME_MS, ENROLMENT_TTL_MS, normalizeRecoveryCode, RECOVERY_CODE_COUNT, recoveryCodes, SECOND_FACTOR_CHALLENGE_MAX_ATTEMPTS,
  SECOND_FACTOR_CHALLENGE_TTL_MS, SECOND_FACTOR_RESET_APPROVE_ROLES, SECOND_FACTOR_RESET_REQUEST_ROLES, secondFactorChallenges, SecondFactorResetRefused, secondFactorResets, secondFactors,
  sessionElevations, TOTP_PARAMETERS, TOTP_SECRET_BYTES,
  type ProofMethod, type SecondFactorNoticeEvent, type SecondFactorProof, type SecondFactorResetRow, type SecondFactorResetView, type SecondFactorRow, type SecondFactorStatus,
  type SecondFactorView, type SessionElevationRow, type SessionElevationView, type TotpEnrolment,
} from './deps.js';
import { deriveSecondFactorKeys, newRecoveryCode, openTotpSecret, recoveryCodeHash, sealTotpSecret, type SecondFactorKeys } from './secrets.js';
import { base32Encode, matchTotp, otpauthUri } from './totp.js';

/** Cookie holding the sign-in challenge token between the first and the second factor. */
export const CHALLENGE_COOKIE = '__Host-sr_2fa';
type ChallengeMethod = 'password' | 'google' | 'apple';
interface UsedProof { method: ProofMethod; factorId: string | null }

/** A proof that did not verify; converted to `auth.invalid_credentials` after the failure has been recorded. */
class ProofRejected extends Error {
  constructor() {
    super('second-factor proof rejected');
    this.name = 'ProofRejected';
  }
}

const iso = (d: Date): string => d.toISOString();
function toFactorView(row: SecondFactorRow): SecondFactorView {
  return { id: row.id, kind: row.kind, createdAt: iso(row.created_at), activatedAt: iso(row.activated_at as Date), lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null };
}
function stepOf(row: SecondFactorRow): number | null {
  return row.last_used_step === null ? null : Number(row.last_used_step);
}
export function toResetView(row: SecondFactorResetRow): SecondFactorResetView {
  return {
    id: row.id, subjectPersonId: row.subject_person_id, supportCaseId: row.support_case_id, requestedBy: row.requested_by, approvedBy: row.approved_by,
    evidenceCount: row.evidence_refs.length, requestedAt: iso(row.requested_at), approvedAt: row.approved_at ? iso(row.approved_at) : null,
    effectiveAt: row.effective_at ? iso(row.effective_at) : null, state: row.state,
  };
}

/**
 * Second factor use cases (BE-004): TOTP enrolment with confirmation, verification with replay protection, recovery
 * codes, the sign-in challenge, elevated sessions and the support reset with a second person and a cooling-off.
 *
 * Every change commits in one transaction with its audit rows, outbox intents and a security notice to every verified
 * address of the person (`security_notice` through the outbox, MAIL-001). Failed proofs are counted per person and
 * per client address with the progressive delay of the password lockout (`lockout.ts`), in their own transaction, so
 * the count survives the refused request; the owner is told when the threshold is first reached. Responses that carry
 * a secret (the TOTP secret, recovery codes) are never stored in idempotency records: those routes are not
 * `@Idempotent`, and a one-time code is its own replay guard.
 */
export class SecondFactorService {
  private readonly keys: SecondFactorKeys;
  private readonly lockout: LockoutPolicy;
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {
    this.keys = deriveSecondFactorKeys(ctx.secondFactorKey);
    this.lockout = lockoutPolicy(ctx.config.lockout);
  }

  private get now(): Date {
    return this.ctx.clock.now();
  }

  /* ---------- Proofs, throttling and notices ---------- */

  private failureSubject(personId: string): string {
    return sha256Hex(`second_factor:${personId}`);
  }

  private async throttle(personId: string, state: RequestState, action: string): Promise<void> {
    const subject = this.failureSubject(personId);
    const ipSubject = subjectHash('ip', state.client.ip);
    const wait = await withoutPrincipal(this.ctx.pool, async (trx) => {
      const account = await preIdentity.throttleState(trx, subject, this.lockout.windowSeconds);
      const ip = await preIdentity.throttleState(trx, ipSubject, this.lockout.windowSeconds);
      const seconds = remainingWaitSeconds(account, ip, this.lockout);
      if (seconds > 0) await journal(trx, { action: `${action}_throttled`, objectKind: 'person', objectId: personId, requestId: state.requestId, basis: { retryAfterSeconds: seconds } });
      return seconds;
    });
    if (wait > 0) throw new ApiError('auth.throttled', 'too many failed attempts; try again later', { retryAfterSeconds: wait });
  }

  /** Records a failed proof (and a failed challenge attempt) with its audit row; notifies the owner at the threshold. */
  private async recordFailure(person: { personId: string; authzEpoch: number }, state: RequestState, action: string, challengeId: string | null = null): Promise<void> {
    const { windowSeconds, retentionSeconds, accountThreshold } = this.lockout;
    await withPrincipal(this.ctx.pool, person, async (trx) => {
      const failures = await preIdentity.recordLoginFailure(trx, this.failureSubject(person.personId), windowSeconds, retentionSeconds);
      await preIdentity.recordLoginFailure(trx, subjectHash('ip', state.client.ip), windowSeconds, retentionSeconds);
      const attempts = challengeId ? await secondFactorChallenges.recordAttempt(trx, challengeId, SECOND_FACTOR_CHALLENGE_MAX_ATTEMPTS, this.now) : null;
      const entries: AuditEntry[] = [{ action: `${action}_failed`, objectKind: 'person', objectId: person.personId, requestId: state.requestId, basis: { windowFailures: failures, ...(attempts !== null ? { challengeAttempts: attempts } : {}) } }];
      const intents: Intent[] = [];
      if (failures === accountThreshold) {
        entries.push({ action: `${action}_lockout`, objectKind: 'person', objectId: person.personId, requestId: state.requestId, basis: { failures } });
        intents.push({ personId: person.personId, type: 'identity.second_factor_throttled', payload: { action } });
        // Caused by whoever typed the codes: no language preference, the hub default applies.
        await this.notify(trx, person.personId, 'second_factor_throttled', []);
      }
      await journal(trx, entries, intents);
    });
  }

  /** Security notice to every verified address of the person, in the caller's transaction. */
  private async notify(trx: Transaction, personId: string, event: SecondFactorNoticeEvent, locales: readonly string[]): Promise<void> {
    const bindings = await emailBindings.listForPerson(trx, personId);
    for (const binding of bindings) if (binding.verified_at) await this.ctx.mail.record(trx, { to: binding.email_normalized, template: 'security_notice', params: { event }, locales });
  }

  /**
   * Verifies and consumes one proof of `personId` inside `trx`: a TOTP code for a step later than the factor's last
   * accepted step (the guarded UPDATE serialises concurrent uses), or an unused recovery code (marked used). Recovery
   * codes work only while a factor is active. Null when nothing matched.
   */
  private async consumeProof(trx: Transaction, personId: string, proof: SecondFactorProof, now: Date): Promise<UsedProof | null> {
    if (proof.method === 'totp') {
      for (const factor of await secondFactors.active(trx, personId)) {
        const secret = openTotpSecret(this.keys, factor.id, personId, factor.secret_sealed);
        const step = matchTotp(secret, proof.code, now.getTime(), { window: TOTP_PARAMETERS.window, periodSeconds: TOTP_PARAMETERS.periodSeconds, digits: TOTP_PARAMETERS.digits, lastUsedStep: stepOf(factor) });
        if (step !== null && (await secondFactors.acceptStep(trx, factor.id, step, now))) return { method: 'totp', factorId: factor.id };
      }
      return null;
    }
    const normalized = normalizeRecoveryCode(proof.code);
    if (!normalized || !(await secondFactors.hasActive(trx, personId))) return null;
    const used = await recoveryCodes.use(trx, recoveryCodeHash(this.keys, personId, normalized));
    return used ? { method: 'recovery_code', factorId: null } : null;
  }

  /**
   * Runs `fn` in the request transaction after consuming a proof of the acting person. A refused proof rolls the
   * transaction back, is recorded in its own transaction and answers `auth.invalid_credentials`. A person without an
   * active factor gets 403 (`details.required = 'second_factor'`) and no failure is counted.
   */
  private async withProof<T>(state: RequestState, action: string, proof: SecondFactorProof, locales: readonly string[], fn: (trx: Transaction, principal: Principal, used: UsedProof) => Promise<T>): Promise<T> {
    const principal = state.principal as Principal;
    await this.throttle(principal.personId, state, action);
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        if (!(await secondFactors.hasActive(trx, p.personId))) throw new ApiError('access.forbidden', 'enrol a second factor first', { required: 'second_factor' });
        const used = await this.consumeProof(trx, p.personId, proof, this.now);
        if (!used) throw new ProofRejected();
        await clearOwnSecondFactorFailures(trx);
        if (used.method === 'recovery_code') await this.recoveryCodeUsed(trx, p, state, locales);
        return fn(trx, p, used);
      });
    } catch (error) {
      if (!(error instanceof ProofRejected)) throw error;
      await this.recordFailure({ personId: principal.personId, authzEpoch: (state.principal as Principal).authzEpoch }, state, action);
      throw new ApiError('auth.invalid_credentials', 'invalid second-factor code');
    }
  }

  private async recoveryCodeUsed(trx: Transaction, p: { personId: string; authzEpoch: number }, state: RequestState, locales: readonly string[]): Promise<void> {
    const remaining = await recoveryCodes.unusedCount(trx, p.personId);
    await journal(trx, { action: 'auth.recovery_code_used', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { remaining } },
      [{ personId: p.personId, type: 'identity.recovery_code_used', payload: { remaining } }]);
    await this.notify(trx, p.personId, 'recovery_code_used', locales);
  }

  private async issueRecoveryCodes(trx: Transaction, personId: string, now: Date): Promise<string[]> {
    await recoveryCodes.revokeUnused(trx, personId, now);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => newRecoveryCode());
    await recoveryCodes.insertBatch(trx, personId, randomUUID(), codes.map((c) => recoveryCodeHash(this.keys, personId, c.normalized)), now);
    return codes.map((c) => c.display);
  }

  /* ---------- Own factors ---------- */

  async status(state: RequestState): Promise<SecondFactorStatus> {
    return this.principals.runAs(state, async (trx, p) => {
      const factors = (await secondFactors.active(trx, p.personId)).map(toFactorView);
      const codes = factors.length ? await recoveryCodes.summary(trx, p.personId) : null;
      const reset = await secondFactorResets.openForSubject(trx, p.personId);
      return {
        enrolled: factors.length > 0,
        factors,
        recoveryCodes: codes ? { remaining: codes.remaining, total: codes.total, generatedAt: iso(codes.generatedAt) } : null,
        pendingReset: reset ? { id: reset.id, state: reset.state as 'pending' | 'cooling_off', requestedAt: iso(reset.requested_at), effectiveAt: reset.effective_at ? iso(reset.effective_at) : null } : null,
      };
    });
  }

  /** Starts a TOTP enrolment: a new secret, sealed at rest, shown once; it activates only after a confirmed code. */
  async startTotp(state: RequestState): Promise<TotpEnrolment> {
    const now = this.now;
    const factorId = randomUUID();
    const secret = randomBytes(TOTP_SECRET_BYTES);
    const expiresAt = new Date(now.getTime() + ENROLMENT_TTL_MS);
    const account = await this.principals.runAs(state, async (trx, p) => {
      if (await secondFactors.hasActive(trx, p.personId)) throw new ApiError('access.forbidden', 'a second factor is already active; remove it first', { reason: 'already_enrolled' });
      await secondFactors.abandonPending(trx, p.personId, now);
      await secondFactors.insertPending(trx, { id: factorId, personId: p.personId, secretSealed: sealTotpSecret(this.keys, factorId, p.personId, secret), expiresAt, createdAt: now });
      await journal(trx, { action: 'auth.second_factor_enrolment_started', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { factorId, kind: 'totp' } });
      const bindings = await emailBindings.listForPerson(trx, p.personId);
      return (bindings.find((b) => b.is_primary) ?? bindings[0])?.email_normalized ?? p.personId;
    });
    const encoded = base32Encode(secret);
    const issuer = new URL(this.ctx.config.publicOrigin).hostname;
    return {
      factorId, secret: encoded, expiresAt: iso(expiresAt), digits: TOTP_PARAMETERS.digits, periodSeconds: TOTP_PARAMETERS.periodSeconds,
      otpauthUri: otpauthUri({ issuer, account, secret: encoded, digits: TOTP_PARAMETERS.digits, periodSeconds: TOTP_PARAMETERS.periodSeconds }),
    };
  }

  /** Confirms an enrolment with a current code; issues recovery codes when the person has no unused ones. */
  async confirmTotp(input: { factorId: string; code: string }, state: RequestState, locales: readonly string[]): Promise<{ status: 'enabled'; factor: SecondFactorView; recoveryCodes: string[] | null }> {
    const principal = state.principal as Principal;
    await this.throttle(principal.personId, state, 'auth.second_factor_enrolment');
    const now = this.now;
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        const pending = await secondFactors.getById(trx, input.factorId);
        if (!pending || pending.person_id !== p.personId || pending.state !== 'pending' || !pending.pending_expires_at || pending.pending_expires_at.getTime() <= now.getTime()) {
          throw new ApiError('access.not_found', 'no enrolment in progress; start again');
        }
        const secret = openTotpSecret(this.keys, pending.id, p.personId, pending.secret_sealed);
        const step = matchTotp(secret, input.code, now.getTime(), { window: TOTP_PARAMETERS.window, periodSeconds: TOTP_PARAMETERS.periodSeconds, digits: TOTP_PARAMETERS.digits, lastUsedStep: null });
        if (step === null) throw new ProofRejected();
        const active = await secondFactors.activate(trx, pending.id, step, now);
        if (!active) throw new ApiError('access.not_found', 'no enrolment in progress; start again');
        const codes = (await recoveryCodes.unusedCount(trx, p.personId)) === 0 ? await this.issueRecoveryCodes(trx, p.personId, now) : null;
        await clearOwnSecondFactorFailures(trx);
        await journal(trx, { action: 'auth.second_factor_enabled', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { factorId: active.id, kind: 'totp', recoveryCodesIssued: codes !== null } },
          [{ personId: p.personId, type: 'identity.second_factor_enabled', payload: { factorId: active.id, kind: 'totp' } }]);
        await this.notify(trx, p.personId, 'second_factor_enabled', locales);
        return { status: 'enabled' as const, factor: toFactorView(active), recoveryCodes: codes };
      });
    } catch (error) {
      if (!(error instanceof ProofRejected)) throw error;
      await this.recordFailure({ personId: principal.personId, authzEpoch: principal.authzEpoch }, state, 'auth.second_factor_enrolment');
      throw new ApiError('auth.invalid_credentials', 'invalid second-factor code');
    }
  }

  /** Replaces every unused recovery code; needs a current proof (a TOTP code or one of the old recovery codes). */
  async regenerateRecoveryCodes(proof: SecondFactorProof, state: RequestState, locales: readonly string[]): Promise<{ recoveryCodes: string[]; generatedAt: string }> {
    const now = this.now;
    return this.withProof(state, 'auth.recovery_codes_regenerate', proof, locales, async (trx, p) => {
      const codes = await this.issueRecoveryCodes(trx, p.personId, now);
      await journal(trx, { action: 'auth.recovery_codes_regenerated', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { count: codes.length } },
        [{ personId: p.personId, type: 'identity.recovery_codes_regenerated' }]);
      await this.notify(trx, p.personId, 'recovery_codes_regenerated', locales);
      return { recoveryCodes: codes, generatedAt: iso(now) };
    });
  }

  /** Removes a factor; removing the last one also revokes the recovery codes and every elevation of the person. */
  async removeFactor(input: { factorId: string; proof: SecondFactorProof }, state: RequestState, locales: readonly string[]): Promise<{ status: 'removed'; enrolled: boolean }> {
    const now = this.now;
    return this.withProof(state, 'auth.second_factor_remove', input.proof, locales, async (trx, p) => {
      if (!(await secondFactors.revoke(trx, input.factorId, 'removed', now))) throw new ApiError('access.not_found', 'factor not found');
      const enrolled = await secondFactors.hasActive(trx, p.personId);
      if (!enrolled) {
        await recoveryCodes.revokeUnused(trx, p.personId, now);
        await secondFactors.abandonPending(trx, p.personId, now);
      }
      await sessionElevations.revokeForPerson(trx, p.personId, 'factor_changed', now);
      await journal(trx, { action: 'auth.second_factor_removed', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { factorId: input.factorId, enrolled } },
        [{ personId: p.personId, type: 'identity.second_factor_removed', payload: { factorId: input.factorId } }]);
      await this.notify(trx, p.personId, 'second_factor_removed', locales);
      return { status: 'removed' as const, enrolled };
    });
  }

  /* ---------- Sign-in challenge ---------- */

  async hasActiveFactor(trx: Transaction, personId: string): Promise<boolean> {
    return secondFactors.hasActive(trx, personId);
  }

  /** Issues the sign-in challenge in the caller's transaction (principal set); the cookie is set after COMMIT. */
  async issueChallenge(trx: Transaction, personId: string, method: ChallengeMethod): Promise<{ token: string; expiresAt: Date }> {
    const now = this.now;
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + SECOND_FACTOR_CHALLENGE_TTL_MS);
    await secondFactorChallenges.insert(trx, { personId, tokenHashHex: sha256Hex(token), authMethod: method, createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  challengeCookieName(): string {
    return this.ctx.config.cookies.hostPrefix ? CHALLENGE_COOKIE : CHALLENGE_COOKIE.replace('__Host-', '');
  }
  setChallengeCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.challengeCookieName(), token, { path: '/', httpOnly: true, secure: this.ctx.config.cookies.secure, sameSite: 'lax', maxAge: Math.floor(SECOND_FACTOR_CHALLENGE_TTL_MS / 1000) });
  }
  clearChallengeCookie(reply: FastifyReply): void {
    reply.clearCookie(this.challengeCookieName(), { path: '/', httpOnly: true, secure: this.ctx.config.cookies.secure, sameSite: 'lax' });
  }
  challengeResponse(expiresAt: Date): { status: 'second_factor_required'; methods: ProofMethod[]; expiresAt: string } {
    return { status: 'second_factor_required', methods: ['totp', 'recovery_code'], expiresAt: iso(expiresAt) };
  }

  /**
   * Second step of sign-in: the challenge cookie names the person who passed the first factor; a valid proof consumes
   * the challenge (single use) and issues the session in the same transaction. At most five attempts per challenge,
   * plus the per-person progressive delay.
   */
  async completeSignIn(proof: SecondFactorProof, state: RequestState, request: FastifyRequest, reply: FastifyReply, locales: readonly string[]): Promise<{ status: 'authenticated'; personId: string }> {
    const token = readCookie(request, this.challengeCookieName());
    if (!token) throw new ApiError('auth.session_invalid', 'no sign-in in progress; start again');
    const now = this.now;
    const open = await withoutPrincipal(this.ctx.pool, (trx) => secondFactorChallenges.lookup(trx, sha256Hex(token), SECOND_FACTOR_CHALLENGE_MAX_ATTEMPTS));
    if (!open || open.expires_at.getTime() <= now.getTime()) {
      this.clearChallengeCookie(reply);
      throw new ApiError('auth.session_invalid', 'the sign-in expired; start again');
    }
    const person = { personId: open.person_id, authzEpoch: open.authz_epoch };
    await this.throttle(person.personId, state, 'auth.second_factor');
    let issued: { sessionId: string; token: string };
    try {
      issued = await withPrincipal(this.ctx.pool, person, async (trx) => {
        const used = await this.consumeProof(trx, person.personId, proof, now);
        if (!used) throw new ProofRejected();
        if (!(await secondFactorChallenges.consume(trx, open.challenge_id, now))) throw new ApiError('auth.session_invalid', 'the sign-in was already completed');
        const session = await this.principals.createSession(trx, request, person.personId, open.auth_method);
        await clearOwnLoginFailures(trx);
        await clearOwnSecondFactorFailures(trx);
        await journal(trx, { action: 'auth.login', objectKind: 'person', objectId: person.personId, requestId: state.requestId, actor: person.personId, epoch: person.authzEpoch, basis: { sessionId: session.sessionId, method: open.auth_method, secondFactor: used.method } },
          [{ personId: person.personId, type: 'identity.session_started', payload: { sessionId: session.sessionId, method: open.auth_method, secondFactor: used.method } }]);
        if (used.method === 'recovery_code') await this.recoveryCodeUsed(trx, person, state, locales);
        return session;
      });
    } catch (error) {
      if (!(error instanceof ProofRejected)) throw error;
      await this.recordFailure(person, state, 'auth.second_factor', open.challenge_id);
      throw new ApiError('auth.invalid_credentials', 'invalid second-factor code');
    }
    this.clearChallengeCookie(reply);
    this.principals.setCookie(reply, issued.token);
    return { status: 'authenticated', personId: person.personId };
  }

  /* ---------- Elevated sessions ---------- */

  private elevationView(row: SessionElevationRow, principal: Principal): SessionElevationView {
    return { elevationId: row.id, factor: row.factor_kind, expiresAt: iso(row.expires_at), staffRoles: [...principal.staff] };
  }

  /** `admin.session.elevate`: staff, a recent step-up (route guard) and a second-factor proof; bound to this session. */
  async elevate(proof: SecondFactorProof, state: RequestState, locales: readonly string[]): Promise<SessionElevationView> {
    const principal = state.principal as Principal;
    if (!principal.staff.length) throw new ApiError('access.forbidden', 'staff only', { required: 'staff' });
    const sessionId = (state.session as { id: string }).id;
    const now = this.now;
    return this.withProof(state, 'admin.session.elevate', proof, locales, async (trx, p, used) => {
      await sessionElevations.revokeForSession(trx, sessionId, 'replaced', now);
      const row = await sessionElevations.insert(trx, { sessionId, personId: p.personId, factorKind: used.method, createdAt: now, expiresAt: new Date(now.getTime() + ELEVATION_LIFETIME_MS) });
      await journal(trx, { action: 'admin.session.elevate', objectKind: 'session', objectId: sessionId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { elevationId: row.id, factor: used.method, staffRoles: p.staff, expiresAt: iso(row.expires_at) } },
        [{ personId: p.personId, type: 'identity.session_elevated', payload: { elevationId: row.id, sessionId } }]);
      return this.elevationView(row, p);
    });
  }

  /**
   * The live elevation of the acting session, or a 403 (`details.required`: `staff` for non-staff, `elevation`
   * otherwise). Used by `ElevationGuard`; a plain transaction, never the request's idempotent one.
   */
  async requireElevation(state: RequestState): Promise<SessionElevationRow> {
    const principal = state.principal;
    const session = state.session;
    if (!principal || !session) throw new ApiError('auth.session_invalid', 'authentication required');
    if (!principal.staff.length) throw new ApiError('access.forbidden', 'staff only', { required: 'staff' });
    const now = this.now;
    const live = await withPrincipal(this.ctx.pool, { personId: principal.personId, authzEpoch: principal.authzEpoch }, (trx) => sessionElevations.live(trx, session.id, now));
    if (!live || live.person_id !== principal.personId) throw new ApiError('access.forbidden', 'an elevated session is required', { required: 'elevation' });
    return live;
  }

  currentElevation(row: SessionElevationRow, state: RequestState): SessionElevationView {
    return this.elevationView(row, state.principal as Principal);
  }

  async endElevation(state: RequestState): Promise<{ ended: number }> {
    const sessionId = (state.session as { id: string }).id;
    const now = this.now;
    return this.principals.runAs(state, async (trx, p) => {
      const ended = await sessionElevations.revokeForSession(trx, sessionId, 'ended', now);
      if (ended) await journal(trx, { action: 'admin.session.elevation_ended', objectKind: 'session', objectId: sessionId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch });
      return { ended };
    });
  }

  /** Logout: the elevations of the ending session end with it (caller's transaction). */
  async endElevationsOfSession(trx: Transaction, sessionId: string): Promise<void> {
    await sessionElevations.revokeForSession(trx, sessionId, 'session_ended', this.now);
  }

  /* ---------- Support reset (second person, 72-hour cooling-off) ---------- */

  private requireRole(principal: Principal, roles: readonly string[]): void {
    if (!principal.staff.some((r) => roles.includes(r))) throw new ApiError('access.forbidden', 'this staff action needs another role', { required: 'staff' });
  }

  private refusal(error: unknown): never {
    if (error instanceof SecondFactorResetRefused) {
      if (error.reason === 'not_found') throw new ApiError('access.not_found', 'reset not found');
      if (error.reason === 'second_person') throw new ApiError('access.second_approver_required', 'a different person must approve this reset');
      if (error.reason === 'cooling_off') throw new ApiError('access.forbidden', 'the cooling-off period has not ended', { reason: 'cooling_off' });
      throw new ApiError('validation.revision_conflict', 'the reset is no longer in a state that allows this');
    }
    const pg = error as { code?: string; constraint?: string };
    if (pg?.code === '23503') throw new ApiError('access.not_found', 'person not found');
    if (pg?.code === '23505' && pg.constraint === 'second_factor_reset_one_open') throw new ApiError('validation.revision_conflict', 'a reset of this person is already open', { reason: 'reset_open' });
    throw error;
  }

  private async notifySubject(trx: Transaction, resetId: string, event: SecondFactorNoticeEvent): Promise<void> {
    // Caused by staff: no language preference, the hub default applies.
    for (const to of await secondFactorResets.subjectAddresses(trx, resetId)) await this.ctx.mail.record(trx, { to, template: 'security_notice', params: { event } });
  }

  private async resetJournal(trx: Transaction, p: Principal, state: RequestState, action: string, reset: SecondFactorResetRow, elevationId: string, intents: Intent[], basis: Record<string, unknown> = {}): Promise<void> {
    await journal(trx, { action, objectKind: 'second_factor_reset', objectId: reset.id, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { subjectPersonId: reset.subject_person_id, supportCaseId: reset.support_case_id, staffRoles: p.staff, sessionElevationId: elevationId, ...basis } }, intents);
  }

  async requestReset(input: { subjectPersonId: string; supportCaseId: string; evidenceRefs: string[]; reason: string }, state: RequestState, elevationId: string): Promise<SecondFactorResetView> {
    const principal = state.principal as Principal;
    this.requireRole(principal, SECOND_FACTOR_RESET_REQUEST_ROLES);
    if (input.subjectPersonId === principal.personId) throw new ApiError('access.forbidden', 'staff never service their own account', { reason: 'own_account' });
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        const reset = await secondFactorResets.request(trx, { ...input, requestedBy: p.personId });
        await this.notifySubject(trx, reset.id, 'second_factor_reset_requested');
        await this.resetJournal(trx, p, state, 'support.second_factor_reset_requested', reset, elevationId,
          [{ personId: reset.subject_person_id, type: 'identity.second_factor_reset_requested', payload: { resetId: reset.id } }], { evidenceCount: input.evidenceRefs.length, reason: input.reason });
        return toResetView(reset);
      });
    } catch (error) {
      this.refusal(error);
    }
  }

  async approveReset(resetId: string, state: RequestState, elevationId: string): Promise<SecondFactorResetView> {
    this.requireRole(state.principal as Principal, SECOND_FACTOR_RESET_APPROVE_ROLES);
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        await secondFactorResets.approve(trx, resetId);
        const reset = (await secondFactorResets.getById(trx, resetId)) as SecondFactorResetRow;
        await this.notifySubject(trx, resetId, 'second_factor_reset_approved');
        await this.resetJournal(trx, p, state, 'support.second_factor_reset_approved', reset, elevationId,
          [{ personId: reset.subject_person_id, type: 'identity.second_factor_reset_approved', payload: { resetId, effectiveAt: iso(reset.effective_at as Date) } }], { effectiveAt: iso(reset.effective_at as Date) });
        return toResetView(reset);
      });
    } catch (error) {
      this.refusal(error);
    }
  }

  async cancelReset(resetId: string, state: RequestState, elevationId: string): Promise<SecondFactorResetView> {
    this.requireRole(state.principal as Principal, [...SECOND_FACTOR_RESET_REQUEST_ROLES, ...SECOND_FACTOR_RESET_APPROVE_ROLES]);
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        await secondFactorResets.cancel(trx, resetId);
        const reset = (await secondFactorResets.getById(trx, resetId)) as SecondFactorResetRow;
        await this.notifySubject(trx, resetId, 'second_factor_reset_cancelled');
        await this.resetJournal(trx, p, state, 'support.second_factor_reset_cancelled', reset, elevationId,
          [{ personId: reset.subject_person_id, type: 'identity.second_factor_reset_cancelled', payload: { resetId } }]);
        return toResetView(reset);
      });
    } catch (error) {
      this.refusal(error);
    }
  }

  /** After the cooling-off: every factor, recovery code, challenge, elevation and session of the subject ends. */
  async executeReset(resetId: string, state: RequestState, elevationId: string): Promise<SecondFactorResetView> {
    this.requireRole(state.principal as Principal, [...SECOND_FACTOR_RESET_REQUEST_ROLES, ...SECOND_FACTOR_RESET_APPROVE_ROLES]);
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        const done = await secondFactorResets.execute(trx, resetId);
        const reset = (await secondFactorResets.getById(trx, resetId)) as SecondFactorResetRow;
        await this.notifySubject(trx, resetId, 'second_factor_reset_completed');
        await this.resetJournal(trx, p, state, 'support.second_factor_reset_completed', reset, elevationId, [
          { personId: reset.subject_person_id, type: 'identity.second_factor_reset_completed', payload: { resetId } },
          { personId: reset.subject_person_id, type: 'identity.sessions_revoked', payload: { reason: 'second_factor_reset' } },
        ], { factorsRevoked: done.factors_revoked, sessionsRevoked: done.sessions_revoked });
        return toResetView(reset);
      });
    } catch (error) {
      this.refusal(error);
    }
  }

  async readReset(resetId: string, state: RequestState): Promise<SecondFactorResetView> {
    this.requireRole(state.principal as Principal, [...SECOND_FACTOR_RESET_REQUEST_ROLES, ...SECOND_FACTOR_RESET_APPROVE_ROLES]);
    const reset = await this.principals.runAs(state, (trx) => secondFactorResets.getById(trx, resetId));
    if (!reset) throw new ApiError('access.not_found', 'reset not found');
    return toResetView(reset);
  }

  /** The subject cancels a reset of their own factors from their account (they keep their factor). */
  async cancelOwnReset(resetId: string, state: RequestState, locales: readonly string[]): Promise<{ status: 'cancelled' }> {
    try {
      return await this.principals.runAs(state, async (trx, p) => {
        const reset = await secondFactorResets.getById(trx, resetId);
        if (!reset || reset.subject_person_id !== p.personId) throw new SecondFactorResetRefused('not_found');
        await secondFactorResets.cancel(trx, resetId);
        await journal(trx, { action: 'auth.second_factor_reset_cancelled_by_subject', objectKind: 'second_factor_reset', objectId: resetId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch },
          [{ personId: p.personId, type: 'identity.second_factor_reset_cancelled', payload: { resetId } }]);
        await this.notify(trx, p.personId, 'second_factor_reset_cancelled', locales);
        return { status: 'cancelled' as const };
      });
    } catch (error) {
      this.refusal(error);
    }
  }
}
