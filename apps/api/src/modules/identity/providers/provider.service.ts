import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { assumePrincipal, auth, credentials, preIdentity, withPrincipal, type Provider } from '../../../deps/data.js';
import { clearFlowCookie, flowCookieName, readCookie, setFlowCookie } from '../../../common/cookies.js';
import { withoutPrincipal } from '../../../common/db.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../context.js';
import { journal, type AuditEntry } from '../journal.js';
import { ProviderUnavailableError, type ProviderIdentity } from '../ports.js';
import type { PrincipalService } from '../principal.service.js';
import { constantTimeEqual, randomToken, sha256Hex, signFlow, verifyFlow, type FlowState } from '../tokens.js';

export type CallbackOutcome = 'signed_in' | 'linked' | 'account_exists' | 'verification_pending' | 'email_required' | 'provider_unavailable' | 'already_linked';
const FLOW_TTL_SECONDS = 600;

/**
 * Apple and Google flows (auth ADR section 7): identity key `(provider, subject)`, never the e-mail; no
 * auto-link; linking only from a stepped-up session; Google `email_verified: true` binds the address as verified and
 * may claim an unverified binding (H06); Apple and unverified Google addresses stay unverified until our own
 * verification. Pre-login state (state, nonce, PKCE verifier, link mode) lives in the HMAC-signed flow cookie.
 */
export class ProviderService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  private port(provider: Provider) {
    const port = this.ctx.providers[provider];
    if (!port) throw new ApiError('access.not_found', `provider ${provider} is not configured`);
    return port;
  }
  private redirectUri(provider: Provider): string {
    return `${this.ctx.config.publicOrigin}/v1/auth/${provider}/callback`;
  }

  async start(provider: Provider, mode: 'login' | 'link', state: RequestState, reply: FastifyReply): Promise<{ authorizationUrl: string }> {
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const flow: FlowState = {
      provider, mode, state: randomToken(), nonce: randomToken(), codeVerifier,
      personId: mode === 'link' ? (state.principal?.personId ?? null) : null, sessionId: mode === 'link' ? (state.session?.id ?? null) : null,
      exp: this.ctx.clock.now().getTime() + FLOW_TTL_SECONDS * 1000,
    };
    const authorizationUrl = await this.port(provider).authorizationUrl({ state: flow.state, nonce: flow.nonce, codeChallenge, redirectUri: this.redirectUri(provider) });
    setFlowCookie(reply, this.ctx.config, signFlow(this.ctx.config.flowSecret, flow), FLOW_TTL_SECONDS);
    return { authorizationUrl };
  }

  /** Provider redirect target. Returns the outcome; the controller redirects to the return path with it. */
  async callback(provider: Provider, query: { code: string; state: string }, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<CallbackOutcome> {
    // Disabled or unconfigured providers answer 404 before any flow state is inspected (same as start).
    const port = this.port(provider);
    const cookie = readCookie(request, flowCookieName(this.ctx.config));
    clearFlowCookie(reply, this.ctx.config);
    const flow = cookie ? verifyFlow(this.ctx.config.flowSecret, cookie, this.ctx.clock.now()) : null;
    if (!flow || flow.provider !== provider || !constantTimeEqual(flow.state, query.state)) throw new ApiError('auth.provider.state_mismatch', 'authorization flow state does not match');
    let identity: ProviderIdentity;
    try {
      identity = await port.complete({ code: query.code, codeVerifier: flow.codeVerifier, nonce: flow.nonce, redirectUri: this.redirectUri(provider), state: flow.state });
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return 'provider_unavailable';
      throw error;
    }
    return flow.mode === 'link' ? this.link(provider, identity, flow, state) : this.login(provider, identity, state, request, reply);
  }

  private async link(provider: Provider, identity: ProviderIdentity, flow: FlowState, state: RequestState): Promise<CallbackOutcome> {
    if (!state.principal || !state.session || state.session.id !== flow.sessionId || state.principal.personId !== flow.personId) throw new ApiError('auth.session_invalid', 'the link flow belongs to another session');
    if (this.ctx.clock.now().getTime() - state.session.authenticatedAt.getTime() > this.ctx.config.session.stepUpMs) throw new ApiError('auth.step_up_required');
    if (!state.principal.emailVerified) throw new ApiError('auth.email_unverified', 'verify the primary address before linking providers');
    const existing = await auth.lookupProviderCredential(this.ctx.pool, provider, identity.subject);
    if (existing && existing.person_id === state.principal.personId && !existing.disabled_at) return 'already_linked';
    if (existing && !existing.disabled_at) throw new ApiError('auth.provider.already_linked', 'this provider identity is linked to another account');
    await this.principals.runAs(state, async (trx, p) => {
      await credentials.insertProvider(trx, p.personId, provider, identity.subject);
      await journal(trx, { action: 'auth.provider_linked', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { provider } },
        [{ personId: p.personId, type: 'identity.provider_linked', payload: { provider } }]);
    });
    await this.notify(state, 'provider_linked');
    return 'linked';
  }

  /**
   * Sign-in or provider-first sign-up. The session, the person created for the subject (or the H06 claim), the
   * verification token, the audit rows and the outbox intents commit in one transaction. A provider that supplies no
   * name stores none: clients render a localized placeholder.
   */
  private async login(provider: Provider, identity: ProviderIdentity, state: RequestState, request: FastifyRequest, reply: FastifyReply): Promise<CallbackOutcome> {
    const linked = await auth.lookupProviderCredential(this.ctx.pool, provider, identity.subject);
    if (linked && !linked.disabled_at) {
      const issued = await withPrincipal(this.ctx.pool, { personId: linked.person_id, authzEpoch: linked.authz_epoch }, async (trx) => {
        const session = await this.principals.createSession(trx, request, linked.person_id, provider);
        await journal(trx, { action: 'auth.login', objectKind: 'person', objectId: linked.person_id, requestId: state.requestId, actor: linked.person_id, epoch: linked.authz_epoch, basis: { sessionId: session.sessionId, method: provider } },
          [{ personId: linked.person_id, type: 'identity.session_started', payload: { sessionId: session.sessionId, method: provider } }]);
        return session;
      });
      this.principals.setCookie(reply, issued.token);
      return 'signed_in';
    }
    if (!identity.email) return 'email_required';
    const email = identity.email.normalize('NFC').toLowerCase();
    const emailRef = sha256Hex(email).slice(0, 32);
    const displayName = identity.name?.normalize('NFC').trim().slice(0, 200) || null;
    const verifiedByGoogle = provider === 'google' && identity.emailVerified === true;
    const verifyToken = verifiedByGoogle ? null : randomToken();
    const outcome = await withoutPrincipal(this.ctx.pool, async (trx) => {
      let personId: string | null = null;
      if (verifiedByGoogle) personId = await preIdentity.claimUnverifiedBinding(trx, { displayName, emailNormalized: email, provider, subject: identity.subject });
      const claimed = personId !== null;
      personId ??= await preIdentity.registerProviderPerson(trx, { displayName, emailNormalized: email, provider, subject: identity.subject, emailVerified: verifiedByGoogle });
      if (!personId) {
        // A binding (verified, or unverified and not claimable) exists: never auto-link; the owner links from settings.
        await journal(trx, { action: 'auth.provider_login_refused', objectKind: 'email', objectId: emailRef, requestId: state.requestId, basis: { provider, reason: 'binding_exists' } });
        return null;
      }
      const epoch = await preIdentity.personEpoch(trx, personId);
      if (epoch === null) throw new ApiError('auth.session_invalid', 'provider registration did not produce a person');
      if (verifyToken) {
        await preIdentity.issueToken(trx, { emailNormalized: email, kind: 'verify_email', tokenHashHex: sha256Hex(verifyToken), expiresAt: new Date(this.ctx.clock.now().getTime() + this.ctx.config.tokens.verifyEmailMs), requireVerified: false });
      }
      await assumePrincipal(trx, { personId, authzEpoch: epoch });
      const session = await this.principals.createSession(trx, request, personId, provider);
      const entries: AuditEntry[] = [];
      if (claimed) entries.push({ action: 'auth.unverified_binding_claimed', objectKind: 'email', objectId: emailRef, requestId: state.requestId, actor: personId, basis: { provider } });
      entries.push({ action: 'auth.login', objectKind: 'person', objectId: personId, requestId: state.requestId, actor: personId, epoch, basis: { sessionId: session.sessionId, method: provider, firstLogin: true } });
      await journal(trx, entries, [
        { personId, type: 'identity.person_registered', payload: { method: provider, emailVerified: verifiedByGoogle, claimedUnverifiedBinding: claimed } },
        { personId, type: 'identity.session_started', payload: { sessionId: session.sessionId, method: provider } },
      ]);
      return session;
    });
    if (!outcome) return 'account_exists';
    this.principals.setCookie(reply, outcome.token);
    if (verifyToken) await this.ctx.mail.send({ to: email, template: 'verify_email', params: { token: verifyToken, expiresInHours: String(this.ctx.config.tokens.verifyEmailMs / 3_600_000) } });
    return verifiedByGoogle ? 'signed_in' : 'verification_pending';
  }

  /** Unlink refuses to leave the person without a password and without another active provider. */
  async unlink(provider: Provider, state: RequestState): Promise<void> {
    await this.principals.runAs(state, async (trx, p) => {
      const rows = await credentials.listForPerson(trx, p.personId);
      const active = rows.filter((c) => !c.disabled_at);
      const hasPassword = active.some((c) => c.kind === 'password');
      const others = active.filter((c) => c.provider && c.provider !== provider);
      if (!hasPassword && others.length === 0) throw new ApiError('access.forbidden', 'unlinking would leave no way to sign in', { reason: 'last_credential' });
      const disabled = await credentials.disableProvider(trx, p.personId, provider, this.ctx.clock.now());
      if (disabled === 0) throw new ApiError('access.not_found', 'provider is not linked');
      await journal(trx, { action: 'auth.provider_unlinked', objectKind: 'person', objectId: p.personId, requestId: state.requestId, actor: p.personId, epoch: p.authzEpoch, basis: { provider } },
        [{ personId: p.personId, type: 'identity.provider_unlinked', payload: { provider } }]);
    });
    await this.notify(state, 'provider_unlinked');
  }

  private async notify(state: RequestState, event: string): Promise<void> {
    const bindings = await this.principals.runAs(state, (trx, p) => withPrincipalBindings(trx, p.personId));
    for (const email of bindings) await this.ctx.mail.send({ to: email, template: 'security_notice', params: { event } });
  }
}

async function withPrincipalBindings(trx: Parameters<typeof credentials.listForPerson>[0], personId: string): Promise<string[]> {
  const rows = await trx.selectFrom('email_binding').select(['email_normalized', 'verified_at']).where('person_id', '=', personId).execute();
  return rows.filter((r) => r.verified_at).map((r) => r.email_normalized);
}
export { withPrincipal };
