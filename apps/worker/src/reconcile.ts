import { auditEvents, jobs, type Job, type Transaction } from '@trustwork/data';

export type ReconcileOutcome = 'succeeded' | 'failed' | 'queued';
export const RECONCILE_OUTCOMES: readonly ReconcileOutcome[] = ['succeeded', 'failed', 'queued'];

export interface ReconcileInput {
  jobId: string;
  /**
   * `succeeded`: the external effect is confirmed (provider lookup found it). `failed`: confirmed that no effect
   * happened and the work must not run again (dead). `queued`: confirmed that no effect happened and it is safe to run
   * again (the stable effect key is reused).
   */
  outcome: ReconcileOutcome;
  /** Names the evidence: provider lookup reference, Reconciliation record id, or the automatic rule. */
  reference: string;
  mode: 'auto' | 'manual';
  /** Free-text operator label for manual reconciliation (no personal data). */
  operator?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TEXT = /^[\x20-\x7E]+$/;

/**
 * Explicit reconciliation of a parked (`outcome_unknown`) job through the owner-run `trustwork.reconcile_job`, plus an
 * append-only audit row in the same transaction. Refuses jobs that are not parked (database hint `job.not_parked`).
 */
export async function reconcileJob(trx: Transaction, input: ReconcileInput): Promise<Job> {
  if (!UUID.test(input.jobId)) throw new Error('jobId must be a UUID');
  if (!RECONCILE_OUTCOMES.includes(input.outcome)) throw new Error(`outcome must be one of ${RECONCILE_OUTCOMES.join(', ')}`);
  if (input.reference.length < 1 || input.reference.length > 200 || !SAFE_TEXT.test(input.reference)) throw new Error('reference must be 1-200 printable ASCII characters');
  const operator = input.operator ?? null;
  if (operator !== null && (operator.length > 128 || !SAFE_TEXT.test(operator))) throw new Error('operator must be at most 128 printable ASCII characters');
  const job = await jobs.reconcile(trx, input.jobId, input.outcome, input.reference);
  await auditEvents.append(trx, {
    action: 'job.reconciled',
    object_kind: 'job',
    object_id: job.id,
    reason: `reconciled as ${input.outcome}`,
    basis: { mode: input.mode, outcome: input.outcome, reference: input.reference, kind: job.kind, attempt: job.attempt, fencingToken: job.fencing_token, operator },
  });
  return job;
}
