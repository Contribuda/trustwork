import { sql } from 'kysely';
import { PrincipalError, type Transaction } from '../pool.js';
import type { AuthTokenKind, Credential, EmailBinding, NewSession, Person, PersonUpdate, Session, SessionRevokedReason } from '../schema.js';
import { hashToBuffer } from './auth.js';

/** Identity repositories: run inside withPrincipal; RLS limits every row to the current person. */
export const persons = {
  getById(trx: Transaction, id: string): Promise<Person | undefined> {
    return trx.selectFrom('person').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Optimistic update: returns the new row or undefined when the revision no longer matches (or not visible). */
  update(trx: Transaction, id: string, expectedRevision: number, patch: PersonUpdate): Promise<Person | undefined> {
    return trx.updateTable('person').set(patch).where('id', '=', id).where('revision', '=', expectedRevision).returningAll().executeTakeFirst();
  },
};

export const emailBindings = {
  listForPerson(trx: Transaction, personId: string): Promise<EmailBinding[]> {
    return trx.selectFrom('email_binding').selectAll().where('person_id', '=', personId).orderBy('created_at').execute();
  },
  /** Own binding by address (RLS limits the lookup to the current person's rows). */
  getOwnByEmail(trx: Transaction, emailNormalized: string): Promise<EmailBinding | undefined> {
    return trx.selectFrom('email_binding').selectAll().where('email_normalized', '=', emailNormalized).executeTakeFirst();
  },
  /** Moves the primary flag to `id` (one primary per person is a unique index, so the old flag is cleared first). */
  async setPrimary(trx: Transaction, personId: string, id: string): Promise<void> {
    await trx.updateTable('email_binding').set({ is_primary: false }).where('person_id', '=', personId).where('is_primary', '=', true).where('id', '<>', id).execute();
    await trx.updateTable('email_binding').set({ is_primary: true }).where('id', '=', id).where('person_id', '=', personId).execute();
  },
  insert(trx: Transaction, personId: string, emailNormalized: string, isPrimary = false): Promise<EmailBinding> {
    return trx.insertInto('email_binding').values({ person_id: personId, email_normalized: emailNormalized, is_primary: isPrimary }).returningAll().executeTakeFirstOrThrow();
  },
  markVerified(trx: Transaction, id: string, at: Date = new Date()): Promise<EmailBinding | undefined> {
    return trx.updateTable('email_binding').set({ verified_at: at }).where('id', '=', id).where('verified_at', 'is', null).returningAll().executeTakeFirst();
  },
};

/** Credential rows never expose password_hash to the runtime role (column privilege), so selects list explicit columns. */
export const credentials = {
  listForPerson(trx: Transaction, personId: string): Promise<Omit<Credential, 'password_hash'>[]> {
    return trx.selectFrom('credential').select(['id', 'person_id', 'kind', 'provider', 'provider_subject', 'disabled_at', 'revision', 'created_at', 'updated_at']).where('person_id', '=', personId).execute();
  },
  insertProvider(trx: Transaction, personId: string, provider: 'google' | 'apple', subject: string): Promise<{ id: string }> {
    return trx.insertInto('credential').values({ person_id: personId, kind: provider, provider, provider_subject: subject }).returning('id').executeTakeFirstOrThrow();
  },
  /** Password change/recovery: updates the hash of the person's password credential; returns the affected count (0 or 1). */
  async setPasswordHash(trx: Transaction, personId: string, passwordHash: string): Promise<number> {
    const result = await trx.updateTable('credential').set({ password_hash: passwordHash, disabled_at: null }).where('person_id', '=', personId).where('kind', '=', 'password').executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
  /** First password for a provider-only person (recovery after mailbox proof). */
  insertPassword(trx: Transaction, personId: string, passwordHash: string): Promise<{ id: string }> {
    return trx.insertInto('credential').values({ person_id: personId, kind: 'password', password_hash: passwordHash }).returning('id').executeTakeFirstOrThrow();
  },
  /** Disables (never deletes) a provider link; a later re-link creates a new row only when the subject is free. */
  async disableProvider(trx: Transaction, personId: string, provider: 'google' | 'apple', at: Date = new Date()): Promise<number> {
    const result = await trx.updateTable('credential').set({ disabled_at: at }).where('person_id', '=', personId).where('provider', '=', provider).where('disabled_at', 'is', null).executeTakeFirst();
    return Number(result.numUpdatedRows);
  },
  /** Pre-hijack defence: disables provider links created before an address was verified. */
  async disableProvidersCreatedBefore(trx: Transaction, personId: string, before: Date, at: Date = new Date(), exceptProvider: 'google' | 'apple' | null = null): Promise<number> {
    let query = trx.updateTable('credential').set({ disabled_at: at }).where('person_id', '=', personId).where('provider', 'is not', null).where('created_at', '<', before).where('disabled_at', 'is', null);
    if (exceptProvider) query = query.where('provider', '<>', exceptProvider);
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  },
};

export const sessions = {
  insert(trx: Transaction, session: Omit<NewSession, 'token_hash'> & { token_hash_hex: string }): Promise<Session> {
    const { token_hash_hex, ...rest } = session;
    return trx.insertInto('session').values({ ...rest, token_hash: hashToBuffer(token_hash_hex) }).returningAll().executeTakeFirstOrThrow();
  },
  getById(trx: Transaction, id: string): Promise<Session | undefined> {
    return trx.selectFrom('session').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Step-up: refreshes the authentication proof time of the acting session. */
  reauthenticate(trx: Transaction, id: string, at: Date = new Date()): Promise<Session | undefined> {
    return trx.updateTable('session').set({ authenticated_at: at }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  /** Pre-hijack defence: revokes every session of the person created before `before` (except the acting one). */
  async revokeCreatedBefore(trx: Transaction, personId: string, before: Date, reason: SessionRevokedReason, exceptSessionId: string | null, at: Date = new Date()): Promise<number> {
    let query = trx.updateTable('session').set({ revoked_at: at, revoked_reason: reason }).where('person_id', '=', personId).where('revoked_at', 'is', null).where('created_at', '<', before);
    if (exceptSessionId) query = query.where('id', '<>', exceptSessionId);
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  },
  listForPerson(trx: Transaction, personId: string): Promise<Session[]> {
    return trx.selectFrom('session').selectAll().where('person_id', '=', personId).orderBy('created_at', 'desc').execute();
  },
  touch(trx: Transaction, id: string, idleExpiresAt: Date, at: Date = new Date()): Promise<Session | undefined> {
    return trx.updateTable('session').set({ last_seen_at: at, idle_expires_at: idleExpiresAt }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  revoke(trx: Transaction, id: string, reason: SessionRevokedReason, at: Date = new Date()): Promise<Session | undefined> {
    return trx.updateTable('session').set({ revoked_at: at, revoked_reason: reason }).where('id', '=', id).where('revoked_at', 'is', null).returningAll().executeTakeFirst();
  },
  async revokeAllForPerson(trx: Transaction, personId: string, reason: SessionRevokedReason, exceptSessionId: string | null = null, at: Date = new Date()): Promise<number> {
    let query = trx.updateTable('session').set({ revoked_at: at, revoked_reason: reason }).where('person_id', '=', personId).where('revoked_at', 'is', null);
    if (exceptSessionId) query = query.where('id', '<>', exceptSessionId);
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  },
};

export const authTokens = {
  /** Identity-bound issue (e-mail change); pre-identity issue goes through auth.issueToken. */
  insert(trx: Transaction, personId: string, kind: AuthTokenKind, emailNormalized: string, tokenHashHex: string, expiresAt: Date): Promise<{ id: string }> {
    return trx.insertInto('auth_token').values({ person_id: personId, kind, email_normalized: emailNormalized, token_hash: hashToBuffer(tokenHashHex), expires_at: expiresAt }).returning('id').executeTakeFirstOrThrow();
  },
  /** Invalidates the person's outstanding tokens (all kinds, or one kind) by consuming them. */
  async consumeOutstanding(trx: Transaction, personId: string, kind: AuthTokenKind | null = null, at: Date = new Date(), exceptTokenHashHex: string | null = null): Promise<number> {
    let query = trx.updateTable('auth_token').set({ consumed_at: at }).where('person_id', '=', personId).where('consumed_at', 'is', null);
    if (kind) query = query.where('kind', '=', kind);
    if (exceptTokenHashHex) query = query.where('token_hash', '<>', hashToBuffer(exceptTokenHashHex));
    return Number((await query.executeTakeFirst()).numUpdatedRows);
  },
};

/**
 * Pre-identity definer calls bound to an open transaction (BE-002): the change, its audit row and its outbox intents
 * commit together. Inputs are hashes, never raw tokens; every function is on the reviewed SECURITY DEFINER allowlist.
 */
export type SignupOutcome = 'registered' | 'claim_pending' | 'bound';
export type MailboxProofOutcome = 'verified' | 'bound' | 'claimed' | 'taken';
export interface MailboxProof {
  person_id: string;
  email_normalized: string;
  kind: 'verify_email' | 'email_change';
  authz_epoch: number;
  outcome: MailboxProofOutcome;
  binding_id: string | null;
  /** Person whose unverified (squatting) binding the proof removed. */
  displaced_person_id: string | null;
}
export interface ThrottleState { failures: number; secondsSinceLast: number }

export const preIdentity = {
  /** `registered`, `claim_pending` (address held by another person's unverified binding) or `bound` (verified owner). */
  async signup(trx: Transaction, input: { displayName: string; emailNormalized: string; passwordHash: string; verifyTokenHashHex: string; verifyExpiresAt: Date }): Promise<{ personId: string | null; outcome: SignupOutcome }> {
    const { rows } = await sql<{ person_id: string | null; outcome: SignupOutcome }>`
      SELECT * FROM trustwork.auth_signup(${input.displayName}, ${input.emailNormalized}, ${input.passwordHash}, ${hashToBuffer(input.verifyTokenHashHex)}, ${input.verifyExpiresAt})`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('auth_signup returned no row');
    return { personId: row.person_id, outcome: row.outcome };
  },
  /** Consumes a verify_email or email_change token and binds the address (removing a squatting unverified binding). */
  async proveMailbox(trx: Transaction, tokenHashHex: string): Promise<MailboxProof | null> {
    const { rows } = await sql<MailboxProof>`SELECT * FROM trustwork.auth_prove_mailbox(${hashToBuffer(tokenHashHex)})`.execute(trx);
    return rows[0] ?? null;
  },
  /** Single-use token consumption of another kind (recovery, invitation) inside the transaction. */
  async consumeToken(trx: Transaction, tokenHashHex: string, kind: AuthTokenKind): Promise<{ token_id: string; person_id: string; email_normalized: string; authz_epoch: number } | null> {
    const { rows } = await sql<{ token_id: string; person_id: string; email_normalized: string; authz_epoch: number }>`
      SELECT * FROM trustwork.auth_consume_token(${hashToBuffer(tokenHashHex)}, ${kind})`.execute(trx);
    return rows[0] ?? null;
  },
  async issueToken(trx: Transaction, input: { emailNormalized: string; kind: AuthTokenKind; tokenHashHex: string; expiresAt: Date; requireVerified: boolean }): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      SELECT trustwork.auth_issue_token(${input.emailNormalized}, ${input.kind}, ${hashToBuffer(input.tokenHashHex)}, ${input.expiresAt}, ${input.requireVerified}) AS id`.execute(trx);
    return rows[0]?.id ?? null;
  },
  async registerProviderPerson(trx: Transaction, input: { displayName: string | null; emailNormalized: string; provider: 'google' | 'apple'; subject: string; emailVerified: boolean }): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      SELECT trustwork.auth_register_provider_person(${input.displayName}, ${input.emailNormalized}, ${input.provider}, ${input.subject}, ${input.emailVerified}) AS id`.execute(trx);
    return rows[0]?.id ?? null;
  },
  async claimUnverifiedBinding(trx: Transaction, input: { displayName: string | null; emailNormalized: string; provider: 'google' | 'apple'; subject: string }): Promise<string | null> {
    const { rows } = await sql<{ id: string | null }>`
      SELECT trustwork.auth_claim_unverified_binding(${input.displayName}, ${input.emailNormalized}, ${input.provider}, ${input.subject}) AS id`.execute(trx);
    return rows[0]?.id ?? null;
  },
  /** Records one failure for a hashed subject; returns the count inside the window. */
  async recordLoginFailure(trx: Transaction, subjectHashHex: string, windowSeconds: number, retentionSeconds: number): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      SELECT trustwork.auth_record_login_failure(${hashToBuffer(subjectHashHex)}, make_interval(secs => ${windowSeconds}), make_interval(secs => ${retentionSeconds})) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
  async throttleState(trx: Transaction, subjectHashHex: string, windowSeconds: number): Promise<ThrottleState> {
    const { rows } = await sql<{ failures: number; seconds_since_last: number }>`
      SELECT * FROM trustwork.auth_login_throttle(${hashToBuffer(subjectHashHex)}, make_interval(secs => ${windowSeconds}))`.execute(trx);
    return { failures: rows[0]?.failures ?? 0, secondsSinceLast: Number(rows[0]?.seconds_since_last ?? 0) };
  },
  /** Current authorization epoch of a person (the value discloses nothing; used right after a definer created or changed it). */
  async personEpoch(trx: Transaction, personId: string): Promise<number | null> {
    const { rows } = await sql<{ authz_epoch: number }>`SELECT authz_epoch FROM trustwork.auth_person_epoch(${personId}::uuid)`.execute(trx);
    return rows[0]?.authz_epoch ?? null;
  },
};

/**
 * Sets the verified identity inside an already open transaction (after pre-identity definer calls), with the same
 * trusted setter as `withPrincipal`; a stale epoch fails closed (SQLSTATE 28000).
 */
export async function assumePrincipal(trx: Transaction, principal: { personId: string; authzEpoch: number }): Promise<void> {
  try {
    await sql`SELECT trustwork.set_principal(${principal.personId}::uuid, ${principal.authzEpoch}::integer)`.execute(trx);
  } catch (error) {
    const e = error as { code?: string; hint?: string; message?: string };
    if (e && e.code === '28000') throw new PrincipalError(e.hint === 'access.stale_epoch' ? 'access.stale_epoch' : 'access.no_principal', e.message ?? 'principal rejected');
    throw error;
  }
}

/** Clears the account failure counters of the current person's verified addresses (identity required). */
export async function clearOwnLoginFailures(trx: Transaction): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT trustwork.auth_clear_login_failures() AS n`.execute(trx);
  return rows[0]?.n ?? 0;
}
