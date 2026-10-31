import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { inOwnerTransaction } from '../../infra/backup/src/retention.js';
import type { RestoreFence } from './fence.js';

/**
 * Restore reconciliation (OPS-003). A restored database is older than the world: after its recovery point the lost
 * primary may have leased jobs, called providers and relayed outbox events. Before any worker runs again, every piece
 * of pending work is compared with what providers actually received, so no effect is sent twice:
 *
 *   external job (queued or leased) with a provider receipt for its effect key  -> closed as succeeded (never re-sent)
 *   external job without a receipt, receipt journal complete                     -> leased: released to queued;
 *                                                                                    queued: stays queued (no effect)
 *   external job without a receipt, journal incomplete                           -> parked as outcome_unknown
 *   transactional job (database-only)                                            -> leased: released to queued
 *   job already parked before the failure                                        -> stays parked (worker reconcile CLI)
 *   receipt whose job the restored database does not know (an "orphan")         -> reported: the effect belongs to work
 *                                                                                    lost with the primary
 *   unpublished outbox event while orphans exist or the journal is incomplete    -> ambiguous: the lost primary may have
 *                                                                                    relayed it; an operator decides per
 *                                                                                    event (delivered | relay)
 *
 * Every change is a fencing-token bump plus an append-only audit row, under an advisory lock (concurrent runs are
 * serialised and idempotent). Authorization lifts the restore fence only when no ambiguous event is left.
 */
export type JobMode = 'external' | 'transactional';

/**
 * Modes of the job kinds the worker registers today (apps/worker; a test keeps this table equal to the production
 * registry). Unknown kinds are treated as external: parking a database-only job is harmless, re-sending an external
 * effect is not.
 */
export const KNOWN_JOB_MODES: Readonly<Record<string, JobMode>> = {
  'outbox.redeliver': 'transactional',
  'mail.deliver': 'external',
  'mail.feedback': 'transactional',
  'files.scan': 'external',
  'files.delete': 'external',
};

export function jobMode(kind: string, overrides: Readonly<Record<string, JobMode>> = {}): JobMode {
  return overrides[kind] ?? KNOWN_JOB_MODES[kind] ?? 'external';
}

/** One provider-side record of an effect, keyed by the effect key the worker passed (`job:<job id>`). */
export interface ProviderReceipt { effectKey: string; kind: string; reference: string; at: string }

export interface ReceiptJournal {
  receipts: ProviderReceipt[];
  /** The journal holds every effect up to this instant (provider export horizon); null when unknown. */
  completeThrough: Date | null;
}

const EFFECT_KEY = /^job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE = /^[\x20-\x7E]{1,200}$/;

/**
 * Reads a JSON Lines journal (one receipt per line). Provider exports are converted to this shape by the operator;
 * lines are data, never instructions: anything that does not match the shape is rejected with its line number.
 */
export async function readReceiptJournal(path: string, completeThrough: Date | null): Promise<ReceiptJournal> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? '' : Promise.reject(error)));
  return { receipts: parseReceipts(text), completeThrough };
}

export function parseReceipts(text: string): ProviderReceipt[] {
  const out: ProviderReceipt[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`receipt journal line ${index + 1} is not JSON`);
    }
    const r = value as Partial<ProviderReceipt>;
    if (typeof r.effectKey !== 'string' || !EFFECT_KEY.test(r.effectKey) || typeof r.kind !== 'string' || !SAFE.test(r.kind)
        || typeof r.reference !== 'string' || !SAFE.test(r.reference) || typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) {
      throw new Error(`receipt journal line ${index + 1} does not match {effectKey: "job:<uuid>", kind, reference, at}`);
    }
    out.push({ effectKey: r.effectKey, kind: r.kind, reference: r.reference, at: new Date(r.at).toISOString() });
  });
  return out;
}

export interface ReconcileInput {
  /** Operator connection of a login that may SET ROLE trustwork_owner (the migrator in the stack). */
  admin: pg.Pool;
  restoreId: string;
  /** Last transaction the restored database contains (pg_last_xact_replay_timestamp after recovery). */
  recoveryPoint: Date;
  /** When the restore began; the journal is complete only if it covers everything up to this instant. */
  restoreStartedAt: Date;
  journal: ReceiptJournal;
  operator: string;
  modes?: Readonly<Record<string, JobMode>>;
}

export interface ReconcileReport {
  restoreId: string;
  recoveryPoint: string;
  journalComplete: boolean;
  jobs: {
    closedByReceipt: { id: string; kind: string; reference: string }[];
    releasedToQueue: { id: string; kind: string; mode: JobMode }[];
    keptQueued: { id: string; kind: string; mode: JobMode }[];
    parked: { id: string; kind: string }[];
    alreadyParked: { id: string; kind: string }[];
  };
  orphanReceipts: ProviderReceipt[];
  pendingOutbox: { id: string; type: string; aggregateKind: string; aggregateId: string; createdAt: string }[];
  /** Events an operator must decide before authorization (empty when the journal proves nothing was relayed). */
  ambiguousOutbox: string[];
}

export const RESTORE_LOCK = "SELECT pg_advisory_xact_lock(hashtext('trustwork.restore_reconciliation'))";
export const RESTORED_PREFIX = 'restored:';

function checkText(name: string, value: string): void {
  if (!SAFE.test(value)) throw new Error(`${name} must be 1-200 printable ASCII characters`);
}

export async function reconcileRestore(input: ReconcileInput): Promise<ReconcileReport> {
  checkText('restoreId', input.restoreId);
  checkText('operator', input.operator);
  const complete = input.journal.completeThrough !== null && input.journal.completeThrough.getTime() >= input.restoreStartedAt.getTime();
  const byKey = new Map(input.journal.receipts.map((r) => [r.effectKey, r]));
  const client = await input.admin.connect();
  try {
    return await inOwnerTransaction(client, async () => {
      await client.query(RESTORE_LOCK);
      const report: ReconcileReport = {
        restoreId: input.restoreId, recoveryPoint: input.recoveryPoint.toISOString(), journalComplete: complete,
        jobs: { closedByReceipt: [], releasedToQueue: [], keptQueued: [], parked: [], alreadyParked: [] },
        orphanReceipts: [], pendingOutbox: [], ambiguousOutbox: [],
      };
      const { rows: jobs } = await client.query<{ id: string; kind: string; state: string; last_error: string | null }>(
        "SELECT id, kind, state, last_error FROM trustwork.job WHERE state IN ('queued', 'leased', 'outcome_unknown') ORDER BY created_at, id FOR UPDATE");
      for (const job of jobs) {
        const mode = jobMode(job.kind, input.modes);
        const receipt = byKey.get(`job:${job.id}`);
        if (job.state === 'outcome_unknown') {
          if (receipt && job.last_error?.startsWith(RESTORED_PREFIX)) {
            await closeByReceipt(client, job.id, receipt, input);
            report.jobs.closedByReceipt.push({ id: job.id, kind: job.kind, reference: receipt.reference });
          } else if (job.last_error?.startsWith(RESTORED_PREFIX)) {
            report.jobs.parked.push({ id: job.id, kind: job.kind });
          } else {
            report.jobs.alreadyParked.push({ id: job.id, kind: job.kind });
          }
          continue;
        }
        if (mode === 'transactional') {
          if (job.state === 'leased') {
            await setState(client, job.id, 'queued', null);
            report.jobs.releasedToQueue.push({ id: job.id, kind: job.kind, mode });
          } else report.jobs.keptQueued.push({ id: job.id, kind: job.kind, mode });
          continue;
        }
        if (receipt) {
          await setState(client, job.id, 'outcome_unknown', `${RESTORED_PREFIX} provider receipt ${receipt.reference} found`);
          await closeByReceipt(client, job.id, receipt, input);
          report.jobs.closedByReceipt.push({ id: job.id, kind: job.kind, reference: receipt.reference });
        } else if (complete) {
          if (job.state === 'leased') {
            await setState(client, job.id, 'queued', null);
            report.jobs.releasedToQueue.push({ id: job.id, kind: job.kind, mode });
          } else report.jobs.keptQueued.push({ id: job.id, kind: job.kind, mode });
        } else {
          await setState(client, job.id, 'outcome_unknown', `${RESTORED_PREFIX} outcome after the recovery point is unknown; reconcile against provider records`);
          report.jobs.parked.push({ id: job.id, kind: job.kind });
        }
      }
      const known = new Set((await client.query<{ id: string }>('SELECT id::text AS id FROM trustwork.job')).rows.map((r) => r.id));
      report.orphanReceipts = input.journal.receipts.filter((r) => !known.has(r.effectKey.slice(4)));
      const { rows: events } = await client.query<{ id: string; type: string; aggregate_kind: string; aggregate_id: string; created_at: Date }>(
        'SELECT id::text AS id, type, aggregate_kind, aggregate_id, created_at FROM trustwork.outbox_event WHERE published_at IS NULL ORDER BY id');
      report.pendingOutbox = events.map((e) => ({ id: e.id, type: e.type, aggregateKind: e.aggregate_kind, aggregateId: e.aggregate_id, createdAt: e.created_at.toISOString() }));
      const decided = await decidedEvents(client, input.restoreId);
      if (report.orphanReceipts.length > 0 || !complete) report.ambiguousOutbox = report.pendingOutbox.map((e) => e.id).filter((id) => !decided.has(id));
      await audit(client, 'restore.reconciled', input.restoreId, `restore reconciled by ${input.operator}`, {
        recoveryPoint: report.recoveryPoint, journalComplete: complete, receipts: input.journal.receipts.length,
        closedByReceipt: report.jobs.closedByReceipt.length, releasedToQueue: report.jobs.releasedToQueue.length, keptQueued: report.jobs.keptQueued.length,
        parked: report.jobs.parked.length, alreadyParked: report.jobs.alreadyParked.length, orphanReceipts: report.orphanReceipts.length,
        pendingOutbox: report.pendingOutbox.length, ambiguousOutbox: report.ambiguousOutbox.length, operator: input.operator,
      });
      return report;
    });
  } finally {
    client.release();
  }
}

/** Moves a non-terminal job; the fencing token is bumped so a lease held by the lost primary can never complete. */
async function setState(client: pg.PoolClient, id: string, state: 'queued' | 'outcome_unknown', error: string | null): Promise<void> {
  const result = await client.query(
    `UPDATE trustwork.job SET state = $2, leased_until = NULL, leased_by = NULL, fencing_token = fencing_token + 1,
       attempt = CASE WHEN state = 'leased' AND $2 = 'queued' THEN greatest(attempt - 1, 0) ELSE attempt END,
       next_at = CASE WHEN $2 = 'queued' THEN now() ELSE next_at END,
       last_error = coalesce($3, last_error), updated_at = clock_timestamp()
     WHERE id = $1 AND state IN ('queued', 'leased')`, [id, state, error]);
  if (result.rowCount !== 1) throw new Error(`job ${id} changed during reconciliation`);
}

async function closeByReceipt(client: pg.PoolClient, id: string, receipt: ProviderReceipt, input: ReconcileInput): Promise<void> {
  await client.query('SELECT trustwork.reconcile_job($1, $2, $3)', [id, 'succeeded', `restore ${input.restoreId}: provider receipt ${receipt.reference}`]);
  await audit(client, 'job.reconciled', id, 'reconciled as succeeded after restore', {
    mode: 'restore', outcome: 'succeeded', reference: receipt.reference, kind: receipt.kind, restoreId: input.restoreId, operator: input.operator,
  }, 'job');
}

async function audit(client: Pick<pg.PoolClient, 'query'>, action: string, objectId: string, reason: string, basis: object, objectKind = 'restore'): Promise<void> {
  await client.query('INSERT INTO trustwork.audit_event (action, object_kind, object_id, reason, basis) VALUES ($1, $2, $3, $4, $5)', [action, objectKind, objectId, reason.slice(0, 500), JSON.stringify(basis)]);
}

async function decidedEvents(client: Pick<pg.PoolClient, 'query'>, restoreId: string): Promise<Set<string>> {
  const { rows } = await client.query<{ object_id: string }>(
    "SELECT object_id FROM trustwork.audit_event WHERE object_kind = 'outbox_event' AND action IN ('restore.outbox_delivered', 'restore.outbox_relay_approved') AND basis->>'restoreId' = $1", [restoreId]);
  return new Set(rows.map((r) => r.object_id));
}

/**
 * Operator decision on one pending outbox event after comparing it with provider records:
 *   delivered  the lost primary already relayed it and its effect exists: marked published, never relayed again;
 *   relay      no effect exists: approved for the relay once the fence is lifted.
 */
export async function resolveOutboxEvent(input: { admin: pg.Pool; restoreId: string; eventId: string; decision: 'delivered' | 'relay'; reference: string; operator: string }): Promise<void> {
  checkText('restoreId', input.restoreId);
  checkText('reference', input.reference);
  checkText('operator', input.operator);
  if (!/^[1-9][0-9]{0,18}$/.test(input.eventId)) throw new Error('eventId must be an outbox event id');
  if (input.decision !== 'delivered' && input.decision !== 'relay') throw new Error('decision must be delivered or relay');
  const client = await input.admin.connect();
  try {
    await inOwnerTransaction(client, async () => {
      await client.query(RESTORE_LOCK);
      const { rows } = await client.query<{ published: boolean }>('SELECT published_at IS NOT NULL AS published FROM trustwork.outbox_event WHERE id = $1 FOR UPDATE', [input.eventId]);
      if (!rows[0]) throw new Error(`outbox event ${input.eventId} not found`);
      if (rows[0].published) throw new Error(`outbox event ${input.eventId} is already published`);
      if (input.decision === 'delivered') await client.query('UPDATE trustwork.outbox_event SET published_at = now() WHERE id = $1', [input.eventId]);
      await audit(client, input.decision === 'delivered' ? 'restore.outbox_delivered' : 'restore.outbox_relay_approved', input.eventId,
        `outbox event ${input.decision === 'delivered' ? 'already delivered before the failure' : 'approved for relay'}`,
        { restoreId: input.restoreId, reference: input.reference, operator: input.operator }, 'outbox_event');
    });
  } finally {
    client.release();
  }
}

export class AuthorizationRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`restore authorization refused: ${reasons.join('; ')}`);
    this.name = 'AuthorizationRefused';
  }
}

/**
 * Lifts the fence after reconciliation. Refused when the restore was never reconciled or when a pending outbox
 * event is still ambiguous (orphan receipts or an incomplete journal, and no operator decision). Parked jobs do not
 * block: a parked job is never leased, and the worker's reconcile CLI resolves it with evidence afterwards.
 */
export async function authorizeRestore(input: { admin: pg.Pool; fence: RestoreFence; restoreId: string; reference: string; operator: string }): Promise<{ authorizedAt: string }> {
  checkText('restoreId', input.restoreId);
  checkText('reference', input.reference);
  checkText('operator', input.operator);
  const client = await input.admin.connect();
  try {
    const authorizedAt = await inOwnerTransaction(client, async () => {
      await client.query(RESTORE_LOCK);
      const { rows } = await client.query<{ basis: { orphanReceipts: number; journalComplete: boolean } }>(
        "SELECT basis FROM trustwork.audit_event WHERE action = 'restore.reconciled' AND object_kind = 'restore' AND object_id = $1 ORDER BY id DESC LIMIT 1", [input.restoreId]);
      const last = rows[0];
      const reasons: string[] = [];
      if (!last) reasons.push('the restore has not been reconciled');
      else if (last.basis.orphanReceipts > 0 || !last.basis.journalComplete) {
        const decided = await decidedEvents(client, input.restoreId);
        const { rows: pending } = await client.query<{ id: string }>('SELECT id::text AS id FROM trustwork.outbox_event WHERE published_at IS NULL ORDER BY id');
        const open = pending.map((p) => p.id).filter((id) => !decided.has(id));
        if (open.length) reasons.push(`${open.length} pending outbox events need a decision (delivered or relay): ${open.slice(0, 20).join(', ')}`);
      }
      if (reasons.length) throw new AuthorizationRefused(reasons);
      const { rows: now } = await client.query<{ now: Date }>('SELECT now() AS now');
      await audit(client, 'restore.authorized', input.restoreId, `restore authorized by ${input.operator}`, { reference: input.reference, operator: input.operator, fence: input.fence.describe() });
      return (now[0] as { now: Date }).now.toISOString();
    });
    // The fence is lifted only after the authorization row committed; a failure here leaves it in place (fail closed).
    await input.fence.lift();
    return { authorizedAt };
  } finally {
    client.release();
  }
}
