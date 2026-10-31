import type { Provider, Transaction } from '../../deps/data.js';

/** Time source; tests substitute it to exercise expiry windows without sleeping. */
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export type MailTemplate = 'verify_email' | 'already_registered' | 'recovery' | 'email_change' | 'membership_invitation' | 'security_notice';
/**
 * One transactional mail, recorded in the caller's transaction. `params` are non-secret template values (durations,
 * ids, public names); `secret` is the one-time token the link embeds (sealed before it is stored); `locales` are the
 * causing request's language preferences, empty when someone else caused the mail.
 */
export interface MailIntent {
  to: string;
  template: MailTemplate;
  params?: Record<string, string>;
  secret?: { token: string; expiresAt: Date };
  locales?: readonly string[];
}
/** Outbound mail port of the identity module: records intents for the worker (MAIL-001); it never sends. */
export interface MailOutbox { record(trx: Transaction, intent: MailIntent): Promise<void> }

/** Identity asserted by a provider after a completed authorization-code exchange. */
export interface ProviderIdentity { subject: string; email: string | null; emailVerified: boolean; name: string | null }
export interface AuthorizationStart { state: string; nonce: string; codeChallenge: string; redirectUri: string }
export interface AuthorizationCompletion { code: string; codeVerifier: string; nonce: string; redirectUri: string; state: string }
export class ProviderUnavailableError extends Error {
  constructor(readonly provider: Provider, message = 'provider unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
/** OAuth 2 / OIDC provider port: Google (OIDC discovery) and Apple (manual configuration); fakes in tests/dev. */
export interface OidcProviderPort {
  readonly provider: Provider;
  authorizationUrl(start: AuthorizationStart): Promise<string>;
  complete(completion: AuthorizationCompletion): Promise<ProviderIdentity>;
}

/**
 * Scriptable fake: `enqueue` the identity the next callback returns (or an error). The authorization URL points to a
 * fake authority; the code value is irrelevant. No network access ever happens.
 */
export class FakeOidcProvider implements OidcProviderPort {
  private readonly queue: (ProviderIdentity | Error)[] = [];
  readonly completions: AuthorizationCompletion[] = [];
  constructor(readonly provider: Provider) {}
  enqueue(next: ProviderIdentity | Error): void {
    this.queue.push(next);
  }
  async authorizationUrl(start: AuthorizationStart): Promise<string> {
    const url = new URL(`https://fake.${this.provider}.invalid/authorize`);
    url.searchParams.set('state', start.state);
    url.searchParams.set('code_challenge', start.codeChallenge);
    url.searchParams.set('redirect_uri', start.redirectUri);
    return url.toString();
  }
  async complete(completion: AuthorizationCompletion): Promise<ProviderIdentity> {
    this.completions.push(completion);
    const next = this.queue.shift();
    if (!next) throw new ProviderUnavailableError(this.provider, 'no scripted identity');
    if (next instanceof Error) throw next;
    return next;
  }
}

/**
 * Placeholder for the assistant lane: membership end and participation revocation must also revoke queued
 * mandates/runs in the same transaction. Until the mandate tables exist, the hook records the intent so the
 * identity use cases already call it at the right point.
 */
export interface MandateRevocationPort {
  revokeForPerson(personId: string, companyId: string | null, reason: string): Promise<void>;
}
export class RecordingMandateRevocation implements MandateRevocationPort {
  readonly calls: { personId: string; companyId: string | null; reason: string }[] = [];
  async revokeForPerson(personId: string, companyId: string | null, reason: string): Promise<void> {
    this.calls.push({ personId, companyId, reason });
  }
}

/** Staff roles come from ADM-001's staff_role_assignment; until then the resolver answers "no staff role". */
export type StaffRoleResolver = (personId: string) => Promise<readonly string[]>;
export const noStaffRoles: StaffRoleResolver = async () => [];
