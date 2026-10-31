import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import { outbox } from './reliability.js';
import { MAIL_FINAL_STATES, MAIL_TEMPLATES, type MailDelivery, type MailDeliveryState, type MailFeedback, type MailTemplateName, type SuppressionReason } from '../schema/mail.js';

export { MAIL_TEMPLATES, MAIL_FINAL_STATES, type MailDelivery, type MailDeliveryState, type MailFeedback, type MailTemplateName, type SuppressionReason };

/** Outbox event type that asks the worker to deliver one mail_delivery row (payload `{}`; aggregate id = delivery id). */
export const MAIL_REQUESTED = 'mail.requested';
export const MAIL_AGGREGATE = 'mail_delivery';

/** Addresses are compared after trimming, Unicode NFC and lower-casing (the identity module stores them the same way). */
export function normalizeMailAddress(address: string): string {
  return address.trim().normalize('NFC').toLowerCase();
}
/** Suppression and rate-limit key: never the address itself. */
export function mailAddressHash(address: string): string {
  return createHash('sha256').update(`mail:${normalizeMailAddress(address)}`, 'utf8').digest('hex');
}

/**
 * Sealing of one-time secrets (verification, recovery, e-mail change and invitation tokens) between the API and the
 * worker. The database only ever stores the token's SHA-256 (auth_token) and this ciphertext; the key is
 * configuration (`MAIL_SECRET_KEY`) shared by the API and the worker and never stored in PostgreSQL, so a database
 * dump alone does not reveal a usable token. AES-256-GCM with a key derived by HKDF-SHA-256 from the configured key,
 * a random 96-bit nonce and the delivery id as associated data (a ciphertext moved to another row does not open).
 * Layout: version byte 0x01 | nonce (12) | tag (16) | ciphertext.
 */
const SEAL_VERSION = 0x01;

/**
 * Key used when `MAIL_SECRET_KEY` is unset outside production, so a local API and worker agree without setup. It is
 * public by construction and refused in production.
 */
export const DEVELOPMENT_MAIL_SECRET_KEY = createHash('sha256').update('trustwork-development-mail-secret-key-not-for-production', 'utf8').digest();

/** The one rule the API and the worker share for `MAIL_SECRET_KEY` (hex, at least 32 bytes, required in production). */
export function mailSecretKeyFromEnv(env: { NODE_ENV?: string | undefined; MAIL_SECRET_KEY?: string | undefined }): Buffer {
  const production = env.NODE_ENV === 'production';
  const raw = env.MAIL_SECRET_KEY?.trim();
  if (!raw) {
    if (production) throw new Error('MAIL_SECRET_KEY is required in production (hex, at least 32 bytes, the same value for the API and the worker)');
    return DEVELOPMENT_MAIL_SECRET_KEY;
  }
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw)) throw new Error('MAIL_SECRET_KEY must be hex of at least 32 bytes');
  const key = Buffer.from(raw, 'hex');
  if (production && key.equals(DEVELOPMENT_MAIL_SECRET_KEY)) throw new Error('MAIL_SECRET_KEY must not be the development key in production');
  return key;
}
export function deriveMailSecretKey(configured: Buffer): Buffer {
  if (configured.length < 32) throw new RangeError('mail secret key must be at least 32 bytes');
  return Buffer.from(hkdfSync('sha256', configured, Buffer.alloc(0), 'trustwork mail secret v1', 32));
}
function aad(deliveryId: string): Buffer {
  return Buffer.from(`trustwork-mail-secret-v1:${deliveryId}`, 'utf8');
}
export function sealMailSecret(key: Buffer, deliveryId: string, secret: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(deliveryId));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, cipher.getAuthTag(), body]);
}
export class MailSecretError extends Error {
  constructor(message = 'sealed mail secret cannot be opened') {
    super(message);
    this.name = 'MailSecretError';
  }
}
export function unsealMailSecret(key: Buffer, deliveryId: string, sealed: Buffer): string {
  if (sealed.length < 1 + 12 + 16 || sealed[0] !== SEAL_VERSION) throw new MailSecretError('unknown sealed secret format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13));
    decipher.setAAD(aad(deliveryId));
    decipher.setAuthTag(sealed.subarray(13, 29));
    return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new MailSecretError(error instanceof Error ? `sealed mail secret cannot be opened: ${error.message}` : undefined);
  }
}

const FEEDBACK_RANK: Record<MailFeedback | 'none', number> = { none: 0, delivered: 1, soft_bounce: 2, hard_bounce: 3, complaint: 4 };
const boundedError = (error: string): string => (error.length > 500 ? `${error.slice(0, 497)}...` : error);

export interface MailRecordInput {
  template: MailTemplateName;
  recipient: string;
  /** Sanitised language preferences of the causing request, best first (at most 6). */
  localePreferences?: readonly string[];
  /** Non-secret parameters (durations, ids, public names). */
  params?: Record<string, string>;
  /** One-time secret sealed under `key`; it is opened by the worker only. */
  secret?: { value: string; expiresAt: Date };
}

/**
 * Transactional mail deliveries. The API role records (INSERT only, no RETURNING: it may not read the table); the
 * worker role reads, claims and settles them.
 */
export const mailDeliveries = {
  /**
   * Records one mail intent in the caller's transaction: the delivery row and the `mail.requested` outbox event commit
   * or roll back with the change that caused them. Returns the delivery id (generated here).
   */
  async record(trx: Transaction, key: Buffer, input: MailRecordInput): Promise<string> {
    if (!MAIL_TEMPLATES.includes(input.template)) throw new RangeError(`unknown mail template ${input.template}`);
    const id = randomUUID();
    const recipient = normalizeMailAddress(input.recipient);
    for (const [name, value] of Object.entries(input.params ?? {})) if (typeof value !== 'string') throw new TypeError(`mail parameter ${name} must be a string`);
    await trx.insertInto('mail_delivery').values({
      id,
      template: input.template,
      locale_preferences: [...(input.localePreferences ?? [])].slice(0, 6),
      recipient,
      recipient_hash: mailAddressHash(recipient),
      params: JSON.stringify(input.params ?? {}),
      sealed_secret: input.secret ? sealMailSecret(key, id, input.secret.value) : null,
      secret_expires_at: input.secret ? input.secret.expiresAt : null,
    }).execute();
    await outbox.append(trx, { aggregate_kind: MAIL_AGGREGATE, aggregate_id: id, revision: 1, type: MAIL_REQUESTED, payload: {} });
    return id;
  },
  getById(trx: Transaction, id: string): Promise<MailDelivery | undefined> {
    return trx.selectFrom('mail_delivery').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Row-locks one delivery for the claim transaction (concurrent deliveries of the same row serialise here). */
  lockForDelivery(trx: Transaction, id: string): Promise<MailDelivery | undefined> {
    return trx.selectFrom('mail_delivery').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  },
  /** Serialises claims for one recipient inside the transaction, so the per-recipient window cannot be overshot. */
  async lockRecipient(trx: Transaction, recipientHash: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`trustwork.mail:${recipientHash}`}, 0))`.execute(trx);
  },
  /** Claims (sending or sent) for a recipient within the last `seconds` (database clock). */
  async recentClaims(trx: Transaction, recipientHash: string | null, seconds: number): Promise<number> {
    let query = trx.selectFrom('mail_delivery').select((eb) => eb.fn.countAll<string>().as('n'))
      .where('claimed_at', '>', sql<Date>`now() - make_interval(secs => ${seconds})`);
    if (recipientHash !== null) query = query.where('recipient_hash', '=', recipientHash);
    return Number((await query.executeTakeFirstOrThrow()).n);
  },
  async setJob(trx: Transaction, id: string, jobId: string): Promise<void> {
    await trx.updateTable('mail_delivery').set({ job_id: jobId, updated_at: sql`now()` }).where('id', '=', id).where('job_id', 'is', null).execute();
  },
  /** Persists the attempt identity before the transport is called (ADR 004). */
  async markSending(trx: Transaction, id: string, attemptRef: string): Promise<void> {
    await trx.updateTable('mail_delivery').set({ state: 'sending', attempt_ref: attemptRef, claimed_at: sql`now()`, last_error: null, updated_at: sql`now()` })
      .where('id', '=', id).where('state', 'in', ['pending', 'sending']).execute();
  },
  /** A definitive failure without effect: back to pending for the next attempt. */
  async markRetry(trx: Transaction, id: string, error: string): Promise<void> {
    await trx.updateTable('mail_delivery').set({ state: 'pending', claimed_at: null, last_error: boundedError(error), updated_at: sql`now()` })
      .where('id', '=', id).where('state', '=', 'sending').execute();
  },
  /** Accepted by the transport: final; the address and the secret are cleared. */
  async markSent(trx: Transaction, id: string, providerMessageId: string | null): Promise<boolean> {
    const result = await trx.updateTable('mail_delivery').set({
      state: 'sent', sent_at: sql`now()`, provider_message_id: providerMessageId === null ? null : providerMessageId.slice(0, 200), recipient: null, sealed_secret: null, last_error: null, updated_at: sql`now()`,
    }).where('id', '=', id).where('state', 'in', ['pending', 'sending']).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /** Final without sending (suppressed, rate limited, expired, failed): the address and the secret are cleared. */
  async markFinal(trx: Transaction, id: string, state: Exclude<MailDeliveryState, 'pending' | 'sending' | 'sent'>, error: string | null = null): Promise<boolean> {
    const result = await trx.updateTable('mail_delivery').set({ state, recipient: null, sealed_secret: null, last_error: error === null ? null : boundedError(error), updated_at: sql`now()` })
      .where('id', '=', id).where('state', 'in', ['pending', 'sending']).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /** Keeps the most severe transport feedback (complaint > hard bounce > soft bounce > delivered). Returns true when it changed. */
  async recordFeedback(trx: Transaction, id: string, feedback: MailFeedback, at: Date | null): Promise<boolean> {
    const current = await trx.selectFrom('mail_delivery').select('feedback').where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current || FEEDBACK_RANK[current.feedback ?? 'none'] >= FEEDBACK_RANK[feedback]) return false;
    await trx.updateTable('mail_delivery').set({ feedback, feedback_at: at ?? sql<Date>`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
    return true;
  },
  /**
   * Housekeeping for the worker's scheduled task: deliveries whose job ended without a recorded outcome take the job's
   * verdict (a job reconciled as succeeded means the provider confirmed the effect; a dead job means it was never
   * sent), expired secrets are never sent, and every final row is stripped of the address and the secret.
   */
  async settle(trx: Transaction): Promise<{ sent: number; failed: number; expired: number }> {
    const sent = await trx.updateTable('mail_delivery').set({ state: 'sent', sent_at: sql`coalesce(sent_at, now())`, recipient: null, sealed_secret: null, updated_at: sql`now()` })
      .where('state', '=', 'sending')
      .where('job_id', 'in', (eb) => eb.selectFrom('job').select('id').where('state', '=', 'succeeded'))
      .executeTakeFirst();
    const failed = await trx.updateTable('mail_delivery').set({ state: 'failed', recipient: null, sealed_secret: null, last_error: sql`coalesce(last_error, 'delivery job dead-lettered')`, updated_at: sql`now()` })
      .where('state', 'in', ['pending', 'sending'])
      .where('job_id', 'in', (eb) => eb.selectFrom('job').select('id').where('state', '=', 'dead'))
      .executeTakeFirst();
    const expired = await trx.updateTable('mail_delivery').set({ state: 'expired', recipient: null, sealed_secret: null, updated_at: sql`now()` })
      .where('state', '=', 'pending')
      .where('secret_expires_at', '<', sql<Date>`now()`)
      .executeTakeFirst();
    return { sent: Number(sent.numUpdatedRows), failed: Number(failed.numUpdatedRows), expired: Number(expired.numUpdatedRows) };
  },
};

export const suppressions = {
  async isSuppressed(trx: Transaction, addressHash: string): Promise<SuppressionReason | null> {
    const row = await trx.selectFrom('suppression_entry').select('reason').where('address_hash', '=', addressHash).executeTakeFirst();
    return row?.reason ?? null;
  },
  /** Idempotent: an existing entry is kept as it is. Returns true when a new entry was added. */
  async add(trx: Transaction, entry: { addressHash: string; reason: SuppressionReason; source: string; deliveryId: string | null }): Promise<boolean> {
    const inserted = await trx.insertInto('suppression_entry').values({ address_hash: entry.addressHash, reason: entry.reason, source: entry.source.slice(0, 100), delivery_id: entry.deliveryId })
      .onConflict((oc) => oc.column('address_hash').doNothing()).returning('address_hash').executeTakeFirst();
    return inserted !== undefined;
  },
};
