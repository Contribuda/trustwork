import type { DataPool } from '../pool.js';
import { SCHEMA } from '../config.js';
import type { AuthMethod, AuthTokenKind, Provider } from '../schema.js';

/**
 * Pre-identity primitives: thin wrappers over the SECURITY DEFINER allowlist. They run as single
 * autocommit statements on the pool because no principal exists yet. Inputs are hashes, never raw tokens.
 */
const HEX64 = /^[a-f0-9]{64}$/;
export function hashToBuffer(hex: string): Buffer {
  if (!HEX64.test(hex)) throw new Error('expected a lowercase hex SHA-256');
  return Buffer.from(hex, 'hex');
}

export interface SessionLookup {
  session_id: string;
  person_id: string;
  authz_epoch: number;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  authenticated_at: Date;
  auth_method: AuthMethod;
  revoked_at: Date | null;
}
export async function lookupSession(pool: DataPool, tokenHashHex: string): Promise<SessionLookup | null> {
  const { rows } = await pool.query<SessionLookup>(`SELECT * FROM ${SCHEMA}.auth_lookup_session($1)`, [hashToBuffer(tokenHashHex)]);
  return rows[0] ?? null;
}

export interface PasswordCredentialLookup {
  person_id: string | null;
  credential_id: string | null;
  /** Always present; a deterministic dummy for unknown e-mails so the caller verifies uniformly. */
  password_hash: string;
  disabled_at: Date | null;
  email_verified: boolean;
  authz_epoch: number | null;
}
export async function lookupPasswordCredential(pool: DataPool, emailNormalized: string): Promise<PasswordCredentialLookup> {
  const { rows } = await pool.query<PasswordCredentialLookup>(`SELECT * FROM ${SCHEMA}.auth_lookup_password_credential($1)`, [emailNormalized]);
  const row = rows[0];
  if (!row) throw new Error('auth_lookup_password_credential returned no row');
  return row;
}

export interface ProviderCredentialLookup { person_id: string; credential_id: string; disabled_at: Date | null; authz_epoch: number }
export async function lookupProviderCredential(pool: DataPool, provider: Provider, subject: string): Promise<ProviderCredentialLookup | null> {
  const { rows } = await pool.query<ProviderCredentialLookup>(`SELECT * FROM ${SCHEMA}.auth_lookup_provider_credential($1, $2)`, [provider, subject]);
  return rows[0] ?? null;
}

export interface ConsumedToken { token_id: string; person_id: string; email_normalized: string; authz_epoch: number }
/** Single use: returns null for unknown, expired, wrong-kind or already consumed tokens. */
export async function consumeToken(pool: DataPool, tokenHashHex: string, kind: AuthTokenKind): Promise<ConsumedToken | null> {
  const { rows } = await pool.query<ConsumedToken>(`SELECT * FROM ${SCHEMA}.auth_consume_token($1, $2)`, [hashToBuffer(tokenHashHex), kind]);
  return rows[0] ?? null;
}

export interface RegisterPersonInput { displayName: string; emailNormalized: string; passwordHash: string; verifyTokenHashHex: string; verifyExpiresAt: Date }
/** Returns the new person id, or null when the e-mail is already bound (caller answers identically). */
export async function registerPerson(pool: DataPool, input: RegisterPersonInput): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    `SELECT ${SCHEMA}.auth_register_person($1, $2, $3, $4, $5) AS id`,
    [input.displayName, input.emailNormalized, input.passwordHash, hashToBuffer(input.verifyTokenHashHex), input.verifyExpiresAt],
  );
  return rows[0]?.id ?? null;
}

export interface RegisterProviderPersonInput { displayName: string; emailNormalized: string; provider: Provider; subject: string; emailVerified: boolean }
/** Provider-first signup without a password; null when the e-mail or the (provider, subject) is already bound. */
export async function registerProviderPerson(pool: DataPool, input: RegisterProviderPersonInput): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    `SELECT ${SCHEMA}.auth_register_provider_person($1, $2, $3, $4, $5) AS id`,
    [input.displayName, input.emailNormalized, input.provider, input.subject, input.emailVerified],
  );
  return rows[0]?.id ?? null;
}

export interface IssueTokenInput { emailNormalized: string; kind: AuthTokenKind; tokenHashHex: string; expiresAt: Date; requireVerified: boolean }
/** Returns the person id the token was issued for, or null when no (verified) binding exists. */
export async function issueToken(pool: DataPool, input: IssueTokenInput): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(
    `SELECT ${SCHEMA}.auth_issue_token($1, $2, $3, $4, $5) AS id`,
    [input.emailNormalized, input.kind, hashToBuffer(input.tokenHashHex), input.expiresAt, input.requireVerified],
  );
  return rows[0]?.id ?? null;
}

/** Records a failure for a hashed subject and returns the count inside the window (thresholds are H03). */
export async function recordLoginFailure(pool: DataPool, subjectHashHex: string, windowSeconds: number, retentionSeconds: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT ${SCHEMA}.auth_record_login_failure($1, make_interval(secs => $2), make_interval(secs => $3)) AS n`,
    [hashToBuffer(subjectHashHex), windowSeconds, retentionSeconds],
  );
  return rows[0]?.n ?? 0;
}

/** Failures inside the window without recording one (pre-check before any password verification). */
export async function loginFailureCount(pool: DataPool, subjectHashHex: string, windowSeconds: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT ${SCHEMA}.auth_login_failure_count($1, make_interval(secs => $2)) AS n`, [hashToBuffer(subjectHashHex), windowSeconds]);
  return rows[0]?.n ?? 0;
}

/** H03 hard lockout: disables the password credential bound to the e-mail until recovery sets a new one. */
export async function disablePassword(pool: DataPool, emailNormalized: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT ${SCHEMA}.auth_disable_password($1) AS ok`, [emailNormalized]);
  return rows[0]?.ok === true;
}

/**
 * H06: Google `email_verified: true` claims an address that only has an unverified binding. Creates a new person for
 * the subject, deletes the unverified binding and invalidates everything created for that address before the claim.
 * Returns null when the address is verified, unbound or the subject already linked (ordinary rules apply then).
 */
export async function claimUnverifiedBinding(pool: DataPool, input: { displayName: string; emailNormalized: string; provider: Provider; subject: string }): Promise<string | null> {
  const { rows } = await pool.query<{ id: string | null }>(`SELECT ${SCHEMA}.auth_claim_unverified_binding($1, $2, $3, $4) AS id`, [input.displayName, input.emailNormalized, input.provider, input.subject]);
  return rows[0]?.id ?? null;
}

export interface PublicProjectRow { id: string; name: string; summary: string | null; status: 'planned' | 'active' | 'suspended' | 'completed' | 'cancelled'; published_story: string | null; revision: number }
/** Public projection columns of a published project for anonymous reads; null for private or unknown ids. */
export async function publicProjectRead(pool: DataPool, id: string): Promise<PublicProjectRow | null> {
  const { rows } = await pool.query<PublicProjectRow>(`SELECT * FROM ${SCHEMA}.public_project_read($1::uuid)`, [id]);
  return rows[0] ?? null;
}
export interface PublicPersonRow { id: string; display_name: string; public_headline: string | null; public_expertise: string[] }
export async function publicPersonRead(pool: DataPool, id: string): Promise<PublicPersonRow | null> {
  const { rows } = await pool.query<PublicPersonRow>(`SELECT * FROM ${SCHEMA}.public_person_read($1::uuid)`, [id]);
  return rows[0] ?? null;
}
