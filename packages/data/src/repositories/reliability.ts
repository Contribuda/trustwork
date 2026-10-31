import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { AuditEvent, IdempotencyRecord, InboxReceipt, Job, JobState, NewAuditEvent, OutboxEvent } from '../schema.js';
import type { ScheduleOutcome, WorkerSchedule } from '../schema/worker.js';

/** Error text stored on job and schedule rows is bounded; stacks and provider bodies never belong there. */
const boundedError = (error: string): string => (error.length > 2000 ? `${error.slice(0, 1997)}...` : error);
/** last_error written by `jobs.expireLeases`; tells lease expiry apart from other reasons for parking. */
const LEASE_EXPIRED = 'lease expired; awaiting reconciliation';
const secondsOf = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('seconds must be a finite non-negative number');
  return value;
};

/**
 * Append-only audit: INSERT only; UPDATE/DELETE raise in the database for every role. The API and worker roles may
 * insert but not read audit rows (REL-001), so `append` returns nothing; reading is for the owner/maintenance
 * connection and future staff tooling with a case grant.
 */
export const auditEvents = {
  async append(trx: Transaction, event: Omit<NewAuditEvent, 'basis'> & { basis?: unknown }): Promise<void> {
    const { basis, ...rest } = event;
    await trx.insertInto('audit_event').values({ ...rest, basis: basis === undefined ? null : JSON.stringify(basis) }).execute();
  },
  /** Owner/maintenance connection only (the runtime roles have no SELECT on audit_event). */
  listForObject(trx: Transaction, objectKind: string, objectId: string): Promise<AuditEvent[]> {
    return trx.selectFrom('audit_event').selectAll().where('object_kind', '=', objectKind).where('object_id', '=', objectId).orderBy('id').execute();
  },
};

/**
 * Transactional outbox: written in the same transaction as the aggregate change, published later by the worker relay.
 * The API role may only append (no SELECT); claiming, reading and publishing need the worker role.
 */
export const outbox = {
  async append(trx: Transaction, event: { aggregate_kind: string; aggregate_id: string; revision: number; type: string; payload: unknown }): Promise<void> {
    await trx.insertInto('outbox_event').values({ ...event, payload: JSON.stringify(event.payload) }).execute();
  },
  /** Oldest unpublished events, row-locked for this relay transaction (other relays skip them). Worker role. */
  claimUnpublished(trx: Transaction, limit: number): Promise<OutboxEvent[]> {
    return trx.selectFrom('outbox_event').selectAll().where('published_at', 'is', null).orderBy('id').limit(limit).forUpdate().skipLocked().execute();
  },
  /** Database clock unless an instant is given. Worker role. */
  async markPublished(trx: Transaction, ids: string[], at?: Date): Promise<number> {
    if (!ids.length) return 0;
    return Number((await trx.updateTable('outbox_event').set({ published_at: at ?? sql<Date>`now()` }).where('id', 'in', ids).where('published_at', 'is', null).executeTakeFirst()).numUpdatedRows);
  },
  /** One event by id (redelivery after a handler failure). Worker role. */
  getById(trx: Transaction, id: string): Promise<OutboxEvent | undefined> {
    return trx.selectFrom('outbox_event').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Backlog gauges measured with the database clock: unpublished count and the age of the oldest unpublished event. */
  async stats(trx: Transaction): Promise<{ unpublished: number; oldestAgeSeconds: number }> {
    const { rows } = await sql<{ unpublished: number; oldest_age_seconds: number }>`
      SELECT count(*)::int AS unpublished, coalesce(extract(epoch FROM now() - min(created_at)), 0)::float8 AS oldest_age_seconds
      FROM trustwork.outbox_event WHERE published_at IS NULL`.execute(trx);
    return { unpublished: rows[0]?.unpublished ?? 0, oldestAgeSeconds: Math.max(0, rows[0]?.oldest_age_seconds ?? 0) };
  },
};

/**
 * Leased jobs with fencing: `lease` uses FOR UPDATE SKIP LOCKED inside trustwork.lease_jobs and increments the
 * per-job fencing token; every completion carries the token and is a no-op (returns false) when the job
 * was re-leased meanwhile. Expired leases are never silently re-queued (reconciliation is an explicit command).
 */
export const jobs = {
  /** `delay_seconds` schedules the first attempt on the database clock (preferred over a caller-computed `next_at`). */
  enqueue(trx: Transaction, job: { kind: string; payload?: unknown; next_at?: Date; delay_seconds?: number; max_attempts?: number }): Promise<Job> {
    return trx.insertInto('job').values({
      kind: job.kind,
      payload: JSON.stringify(job.payload ?? {}),
      ...(job.next_at ? { next_at: job.next_at } : {}),
      ...(job.delay_seconds !== undefined ? { next_at: sql<Date>`now() + make_interval(secs => ${secondsOf(job.delay_seconds)})` } : {}),
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
  /**
   * Pre-effect failure with the retry time computed by the database clock (`now() + delay`), so a worker with a skewed
   * clock cannot schedule a retry in the past or far future. Re-queues while attempts remain, otherwise dead-letters.
   */
  async failWithBackoff(trx: Transaction, id: string, fencingToken: string | number | bigint, error: string, delaySeconds: number): Promise<boolean> {
    const result = await trx.updateTable('job').set({
      state: sql<JobState>`CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'queued' END`,
      next_at: sql`now() + make_interval(secs => ${secondsOf(delaySeconds)})`, leased_until: null, leased_by: null, last_error: boundedError(error), updated_at: sql`clock_timestamp()`,
    }).where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /** Definitive, non-retryable failure before any external effect: dead-letter now, whatever attempts remain. */
  async deadLetter(trx: Transaction, id: string, fencingToken: string | number | bigint, error: string): Promise<boolean> {
    const result = await trx.updateTable('job').set({ state: 'dead', leased_until: null, leased_by: null, last_error: boundedError(error), updated_at: sql`clock_timestamp()` })
      .where('id', '=', id).where('state', '=', 'leased').where('fencing_token', '=', String(fencingToken)).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  },
  /**
   * Gives a lease back without consuming an attempt (graceful shutdown before the work started, or a transactional
   * handler whose transaction rolled back). Owner-run `trustwork.release_job`; fencing-checked.
   */
  async release(trx: Transaction, id: string, fencingToken: string | number | bigint): Promise<boolean> {
    const { rows } = await sql<{ released: boolean }>`SELECT trustwork.release_job(${id}::uuid, ${String(fencingToken)}::bigint) AS released`.execute(trx);
    return rows[0]?.released === true;
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
  expireLeases(trx: Transaction, now?: Date): Promise<Job[]> {
    // Without an explicit instant the database clock decides (the same clock that set leased_until), so clock skew
    // between worker hosts can never park a live lease.
    return trx.updateTable('job').set({ state: 'outcome_unknown', leased_until: null, leased_by: null, last_error: LEASE_EXPIRED, updated_at: sql`clock_timestamp()` })
      .where('state', '=', 'leased').where('leased_until', '<', now ?? sql<Date>`now()`).returningAll().execute();
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
  /** Jobs parked as outcome_unknown, oldest first (input of the reconciliation command). */
  listParked(trx: Transaction, limit = 100): Promise<Job[]> {
    return trx.selectFrom('job').selectAll().where('state', '=', 'outcome_unknown').orderBy('updated_at').orderBy('id').limit(limit).execute();
  },
  /**
   * Queue gauges per (kind, state) for the non-terminal and dead-letter states: `ready` counts queued jobs that are due
   * by the database clock, `lease_expired` counts outcome_unknown jobs parked by lease expiry (not yet reconciled).
   */
  async stats(trx: Transaction): Promise<{ kind: string; state: JobState; count: number; ready: number; lease_expired: number }[]> {
    const { rows } = await sql<{ kind: string; state: JobState; count: number; ready: number; lease_expired: number }>`
      SELECT kind, state, count(*)::int AS count,
        (count(*) FILTER (WHERE state = 'queued' AND next_at <= now()))::int AS ready,
        (count(*) FILTER (WHERE state = 'outcome_unknown' AND last_error = ${LEASE_EXPIRED}))::int AS lease_expired
      FROM trustwork.job WHERE state IN ('queued', 'leased', 'outcome_unknown', 'dead') GROUP BY kind, state ORDER BY kind, state`.execute(trx);
    return rows;
  },
};


export interface SweepReport { auth_tokens: number; login_failures: number; idempotency_records: number; admission_leases: number; sessions: number; unverified_persons: number }
export interface SweepOptions { sessionRetentionSeconds?: number; leaseGraceSeconds?: number; unverifiedSignupAgeSeconds?: number }
/**
 * Bounded tables and scheduled maintenance. `sweepExpired` keeps the caller-chosen intervals for the existing API dev
 * script; the worker calls `sweepScheduled`, whose intervals are fixed inside the definer function.
 */
export const maintenance = {
  /** Worker role: trustwork.worker_sweep_expired() with fixed intervals (also deletes expired idempotency records). */
  async sweepScheduled(trx: Transaction): Promise<SweepReport> {
    const { rows } = await sql<SweepReport>`SELECT * FROM trustwork.worker_sweep_expired()`.execute(trx);
    const row = rows[0];
    if (!row) throw new Error('worker_sweep_expired returned no row');
    return row;
  },
  /** Worker role: creates the missing monthly partitions of audit_event and outbox_event (current month plus three). */
  async ensureMonthlyPartitions(trx: Transaction): Promise<string[]> {
    const { rows } = await sql<{ name: string }>`SELECT name FROM trustwork.ensure_monthly_partitions() AS name`.execute(trx);
    return rows.map((r) => r.name);
  },
  /**
   * Claims a due scheduled task: moves `next_at` forward by the interval in one UPDATE, so at most one worker runs a
   * given slot. Returns undefined when the task is not due. Database clock only.
   */
  async claimScheduledTask(trx: Transaction, task: string, intervalSeconds: number, worker: string): Promise<WorkerSchedule | undefined> {
    await trx.insertInto('worker_schedule').values({ task }).onConflict((oc) => oc.column('task').doNothing()).execute();
    return trx.updateTable('worker_schedule').set({
      next_at: sql`now() + make_interval(secs => ${secondsOf(intervalSeconds)})`, last_started_at: sql`now()`, last_worker: worker,
      run_count: sql`run_count + 1`, updated_at: sql`clock_timestamp()`,
    }).where('task', '=', task).where('next_at', '<=', sql<Date>`now()`).returningAll().executeTakeFirst();
  },
  /** Records the outcome; a failure brings the next run forward to `now() + retrySeconds` when that is sooner. */
  async finishScheduledTask(trx: Transaction, task: string, outcome: ScheduleOutcome, error: string | null, retrySeconds: number): Promise<void> {
    const failed = outcome === 'failed';
    await trx.updateTable('worker_schedule').set({
      last_finished_at: sql`now()`, last_outcome: outcome, last_error: error === null ? null : boundedError(error),
      failure_count: failed ? sql`failure_count + 1` : sql`failure_count`,
      next_at: failed ? sql`least(next_at, now() + make_interval(secs => ${secondsOf(retrySeconds)}))` : sql`next_at`,
      updated_at: sql`clock_timestamp()`,
    }).where('task', '=', task).execute();
  },
  listScheduledTasks(trx: Transaction): Promise<WorkerSchedule[]> {
    return trx.selectFrom('worker_schedule').selectAll().orderBy('task').execute();
  },
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
