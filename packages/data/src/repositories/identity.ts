import type { Transaction } from '../pool.js';
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
