import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AuditEvent, IdempotencyRecord, InboxReceipt, Job, JobState, NewAuditEvent, OutboxEvent } from '../schema.js';

/** Append-only audit: INSERT only; UPDATE/DELETE raise in the database for every role. */
export const auditEvents = {
  append(trx: Transaction, event: Omit<NewAuditEvent, 'basis'> & { basis?: unknown }): Promise<AuditEvent> {
    const { basis, ...rest } = event;
    return trx.insertInto('audit_event').values({ ...rest, basis: basis === undefined ? null : JSON.stringify(basis) }).returningAll().executeTakeFirstOrThrow();
  },
  listForObject(trx: Transaction, objectKind: string, objectId: string): Promise<AuditEvent[]> {
    return trx.selectFrom('audit_event').selectAll().where('object_kind', '=', objectKind).where('object_id', '=', objectId).orderBy('id').execute();
  },
};

/** Transactional outbox: written in the same transaction as the aggregate change, published later by a relay. */
export const outbox = {
  append(trx: Transaction, event: { aggregate_kind: string; aggregate_id: string; revision: number; type: string; payload: unknown }): Promise<OutboxEvent> {
    return trx.insertInto('outbox_event').values({ ...event, payload: JSON.stringify(event.payload) }).returningAll().executeTakeFirstOrThrow();
  },
  /** Oldest unpublished events, row-locked for this relay transaction (other relays skip them). */
  claimUnpublished(trx: Transaction, limit: number): Promise<OutboxEvent[]> {
    return trx.selectFrom('outbox_event').selectAll().where('published_at', 'is', null).orderBy('id').limit(limit).forUpdate().skipLocked().execute();
  },
  async markPublished(trx: Transaction, ids: string[], at: Date = new Date()): Promise<number> {
    if (!ids.length) return 0;
    return Number((await trx.updateTable('outbox_event').set({ published_at: at }).where('id', 'in', ids).where('published_at', 'is', null).executeTakeFirst()).numUpdatedRows);
  },
};

/**
 * Leased jobs with fencing: `lease` uses FOR UPDATE SKIP LOCKED inside trustwork.lease_jobs and increments the
 * per-job fencing token; every completion carries the token and is a no-op (returns false) when the job
 * was re-leased meanwhile. Expired leases are never silently re-queued (reconciliation is an explicit command).
 */
export const jobs = {
  enqueue(trx: Transaction, job: { kind: string; payload?: unknown; next_at?: Date; max_attempts?: number }): Promise<Job> {
    return trx.insertInto('job').values({
      kind: job.kind,
      payload: JSON.stringify(job.payload ?? {}),
      ...(job.next_at ? { next_at: job.next_at } : {}),
      ...(job.max_attempts ? { max_attempts: job.max_attempts } : {}),
    }).returningAll().executeTakeFirstOrThrow();
  },
  async lease(trx: Transaction, kinds: string[], worker: string, leaseSeconds: number, limit: number): Promise<Job[]> {
    const { rows } = await sql<Job>`SELECT * FROM trustwork.lease_jobs(${kinds}::text[], ${worker}, make_interval(secs => ${leaseSeconds}), ${limit}::integer)`.execute(trx);
    return rows;
  },
  async heartbeat(trx: Transaction, id: string, fencingToken: string | number | bigint, leaseSeconds: number): Promise<boolean> {
    const result = await trx.updateTable('job').set({ leased_until: sql`now() + make_interval(secs => ${leaseSeconds})`, updated_at: sql`clock_timestamp()` })
      .where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  async complete(trx: Transaction, id: string, fencingToken: string | number | bigint): Promise<boolean> {
    const result = await trx.updateTable('job').set({ state: 'succeeded', leased_until: null, leased_by: null, updated_at: sql`clock_timestamp()` })
      .where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /** Pre-effect failure: re-queue with backoff while attempts remain, otherwise dead-letter. */
  async fail(trx: Transaction, id: string, fencingToken: string | number | bigint, error: string, retryAt: Date): Promise<boolean> {
    const result = await trx.updateTable('job').set({
      state: sql<JobState>`CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'queued' END`,
      next_at: retryAt, leased_until: null, leased_by: null, last_error: error, updated_at: sql`clock_timestamp()`,
    }).where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /** Crash or ambiguous timeout after a possible external effect: park for reconciliation, never replay. */
  async markOutcomeUnknown(trx: Transaction, id: string, fencingToken: string | number | bigint, error: string): Promise<boolean> {
    const result = await trx.updateTable('job').set({ state: 'outcome_unknown', leased_until: null, leased_by: null, last_error: error, updated_at: sql`clock_timestamp()` })
      .where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /**
   * Expired executing leases are never replayed: they move to `outcome_unknown` (contract action state) and wait
   * for an explicit Reconciliation record. Returns the parked jobs. Intended for a periodic worker sweep.
   */
  expireLeases(trx: Transaction, now: Date = new Date()): Promise<Job[]> {
    return trx.updateTable('job').set({ state: 'outcome_unknown', leased_until: null, leased_by: null, last_error: 'lease expired; awaiting reconciliation', updated_at: sql`clock_timestamp()` })
      .where('state', '=', 'leased').where('leased_until', '<', now).returningAll().execute();
  },
  /** Resolves a parked (outcome_unknown) job with final evidence; the reference names the Reconciliation record. */
  async reconcile(trx: Transaction, id: string, outcome: 'succeeded' | 'failed' | 'queued', reconciliationRef: string): Promise<Job> {
    const { rows } = await sql<Job>`SELECT * FROM trustwork.reconcile_job(${id}::uuid, ${outcome}, ${reconciliationRef})`.execute(trx);
    const job = rows[0];
    if (!job) throw new Error('reconcile_job returned no row');
    return job;
  },
  getById(trx: Transaction, id: string): Promise<Job | undefined> {
    return trx.selectFrom('job').selectAll().where('id', '=', id).executeTakeFirst();
  },
};

export interface SweepReport { auth_tokens: number; login_failures: number; idempotency_records: number; admission_leases: number; sessions: number; unverified_persons: number }
export interface SweepOptions { sessionRetentionSeconds?: number; leaseGraceSeconds?: number; unverifiedSignupAgeSeconds?: number }
/** Bounded tables: owner-run sweeper (trustwork.sweep_expired) callable by the runtime role from a worker or the API. */
export const maintenance = {
  async sweepExpired(trx: Transaction, options: SweepOptions = {}): Promise<SweepReport> {
    const { rows } = await sql<SweepReport>`SELECT * FROM trustwork.sweep_expired(
      make_interval(secs => ${options.sessionRetentionSeconds ?? 90 * 86_400}), make_interval(secs => ${options.leaseGraceSeconds ?? 86_400}), make_interval(secs => ${options.unverifiedSignupAgeSeconds ?? 7 * 86_400}))`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('sweep_expired returned no row');
    return row;
  },
};

export interface IdempotencyScope { principalId: string; action: string; contextId: string; key: string }
/** Unique (principal, action, context, key) with payload digest; same key + different digest is a conflict. */
export const idempotency = {
  get(trx: Transaction, scope: IdempotencyScope): Promise<IdempotencyRecord | undefined> {
    return trx.selectFrom('idempotency_record').selectAll()
      .where('principal_id', '=', scope.principalId).where('action', '=', scope.action).where('context_id', '=', scope.contextId).where('key', '=', scope.key)
      .executeTakeFirst();
  },
  /** Reserves the key; a unique violation (23505) means another request holds it and the caller re-reads. */
  begin(trx: Transaction, scope: IdempotencyScope, payloadDigest: string, expiresAt: Date): Promise<IdempotencyRecord> {
    return trx.insertInto('idempotency_record').values({ principal_id: scope.principalId, action: scope.action, context_id: scope.contextId, key: scope.key, payload_digest: payloadDigest, expires_at: expiresAt })
      .returningAll().executeTakeFirstOrThrow();
  },
  complete(trx: Transaction, id: string, result: unknown): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ state: 'completed', result: JSON.stringify(result) }).where('id', '=', id).where('state', '=', 'in_progress').returningAll().executeTakeFirst();
  },
  /** Replaces a recorded server-side failure (5xx) so the next retry executes again instead of replaying the failure. */
  overwrite(trx: Transaction, id: string, result: unknown): Promise<IdempotencyRecord | undefined> {
    return trx.updateTable('idempotency_record').set({ result: JSON.stringify(result) }).where('id', '=', id).where('state', '=', 'completed').returningAll().executeTakeFirst();
  },
};

/** Inbound deliveries: `record` returns false for a duplicate (provider, account, event_id) instead of raising. */
export const inbox = {
  async record(trx: Transaction, receipt: { provider: string; account: string; event_id: string }): Promise<{ fresh: boolean; receipt: InboxReceipt | undefined }> {
    const inserted = await trx.insertInto('inbox_receipt').values(receipt).onConflict((oc) => oc.columns(['provider', 'account', 'event_id']).doNothing()).returningAll().executeTakeFirst();
    if (inserted) return { fresh: true, receipt: inserted };
    const existing = await trx.selectFrom('inbox_receipt').selectAll().where('provider', '=', receipt.provider).where('account', '=', receipt.account).where('event_id', '=', receipt.event_id).executeTakeFirst();
    return { fresh: false, receipt: existing };
  },
};
